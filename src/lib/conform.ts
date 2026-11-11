/**
 * One output rate and size for a cut whose clips came from different providers.
 * The fps filter holds the picture's duration and duplicates or drops frames.
 * It does not speed a clip up. Letterbox and pillarbox pad; they do not stretch.
 *
 * Smooth frame rate is off unless the project turns it on. A clip below the
 * target rate then uses ffmpeg minterpolate (motion-compensated) instead of
 * repeated frames. The length stays the same. It is not RIFE or FILM, and it
 * does not add detail, fix a character, or regenerate motion.
 */

export const HISTORIC_NORMALIZE =
  "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p";

/** EBU R128 integrated loudness is −23 LUFS, with a −1 dBTP true-peak ceiling. */
export const LOUDNORM_FILTER = "loudnorm=I=-23:TP=-1:LRA=11";

/**
 * Streaming master for a cut that has a music bed. −14 LUFS, −1 dBTP.
 * Clips with no bed stay on LOUDNORM_FILTER.
 */
export const STREAM_LOUDNORM_FILTER = "loudnorm=I=-14:TP=-1:LRA=11";

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
  durationSec?: number;
}

/** What the stitch did to one clip's frame rate. */
export type SmoothFpsMethod = "unchanged" | "duplicate" | "drop" | "minterpolate";

export interface SmoothFpsShot {
  shotId: string;
  position: number;
  fromFps: number;
  toFps: number;
  method: SmoothFpsMethod;
}

/** What the stitch card and the manifest say about Smooth frame rate. */
export interface SmoothFpsReport {
  active: boolean;
  summary: string;
  shots: SmoothFpsShot[];
}

/**
 * Limits of ffmpeg's block matcher. Shown whenever the option is on, including
 * when no clip was below the target rate.
 */
export const SMOOTH_FPS_LIMIT =
  "Fast motion and thin edges can warp. This is not RIFE or FILM. It does not add detail, fix a character, or regenerate motion.";

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

/**
 * Motion-compensated interpolation to `fps`, then the fps filter.
 * minterpolate stops a couple of frames short of the source length. The fps
 * filter fills that gap, so the clip is not slow motion and the length matches
 * frame duplication. This is ffmpeg's block match. It is not RIFE or FILM.
 */
export function smoothRateFilter(fps: number): string {
  const rate = canonicalFps(fps);
  return `minterpolate=fps=${rate}:mi_mode=mci:mc_mode=obmc:me_mode=bidir:me=hexbs:mb_size=16:search_param=4:vsbmc=0,fps=${rate}`;
}

/**
 * True when this clip should be raised with minterpolate.
 * A clip that is already at the target, or above it, stays on the fps filter.
 * Fewer than two frames has no motion to interpolate, so those stay duplicated.
 */
export function useMotionInterpolation(
  clip: { fps: number; durationSec?: number },
  targetFps: number,
  smooth: boolean
): boolean {
  if (!smooth) return false;
  if (!(canonicalFps(clip.fps) < canonicalFps(targetFps))) return false;
  if (clip.durationSec == null) return true;
  if (!(clip.durationSec > 0)) return false;
  return clip.durationSec * clip.fps >= 2;
}

