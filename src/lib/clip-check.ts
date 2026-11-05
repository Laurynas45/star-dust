/**
 * After a backend writes a clip, read it with ffmpeg signalstats.
 *
 * Black: a frame counts only when it is a flat field at black level.
 * Limited-range black sits at luma 16. Average luma at most 18 and brightest
 * luma at most 20. A dark picture with any highlight stays unflagged.
 * The clip is flagged when at least 95% of frames are that flat black.
 * A one-second fade on a four-second shot is about 25% and is not flagged.
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
import { getJob, resolveDataPath, updateJob } from "./storage";
import { ClipCheck, ProviderId } from "./types";

/** Limited-range black is 16. This sits just above it. */
export const BLACK_YAVG_MAX = 18;
/** Brightest pixel. A highlight above this is a picture, not a black frame. */
export const BLACK_YMAX_MAX = 20;
/** Share of frames that must be flat black. */
export const BLACK_FRAME_FRACTION = 0.95;
/** Mean YDIF at or below this is encoder noise, not a slow move. */
export const FROZEN_MEAN_YDIF_MAX = 0.02;
/** No single frame-to-frame jump above this. */
export const FROZEN_MAX_YDIF_MAX = 0.04;
/** Shorter clips are not judged for motion. */
export const FROZEN_MIN_FRAMES = 4;

/**
 * Reported causes of an all-black Wan 2.2 clip, in the order to try them.
 * Shown for a flagged ComfyUI clip. Not a promise that one of them is this file.
 */
export const COMFY_BLACK_FRAME_HINTS = [
  "ComfyUI was started with --use-sage-attention or --fast fp16_accumulation. Those flags are a reported cause of an all-black Wan clip. Start ComfyUI without them and render this shot again.",
  "The VAE is running in fp16. Start ComfyUI with --fp32-vae and render this shot again.",
  "The VAE file does not match the Wan model. Wan 2.2 5B needs wan2.2_vae. Wan 2.2 14B uses wan_2.1_vae. Pair the VAE with the model and render this shot again.",
  "The graph uses VAE Decode (Tiled) on Wan. Use VAE Decode and render this shot again.",
] as const;

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
  };
}

/** True when Export stitch should leave this clip out. */
export function clipHeldFromStitch(job: { clipCheck?: ClipCheck | null } | null | undefined): boolean {
  return Boolean(job?.clipCheck?.flagged && !job.clipCheck.includeAnyway);
}

/** Short label for a join warning. */
export function clipFlagLabel(check: ClipCheck): string {
  const black = check.black ? (check.blackFraction >= 0.999 ? "all black" : "nearly all black") : null;
  const frozen = check.frozen ? "no motion" : null;
  return [black, frozen].filter(Boolean).join(", ") || "broken output";
}

export function judgeFrames(frames: readonly FrameLuma[]): {
  black: boolean;
  frozen: boolean;
  blackFraction: number;
  meanMotion: number | null;
} {
  if (frames.length === 0) {
    return { black: false, frozen: false, blackFraction: 0, meanMotion: null };
  }
  const blackFrames = frames.filter(
    (frame) =>
      Number.isFinite(frame.yavg) &&
      Number.isFinite(frame.ymax) &&
      frame.yavg <= BLACK_YAVG_MAX &&
      frame.ymax <= BLACK_YMAX_MAX
  ).length;
  const blackFraction = blackFrames / frames.length;
  const black = blackFraction >= BLACK_FRAME_FRACTION;
  if (frames.length < FROZEN_MIN_FRAMES) {
    return { black, frozen: false, blackFraction, meanMotion: null };
  }
  const diffs = frames.slice(1).map((frame) => frame.ydif);
  if (diffs.length === 0 || diffs.some((value) => !Number.isFinite(value))) {
    return { black, frozen: false, blackFraction, meanMotion: null };
  }
  const mean = diffs.reduce((sum, value) => sum + value, 0) / diffs.length;
  const max = Math.max(...diffs);
  const frozen = mean <= FROZEN_MEAN_YDIF_MAX && max <= FROZEN_MAX_YDIF_MAX;
  return { black, frozen, blackFraction, meanMotion: mean };
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

function statusFor(black: boolean, frozen: boolean, blackFraction: number): string {
  const blackPhrase = blackFraction >= 0.999 ? "all black" : "nearly all black";
  let lead: string;
  if (black && frozen) lead = `This clip is ${blackPhrase} and does not move.`;
  else if (black) lead = `This clip is ${blackPhrase}.`;
  else lead = "This clip does not move. It looks like a still.";
  return `${lead} It stays out of the stitch until you include it or render the shot again.`;
}

export function inspectClipFile(file: string, opts?: { provider?: ProviderId }): ClipCheck {
  const frames = measureClip(file);
  if (!frames) return emptyClipCheck();
  const judged = judgeFrames(frames);
  const flagged = judged.black || judged.frozen;
  const comfy = opts?.provider === "comfyui" && flagged;
  const check: ClipCheck = {
    flagged,
    black: judged.black,
    frozen: judged.frozen,
    status: flagged ? statusFor(judged.black, judged.frozen, judged.blackFraction) : "",
    hints: comfy ? [...COMFY_BLACK_FRAME_HINTS] : [],
    includeAnyway: false,
    frames: frames.length,
    blackFraction: judged.blackFraction,
    meanMotion: judged.meanMotion,
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
    };
  }
  if (comfy && check.flagged) {
    check.status = `${check.status} If this was Wan on ComfyUI, these are the reported causes of an all-black clip, in the order to try them. They are not a promise that one of them is this clip.`;
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
    clipCheck = inspectClipFile(resolveDataPath(rel), { provider: job.provider });
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
