/**
 * Portable shot list. schema "stardust.shotlist/1".
 * A zip holds shotlist.json and the stills it names.
 * Validation lists every problem and creates nothing until the file is clean.
 * Sexual content involving a minor is refused before a project or image is stored.
 * API keys, auth headers, environment values, billing rates, and payment or
 * license data are not written.
 */

import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import JSZip from "jszip";
import { OUTPUT_DIM_MAX, OUTPUT_DIM_MIN, OUTPUT_FPS_MAX, OUTPUT_FPS_MIN } from "./conform";
import { assertExportHasNoSecrets } from "./edit-export";
import { effectiveSeed } from "./input-key";
import {
  COMFY_WORKFLOW_TITLES,
  comfyWorkflowIdByTitle,
  comfyWorkflowTitle,
} from "./provider-info";
import { generationIsRefused, MINOR_SEXUAL_REFUSAL } from "./safety";
import {
  createProject,
  createShot,
  deleteProject,
  getProject,
  getSettings,
  listProjects,
  listShots,
  resolveDataPath,
  saveUpload,
  updateProject,
  updateShot,
} from "./storage";
import { sniffImage } from "./uploads";
import {
  ComfyWorkflowId,
  MAX_CHAIN_FRAME_BACK,
  MAX_CHAIN_TRIM_START_FRAMES,
  MAX_SEAM_FADE_FRAMES,
  MAX_SEAM_FADE_SEC,
  MAX_SHOT_SECONDS,
  MIN_CHAIN_TRIM_START_FRAMES,
  MIN_SEAM_FADE_FRAMES,
  MIN_SEAM_FADE_SEC,
  MIN_SHOT_SECONDS,
  MOTION_PRESETS,
  Project,
  ProviderId,
  SeamFadeUnit,
  SeamMode,
  Shot,
  effectivePrompt,
  isProviderId,
} from "./types";

export const SHOTLIST_SCHEMA = "stardust.shotlist/1";
export const SHOTLIST_JSON = "shotlist.json";
export const MAX_SHOTLIST_SHOTS = 200;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 80 * 1024 * 1024;
const MAX_BUNDLE_FILES = 500;

const PRESET_IDS = MOTION_PRESETS.map((preset) => preset.id);
const PROVIDER_IDS: ProviderId[] = ["mock", "fal", "replicate", "comfyui"];

const ROOT_KEYS = [
  "schema",
  "name",
  "description",
  "styleBase",
  "provider",
  "comfyuiWorkflow",
  "comfyLowMemory",
  "output",
  "transition",
  "chainTrimStartFrames",
  "shots",
] as const;

const SHOT_KEYS = [
  "prompt",
  "durationSec",
  "preset",
  "enabled",
  "seed",
  "seedPinned",
  "images",
  "chainFromPrevious",
  "chainFrameBack",
  "chainTrimStartFrames",
  "transition",
  "comfyuiWorkflow",
  "comfyLowMemory",
] as const;

const IMAGE_KEYS = ["file", "role"] as const;
const OUTPUT_KEYS = ["fps", "width", "height"] as const;
const TRANSITION_KEYS = ["mode", "fadeSec", "fadeUnit", "fadeFrames"] as const;

const FORBIDDEN_KEY =
  /^(api[_-]?key|key|token|secret|password|authorization|auth|license|stripe|paypal|rates?|budget|budgetCap|billing|falKey|replicateToken|comfyuiBaseUrl|comfyuiAuth|env)$/i;

export interface ShotListTransition {
  mode: SeamMode;
  fadeSec: number;
  fadeUnit: SeamFadeUnit;
  fadeFrames: number;
}

export interface ShotListImage {
  file: string;
  role: "start" | "end";
}

export interface ShotListShot {
  prompt: string;
  durationSec: number;
  preset: string;
  enabled: boolean;
  seed: number | null;
  seedPinned: boolean;
  images: ShotListImage[];
  chainFromPrevious: boolean;
  chainFrameBack: number;
  chainTrimStartFrames: number | null;
  transition: ShotListTransition | null;
  comfyuiWorkflow: string | null;
  comfyLowMemory: boolean | null;
}

export interface ShotListOutput {
  fps: number | null;
  width: number | null;
  height: number | null;
}

export interface ShotListDocument {
  schema: typeof SHOTLIST_SCHEMA;
  name: string;
  description: string;
  styleBase: string;
  provider: ProviderId;
  comfyuiWorkflow: string | null;
  comfyLowMemory: boolean | null;
  output: ShotListOutput;
  transition: ShotListTransition;
  chainTrimStartFrames: number;
  shots: ShotListShot[];
}

export interface ShotListBundle {
  /** UTF-8 JSON text of the shot list. */
  json: string;
  /** Relative paths, forward slashes, to file bytes. */
  files: ReadonlyMap<string, Buffer>;
  source: "zip" | "json" | "directory";
}

export interface ShotListCheck {
  document: ShotListDocument | null;
  errors: string[];
  refused: boolean;
}

export type ShotListImport =
  | { ok: true; project: Project }
  | { ok: false; errors: string[]; refused: boolean };