export function conformVideoFilter(
  width: number,
  height: number,
  fps: number,
  opts?: { smooth?: boolean }
): string {
  const w = evenDim(width);
  const h = evenDim(height);
  const rate = canonicalFps(fps);
  const rateFilter = opts?.smooth ? smoothRateFilter(rate) : `fps=${rate}`;
  return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,${rateFilter},format=yuv420p`;
}

/** One conform filter per clip. A string is shared when every clip uses the same filter. */
export function conformClipFilters(
  clips: readonly { fps: number; durationSec?: number }[],
  target: { width: number; height: number; fps: number },
  smooth: boolean
): string[] {
  return clips.map((clip) =>
    conformVideoFilter(target.width, target.height, target.fps, {
      smooth: useMotionInterpolation(clip, target.fps, smooth),
    })
  );
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

/**
 * A music bed masters to −14 LUFS unless loudness is explicitly off.
 * Without a bed, loudness stays the EBU R128 rule from the conform step.
 */
export function masterLoudnessOn(
  setting: boolean | null | undefined,
  anyClipAudio: boolean,
  hasMusic: boolean
): boolean {
  if (hasMusic) return setting !== false;
  return loudnessOn(setting, anyClipAudio);
}

export function masterLoudnormFilter(hasMusic: boolean): string {
  return hasMusic ? STREAM_LOUDNORM_FILTER : LOUDNORM_FILTER;
}

export function conformShotLabel(
  clip: { fps: number; width: number; height: number; hasAudio?: boolean },
  target: { fps: number; width: number; height: number },
  opts?: { anyAudio?: boolean; smooth?: boolean }
): string | null {
  const parts: string[] = [];
  const srcFps = canonicalFps(clip.fps);
  const dstFps = canonicalFps(target.fps);
  if (srcFps !== dstFps) {
    parts.push(opts?.smooth ? `${srcFps} fps → ${dstFps} fps, motion interpolation` : `${srcFps} fps → ${dstFps} fps`);
  }
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
  /** When true and no clip is interpolated, say so. Off leaves the old sentence. */
  smoothFps?: boolean;
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
  const interpolated = changed.some((label) => label.includes("motion interpolation"));
  const dropped = changed.some((label) => label.includes("fps →") && !label.includes("motion interpolation"));
  const idle = " Smooth frame rate is on. No clip is below the target rate, so none are interpolated.";
  let retime = "";
  if (interpolated) {
    retime = ` A lower frame rate is raised with ffmpeg motion interpolation (minterpolate), not by speeding a clip up. ${SMOOTH_FPS_LIMIT}`;
    if (dropped) retime += " A higher frame rate is still lowered by dropping frames.";
  } else if (changed.some((label) => label.includes("fps →"))) {
    retime = " Frame rate changes by duplicating or dropping frames, not by speeding a clip up.";
    if (input.smoothFps) retime += idle;
  } else if (input.smoothFps) {
    retime = idle;
  }
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
    smoothFps?: boolean | null;
  },
  clips: readonly ConformClip[]
): ConformPlan {
  if (clips.length === 0) {
    const fps = project.outputFps == null ? 24 : canonicalFps(project.outputFps);
    const width = project.outputWidth == null ? 1280 : evenDim(project.outputWidth, OUTPUT_DIM_MIN);
    const height = project.outputHeight == null ? 720 : evenDim(project.outputHeight, OUTPUT_DIM_MIN);
    const smoothNote =
      project.smoothFps === true
        ? ` Smooth frame rate is on. A clip below the target rate is raised with ffmpeg motion interpolation (minterpolate), not by speeding a clip up. ${SMOOTH_FPS_LIMIT}`
        : "";
    return {
      summary: `No finished take yet. The stitch conforms clips to one frame rate and size before it joins them.${smoothNote}`,
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
  const smooth = project.smoothFps === true;
  const shots = clips.map((clip) => ({
    shotId: clip.shotId,
    label: conformShotLabel(clip, target, {
      anyAudio,
      smooth: useMotionInterpolation(clip, target.fps, smooth),
    }),
  }));
  return {
    summary: conformSummary({
      target,
      labels: shots.map((shot) => shot.label),
      anyAudio,
      loudness,
      smoothFps: smooth,
    }),
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

function nameShots(shots: readonly { position: number }[]): string {
  const names = shots.map((shot) => `shot ${shot.position}`);
  if (names.length <= 1) return names[0] ?? "the shot";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/**
 * What this stitch did. Off keeps the duplication sentence. On names the clips
 * that were interpolated, and says when nothing was below the target rate.
 * The length is not changed into slow motion.
 */
export function smoothFpsReport(
  active: boolean,
  clips: readonly { shotId: string; position: number; fps: number; durationSec?: number }[],
  targetFps: number
): SmoothFpsReport {
  const toFps = canonicalFps(targetFps);
  const shots: SmoothFpsShot[] = clips.map((clip) => {
    const fromFps = canonicalFps(clip.fps);
    let method: SmoothFpsMethod = "unchanged";
    if (fromFps < toFps) {
      method = useMotionInterpolation(clip, toFps, active) ? "minterpolate" : "duplicate";
    } else if (fromFps > toFps) {
      method = "drop";
    }
    return { shotId: clip.shotId, position: clip.position, fromFps, toFps, method };
  });
  const raised = shots.filter((shot) => shot.method === "minterpolate");
  const dropped = shots.filter((shot) => shot.method === "drop");
  let summary: string;
  if (!active) {
    summary =
      "Smooth frame rate is off. A lower frame rate is raised by duplicating frames, not by speeding a clip up.";
  } else if (raised.length === 0) {
    summary = `Smooth frame rate is on. No clip is below ${toFps} fps, so none were interpolated. ${SMOOTH_FPS_LIMIT}`;
  } else {
    summary = `Smooth frame rate raised ${nameShots(raised)} to ${toFps} fps with ffmpeg motion interpolation (minterpolate). Clip length is unchanged. ${SMOOTH_FPS_LIMIT}`;
    if (dropped.length > 0) summary += " A higher frame rate was lowered by dropping frames.";
  }
  return { active, summary, shots };
}

/**
 * The line Export for edit writes. The files themselves are the original takes.
 * Off keeps the sentence the EDL already used.
 */
export function editRateNote(smooth: boolean): string {
  if (!smooth) {
    return "Frame rate changes by duplicating or dropping frames, not by speeding a clip up.";
  }
  return `Smooth frame rate is on. These files are the original takes and were not interpolated. The stitch raises a lower frame rate with ffmpeg motion interpolation (minterpolate), not by speeding a clip up. ${SMOOTH_FPS_LIMIT}`;
}
