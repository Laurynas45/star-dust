/**
 * One output rate and size for a cut whose clips came from different providers.
 * The fps filter holds the picture's duration and duplicates or drops frames.
 * It does not speed a clip up. Letterbox and pillarbox pad; they do not stretch.
 */

export const HISTORIC_NORMALIZE =
  "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p";

/** EBU R128 integrated loudness is −23 LUFS, with a −1 dBTP true-peak ceiling. */
export const LOUDNORM_FILTER = "loudnorm=I=-23:TP=-1:LRA=11";

export const OUTPUT_FPS_MIN = 1;
export const OUTPUT_FPS_MAX = 60;
export const OUTPUT_DIM_MIN = 16;
export const OUTPUT_DIM_MAX = 4096;

export interface FrameSize {
  width: number;
  height: number;
}

export interface ConformTarget extends FrameSize {
  fps: number;
  fpsSource: "project" | "majority";
  sizeSource: "project" | "majority";
}

export interface LetterboxFit extends FrameSize {
  padX: number;
  padY: number;
  /** Bars above and below the picture. */
  letterboxed: boolean;
  /** Bars on the left and right. */
  pillarboxed: boolean;
}

export interface ConformClip extends FrameSize {
  shotId: string;
  fps: number;
  hasAudio: boolean;
}

export interface ConformPlan {
  summary: string;
  fps: number;
  width: number;
  height: number;
  fpsSource: "project" | "majority";
  sizeSource: "project" | "majority";
  anyAudio: boolean;
  loudness: boolean;
  shots: { shotId: string; label: string | null }[];
}

export function canonicalFps(fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) return 24;
  return Math.min(OUTPUT_FPS_MAX, Math.max(OUTPUT_FPS_MIN, Math.round(fps)));
}

export function evenDim(value: number, min = 2): number {
  if (!Number.isFinite(value)) return min;
  const even = Math.round(value / 2) * 2;
  return Math.min(OUTPUT_DIM_MAX, Math.max(min, even));
}

/**
 * Fit the source inside the target. The scale is the smaller axis, matching
 * ffmpeg `force_original_aspect_ratio=decrease`, then the leftover is pad.
 */
export function letterboxFit(srcW: number, srcH: number, dstW: number, dstH: number): LetterboxFit {
  const dw = Math.max(1, Math.round(dstW));
  const dh = Math.max(1, Math.round(dstH));
  const sw = Math.max(1, srcW);
  const sh = Math.max(1, srcH);
  const factor = Math.min(dw / sw, dh / sh);
  const width = Math.min(dw, Math.max(1, Math.round(sw * factor)));
  const height = Math.min(dh, Math.max(1, Math.round(sh * factor)));
  const padX = Math.max(0, Math.floor((dw - width) / 2));
  const padY = Math.max(0, Math.floor((dh - height) / 2));
  return {
    width,
    height,
    padX,
    padY,
    letterboxed: padY > 0,
    pillarboxed: padX > 0,
  };
}

/** Majority rate. An equal count uses the higher rate. */
export function majorityFps(rates: readonly number[]): number {
  const counts = new Map<number, number>();
  for (const rate of rates) {
    const fps = canonicalFps(rate);
    counts.set(fps, (counts.get(fps) ?? 0) + 1);
  }
  let bestFps = 24;
  let bestCount = -1;
  for (const [fps, count] of Array.from(counts.entries())) {
    if (count > bestCount || (count === bestCount && fps > bestFps)) {
      bestFps = fps;
      bestCount = count;
    }
  }
  return bestCount < 0 ? 24 : bestFps;
}

/**
 * Majority frame size. An equal count uses the larger frame (more pixels,
 * then the wider one), the same idea as the higher rate winning an fps tie.
 */
export function majoritySize(sizes: readonly FrameSize[]): FrameSize {
  const counts = new Map<string, FrameSize & { count: number }>();
  for (const size of sizes) {
    const width = evenDim(size.width);
    const height = evenDim(size.height);
    const key = `${width}x${height}`;
    const row = counts.get(key) ?? { width, height, count: 0 };
    row.count += 1;
    counts.set(key, row);
  }
  let best: FrameSize & { count: number } = { width: 1280, height: 720, count: -1 };
  for (const row of Array.from(counts.values())) {
    const area = row.width * row.height;
    const bestArea = best.width * best.height;
    const wins =
      row.count > best.count ||
      (row.count === best.count &&
        (area > bestArea || (area === bestArea && row.width > best.width)));
    if (wins) best = row;
  }
  return { width: best.width, height: best.height };
}

export function resolveConformTarget(
  project: {
    outputFps?: number | null;
    outputWidth?: number | null;
    outputHeight?: number | null;
  },
  clips: readonly { fps: number; width: number; height: number }[]
): ConformTarget {
  const fpsOverride =
    project.outputFps != null && Number.isFinite(project.outputFps)
      ? canonicalFps(project.outputFps)
      : null;
  const sizeOverride =
    project.outputWidth != null &&
    project.outputHeight != null &&
    Number.isFinite(project.outputWidth) &&
    Number.isFinite(project.outputHeight)
      ? { width: evenDim(project.outputWidth, OUTPUT_DIM_MIN), height: evenDim(project.outputHeight, OUTPUT_DIM_MIN) }
      : null;
  const fps = fpsOverride ?? majorityFps(clips.map((clip) => clip.fps));
  const size = sizeOverride ?? majoritySize(clips.map((clip) => ({ width: clip.width, height: clip.height })));
  return {
    fps,
    width: size.width,
    height: size.height,
    fpsSource: fpsOverride == null ? "majority" : "project",
    sizeSource: sizeOverride == null ? "majority" : "project",
  };
}

