import { createHash, randomInt } from "crypto";
import fs from "fs";
import { completedTakesFor, cutTake } from "./chain-stale";
import { resolveComfyChoice } from "./comfy-choice";
import { modelNameFor } from "./provider-info";
import { resolveChainTrimStartFrames } from "./stitch";
import { getProject, getSettings, listJobs, listShots, resolveDataPath } from "./storage";
import {
  Project,
  Shot,
  clampChainFrameBack,
  effectivePrompt,
} from "./types";

/**
 * Identity of one clip.
 * The same key means the same inputs, so a finished clip can be loaded again
 * instead of rendering. It does not promise identical pixels from another backend.
 */
export type ClipKeyParts = {
  image: string;
  endImage: string;
  prompt: string;
  seed: number;
  provider: string;
  model: string;
  workflow: string;
  lowMemory: boolean;
  preset: string;
  durationSec: number;
  startFrameTrim: number | null;
  upstreamKey: string;
};

export function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed)) return 0;
  return Math.floor(Math.abs(seed)) % 1_000_000_000;
}

/** Stable seed for a shot that has never had one stored. */
export function derivedSeed(shotId: string): number {
  const digest = createHash("sha256").update(`star-dust-seed:v1:${shotId}`).digest();
  return digest.readUInt32BE(0) % 1_000_000_000;
}

export function effectiveSeed(shot: Pick<Shot, "id" | "seed">): number {
  if (shot.seed != null && Number.isFinite(shot.seed)) return normalizeSeed(shot.seed);
  return derivedSeed(shot.id);
}

export function freshSeed(avoid: readonly number[]): number {
  const banned = new Set(avoid.map((value) => normalizeSeed(value)));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const seed = randomInt(0, 1_000_000_000);
    if (!banned.has(seed)) return seed;
  }
  return normalizeSeed((avoid[0] ?? 0) + 1 + randomInt(0, 1000));
}

export function buildInputKey(parts: ClipKeyParts): string {
  const canonical = {
    v: 1,
    image: parts.image,
    endImage: parts.endImage,
    prompt: parts.prompt,
    seed: parts.seed,
    provider: parts.provider,
    model: parts.model,
    workflow: parts.workflow,
    lowMemory: parts.lowMemory,
    preset: parts.preset,
    durationSec: parts.durationSec,
    startFrameTrim: parts.startFrameTrim,
    upstreamKey: parts.upstreamKey,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Trim that actually changes this clip's join.
 * Unchained shots, crossfades, and stepped-back chains do not use it, so a
 * project trim edit does not change their key.
 */
export function applicableStartFrameTrim(
  project: Pick<Project, "seamMode" | "chainTrimStartFrames" | "dropDuplicateFrame">,
  shot: Pick<
    Shot,
    | "chainFromPrevious"
    | "seamMode"
    | "chainFrameBack"
    | "chainTrimStartFrames"
    | "dropDuplicateFrame"
  >
): number | null {
  if (!shot.chainFromPrevious) return null;
  const seam = shot.seamMode ?? project.seamMode ?? "cut";
  if (seam !== "cut") return null;
  if (clampChainFrameBack(shot.chainFrameBack ?? 0) !== 0) return null;
  return resolveChainTrimStartFrames(project, shot);
}

function fileToken(relativePath: string | undefined): string {
  if (!relativePath) return "";
  try {
    const abs = resolveDataPath(relativePath);
    if (!fs.existsSync(abs)) return `missing:${relativePath}`;
    return createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  } catch {
    return `missing:${relativePath}`;
  }
}

function sourceToken(shot: Shot, upstreamKey: string): string {
  if (shot.chainFromPrevious) {
    const back = clampChainFrameBack(shot.chainFrameBack ?? 0);
    return `chain:${upstreamKey}:back:${back}`;
  }
  return fileToken(shot.startImagePath) || "missing-start";
}

function previousShotOf(shot: Shot): Shot | undefined {
  const shots = listShots(shot.projectId);
  const index = shots.findIndex((item) => item.id === shot.id);
  if (index <= 0) return undefined;
  return shots[index - 1];
}

/** Key of the take currently in the cut, for a chained shot's upstream. */
export function upstreamCutKey(shot: Shot): string {
  if (!shot.chainFromPrevious) return "";
  const prev = previousShotOf(shot);
  if (!prev) return "";
  const takes = completedTakesFor(listJobs(shot.projectId), prev.id);
  const cut = cutTake(prev.selectedJobId, takes, prev.approvedJobId);
  if (!cut) return "";
  if (cut.inputKey) return cut.inputKey;
  return buildInputKey({
    image: fileToken(cut.imagePath) || "missing-start",
    endImage: fileToken(cut.endImagePath),
    prompt: cut.prompt,
    seed: cut.seed != null && Number.isFinite(cut.seed) ? normalizeSeed(cut.seed) : derivedSeed(prev.id),
    provider: cut.provider,
    model: cut.modelName ?? "",
    workflow: "",
    lowMemory: false,
    preset: cut.presetId,
    durationSec: Number(cut.durationSec) || 0,
    startFrameTrim: null,
    upstreamKey: "",
  });
}

function clipParts(shot: Shot, seed: number, upstreamKey: string): ClipKeyParts {
  const project = getProject(shot.projectId);
  const settings = getSettings();
  const provider = settings.provider;
  const comfy =
    provider === "comfyui" ? resolveComfyChoice({ settings, project, shot }) : undefined;
  return {
    image: sourceToken(shot, upstreamKey),
    endImage: fileToken(shot.endImagePath),
    prompt: effectivePrompt(project?.styleBase, shot.prompt),
    seed: normalizeSeed(seed),
    provider,
    model: modelNameFor(provider, settings, comfy),
    workflow: comfy?.workflow ?? "",
    lowMemory: Boolean(comfy?.lowMemory),
    preset: shot.presetId,
    durationSec: Number(shot.durationSec) || 0,
    startFrameTrim: project ? applicableStartFrameTrim(project, shot) : null,
    upstreamKey: shot.chainFromPrevious ? upstreamKey : "",
  };
}

/** Key of a render from this shot's current seed and the cut upstream, unless overridden. */
export function desiredClipKey(shot: Shot, upstreamOverride?: string): string {
  const upstream = shot.chainFromPrevious ? (upstreamOverride ?? upstreamCutKey(shot)) : "";
  return buildInputKey(clipParts(shot, effectiveSeed(shot), upstream));
}

/** Same inputs, with one explicit seed. Used by Try seeds. */
export function clipKeyForSeed(shot: Shot, seed: number, upstreamOverride?: string): string {
  const upstream = shot.chainFromPrevious ? (upstreamOverride ?? upstreamCutKey(shot)) : "";
  return buildInputKey(clipParts(shot, seed, upstream));
}