export interface ShotRenderSettings {
  name: string;
  description: string;
  styleBase: string;
  provider: ProviderId;
  comfyuiWorkflow: string | null;
  comfyLowMemory: boolean | null;
  output: ShotListOutput;
  transition: ShotListTransition;
  chainTrimStartFrames: number;
  shots: Array<{
    prompt: string;
    durationSec: number;
    preset: string;
    enabled: boolean;
    seed: number;
    seedPinned: boolean;
    startSha256: string;
    endSha256: string | null;
    chainFromPrevious: boolean;
    chainFrameBack: number;
    chainTrimStartFrames: number | null;
    transition: ShotListTransition | null;
    comfyuiWorkflow: string | null;
    comfyLowMemory: boolean | null;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pushUnknown(errors: string[], value: Record<string, unknown>, allowed: readonly string[], where: string) {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEY.test(key)) {
      errors.push(
        `${where} field "${key}" is not part of a shot list. Keys, tokens, rates, and license data are not stored.`
      );
      continue;
    }
    if (!allowed.includes(key)) {
      errors.push(`${where} field "${key}" is not part of ${SHOTLIST_SCHEMA}.`);
    }
  }
}

export function normalizeShotListPath(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

function pathProblem(file: string): string | null {
  if (!file.trim()) return "is empty";
  const norm = normalizeShotListPath(file);
  if (norm.startsWith("/") || /^[a-zA-Z]:/.test(norm)) return "must be a relative path inside the shot list";
  if (norm.split("/").some((part) => part === "" || part === "." || part === "..")) {
    return "must stay inside the shot list";
  }
  if (norm.includes("\0")) return "is not a usable path";
  return null;
}

function workflowTitle(id: ComfyWorkflowId | null | undefined): string | null {
  if (!id) return null;
  return comfyWorkflowTitle(id);
}

function transitionFrom(
  mode: SeamMode,
  fadeSec: number,
  fadeUnit: SeamFadeUnit,
  fadeFrames: number
): ShotListTransition {
  return { mode, fadeSec, fadeUnit, fadeFrames };
}

function readTransition(
  value: unknown,
  where: string,
  errors: string[],
  allowNull: boolean
): ShotListTransition | null | undefined {
  if (value === undefined) {
    errors.push(`${where} is missing.`);
    return undefined;
  }
  if (value === null) {
    if (allowNull) return null;
    errors.push(`${where} is missing.`);
    return undefined;
  }
  if (!isRecord(value)) {
    errors.push(`${where} must be an object with mode, fadeSec, fadeUnit, and fadeFrames.`);
    return undefined;
  }
  pushUnknown(errors, value, TRANSITION_KEYS, where);
  const mode = value.mode;
  if (mode !== "cut" && mode !== "crossfade") {
    errors.push(`${where} mode "${String(mode)}" is not cut or crossfade.`);
  }
  const fadeSec = value.fadeSec;
  if (typeof fadeSec !== "number" || !Number.isFinite(fadeSec)) {
    errors.push(`${where} fadeSec must be a number of seconds from ${MIN_SEAM_FADE_SEC} to ${MAX_SEAM_FADE_SEC}.`);
  } else if (fadeSec < MIN_SEAM_FADE_SEC || fadeSec > MAX_SEAM_FADE_SEC) {
    errors.push(`${where} fadeSec is ${fadeSec}. The range is ${MIN_SEAM_FADE_SEC}–${MAX_SEAM_FADE_SEC} seconds.`);
  }
  const fadeUnit = value.fadeUnit;
  if (fadeUnit !== "seconds" && fadeUnit !== "frames") {
    errors.push(`${where} fadeUnit "${String(fadeUnit)}" is not seconds or frames.`);
  }
  const fadeFrames = value.fadeFrames;
  if (typeof fadeFrames !== "number" || !Number.isInteger(fadeFrames)) {
    errors.push(
      `${where} fadeFrames must be a whole number from ${MIN_SEAM_FADE_FRAMES} to ${MAX_SEAM_FADE_FRAMES}.`
    );
  } else if (fadeFrames < MIN_SEAM_FADE_FRAMES || fadeFrames > MAX_SEAM_FADE_FRAMES) {
    errors.push(`${where} fadeFrames is ${fadeFrames}. The range is ${MIN_SEAM_FADE_FRAMES}–${MAX_SEAM_FADE_FRAMES}.`);
  }
  if (mode !== "cut" && mode !== "crossfade") return undefined;
  if (typeof fadeSec !== "number" || fadeSec < MIN_SEAM_FADE_SEC || fadeSec > MAX_SEAM_FADE_SEC) return undefined;
  if (fadeUnit !== "seconds" && fadeUnit !== "frames") return undefined;
  if (typeof fadeFrames !== "number" || !Number.isInteger(fadeFrames)) return undefined;
  if (fadeFrames < MIN_SEAM_FADE_FRAMES || fadeFrames > MAX_SEAM_FADE_FRAMES) return undefined;
  return transitionFrom(mode, fadeSec, fadeUnit, fadeFrames);
}

function readWorkflow(value: unknown, where: string, errors: string[]): string | null | undefined {
  if (value === undefined) {
    errors.push(`${where} is missing. Use a workflow name or null.`);
    return undefined;
  }
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${where} must be a workflow name or null.`);
    return undefined;
  }
  const title = value.trim();
  if (!comfyWorkflowIdByTitle(title)) {
    errors.push(
      `${where} "${title}" is not a known ComfyUI workflow. Use one of: ${COMFY_WORKFLOW_TITLES.join(", ")}. Or null to inherit.`
    );
    return undefined;
  }
  return title;
}

function readFlag(value: unknown, where: string, errors: string[]): boolean | null | undefined {
  if (value === undefined) {
    errors.push(`${where} is missing. Use true, false, or null.`);
    return undefined;
  }
  if (value === null) return null;
  if (typeof value !== "boolean") {
    errors.push(`${where} must be true, false, or null.`);
    return undefined;
  }
  return value;
}

function fileBytes(files: ReadonlyMap<string, Buffer>, file: string): Buffer | undefined {
  const norm = normalizeShotListPath(file);
  return files.get(norm) ?? files.get(file);
}

function collectRefusal(raw: unknown, files: ReadonlyMap<string, Buffer>): boolean {
  if (!isRecord(raw)) return false;
  const style = typeof raw.styleBase === "string" ? raw.styleBase : "";
  const shots = Array.isArray(raw.shots) ? raw.shots : [];
  for (const shot of shots) {
    if (!isRecord(shot)) continue;
    const prompt = typeof shot.prompt === "string" ? shot.prompt : "";
    const names: string[] = [];
    if (Array.isArray(shot.images)) {
      for (const image of shot.images) {
        if (!isRecord(image) || typeof image.file !== "string") continue;
        names.push(image.file, path.posix.basename(normalizeShotListPath(image.file)));
      }
    }
    if (generationIsRefused(effectivePrompt(style, prompt), names)) return true;
    if (generationIsRefused(prompt, names)) return true;
  }
  if (style && generationIsRefused(style, [])) return true;
  for (const name of Array.from(files.keys())) {
    if (generationIsRefused("", [name, path.posix.basename(name)])) return true;
  }
  return false;
}

export function validateShotList(bundle: ShotListBundle): ShotListCheck {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(bundle.json.replace(/^\uFEFF/, ""));
  } catch {
    return { document: null, errors: ["The shot list JSON is not valid."], refused: false };
  }
  const refused = collectRefusal(parsed, bundle.files);
  if (refused) errors.push(MINOR_SEXUAL_REFUSAL);
  if (!isRecord(parsed)) {
    errors.push("The shot list JSON must be an object.");
    return { document: null, errors, refused };
  }
  pushUnknown(errors, parsed, ROOT_KEYS, "Shot list");

  if (parsed.schema !== SHOTLIST_SCHEMA) {
    const shown = parsed.schema == null ? "missing" : JSON.stringify(parsed.schema);
    errors.push(`Unknown shot list schema ${shown}. This version of Star Dust reads "${SHOTLIST_SCHEMA}".`);
  }
  if (typeof parsed.name !== "string" || !parsed.name.trim()) {
    errors.push("The shot list needs a name.");
  } else if (parsed.name.trim().length > 200) {
    errors.push("The shot list name is longer than 200 characters.");
  }
  if (typeof parsed.description !== "string") {
    errors.push("description must be a string. Use an empty string when there is no note.");
  } else if (parsed.description.length > 2000) {
    errors.push("description is longer than 2000 characters.");
  }
  if (typeof parsed.styleBase !== "string") {
    errors.push("styleBase must be a string. Use an empty string when there is no shared style text.");
  } else if (parsed.styleBase.length > 8000) {
    errors.push("styleBase is longer than 8000 characters.");
  }

  const provider = isProviderId(parsed.provider) ? parsed.provider : undefined;
  if (parsed.provider == null) {
    errors.push(`provider is missing. Use ${PROVIDER_IDS.join(", ")}.`);
  } else if (!provider) {
    errors.push(`Provider "${String(parsed.provider)}" is not ${PROVIDER_IDS.join(", ")}.`);
  }
  const comfyuiWorkflow = readWorkflow(parsed.comfyuiWorkflow, "Project workflow", errors);
  const comfyLowMemory = readFlag(parsed.comfyLowMemory, "Project low-memory preset", errors);

  let output: ShotListOutput | undefined;
  if (!isRecord(parsed.output)) {
    errors.push("output must be an object with fps, width, and height. Use null to leave a size or rate unset.");
  } else {
    pushUnknown(errors, parsed.output, OUTPUT_KEYS, "output");
    const fps = parsed.output.fps;
    const width = parsed.output.width;
    const height = parsed.output.height;
    let fpsOk: number | null | undefined;
    if (!("fps" in parsed.output)) {
      errors.push(`output fps is missing. Use a whole number from ${OUTPUT_FPS_MIN} to ${OUTPUT_FPS_MAX}, or null.`);
    } else if (fps == null) fpsOk = null;
    else if (typeof fps !== "number" || !Number.isInteger(fps)) {
      errors.push(`output fps must be a whole number from ${OUTPUT_FPS_MIN} to ${OUTPUT_FPS_MAX}, or null.`);
    } else if (fps < OUTPUT_FPS_MIN || fps > OUTPUT_FPS_MAX) {
      errors.push(`output fps is ${fps}. The range is ${OUTPUT_FPS_MIN}–${OUTPUT_FPS_MAX}, or null.`);
    } else fpsOk = fps;
    const dimError = (label: string, value: unknown, present: boolean): number | null | undefined => {
      if (!present) {
        errors.push(
          `output ${label} is missing. Use an even whole number from ${OUTPUT_DIM_MIN} to ${OUTPUT_DIM_MAX}, or null.`
        );
        return undefined;
      }
      if (value == null) return null;
      if (typeof value !== "number" || !Number.isInteger(value)) {
        errors.push(
          `output ${label} must be an even whole number from ${OUTPUT_DIM_MIN} to ${OUTPUT_DIM_MAX}, or null.`
        );
        return undefined;
      }
      if (value < OUTPUT_DIM_MIN || value > OUTPUT_DIM_MAX || value % 2 !== 0) {
        errors.push(
          `output ${label} ${value} must be an even number from ${OUTPUT_DIM_MIN} to ${OUTPUT_DIM_MAX}.`
        );
        return undefined;
      }
      return value;
    };
    const widthOk = dimError("width", width, "width" in parsed.output);
    const heightOk = dimError("height", height, "height" in parsed.output);
    if (widthOk === null && heightOk !== null && heightOk !== undefined) {
      errors.push("output width is unset and output height is set. Set both, or set both to null.");
    }
    if (heightOk === null && widthOk !== null && widthOk !== undefined) {
      errors.push("output height is unset and output width is set. Set both, or set both to null.");
    }
    if (fpsOk !== undefined && widthOk !== undefined && heightOk !== undefined) {
      output = { fps: fpsOk, width: widthOk, height: heightOk };
    }
  }

  const transition = readTransition(parsed.transition, "Project transition", errors, false);
  const trim = parsed.chainTrimStartFrames;
  let chainTrim: number | undefined;
  if (typeof trim !== "number" || !Number.isInteger(trim)) {
    errors.push(
      `chainTrimStartFrames must be a whole number from ${MIN_CHAIN_TRIM_START_FRAMES} to ${MAX_CHAIN_TRIM_START_FRAMES}.`
    );
  } else if (trim < MIN_CHAIN_TRIM_START_FRAMES || trim > MAX_CHAIN_TRIM_START_FRAMES) {
    errors.push(
      `chainTrimStartFrames is ${trim}. The range is ${MIN_CHAIN_TRIM_START_FRAMES}–${MAX_CHAIN_TRIM_START_FRAMES}.`
    );
  } else chainTrim = trim;

  const shots: ShotListShot[] = [];
  if (!Array.isArray(parsed.shots)) {
    errors.push("shots must be a list.");
  } else if (parsed.shots.length === 0) {
    errors.push("The shot list has no shots.");
  } else if (parsed.shots.length > MAX_SHOTLIST_SHOTS) {
    errors.push(`This shot list has ${parsed.shots.length} shots. The limit is ${MAX_SHOTLIST_SHOTS}.`);
  } else {
    parsed.shots.forEach((entry, index) => {
      const label = `Shot ${index + 1}`;
      if (!isRecord(entry)) {
        errors.push(`${label} is not an object.`);
        return;
      }
      pushUnknown(errors, entry, SHOT_KEYS, label);
      let prompt: string | undefined;
      if (typeof entry.prompt !== "string" || !entry.prompt.trim()) {
        errors.push(`${label} prompt is empty.`);
      } else if (entry.prompt.trim().length > 8000) {
        errors.push(`${label} prompt is longer than 8000 characters.`);
      } else prompt = entry.prompt.trim();

      let durationSec: number | undefined;
      if (typeof entry.durationSec !== "number" || !Number.isFinite(entry.durationSec)) {
        errors.push(
          `${label} duration must be a number of seconds from ${MIN_SHOT_SECONDS} to ${MAX_SHOT_SECONDS}.`
        );
      } else if (entry.durationSec < MIN_SHOT_SECONDS || entry.durationSec > MAX_SHOT_SECONDS) {
        errors.push(
          `${label} duration is ${entry.durationSec}. Duration is a number of seconds from ${MIN_SHOT_SECONDS} to ${MAX_SHOT_SECONDS}.`
        );
      } else durationSec = entry.durationSec;

      let preset: string | undefined;
      if (typeof entry.preset !== "string" || !PRESET_IDS.includes(entry.preset)) {
        errors.push(`${label} preset "${String(entry.preset)}" is not one of: ${PRESET_IDS.join(", ")}.`);
      } else preset = entry.preset;

      const enabled = typeof entry.enabled === "boolean" ? entry.enabled : undefined;
      if (enabled == null) errors.push(`${label} enabled must be true or false.`);

      let seed: number | null | undefined;
      if (!("seed" in entry)) {
        errors.push(`${label} seed is missing. Use a whole number or null.`);
      } else if (entry.seed == null) seed = null;
      else if (
        typeof entry.seed !== "number" ||
        !Number.isInteger(entry.seed) ||
        entry.seed < 0 ||
        entry.seed > 999_999_999
      ) {
        errors.push(`${label} seed must be a whole number from 0 to 999999999, or null.`);
      } else seed = entry.seed;

      const seedPinned = typeof entry.seedPinned === "boolean" ? entry.seedPinned : undefined;
      if (seedPinned == null) errors.push(`${label} seedPinned must be true or false.`);
      if (seedPinned === true && seed == null) errors.push(`${label} pins a seed but seed is null.`);

      const images: ShotListImage[] = [];
      if (!Array.isArray(entry.images)) {
        errors.push(`${label} images must be a list of { file, role }.`);
      } else {
        entry.images.forEach((image, imageIndex) => {
          const imageWhere = `${label} image ${imageIndex + 1}`;
          if (!isRecord(image)) {
            errors.push(`${imageWhere} is not an object.`);
            return;
          }
          pushUnknown(errors, image, IMAGE_KEYS, imageWhere);
          const role = image.role;
          if (role !== "start" && role !== "end") {
            errors.push(`${label} image role "${String(role)}" is not start or end.`);
          }
          if (typeof image.file !== "string") {
            errors.push(`${imageWhere} file must be a path inside the shot list.`);
            return;
          }
          const problem = pathProblem(image.file);
          const rel = normalizeShotListPath(image.file);
          if (problem) {
            errors.push(`${label} still "${image.file}" ${problem}.`);
            return;
          }
          const bytes = fileBytes(bundle.files, rel);
          if (!bytes) {
            errors.push(`${label} still "${rel}" is missing from the shot list files.`);
            return;
          }
          if (bytes.length === 0) {
            errors.push(`${label} still "${rel}" is empty.`);
            return;
          }
          if (bytes.length > MAX_IMAGE_BYTES) {
            errors.push(`${label} still "${rel}" is larger than 12 MB.`);
            return;
          }
          if (!sniffImage(bytes)) {
            errors.push(`${label} still "${rel}" is not a PNG, JPEG, WebP, or GIF.`);
            return;
          }
          if (role === "start" || role === "end") images.push({ file: rel, role });
        });
        const starts = images.filter((image) => image.role === "start");
        const ends = images.filter((image) => image.role === "end");
        if (starts.length === 0) errors.push(`${label} has no start still.`);
        if (starts.length > 1) errors.push(`${label} has more than one start still.`);
        if (ends.length > 1) errors.push(`${label} has more than one end still.`);
      }

      const chainFromPrevious = typeof entry.chainFromPrevious === "boolean" ? entry.chainFromPrevious : undefined;
      if (chainFromPrevious == null) errors.push(`${label} chainFromPrevious must be true or false.`);
      if (index === 0 && entry.chainFromPrevious === true) {
        errors.push(`${label} is the first shot, so it cannot chain from a previous shot.`);
      }

      let chainFrameBack: number | undefined;
      if (typeof entry.chainFrameBack !== "number" || !Number.isInteger(entry.chainFrameBack)) {
        errors.push(`${label} chainFrameBack must be a whole number from 0 to ${MAX_CHAIN_FRAME_BACK}.`);
      } else if (entry.chainFrameBack < 0 || entry.chainFrameBack > MAX_CHAIN_FRAME_BACK) {
        errors.push(
          `${label} steps back ${entry.chainFrameBack} frames. The range is 0–${MAX_CHAIN_FRAME_BACK}.`
        );
      } else chainFrameBack = entry.chainFrameBack;

      let chainTrimStartFrames: number | null | undefined;
      if (!("chainTrimStartFrames" in entry)) {
        errors.push(
          `${label} chainTrimStartFrames is missing. Use a whole number from ${MIN_CHAIN_TRIM_START_FRAMES} to ${MAX_CHAIN_TRIM_START_FRAMES}, or null to inherit.`
        );
      } else if (entry.chainTrimStartFrames == null) chainTrimStartFrames = null;
      else if (typeof entry.chainTrimStartFrames !== "number" || !Number.isInteger(entry.chainTrimStartFrames)) {
        errors.push(
          `${label} chainTrimStartFrames must be a whole number from ${MIN_CHAIN_TRIM_START_FRAMES} to ${MAX_CHAIN_TRIM_START_FRAMES}, or null to inherit.`
        );
      } else if (
        entry.chainTrimStartFrames < MIN_CHAIN_TRIM_START_FRAMES ||
        entry.chainTrimStartFrames > MAX_CHAIN_TRIM_START_FRAMES
      ) {
        errors.push(
          `${label} start-frame trim is ${entry.chainTrimStartFrames}. The range is ${MIN_CHAIN_TRIM_START_FRAMES}–${MAX_CHAIN_TRIM_START_FRAMES}, or null to inherit.`
        );
      } else chainTrimStartFrames = entry.chainTrimStartFrames;

      const shotTransition = readTransition(entry.transition, `${label} transition`, errors, true);
      const shotWorkflow = readWorkflow(entry.comfyuiWorkflow, `${label} workflow`, errors);
      const shotLow = readFlag(entry.comfyLowMemory, `${label} low-memory preset`, errors);
      const starts = images.filter((image) => image.role === "start").length;
      const ends = images.filter((image) => image.role === "end").length;
      if (
        prompt == null ||
        durationSec == null ||
        preset == null ||
        enabled == null ||
        seed === undefined ||
        seedPinned == null ||
        chainFromPrevious == null ||
        chainFrameBack == null ||
        chainTrimStartFrames === undefined ||
        shotTransition === undefined ||
        shotWorkflow === undefined ||
        shotLow === undefined ||
        starts !== 1 ||
        ends > 1
      ) {
        return;
      }
      shots.push({
        prompt,
        durationSec,
        preset,
        enabled,
        seed,
        seedPinned,
        images,
        chainFromPrevious,
        chainFrameBack,
        chainTrimStartFrames,
        transition: shotTransition,
        comfyuiWorkflow: shotWorkflow,
        comfyLowMemory: shotLow,
      });
    });
  }

  const shotCount = Array.isArray(parsed.shots) ? parsed.shots.length : -1;
  if (
    !provider ||
    comfyuiWorkflow === undefined ||
    comfyLowMemory === undefined ||
    !output ||
    !transition ||
    chainTrim == null ||
    typeof parsed.name !== "string" ||
    typeof parsed.description !== "string" ||
    typeof parsed.styleBase !== "string" ||
    shots.length !== shotCount ||
    refused ||
    errors.length > 0
  ) {
    return { document: null, errors, refused };
  }

  return {
    document: {
      schema: SHOTLIST_SCHEMA,
      name: parsed.name.trim(),
      description: parsed.description,
      styleBase: parsed.styleBase,
      provider,
      comfyuiWorkflow,
      comfyLowMemory,
      output,
      transition,
      chainTrimStartFrames: chainTrim,
      shots,
    },
    errors: [],
    refused: false,
  };
}

function extFor(bytes: Buffer): string {
  const kind = sniffImage(bytes);
  if (kind === "jpeg") return "jpg";
  if (kind === "webp") return "webp";
  if (kind === "gif") return "gif";
  return "png";
}

function shotTransition(shot: Shot, project: Project): ShotListTransition | null {
  if (
    shot.seamMode == null &&
    shot.seamFadeSec == null &&
    shot.seamFadeUnit == null &&
    shot.seamFadeFrames == null
  ) {
    return null;
  }
  return transitionFrom(
    shot.seamMode ?? project.seamMode,
    shot.seamFadeSec ?? project.seamFadeSec,
    shot.seamFadeUnit ?? project.seamFadeUnit,
    shot.seamFadeFrames ?? project.seamFadeFrames
  );
}

export function buildShotList(projectId: string): { document: ShotListDocument; files: Map<string, Buffer> } {
  const project = getProject(projectId);
  if (!project) throw new Error("Project not found");
  const shots = listShots(projectId);
  if (shots.length === 0) throw new Error("Add a shot before exporting a shot list.");
  const settings = getSettings();
  const provider = project.provider ?? settings.provider;
  const files = new Map<string, Buffer>();
  const used = new Map<string, string>();

  function place(relativePath: string | undefined, position: number, role: "start" | "end"): string {
    if (!relativePath) throw new Error(`Shot ${position} is missing a ${role} image.`);
    const existing = used.get(relativePath);
    if (existing) return existing;
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(resolveDataPath(relativePath));
    } catch {
      throw new Error(`Shot ${position} ${role} image is missing from disk.`);
    }
    if (!sniffImage(bytes)) {
      throw new Error(`Shot ${position} ${role} image is not a PNG, JPEG, WebP, or GIF.`);
    }
    const name = `stills/${String(position).padStart(2, "0")}-${role}.${extFor(bytes)}`;
    files.set(name, bytes);
    used.set(relativePath, name);
    return name;
  }

  const document: ShotListDocument = {
    schema: SHOTLIST_SCHEMA,
    name: project.name,
    description: project.description,
    styleBase: project.styleBase,
    provider,
    comfyuiWorkflow: workflowTitle(project.comfyuiWorkflow),
    comfyLowMemory: project.comfyLowMemory ?? null,
    output: {
      fps: project.outputFps,
      width: project.outputWidth,
      height: project.outputHeight,
    },
    transition: transitionFrom(
      project.seamMode,
      project.seamFadeSec,
      project.seamFadeUnit,
      project.seamFadeFrames
    ),
    chainTrimStartFrames: project.chainTrimStartFrames,
    shots: shots.map((shot) => {
      const images: ShotListImage[] = [
        { file: place(shot.startImagePath, shot.position, "start"), role: "start" },
      ];
      if (shot.endImagePath) {
        images.push({ file: place(shot.endImagePath, shot.position, "end"), role: "end" });
      }
      return {
        prompt: shot.prompt,
        durationSec: shot.durationSec,
        preset: shot.presetId,
        enabled: shot.enabled !== false,
        seed: shot.seed != null ? shot.seed : effectiveSeed(shot),
        seedPinned: Boolean(shot.seedPinned),
        images,
        chainFromPrevious: shot.chainFromPrevious,
        chainFrameBack: shot.chainFrameBack,
        chainTrimStartFrames: shot.chainTrimStartFrames ?? null,
        transition: shotTransition(shot, project),
        comfyuiWorkflow: workflowTitle(shot.comfyuiWorkflow),
        comfyLowMemory: shot.comfyLowMemory ?? null,
      };
    }),
  };
  return { document, files };
}

function assertDocumentClean(json: string) {
  assertExportHasNoSecrets(json);
  const parsed = JSON.parse(json) as unknown;
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((entry) => walk(entry));
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEY.test(key)) {
        throw new Error("Export blocked because it would include an API key, auth header, rate, or license field.");
      }
      walk(child);
    }
  };
  walk(parsed);
}

export function shotListJson(document: ShotListDocument): string {
  const json = `${JSON.stringify(document, null, 2)}\n`;
  assertDocumentClean(json);
  return json;
}

function zipName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "shotlist"}-shotlist.zip`;
}

export async function packShotList(projectId: string): Promise<{
  filename: string;
  bytes: Buffer;
  document: ShotListDocument;
}> {
  const { document, files } = buildShotList(projectId);
  const json = shotListJson(document);
  const zip = new JSZip();
  zip.file(SHOTLIST_JSON, json);
  for (const [name, bytes] of Array.from(files.entries())) {
    assertExportHasNoSecrets(name);
    zip.file(name, bytes);
  }
  const packed = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { filename: zipName(document.name), bytes: packed, document };
}

export function renderSettingsOf(projectId: string): ShotRenderSettings {
  const { document, files } = buildShotList(projectId);
  const hash = (file: string) => createHash("sha256").update(files.get(file) ?? Buffer.alloc(0)).digest("hex");
  return {
    name: document.name,
    description: document.description,
    styleBase: document.styleBase,
    provider: document.provider,
    comfyuiWorkflow: document.comfyuiWorkflow,
    comfyLowMemory: document.comfyLowMemory,
    output: document.output,
    transition: document.transition,
    chainTrimStartFrames: document.chainTrimStartFrames,
    shots: document.shots.map((shot) => {
      const start = shot.images.find((image) => image.role === "start");
      const end = shot.images.find((image) => image.role === "end");
      return {
        prompt: shot.prompt,
        durationSec: shot.durationSec,
        preset: shot.preset,
        enabled: shot.enabled,
        seed: shot.seed ?? 0,
        seedPinned: shot.seedPinned,
        startSha256: start ? hash(start.file) : "",
        endSha256: end ? hash(end.file) : null,
        chainFromPrevious: shot.chainFromPrevious,
        chainFrameBack: shot.chainFrameBack,
        chainTrimStartFrames: shot.chainTrimStartFrames,
        transition: shot.transition,
        comfyuiWorkflow: shot.comfyuiWorkflow,
        comfyLowMemory: shot.comfyLowMemory,
      };
    }),
  };
}

function workflowId(title: string | null): ComfyWorkflowId | null {
  if (!title) return null;
  return comfyWorkflowIdByTitle(title);
}

export function importShotList(bundle: ShotListBundle): ShotListImport {
  const checked = validateShotList(bundle);
  if (!checked.document || checked.errors.length > 0 || checked.refused) {
    return { ok: false, errors: checked.errors, refused: checked.refused };
  }
  const doc = checked.document;
  const idsBefore = new Set(listProjects().map((project) => project.id));
  let createdId: string | undefined;
  try {
    const project = createProject(doc.name, doc.description);
    createdId = project.id;
    if (idsBefore.has(project.id)) {
      throw new Error("Import refused to reuse an existing project id.");
    }
    updateProject(project.id, {
      styleBase: doc.styleBase,
      provider: doc.provider,
      comfyuiWorkflow: workflowId(doc.comfyuiWorkflow),
      comfyLowMemory: doc.comfyLowMemory,
      seamMode: doc.transition.mode,
      seamFadeSec: doc.transition.fadeSec,
      seamFadeUnit: doc.transition.fadeUnit,
      seamFadeFrames: doc.transition.fadeFrames,
      chainTrimStartFrames: doc.chainTrimStartFrames,
      outputFps: doc.output.fps,
      outputWidth: doc.output.width,
      outputHeight: doc.output.height,
    });
    const stored = new Map<string, string>();
    const saveStill = (file: string) => {
      const ready = stored.get(file);
      if (ready) return ready;
      const bytes = fileBytes(bundle.files, file);
      if (!bytes) throw new Error(`Still "${file}" disappeared before import.`);
      const saved = saveUpload(project.id, path.posix.basename(file), bytes);
      stored.set(file, saved);
      return saved;
    };
    for (const shot of doc.shots) {
      const start = shot.images.find((image) => image.role === "start");
      const end = shot.images.find((image) => image.role === "end");
      if (!start) throw new Error("A shot lost its start still.");
      const created = createShot({
        projectId: project.id,
        prompt: shot.prompt,
        presetId: shot.preset,
        durationSec: shot.durationSec,
        startImagePath: saveStill(start.file),
        endImagePath: end ? saveStill(end.file) : undefined,
        comfyuiWorkflow: workflowId(shot.comfyuiWorkflow),
        comfyLowMemory: shot.comfyLowMemory,
        chainFromPrevious: shot.chainFromPrevious,
        chainFrameBack: shot.chainFrameBack,
      });
      updateShot(created.id, {
        enabled: shot.enabled,
        seed: shot.seed,
        seedPinned: shot.seedPinned,
        chainTrimStartFrames: shot.chainTrimStartFrames,
        seamMode: shot.transition ? shot.transition.mode : null,
        seamFadeSec: shot.transition ? shot.transition.fadeSec : null,
        seamFadeUnit: shot.transition ? shot.transition.fadeUnit : null,
        seamFadeFrames: shot.transition ? shot.transition.fadeFrames : null,
      });
    }
    const saved = getProject(project.id);
    if (!saved || idsBefore.has(saved.id)) {
      throw new Error("Import refused to overwrite an existing project.");
    }
    return { ok: true, project: saved };
  } catch (err) {
    if (createdId) deleteProject(createdId);
    const message = err instanceof Error ? err.message : "Import failed.";
    return { ok: false, errors: [message], refused: false };
  }
}

function looksLikeZip(bytes: Buffer, fileName: string): boolean {
  if (fileName.toLowerCase().endsWith(".zip")) return true;
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function looksLikeJson(bytes: Buffer, fileName: string): boolean {
  if (fileName.toLowerCase().endsWith(".json")) return true;
  const start = bytes.toString("utf8", 0, Math.min(bytes.length, 64)).replace(/^\uFEFF/, "").trim();
  return start.startsWith("{");
}

async function filesFromZip(bytes: Buffer): Promise<{ files: Map<string, Buffer>; errors: string[] }> {
  const errors: string[] = [];
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return { files: new Map(), errors: ["This is not a zip file."] };
  }
  const files = new Map<string, Buffer>();
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
  if (names.length > MAX_BUNDLE_FILES) {
    errors.push(`This zip has ${names.length} files. The limit is ${MAX_BUNDLE_FILES}.`);
    return { files, errors };
  }
  let total = 0;
  for (const name of names) {
    const rel = normalizeShotListPath(name);
    if (pathProblem(rel)) {
      errors.push(`Zip entry "${name}" must stay inside the shot list.`);
      continue;
    }
    const buf = await zip.files[name].async("nodebuffer");
    total += buf.length;
    if (total > MAX_BUNDLE_BYTES) {
      errors.push("This zip is larger than 80 MB uncompressed.");
      break;
    }
    files.set(rel, buf);
  }
  return { files, errors };
}

export async function bundleFromUpload(opts: {
  fileName: string;
  file: Buffer;
  imagesZip?: Buffer | null;
}): Promise<{ bundle: ShotListBundle | null; errors: string[] }> {
  const fileName = opts.fileName || "shotlist";
  const imagesZip = opts.imagesZip ?? null;
  if (looksLikeZip(opts.file, fileName) && !fileName.toLowerCase().endsWith(".json")) {
    if (imagesZip && imagesZip.length > 0) {
      return {
        bundle: null,
        errors: ["The zip already holds the stills. Upload that zip on its own, or upload the JSON plus a stills zip."],
      };
    }
    const loaded = await filesFromZip(opts.file);
    if (loaded.errors.length > 0) return { bundle: null, errors: loaded.errors };
    const jsonBuf = loaded.files.get(SHOTLIST_JSON);
    if (!jsonBuf) {
      return { bundle: null, errors: [`${SHOTLIST_JSON} is missing from the zip.`] };
    }
    loaded.files.delete(SHOTLIST_JSON);
    return {
      bundle: { json: jsonBuf.toString("utf8"), files: loaded.files, source: "zip" },
      errors: [],
    };
  }
  if (!looksLikeJson(opts.file, fileName)) {
    return { bundle: null, errors: ["This is not a zip and not a shot list JSON file."] };
  }
  const files = new Map<string, Buffer>();
  if (imagesZip && imagesZip.length > 0) {
    const loaded = await filesFromZip(imagesZip);
    if (loaded.errors.length > 0) return { bundle: null, errors: loaded.errors };
    loaded.files.delete(SHOTLIST_JSON);
    for (const [name, bytes] of Array.from(loaded.files.entries())) files.set(name, bytes);
  }
  return { bundle: { json: opts.file.toString("utf8"), files, source: "json" }, errors: [] };
}

function readTree(dir: string, root: string, files: Map<string, Buffer>, errors: string[]) {
  if (files.size > MAX_BUNDLE_FILES) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      readTree(abs, root, files, errors);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = normalizeShotListPath(path.relative(root, abs));
    if (rel === SHOTLIST_JSON) continue;
    if (pathProblem(rel)) {
      errors.push(`"${rel}" must stay inside the shot list.`);
      continue;
    }
    const bytes = fs.readFileSync(abs);
    files.set(rel, bytes);
  }
}

