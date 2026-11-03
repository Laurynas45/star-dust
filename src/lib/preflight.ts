/**
 * Advisory checks before a render. Nothing here blocks a job.
 * The minor-content refusal stays where it already is, before the queue.
 * Notes are hints about common failure modes, not guarantees.
 */

import { resolveComfyChoice } from "./comfy-choice";
import { evenDim, OUTPUT_DIM_MIN } from "./conform";
import {
  LTX_LOW_HEIGHT,
  LTX_LOW_WIDTH,
  LTX_MAX_HEIGHT,
  LTX_MAX_WIDTH,
} from "./ltx";
import {
  MOCK_FRAME,
  SVD_FRAME,
  SVD_LOW_FRAME,
} from "./provider-info";
import {
  AppSettings,
  ComfyWorkflowId,
  Project,
  ProviderId,
  effectivePrompt,
  presetById,
} from "./types";
import {
  WAN_FLF_LOW_MAX_HEIGHT,
  WAN_FLF_LOW_MAX_WIDTH,
  WAN_FLF_MAX_HEIGHT,
  WAN_FLF_MAX_WIDTH,
  WAN_MAX_HEIGHT,
  WAN_MAX_WIDTH,
  wanFlfFrameSize,
  wanFrameSize,
} from "./wan";

export const PREFLIGHT_HONESTY =
  "These are hints about common failure modes. They do not block a render, and they do not guarantee that a clip will fail or succeed. Star Dust does not lock a character, lip-sync, or turn the shot list into a long film.";

const HINT = "This is a hint, not a guarantee.";

/** A still this much smaller than the working frame is worth a note. */
const SCALE_SLACK = 1.02;

export type PreflightCode =
  | "still-small"
  | "aspect"
  | "divisible-16"
  | "orbit"
  | "fast-action"
  | "hands"
  | "moving-text"
  | "several-actions"
  | "chain-camera"
  | "chain-shot-size";

export type PreflightNote = {
  id: string;
  code: PreflightCode;
  /** Shot the note is about. A boundary note uses the later shot. */
  shotId: string;
  shotPosition: number;
  /** Boundary notes are about the shot list. The rest are about one shot. */
  scope: "shot" | "list";
  note: string;
  reason: string;
  fix: string;
};

export type PreflightShotInput = {
  id: string;
  position: number;
  prompt: string;
  presetId: string;
  chainFromPrevious: boolean;
  comfyuiWorkflow?: ComfyWorkflowId | null;
  comfyLowMemory?: boolean | null;
  /** Pixel size of the still that will be sent. Null when it is not known yet. */
  width: number | null;
  height: number | null;
};

export type PreflightInput = {
  styleBase: string;
  provider: ProviderId;
  outputWidth: number | null;
  outputHeight: number | null;
  settings: Pick<AppSettings, "comfyuiWorkflow" | "comfyLowMemory">;
  project: Pick<Project, "comfyuiWorkflow" | "comfyLowMemory">;
  shots: readonly PreflightShotInput[];
};

export type PreflightShotReport = {
  shotId: string;
  position: number;
  notes: PreflightNote[];
};

export type PreflightReport = {
  honesty: string;
  notes: PreflightNote[];
  shots: PreflightShotReport[];
  /** Notes that compare neighbouring shots. */
  list: PreflightNote[];
};

type Phrase = { id: string; label: string };

type Pattern = { id: string; re: RegExp };

type WorkingFrame = {
  width: number;
  height: number;
  mode: "crop" | "fit";
  /** "Mock writes 1280×720" */
  writes: string;
  /** "Mock's frame" */
  name: string;
  workflow: ComfyWorkflowId | null;
  lowMemory: boolean;
};

const CODE_ORDER: PreflightCode[] = [
  "still-small",
  "aspect",
  "divisible-16",
  "orbit",
  "fast-action",
  "hands",
  "moving-text",
  "several-actions",
  "chain-camera",
  "chain-shot-size",
];

