/**
 * After a backend writes a clip, read it with ffmpeg signalstats.
 *
 * Black: a frame counts only when it is a flat field at black level.
 * Limited-range black sits at luma 16. Average luma at most 18 and brightest
 * luma at most 20. A dark picture with any highlight stays unflagged.
 * The clip is flagged when at least 95% of frames are that flat black.
 * A one-second fade on a four-second shot is about 25% and is not flagged.
 *
 * A long flat-black run uses that same frame. The bar is the smaller of
 * 0.5 seconds and 12 frames, at this clip's frame rate. At 24 fps those are
 * both 12 frames. At a lower rate, 0.5 seconds is fewer frames and is the bar.
 * At a higher rate, 12 frames is the shorter time and is the bar. A clip
 * shorter than that bar is not judged here. A run that meets the bar at the
 * start is a black opening. The same length at the end, or in the middle, is
 * flagged too. The note gives the length in seconds and in frames. A fade
 * from black of 0.5 seconds or less is not a flat field for that whole time,
 * so it stays under the bar. A one-second fade-in on a dark scene with a
 * highlight is not flat black. When at least 95% of frames are flat black,
 * that flag stands alone and the run is not named again.
 *
 * The check does not trim the file and does not render the shot again.
 * On a chained hard cut, start-frame trim can already drop 0–4 frames at the
 * start of the next clip. The note says so when the run is an opening. It
 * does not apply that trim.
 *
 * Motion: signalstats YDIF is the mean absolute luma change from the previous
 * frame (0–255). The first frame is ignored. With at least 4 frames, the clip
 * is flagged when the mean of the rest is at most 0.02 and the largest jump is
 * at most 0.04. That is encoder noise on a still. A slow pan of the Harbor
 * still measured about 0.06 mean and 0.4 max, so it is not flagged.
 *
 * A file ffmpeg cannot read is not flagged. The render still completes.
 * Mock clips are inspected and not flagged when CI is "true" or "1", so the
 * Mock suite (including a flat-color Ken Burns) is not marked broken.
 */

import { spawnSync } from "child_process";
import { comfyWorkflowFromModelName } from "./provider-info";
import { getJob, resolveDataPath, updateJob } from "./storage";
import {
  BlackRun,
  ClipCheck,
  DEFAULT_CHAIN_TRIM_START_FRAMES,
  MAX_CHAIN_TRIM_START_FRAMES,
  ProviderId,
} from "./types";

/** Limited-range black is 16. This sits just above it. */
export const BLACK_YAVG_MAX = 18;
/** Brightest pixel. A highlight above this is a picture, not a black frame. */
export const BLACK_YMAX_MAX = 20;
/** Share of frames that must be flat black. */
export const BLACK_FRAME_FRACTION = 0.95;
/**
 * A flat-black run at least this long is flagged.
 * The bar is the smaller of this and BLACK_RUN_MIN_FRAMES.
 */
export const BLACK_RUN_MIN_SEC = 0.5;
/** A flat-black run at least this many frames is flagged, when that is shorter than 0.5 seconds. */
export const BLACK_RUN_MIN_FRAMES = 12;
/** Mean YDIF at or below this is encoder noise, not a slow move. */
export const FROZEN_MEAN_YDIF_MAX = 0.02;
/** No single frame-to-frame jump above this. */
export const FROZEN_MAX_YDIF_MAX = 0.04;
/** Shorter clips are not judged for motion. */
export const FROZEN_MIN_FRAMES = 4;

/**
 * Reported causes of an all-black Wan 2.2 clip, in the order to try them.
 * Shown for a flagged ComfyUI clip that is all black, nearly all black, or
 * still. Not a promise that one of them is this file. A black opening does
 * not use this list.
 */
export const COMFY_BLACK_FRAME_HINTS = [
  "ComfyUI was started with --use-sage-attention or --fast fp16_accumulation. Those flags are a reported cause of an all-black Wan clip. Start ComfyUI without them and render this shot again.",
  "The VAE is running in fp16. Start ComfyUI with --fp32-vae and render this shot again.",
  "The VAE file does not match the Wan model. Wan 2.2 5B needs wan2.2_vae. Wan 2.2 14B uses wan_2.1_vae. Pair the VAE with the model and render this shot again.",
  "The graph uses VAE Decode (Tiled) on Wan. Use VAE Decode and render this shot again.",
] as const;