export function conformVideoFilter(width: number, height: number, fps: number): string {
  const w = evenDim(width);
  const h = evenDim(height);
  const rate = canonicalFps(fps);
  return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${rate},format=yuv420p`;
}

/** A silent clip needs a silent track when any other clip in the cut has audio. */
export function silenceForClip(hasAudio: boolean, anyAudio: boolean): boolean {
  return anyAudio && !hasAudio;
}

/**
 * Loudness follows EBU R128 only when a clip has audio.
 * Null is the default: on in that case, off when every clip is silent.
 * An explicit on does nothing if there is no audio to measure.
 */
export function loudnessOn(setting: boolean | null | undefined, anyAudio: boolean): boolean {
  if (!anyAudio) return false;
  if (setting == null) return true;
  return setting;
}

export function conformShotLabel(
  clip: { fps: number; width: number; height: number; hasAudio?: boolean },
  target: { fps: number; width: number; height: number },
  opts?: { anyAudio?: boolean }
): string | null {
  const parts: string[] = [];
  const srcFps = canonicalFps(clip.fps);
  const dstFps = canonicalFps(target.fps);
  if (srcFps !== dstFps) parts.push(`${srcFps} fps → ${dstFps} fps`);
  const fit = letterboxFit(clip.width, clip.height, target.width, target.height);
  if (fit.letterboxed || fit.pillarboxed) {
    parts.push(fit.letterboxed && fit.padY >= fit.padX ? "letterboxed" : "pillarboxed");
  } else if (evenDim(clip.width) !== evenDim(target.width) || evenDim(clip.height) !== evenDim(target.height)) {
    parts.push("scaled");
  }
  if (opts?.anyAudio && clip.hasAudio === false) parts.push("silence added");
  return parts.length === 0 ? null : parts.join(", ");
}

function originPhrase(fpsSource: "project" | "majority", sizeSource: "project" | "majority"): string {
  if (fpsSource === "majority" && sizeSource === "majority") return "the majority of these clips";
  if (fpsSource === "project" && sizeSource === "project") return "the project output";
  const rate = fpsSource === "project" ? "the project frame rate" : "the majority frame rate";
  const size = sizeSource === "project" ? "the project size" : "the majority size";
  return `${rate} and ${size}`;
}

export function conformSummary(input: {
  target: Pick<ConformTarget, "fps" | "width" | "height" | "fpsSource" | "sizeSource">;
  labels: readonly (string | null)[];
  anyAudio: boolean;
  loudness: boolean;
}): string {
  const changed = input.labels.filter((label): label is string => Boolean(label));
  const where = originPhrase(input.target.fpsSource, input.target.sizeSource);
  const head = `Conform to ${input.target.fps} fps and ${input.target.width}×${input.target.height}, ${where}.`;
  const count =
    changed.length === 0
      ? "These clips already match, so none are retimed or padded."
      : changed.length === 1
        ? "1 shot is conformed."
        : `${changed.length} shots are conformed.`;
  const retime = changed.some((label) => label.includes("fps →"))
    ? " Frame rate changes by duplicating or dropping frames, not by speeding a clip up."
    : "";
  const audio = !input.anyAudio
    ? ""
    : input.loudness
      ? " Clips without audio get silence. EBU R128 loudness is on."
      : " Clips without audio get silence. Loudness normalisation is off.";
  return `${head} ${count}${retime}${audio}`;
}

export function planTakeConform(
  project: {
    outputFps?: number | null;
    outputWidth?: number | null;
    outputHeight?: number | null;
    loudnessNormalize?: boolean | null;
  },
  clips: readonly ConformClip[]
): ConformPlan {
  if (clips.length === 0) {
    const fps = project.outputFps == null ? 24 : canonicalFps(project.outputFps);
    const width = project.outputWidth == null ? 1280 : evenDim(project.outputWidth, OUTPUT_DIM_MIN);
    const height = project.outputHeight == null ? 720 : evenDim(project.outputHeight, OUTPUT_DIM_MIN);
    return {
      summary: "No finished take yet. The stitch conforms clips to one frame rate and size before it joins them.",
      fps,
      width,
      height,
      fpsSource: project.outputFps == null ? "majority" : "project",
      sizeSource: project.outputWidth == null || project.outputHeight == null ? "majority" : "project",
      anyAudio: false,
      loudness: false,
      shots: [],
    };
  }
  const target = resolveConformTarget(project, clips);
  const anyAudio = clips.some((clip) => clip.hasAudio);
  const loudness = loudnessOn(project.loudnessNormalize, anyAudio);
  const shots = clips.map((clip) => ({
    shotId: clip.shotId,
    label: conformShotLabel(clip, target, { anyAudio }),
  }));
  return {
    summary: conformSummary({ target, labels: shots.map((shot) => shot.label), anyAudio, loudness }),
    fps: target.fps,
    width: target.width,
    height: target.height,
    fpsSource: target.fpsSource,
    sizeSource: target.sizeSource,
    anyAudio,
    loudness,
    shots,
  };
}