const PRESET_CAMERA: Record<string, string> = {
  "slow-zoom-in": "push-in",
  "slow-zoom-out": "pull-out",
  "pan-right": "pan-right",
  "dramatic-push": "push-in",
};

/** Longer phrases first so "medium close-up" is not also read as "close-up". */
const SHOT_SIZE_PATTERNS: Pattern[] = [
  { id: "ews", re: /\b(extreme wide shots?|extreme long shots?|ews)\b/i },
  { id: "ecu", re: /\b(extreme close-?ups?|extreme close\s+ups?|ecu)\b/i },
  { id: "mcu", re: /\b(medium close-?ups?|medium close\s+ups?|mcu)\b/i },
  { id: "mws", re: /\b(medium wide shots?|medium-wide shots?|mws)\b/i },
  { id: "cu", re: /\b(close-?ups?|close\s+ups?|closeups?|cu)\b/i },
  { id: "ws", re: /\b(wide shots?|long shots?|establishing shots?|full shots?|ws)\b/i },
  { id: "ms", re: /\b(medium shots?|ms)\b/i },
];

const CAMERA_PATTERNS: Pattern[] = [
  { id: "flythrough", re: /\b(fly[\s-]?throughs?|fly[\s-]?arounds?|fly[\s-]?overs?|fpv)\b/i },
  { id: "orbit", re: /\b(orbits?|orbiting|circl(?:e|es|ing)\s+around|360(?:\s*°|\s*-?\s*degrees?|\s+spins?))\b/i },
  { id: "crane", re: /\b(crane shot|jib shot|camera crane)\b/i },
  { id: "push-in", re: /\b(push(?:es|ing)?[\s-]?in|push(?:es|ing)? toward|dolly(?:ing)? in|zoom(?:s|ing)? in)\b/i },
  { id: "pull-out", re: /\b(pull(?:s|ing)? back|pull(?:s|ing)? out|dolly(?:ing)? out|zoom(?:s|ing)? out)\b/i },
  { id: "pan-left", re: /\b((?:pan|truck|drift|slide)(?:s|ing)? left)\b/i },
  { id: "pan-right", re: /\b((?:pan|truck|drift|slide)(?:s|ing)? right)\b/i },
  { id: "tilt-up", re: /\b(tilt(?:s|ing)? up)\b/i },
  { id: "tilt-down", re: /\b(tilt(?:s|ing)? down)\b/i },
  { id: "handheld", re: /\b(handheld|hand-held|shaky cam)\b/i },
  { id: "static", re: /\b(static camera|locked-?off|lock-?off|no camera move)\b/i },
  { id: "dutch", re: /\b(dutch angle)\b/i },
];

const FAST_ACTION =
  /\b(fights?|fighting|brawls?|brawling|combat|punches|punching|punch|kicks|kicking|kick|sword[\s-]?fights?|explosions?|explodes?|exploding|parkour|sprinting|fast[\s-]?action|high[\s-]speed)\b/i;

const HAND = /\b(hands?|fingers?|fingertips?|fists?)\b/i;
const CLOSE = /\b(close-?ups?|close\s+ups?|closeups?|macros?|extreme close)\b/i;

const TEXT_PATTERNS: RegExp[] = [
  /\b((?:moving|animated|scrolling|morphing|spinning)\s+(?:text|logos?|titles?|lettering|words|typography))\b/i,
  /\b((?:text|logos?|titles?|lettering|typography)\s+(?:that\s+)?(?:moves?|moving|animates?|animated|scrolls?|scrolling|morphs?|morphing|spins?|spinning))\b/i,
  /\b(kinetic\s+type|title\s+sequence|logo\s+animation)\b/i,
];