/**
 * One possible cause of a black opening on ComfyUI LTX-2.3 or LTX-2.5.
 * Not a certainty, and not a claim about any other backend.
 */
export const LTX_BLACK_OPENING_NOTE =
  "ComfyUI 0.44.x has a reported LTX image-to-video regression: the first frames can be black, then the picture looks normal (Comfy-Org/ComfyUI issue 17618). That is one possible cause of this opening, not a certainty.";

export type FrameLuma = {
  yavg: number;
  ymax: number;
  ydif: number;
};

export function mockClipFlagsSuppressed(): boolean {
  const ci = (process.env.CI ?? "").trim().toLowerCase();
  return ci === "true" || ci === "1";
}

export function emptyClipCheck(): ClipCheck {
  return {
    flagged: false,
    black: false,
    frozen: false,
    status: "",
    hints: [],
    includeAnyway: false,
    frames: 0,
    blackFraction: 0,
    meanMotion: null,
    blackRuns: [],
  };
}

/** True when Export stitch should leave this clip out. */
export function clipHeldFromStitch(job: { clipCheck?: ClipCheck | null } | null | undefined): boolean {
  return Boolean(job?.clipCheck?.flagged && !job.clipCheck.includeAnyway);
}

/** Seconds and frames, for a note or a manifest label. */
export function formatBlackRunLength(run: Pick<BlackRun, "frames" | "sec">): string {
  const frames = `${run.frames} frame${run.frames === 1 ? "" : "s"}`;
  if (run.sec == null || !Number.isFinite(run.sec)) return frames;
  const rounded = Math.round(run.sec * 100) / 100;
  const text = rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `${text} s (${frames})`;
}

export function clipFlagLabel(check: ClipCheck): string {
  const black = check.black ? (check.blackFraction >= 0.999 ? "all black" : "nearly all black") : null;
  const runs = (check.blackRuns ?? []).map((run) => {
    const opening = run.startFrame === 0;
    const ending = check.frames > 0 && run.startFrame + run.frames >= check.frames;
    const place = opening ? "black opening" : ending ? "black ending" : "black run";
    const at = place === "black run" ? ` at frame ${run.startFrame + 1}` : "";
    return `${place} ${formatBlackRunLength(run)}${at}`;
  });
  const frozen = check.frozen ? "no motion" : null;
  return [black, ...runs, frozen].filter(Boolean).join(", ") || "broken output";
}

export function flatBlackFrame(frame: FrameLuma): boolean {
  return (
    Number.isFinite(frame.yavg) &&
    Number.isFinite(frame.ymax) &&
    frame.yavg <= BLACK_YAVG_MAX &&
    frame.ymax <= BLACK_YMAX_MAX
  );
}

/**
 * How many flat-black frames a run must last.
 * The smaller of 0.5 seconds and 12 frames. A clip shorter than that bar
 * returns a count the clip cannot reach, so the 95% check is the one that
 * judges a clip that is black throughout.
 */
export function blackRunBarFrames(frameCount: number, fps: number | null): number {
  const byTime =
    fps != null && Number.isFinite(fps) && fps > 0
      ? Math.max(1, Math.round(BLACK_RUN_MIN_SEC * fps))
      : BLACK_RUN_MIN_FRAMES;
  const bar = Math.min(byTime, BLACK_RUN_MIN_FRAMES);
  if (frameCount > 0 && bar >= frameCount) return frameCount + 1;
  return Math.max(1, bar);
}

export function collectBlackRuns(frames: readonly FrameLuma[], fps: number | null): BlackRun[] {
  const bar = blackRunBarFrames(frames.length, fps);
  const runs: BlackRun[] = [];
  let start = -1;
  const flush = (end: number) => {
    if (start < 0) return;
    const count = end - start;
    if (count >= bar) {
      const sec = fps != null && fps > 0 ? Math.round((count / fps) * 1000) / 1000 : null;
      runs.push({ startFrame: start, frames: count, sec });
    }
    start = -1;
  };
  frames.forEach((frame, index) => {
    if (flatBlackFrame(frame)) {
      if (start < 0) start = index;
    } else flush(index);
  });
  flush(frames.length);
  return runs;
}