export async function loadShotListPath(filePath: string): Promise<{ bundle: ShotListBundle | null; errors: string[] }> {
  if (!fs.existsSync(filePath)) {
    return { bundle: null, errors: [`Shot list file not found: ${filePath}`] };
  }
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    const jsonPath = path.join(filePath, SHOTLIST_JSON);
    if (!fs.existsSync(jsonPath)) {
      return { bundle: null, errors: [`${SHOTLIST_JSON} is missing from ${filePath}.`] };
    }
    const files = new Map<string, Buffer>();
    const errors: string[] = [];
    readTree(filePath, filePath, files, errors);
    if (errors.length > 0) return { bundle: null, errors };
    return {
      bundle: { json: fs.readFileSync(jsonPath, "utf8"), files, source: "directory" },
      errors: [],
    };
  }
  const bytes = fs.readFileSync(filePath);
  const loaded = await bundleFromUpload({ fileName: path.basename(filePath), file: bytes });
  if (!loaded.bundle || loaded.errors.length > 0) return loaded;
  if (loaded.bundle.source === "json") {
    const root = path.dirname(filePath);
    const files = new Map<string, Buffer>();
    const errors: string[] = [];
    if (fs.existsSync(root)) readTree(root, root, files, errors);
    if (errors.length > 0) return { bundle: null, errors };
    return { bundle: { ...loaded.bundle, files }, errors: [] };
  }
  return loaded;
}