const NAMED_ASPECTS: { ratio: number; label: string }[] = [
  { ratio: 16 / 9, label: "16:9" },
  { ratio: 9 / 16, label: "9:16" },
  { ratio: 1, label: "1:1" },
  { ratio: 4 / 3, label: "4:3" },
  { ratio: 3 / 4, label: "3:4" },
  { ratio: 21 / 9, label: "21:9" },
  { ratio: 4 / 5, label: "4:5" },
  { ratio: 3 / 2, label: "3:2" },
  { ratio: 2 / 3, label: "2:3" },
];

export function isWanLike(provider: ProviderId, workflow: ComfyWorkflowId | null): boolean {
  return provider === "comfyui" && (workflow === "wan" || workflow === "wan-flf");
}

export function formatPreflight(report: PreflightReport): string {
  const lines = ["Preflight", report.honesty];
  if (report.notes.length === 0) {
    lines.push("Preflight: no notes.");
    return lines.join("\n");
  }
  const count = report.notes.length;
  lines.push(`Preflight: ${count} ${count === 1 ? "note" : "notes"}.`);
  for (const note of report.notes) {
    lines.push(`- ${note.note}`);
    lines.push(`  Reason: ${note.reason}`);
    lines.push(`  Fix: ${note.fix}`);
  }
  return lines.join("\n");
}

export function buildPreflight(input: PreflightInput): PreflightReport {
  const ordered = [...input.shots].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const projectFrame = projectOutput(input.outputWidth, input.outputHeight);
  const draft: PreflightNote[] = [];

  for (const shot of ordered) {
    const frame = workingFrame(input, shot);
    const seen = stillOf(shot);
    if (seen && frame) draft.push(...sizeNotes(shot, seen, frame));
    if (projectFrame) draft.push(...projectNotes(input.provider, shot, seen, frame, projectFrame));
    if (seen && frame && isWanLike(input.provider, frame.workflow)) {
      const divisible = divisibleNote(shot, seen, frame);
      if (divisible) draft.push(divisible);
    }
    draft.push(...promptNotes(shot, effectivePrompt(input.styleBase, shot.prompt)));
  }

  for (let index = 1; index < ordered.length; index += 1) {
    const shot = ordered[index];
    if (!shot.chainFromPrevious) continue;
    draft.push(...boundaryNotes(input.styleBase, ordered[index - 1], shot));
  }

  const notes = draft
    .sort((a, b) => {
      if (a.shotPosition !== b.shotPosition) return a.shotPosition - b.shotPosition;
      return CODE_ORDER.indexOf(a.code) - CODE_ORDER.indexOf(b.code);
    })
    .map((note, index) => ({ ...note, id: `${note.code}:${note.shotId}:${index}` }));

  return {
    honesty: PREFLIGHT_HONESTY,
    notes,
    shots: ordered.map((shot) => ({
      shotId: shot.id,
      position: shot.position,
      notes: notes.filter((note) => note.shotId === shot.id),
    })),
    list: notes.filter((note) => note.scope === "list"),
  };
}

function projectOutput(
  width: number | null,
  height: number | null
): { width: number; height: number } | null {
  if (width == null || height == null) return null;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  return {
    width: evenDim(width, OUTPUT_DIM_MIN),
    height: evenDim(height, OUTPUT_DIM_MIN),
  };
}

function stillOf(shot: PreflightShotInput): { width: number; height: number } | null {
  if (shot.width == null || shot.height == null) return null;
  if (!Number.isFinite(shot.width) || !Number.isFinite(shot.height)) return null;
  if (shot.width < 1 || shot.height < 1) return null;
  return { width: shot.width, height: shot.height };
}