export function judgeFrames(
  frames: readonly FrameLuma[],
  fps: number | null = null
): {
  black: boolean;
  frozen: boolean;
  blackFraction: number;
  meanMotion: number | null;
  blackRuns: BlackRun[];
} {
  if (frames.length === 0) {
    return { black: false, frozen: false, blackFraction: 0, meanMotion: null, blackRuns: [] };
  }
  const blackFrames = frames.filter((frame) => flatBlackFrame(frame)).length;
  const blackFraction = blackFrames / frames.length;
  const black = blackFraction >= BLACK_FRAME_FRACTION;
  const blackRuns = black ? [] : collectBlackRuns(frames, fps);
  if (frames.length < FROZEN_MIN_FRAMES) {
    return { black, frozen: false, blackFraction, meanMotion: null, blackRuns };
  }
  const diffs = frames.slice(1).map((frame) => frame.ydif);
  if (diffs.length === 0 || diffs.some((value) => !Number.isFinite(value))) {
    return { black, frozen: false, blackFraction, meanMotion: null, blackRuns };
  }
  const mean = diffs.reduce((sum, value) => sum + value, 0) / diffs.length;
  const max = Math.max(...diffs);
  const frozen = mean <= FROZEN_MEAN_YDIF_MAX && max <= FROZEN_MAX_YDIF_MAX;
  return { black, frozen, blackFraction, meanMotion: mean, blackRuns };
}

export function parseSignalStats(text: string): FrameLuma[] {
  const frames: FrameLuma[] = [];
  let yavg: number | null = null;
  let ymax: number | null = null;
  let ydif: number | null = null;
  const flush = () => {
    if (yavg == null || ymax == null || ydif == null) return;
    if (!Number.isFinite(yavg) || !Number.isFinite(ymax) || !Number.isFinite(ydif)) return;
    frames.push({ yavg, ymax, ydif });
    yavg = null;
    ymax = null;
    ydif = null;
  };
  for (const line of text.split(/\r?\n/)) {
    if (/frame:\d+/.test(line)) flush();
    const avg = /lavfi\.signalstats\.YAVG=([0-9.eE+-]+)/.exec(line);
    if (avg) yavg = Number(avg[1]);
    const max = /lavfi\.signalstats\.YMAX=([0-9.eE+-]+)/.exec(line);
    if (max) ymax = Number(max[1]);
    const dif = /lavfi\.signalstats\.YDIF=([0-9.eE+-]+)/.exec(line);
    if (dif) ydif = Number(dif[1]);
  }
  flush();
  return frames;
}

function readFrameRate(file: string): number | null {
  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=r_frame_rate",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ],
    { encoding: "utf8" }
  );
  if (probe.error || probe.status !== 0) return null;
  const [num, den] = String(probe.stdout).trim().split("/").map((part) => Number(part));
  if (!Number.isFinite(num) || num <= 0) return null;
  if (!Number.isFinite(den) || den === 0) return num;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 ? fps : null;
}

/** Null when ffmpeg cannot read the file. Does not throw. */
export function measureClip(file: string): FrameLuma[] | null {
  const probe = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-i", file, "-vf", "signalstats,metadata=print", "-f", "null", "-"],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
  );
  if (probe.error || probe.status !== 0) return null;
  const frames = parseSignalStats(`${probe.stderr ?? ""}\n${probe.stdout ?? ""}`);
  return frames.length > 0 ? frames : null;
}

function describeRun(run: BlackRun, frameCount: number): string {
  const length = formatBlackRunLength(run);
  if (run.startFrame === 0) return `the first ${length} are flat black`;
  if (frameCount > 0 && run.startFrame + run.frames >= frameCount) return `the last ${length} are flat black`;
  return `a run of ${length} starting at frame ${run.startFrame + 1} is flat black`;
}