function workingFrame(input: PreflightInput, shot: PreflightShotInput): WorkingFrame | null {
  if (input.provider === "mock") {
    return {
      width: MOCK_FRAME.width,
      height: MOCK_FRAME.height,
      mode: "crop",
      writes: `Mock writes ${MOCK_FRAME.width}×${MOCK_FRAME.height}`,
      name: "Mock's frame",
      workflow: null,
      lowMemory: false,
    };
  }
  if (input.provider !== "comfyui") return null;
  const choice = resolveComfyChoice({ settings: input.settings, project: input.project, shot });
  if (choice.workflow === "svd") {
    const frame = choice.lowMemory ? SVD_LOW_FRAME : SVD_FRAME;
    const name = choice.lowMemory ? "the shipped SVD low-memory frame" : "the shipped SVD frame";
    return {
      width: frame.width,
      height: frame.height,
      mode: "crop",
      writes: `The shipped SVD graph uses ${frame.width}×${frame.height}`,
      name,
      workflow: "svd",
      lowMemory: choice.lowMemory,
    };
  }
  if (choice.workflow === "wan") {
    return {
      width: WAN_MAX_WIDTH,
      height: WAN_MAX_HEIGHT,
      mode: "fit",
      writes: `The Wan 2.2 graph fits the still inside ${WAN_MAX_WIDTH}×${WAN_MAX_HEIGHT}`,
      name: "the Wan 2.2 box",
      workflow: "wan",
      lowMemory: choice.lowMemory,
    };
  }
  if (choice.workflow === "wan-flf") {
    const width = choice.lowMemory ? WAN_FLF_LOW_MAX_WIDTH : WAN_FLF_MAX_WIDTH;
    const height = choice.lowMemory ? WAN_FLF_LOW_MAX_HEIGHT : WAN_FLF_MAX_HEIGHT;
    const name = choice.lowMemory ? "the Wan 2.2 first-last low-memory box" : "the Wan 2.2 first-last box";
    return {
      width,
      height,
      mode: "fit",
      writes: `The Wan 2.2 first-last graph fits the still inside ${width}×${height}`,
      name,
      workflow: "wan-flf",
      lowMemory: choice.lowMemory,
    };
  }
  const width = choice.lowMemory ? LTX_LOW_WIDTH : LTX_MAX_WIDTH;
  const height = choice.lowMemory ? LTX_LOW_HEIGHT : LTX_MAX_HEIGHT;
  const name = choice.lowMemory ? "the LTX-2.3 low-memory box" : "the LTX-2.3 box";
  return {
    width,
    height,
    mode: "fit",
    writes: `The LTX-2.3 graph fits the still inside ${width}×${height}`,
    name,
    workflow: "ltx",
    lowMemory: choice.lowMemory,
  };
}

function sizeNotes(
  shot: PreflightShotInput,
  still: { width: number; height: number },
  frame: WorkingFrame
): PreflightNote[] {
  const notes: PreflightNote[] = [];
  const size = px(still.width, still.height);
  const box = px(frame.width, frame.height);
  if (frame.mode === "crop") {
    const scale = Math.max(frame.width / still.width, frame.height / still.height);
    if (scale > SCALE_SLACK) {
      notes.push(
        shotNote(shot, "still-small", {
          note: `Shot ${shot.position}: the still is ${size}. ${frame.writes}.`,
          reason: `A still smaller than the working size is scaled up to fill that frame. That often looks soft. ${HINT}`,
          fix: `Export the still at ${box} or larger before you render.`,
        })
      );
    }
    if (cropCuts(still.width, still.height, frame.width, frame.height)) {
      notes.push(
        shotNote(shot, "aspect", {
          note: `Shot ${shot.position}: the still is ${size} (${aspectLabel(still.width, still.height)}) and ${frame.name} is ${box} (${aspectLabel(frame.width, frame.height)}). The still is cropped to fill that frame.`,
          reason: `A different aspect is cropped to fill the working frame, so the edges of the still are cut off. ${HINT}`,
          fix: `Crop the still to ${aspectLabel(frame.width, frame.height)}, with the subject inside the frame, before you render.`,
        })
      );
    }
    return notes;
  }
  const underWidth = still.width < frame.width * 0.98;
  const underHeight = still.height < frame.height * 0.98;
  if (underWidth && underHeight) {
    notes.push(
      shotNote(shot, "still-small", {
        note: `Shot ${shot.position}: the still is ${size}. ${frame.name} is ${box}.`,
        reason: `A still smaller than the working size often looks soft once the clip is scaled up. The shipped graph fits the still inside that box and does not enlarge it. ${HINT}`,
        fix: `Export the still at ${box} or larger before you render.`,
      })
    );
  }
  return notes;
}

function projectNotes(
  provider: ProviderId,
  shot: PreflightShotInput,
  still: { width: number; height: number } | null,
  frame: WorkingFrame | null,
  projectFrame: { width: number; height: number }
): PreflightNote[] {
  const notes: PreflightNote[] = [];
  const projectSize = px(projectFrame.width, projectFrame.height);
  const clip =
    frame?.mode === "crop"
      ? { width: frame.width, height: frame.height, lead: frame.writes }
      : still
        ? { width: still.width, height: still.height, lead: `The still is ${px(still.width, still.height)}` }
        : null;
  if (clip && aspectsDiffer(clip.width, clip.height, projectFrame.width, projectFrame.height)) {
    const cloud =
      provider === "fal" || provider === "replicate"
        ? " A cloud model may also crop to its own frame before that."
        : "";
    notes.push(
      shotNote(shot, "aspect", {
        note: `Shot ${shot.position}: ${clip.lead}, and the project output is ${projectSize}. Those aspects do not match.`,
        reason: `The stitch pads a clip that does not match the project aspect. It does not stretch the picture, so bars are a common result.${cloud} ${HINT}`,
        fix: `Match the project output to the clip's aspect, or export the still so the clip already matches ${projectSize}.`,
      })
    );
  }
  if (!still || frame?.mode === "crop") return notes;
  const contain = Math.min(projectFrame.width / still.width, projectFrame.height / still.height);
  const alreadySmall = frame?.mode === "fit" && still.width < frame.width * 0.98 && still.height < frame.height * 0.98;
  if (contain > SCALE_SLACK && !alreadySmall) {
    const cloud =
      provider === "fal" || provider === "replicate"
        ? " Star Dust does not know this cloud model's own frame size, so this check uses the project output."
        : "";
    notes.push(
      shotNote(shot, "still-small", {
        note: `Shot ${shot.position}: the still is ${px(still.width, still.height)}. The project output is ${projectSize}.`,
        reason: `A still smaller than the project output is scaled up when the stitch conforms the clip. That often looks soft.${cloud} ${HINT}`,
        fix: `Export the still at ${projectSize} or larger, at the same aspect, before you render.`,
      })
    );
  }
  return notes;
}

function divisibleNote(
  shot: PreflightShotInput,
  still: { width: number; height: number },
  frame: WorkingFrame
): PreflightNote | null {
  const bad: string[] = [];
  if (still.width % 16 !== 0) bad.push(`width ${still.width}`);
  if (still.height % 16 !== 0) bad.push(`height ${still.height}`);
  if (bad.length === 0) return null;
  const snapped =
    frame.workflow === "wan-flf"
      ? wanFlfFrameSize(still.width, still.height, frame.lowMemory)
      : wanFrameSize(still.width, still.height);
  const which = bad.length === 1 ? `The ${bad[0]} is not divisible by 16.` : `The ${bad[0]} and the ${bad[1]} are not divisible by 16.`;
  const snap =
    snapped.width === still.width && snapped.height === still.height
      ? "The shipped Wan graph writes this size."
      : `The shipped Wan graph snaps the size it writes to a multiple of 32 (${px(snapped.width, snapped.height)} from this still). That snap can shift the frame.`;
  return shotNote(shot, "divisible-16", {
    note: `Shot ${shot.position}: the still is ${px(still.width, still.height)}. ${which}`,
    reason: `Wan and VACE-style workflows often crop or reject a size that is not a multiple of 16. ${snap} This does not mean the job will fail. ${HINT}`,
    fix: "Resize the still so the width and the height are both multiples of 16 before you render.",
  });
}