function describeRuns(runs: readonly BlackRun[], frameCount: number): string {
  const parts = runs.map((run) => describeRun(run, frameCount));
  const sentence = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

function trimSentence(opening: BlackRun | undefined): string {
  if (!opening) return "";
  if (opening.frames <= MAX_CHAIN_TRIM_START_FRAMES) {
    return `On a chained hard cut, start-frame trim can drop those frames. The range is 0–${MAX_CHAIN_TRIM_START_FRAMES} and the default is ${DEFAULT_CHAIN_TRIM_START_FRAMES}.`;
  }
  return `On a chained hard cut, start-frame trim drops at most ${MAX_CHAIN_TRIM_START_FRAMES} frames at the start. The default is ${DEFAULT_CHAIN_TRIM_START_FRAMES}. That does not remove this run.`;
}

function statusFor(judged: {
  black: boolean;
  frozen: boolean;
  blackFraction: number;
  blackRuns: BlackRun[];
  frames: number;
}): string {
  const hold = "It stays out of the stitch until you include it or render the shot again.";
  if (judged.black || judged.blackRuns.length === 0) {
    const blackPhrase = judged.blackFraction >= 0.999 ? "all black" : "nearly all black";
    let lead: string;
    if (judged.black && judged.frozen) lead = `This clip is ${blackPhrase} and does not move.`;
    else if (judged.black) lead = `This clip is ${blackPhrase}.`;
    else lead = "This clip does not move. It looks like a still.";
    return `${lead} ${hold}`;
  }
  const parts = [describeRuns(judged.blackRuns, judged.frames)];
  if (judged.frozen) parts.push("This clip does not move. It looks like a still.");
  parts.push(hold);
  const opening = judged.blackRuns.find((run) => run.startFrame === 0);
  const trim = trimSentence(opening);
  if (trim) parts.push(trim);
  return parts.join(" ");
}

function comfyLtxModel(modelName?: string): boolean {
  const id = comfyWorkflowFromModelName(modelName);
  return id === "ltx" || id === "ltx25";
}

export function inspectClipFile(
  file: string,
  opts?: { provider?: ProviderId; modelName?: string }
): ClipCheck {
  const frames = measureClip(file);
  if (!frames) return emptyClipCheck();
  const judged = judgeFrames(frames, readFrameRate(file));
  const runFlag = judged.blackRuns.length > 0;
  const flagged = judged.black || judged.frozen || runFlag;
  const wanHints =
    opts?.provider === "comfyui" && (judged.black || (judged.frozen && !runFlag));
  const ltxOpening =
    opts?.provider === "comfyui" &&
    comfyLtxModel(opts.modelName) &&
    judged.blackRuns.some((run) => run.startFrame === 0);
  const check: ClipCheck = {
    flagged,
    black: judged.black,
    frozen: judged.frozen,
    status: flagged ? statusFor({ ...judged, frames: frames.length }) : "",
    hints: wanHints ? [...COMFY_BLACK_FRAME_HINTS] : [],
    includeAnyway: false,
    frames: frames.length,
    blackFraction: judged.blackFraction,
    meanMotion: judged.meanMotion,
    blackRuns: judged.blackRuns,
  };
  if (opts?.provider === "mock" && mockClipFlagsSuppressed()) {
    return {
      ...check,
      flagged: false,
      black: false,
      frozen: false,
      status: "",
      hints: [],
      includeAnyway: false,
      blackRuns: [],
    };
  }
  if (wanHints) {
    check.status = `${check.status} If this was Wan on ComfyUI, these are the reported causes of an all-black clip, in the order to try them. They are not a promise that one of them is this clip.`;
  }
  if (ltxOpening) {
    check.status = `${check.status} ${LTX_BLACK_OPENING_NOTE}`;
  }
  return check;
}

/**
 * Marks the job completed and stores the clip check.
 * Called where a backend has the file and is about to set status to completed.
 */
export function finishRenderedClip(jobId: string, outputRel: string): void {
  const job = getJob(jobId);
  if (!job || job.status === "cancelled") return;
  const rel = outputRel.split(/[\\/]/).join("/");
  let clipCheck: ClipCheck;
  try {
    clipCheck = inspectClipFile(resolveDataPath(rel), { provider: job.provider, modelName: job.modelName });
  } catch {
    clipCheck = emptyClipCheck();
  }
  updateJob(jobId, {
    status: "completed",
    progress: 100,
    outputPath: rel,
    error: undefined,
    clipCheck,
  });
}

/** Remember that the user wants this flagged clip in the stitch. */
export function setClipIncludeAnyway(jobId: string, include: boolean): ReturnType<typeof getJob> {
  const job = getJob(jobId);
  if (!job?.clipCheck?.flagged) return undefined;
  return updateJob(jobId, {
    clipCheck: { ...job.clipCheck, includeAnyway: include },
  });
}