function promptNotes(shot: PreflightShotInput, prompt: string): PreflightNote[] {
  const notes: PreflightNote[] = [];
  const cameras = matchPatterns(prompt, CAMERA_PATTERNS);
  const risky = cameras.filter((item) => item.id === "orbit" || item.id === "flythrough");
  if (risky.length > 0) {
    notes.push(
      shotNote(shot, "orbit", {
        note: `Shot ${shot.position}: the prompt asks for an orbit or a fly-through (${risky.map((item) => quote(item.label)).join(" and ")}).`,
        reason: `Orbit and fly-through camera moves are a known weak spot for image-to-video. The clip often slides or warps. ${HINT}`,
        fix: "Ask for a slow push, a gentle pan, or a locked camera, and keep the move to one direction.",
      })
    );
  }
  const actionText = prompt.replace(/\bpunch[\s-]?ins?\b/gi, " ");
  const action = FAST_ACTION.exec(actionText);
  if (action) {
    notes.push(
      shotNote(shot, "fast-action", {
        note: `Shot ${shot.position}: the prompt asks for fast action or a fight (${quote(action[1] ?? action[0])}).`,
        reason: `Fights, punches, and other fast action are a known weak spot. Limbs and props often smear. ${HINT}`,
        fix: "Split the moment into one slower beat, or describe the pose before and after the impact.",
      })
    );
  }
  const hands = prompt.replace(/\bhand-?held\b/gi, " ");
  if (HAND.test(hands) && CLOSE.test(hands)) {
    notes.push(
      shotNote(shot, "hands", {
        note: `Shot ${shot.position}: the prompt asks for hands in close-up.`,
        reason: `Hands and fingers in close-up are a known weak spot. Extra fingers are common. ${HINT}`,
        fix: "Keep the hands small in a wider frame, or leave them out of the close-up.",
      })
    );
  }
  const moving = movingText(prompt);
  if (moving) {
    notes.push(
      shotNote(shot, "moving-text", {
        note: `Shot ${shot.position}: the prompt asks for moving text or a logo (${quote(moving)}).`,
        reason: `Moving text, titles, and logos are a known weak spot. Letters usually warp. ${HINT}`,
        fix: "Leave the text out of the clip and add it in the edit.",
      })
    );
  }
  if (asksForSeveralActions(prompt)) {
    notes.push(
      shotNote(shot, "several-actions", {
        note: `Shot ${shot.position}: the prompt asks for more than one action.`,
        reason: `A shot that asks for several actions often swaps a prop or skips a beat in the middle of the clip. ${HINT}`,
        fix: "Keep one action in this shot. Put the next action in the next shot.",
      })
    );
  }
  return notes;
}

function boundaryNotes(styleBase: string, prev: PreflightShotInput, shot: PreflightShotInput): PreflightNote[] {
  const notes: PreflightNote[] = [];
  const prevText = effectivePrompt(styleBase, prev.prompt);
  const nextText = effectivePrompt(styleBase, shot.prompt);
  if (cameraKey(prevText, prev.presetId) !== cameraKey(nextText, shot.presetId)) {
    notes.push(
      listNote(shot, "chain-camera", {
        note: `Shot ${shot.position} starts from shot ${prev.position}'s last frame, but the camera language does not match (shot ${prev.position}: ${cameraWords(prevText, prev.presetId)}, shot ${shot.position}: ${cameraWords(nextText, shot.presetId)}).`,
        reason: `A different camera phrase across a chained boundary often looks like a jump, because the next clip starts on the previous frame. ${HINT}`,
        fix: 'Use the same camera wording on both shots, or turn off "Start from previous shot\'s last frame".',
      })
    );
  }
  const prevSizes = matchPatterns(prevText, SHOT_SIZE_PATTERNS);
  const nextSizes = matchPatterns(nextText, SHOT_SIZE_PATTERNS);
  if (prevSizes.length > 0 && nextSizes.length > 0 && phraseKey(prevSizes) !== phraseKey(nextSizes)) {
    notes.push(
      listNote(shot, "chain-shot-size", {
        note: `Shot ${shot.position} starts from shot ${prev.position}'s last frame, but the shot size does not match (shot ${prev.position}: ${sizeWords(prevSizes)}, shot ${shot.position}: ${sizeWords(nextSizes)}).`,
        reason: `A different shot size across a chained boundary often looks like a camera jump, because the next clip starts on the previous frame. ${HINT}`,
        fix: 'Use the same shot size on both shots, or turn off "Start from previous shot\'s last frame".',
      })
    );
  }
  return notes;
}

function shotNote(
  shot: PreflightShotInput,
  code: PreflightCode,
  text: { note: string; reason: string; fix: string }
): PreflightNote {
  return {
    id: code,
    code,
    shotId: shot.id,
    shotPosition: shot.position,
    scope: "shot",
    ...text,
  };
}

function listNote(
  shot: PreflightShotInput,
  code: PreflightCode,
  text: { note: string; reason: string; fix: string }
): PreflightNote {
  return { ...shotNote(shot, code, text), scope: "list" };
}

function cropCuts(srcW: number, srcH: number, dstW: number, dstH: number): boolean {
  const scale = Math.max(dstW / srcW, dstH / srcH);
  return srcW * scale - dstW > 2 || srcH * scale - dstH > 2;
}

function aspectsDiffer(aW: number, aH: number, bW: number, bH: number): boolean {
  const left = aW / aH;
  const right = bW / bH;
  return Math.abs(left - right) / right > 0.02;
}

function aspectLabel(width: number, height: number): string {
  const ratio = width / height;
  for (const named of NAMED_ASPECTS) {
    if (Math.abs(ratio - named.ratio) / named.ratio <= 0.02) return named.label;
  }
  return px(width, height);
}

function px(width: number, height: number): string {
  return `${width}×${height}`;
}

function quote(label: string): string {
  return `"${label.replace(/\s+/g, " ").trim().slice(0, 48)}"`;
}

function matchPatterns(text: string, patterns: readonly Pattern[]): Phrase[] {
  const found: Phrase[] = [];
  let rest = text;
  for (const pattern of patterns) {
    const match = pattern.re.exec(rest);
    if (!match || match.index == null) continue;
    const label = (match[1] ?? match[0]).replace(/\s+/g, " ").trim();
    if (!found.some((item) => item.id === pattern.id)) found.push({ id: pattern.id, label });
    const start = match.index;
    rest = rest.slice(0, start) + " ".repeat(match[0].length) + rest.slice(start + match[0].length);
  }
  return found;
}

function phraseKey(phrases: readonly Phrase[]): string {
  return Array.from(new Set(phrases.map((item) => item.id))).sort().join("+");
}

function cameraKey(prompt: string, presetId: string): string {
  const found = matchPatterns(prompt, CAMERA_PATTERNS);
  if (found.length > 0) return phraseKey(found);
  return PRESET_CAMERA[presetById(presetId).id] ?? "push-in";
}

function cameraWords(prompt: string, presetId: string): string {
  const found = matchPatterns(prompt, CAMERA_PATTERNS);
  if (found.length > 0) return found.map((item) => quote(item.label)).join(" and ");
  return `the ${presetById(presetId).label} preset`;
}

function sizeWords(phrases: readonly Phrase[]): string {
  return phrases.map((item) => quote(item.label)).join(" and ");
}

function movingText(prompt: string): string | null {
  for (const pattern of TEXT_PATTERNS) {
    const match = pattern.exec(prompt);
    if (match) return (match[1] ?? match[0]).replace(/\s+/g, " ").trim();
  }
  return null;
}

function asksForSeveralActions(prompt: string): boolean {
  const parts = prompt
    .split(/\bthen\b|;|\.\s+(?=[A-Z])/)
    .map((part) => part.replace(/^[\s,]+|[\s,.!?]+$/g, ""))
    .filter((part) => /[a-z]/i.test(part));
  return parts.length >= 2;
}
