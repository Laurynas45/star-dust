import {
  DEFAULT_SEAM_FADE_FRAMES,
  DEFAULT_SEAM_FADE_SEC,
  MAX_SEAM_FADE_SEC,
  MIN_SEAM_FADE_SEC,
  SeamFadeUnit,
  SeamMode,
  clampSeamFade,
  clampSeamFadeFrames,
} from "./types";

export interface SeamRequest {
  seamMode?: SeamMode | null;
  seamFadeSec?: number | null;
  seamFadeUnit?: SeamFadeUnit | null;
  seamFadeFrames?: number | null;
}

export interface ProjectSeam extends SeamRequest {
  seamMode: SeamMode;
  seamFadeSec: number;
  seamFadeUnit?: SeamFadeUnit | null;
  seamFadeFrames?: number | null;
}

export interface RequestedFade {
  mode: SeamMode;
  /** Seconds passed to ffmpeg. 0 means this boundary is a hard cut. */
  fadeSec: number;
  /** Set when the boundary is measured in frames. */
  frames: number | null;
  unit: SeamFadeUnit;
  /** Set when 24 frames would last longer than 1 second at this frame rate. */
  capped?: boolean;
}

export interface JoinSeamSpec {
  mode: SeamMode;
  fadeSec: number;
  droppedFrames: number;
}

export interface JoinRuntime {
  sumSec: number;
  joinedSec: number;
  /** Seconds removed by crossfades. Start-frame trim is separate. */
  overlapSec: number;
  trimSec: number;
}

export type JoinOmissionReason = "disabled" | "no-clip" | "missing-file";

export interface JoinOmission {
  shotId: string;
  position: number;
  prompt: string;
  reason: JoinOmissionReason;
}

export interface JoinPlanShot extends SeamRequest {
  id: string;
  position: number;
  prompt: string;
  durationSec: number;
  enabled?: boolean;
}

export interface JoinPlan {
  /** Clips that exist and would be joined right now. */
  sumSec: number;
  joinedSec: number;
  overlapSec: number;
  /** Enabled shots. A missing clip uses the shot duration. */
  plannedSumSec: number;
  plannedJoinedSec: number;
  plannedOverlapSec: number;
  omissions: JoinOmission[];
  warning: string | null;
  usesPlannedDuration: boolean;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function rateOf(fps: number): number {
  return Number.isFinite(fps) && fps > 0 ? fps : 24;
}

/**
 * Frame count converted for ffmpeg. 0 frames is no fade.
 * The result is never longer than 1 second. At 16 fps, 24 frames would be
 * 1.5s, so the count is reduced until it fits.
 */
export function framesToFadeSec(frames: number, fps: number): { fadeSec: number; frames: number; capped: boolean } {
  const requested = clampSeamFadeFrames(frames, 0);
  const rate = rateOf(fps);
  const raw = requested / rate;
  if (raw > MAX_SEAM_FADE_SEC + 0.0005) {
    const fitted = Math.max(0, Math.round(MAX_SEAM_FADE_SEC * rate));
    const used = Math.min(requested, fitted);
    return { fadeSec: round3(used / rate), frames: used, capped: true };
  }
  return { fadeSec: round3(raw), frames: requested, capped: false };
}

/** The fade this boundary asked for, before it is checked against the clip lengths. */
export function requestedSeamFade(project: ProjectSeam, shot: SeamRequest, fps: number): RequestedFade {
  const mode = shot.seamMode ?? project.seamMode ?? "cut";
  if (mode !== "crossfade") {
    return { mode: "cut", fadeSec: 0, frames: null, unit: "seconds" };
  }
  const unit = shot.seamFadeUnit ?? project.seamFadeUnit ?? "seconds";
  if (unit === "frames") {
    const count =
      shot.seamFadeFrames == null
        ? clampSeamFadeFrames(project.seamFadeFrames ?? DEFAULT_SEAM_FADE_FRAMES)
        : clampSeamFadeFrames(shot.seamFadeFrames);
    const converted = framesToFadeSec(count, fps);
    return {
      mode: converted.fadeSec > 0 ? "crossfade" : "cut",
      fadeSec: converted.fadeSec,
      frames: converted.frames,
      unit: "frames",
      capped: converted.capped,
    };
  }
  const fadeSec = clampSeamFade(
    shot.seamFadeSec == null ? project.seamFadeSec ?? DEFAULT_SEAM_FADE_SEC : shot.seamFadeSec
  );
  return { mode: "crossfade", fadeSec, frames: null, unit: "seconds" };
}

/**
 * Joined length. A crossfade overlaps, so it is subtracted once.
 * A hard cut can also drop start frames. Those seconds are trimSec, not overlap.
 */
export function joinedRuntimeSec(durations: number[], seams: JoinSeamSpec[], fps: number): JoinRuntime {
  const rate = rateOf(fps);
  if (durations.length === 0) return { sumSec: 0, joinedSec: 0, overlapSec: 0, trimSec: 0 };
  const sumSec = round3(durations.reduce((sum, value) => sum + Math.max(0, value), 0));
  let joined = Math.max(0, durations[0] ?? 0);
  let overlapSec = 0;
  let trimSec = 0;
  for (let index = 1; index < durations.length; index += 1) {
    const seam = seams[index - 1];
    const drop = seam?.mode === "cut" ? Math.max(0, Math.round(seam.droppedFrames)) : 0;
    const dropSec = drop / rate;
    const incoming = Math.max(0, (durations[index] ?? 0) - dropSec);
    trimSec += Math.min(dropSec, Math.max(0, durations[index] ?? 0));
    const fade = seam?.mode === "crossfade" ? Math.max(0, seam.fadeSec) : 0;
    const overlap = Math.min(fade, joined, incoming);
    overlapSec += overlap;
    joined = joined + incoming - overlap;
  }
  return {
    sumSec,
    joinedSec: round3(Math.max(0, joined)),
    overlapSec: round3(overlapSec),
    trimSec: round3(trimSec),
  };
}

export function shotJoinName(shot: { position: number; prompt: string }): string {
  const text = shot.prompt.trim().replace(/\s+/g, " ");
  const short = text.length > 42 ? `${text.slice(0, 39)}…` : text;
  return `shot ${shot.position} "${short || "untitled"}"`;
}

function omissionPhrase(reason: JoinOmissionReason): string {
  if (reason === "disabled") return "disabled";
  if (reason === "missing-file") return "clip file missing";
  return "no rendered clip";
}

/** One sentence that names every shot the join will not include. */
export function joinOmissionWarning(items: readonly JoinOmission[]): string | null {
  if (items.length === 0) return null;
  const parts = items.map((item) => `${shotJoinName(item)} (${omissionPhrase(item.reason)})`);
  return `Left out of this join: ${parts.join("; ")}.`;
}

export function projectFadeLabel(project: ProjectSeam): string {
  if ((project.seamMode ?? "cut") !== "crossfade") return "hard cut";
  if ((project.seamFadeUnit ?? "seconds") === "frames") {
    const frames = clampSeamFadeFrames(project.seamFadeFrames ?? DEFAULT_SEAM_FADE_FRAMES);
    return frames === 0 ? "crossfade 0 frames" : `crossfade ${frames} frames`;
  }
  return `crossfade ${project.seamFadeSec ?? DEFAULT_SEAM_FADE_SEC}s`;
}

function fittedFade(requested: RequestedFade, prevDur: number, nextDur: number, fps: number): number {
  if (requested.mode !== "crossfade" || requested.fadeSec <= 0) return 0;
  const longestSafe = Math.min(Math.max(0, prevDur), Math.max(0, nextDur)) / 2;
  const shortest = requested.unit === "frames" ? 1 / rateOf(fps) : MIN_SEAM_FADE_SEC;
  if (!(longestSafe >= shortest)) return 0;
  return round3(Math.min(requested.fadeSec, longestSafe));
}

function runtimeFor(
  project: ProjectSeam,
  shots: JoinPlanShot[],
  durations: number[],
  fps: number
): { joinedSec: number; overlapSec: number; sumSec: number } {
  const seams: JoinSeamSpec[] = [];
  for (let index = 1; index < shots.length; index += 1) {
    const requested = requestedSeamFade(project, shots[index], fps);
    const fadeSec = fittedFade(requested, durations[index - 1] ?? 0, durations[index] ?? 0, fps);
    seams.push({ mode: fadeSec > 0 ? "crossfade" : "cut", fadeSec, droppedFrames: 0 });
  }
  const runtime = joinedRuntimeSec(durations, seams, fps);
  return { joinedSec: runtime.joinedSec, overlapSec: runtime.overlapSec, sumSec: runtime.sumSec };
}

/**
 * Planned cut from the shot list, and the cut Export stitch can make from clips
 * that already exist. Disabled shots and shots with no clip are named.
 */
export function planJoin(project: ProjectSeam, shots: JoinPlanShot[], clips: { shotId: string; durationSec: number }[], fps: number): JoinPlan {
  const have = new Map(clips.map((clip) => [clip.shotId, clip.durationSec]));
  const omissions: JoinOmission[] = [];
  const readyShots: JoinPlanShot[] = [];
  const readyDurations: number[] = [];
  const plannedShots: JoinPlanShot[] = [];
  const plannedDurations: number[] = [];
  let usesPlannedDuration = false;

  for (const shot of shots) {
    if (shot.enabled === false) {
      omissions.push({ shotId: shot.id, position: shot.position, prompt: shot.prompt, reason: "disabled" });
      continue;
    }
    const clipSec = have.get(shot.id);
    const planned = clipSec != null && clipSec > 0 ? clipSec : Math.max(0, shot.durationSec);
    if (clipSec == null) {
      omissions.push({ shotId: shot.id, position: shot.position, prompt: shot.prompt, reason: "no-clip" });
      usesPlannedDuration = true;
    }
    plannedShots.push(shot);
    plannedDurations.push(planned);
    if (clipSec != null && clipSec > 0) {
      readyShots.push(shot);
      readyDurations.push(clipSec);
    }
  }

  const ready = runtimeFor(project, readyShots, readyDurations, fps);
  const planned = runtimeFor(project, plannedShots, plannedDurations, fps);
  return {
    sumSec: ready.sumSec,
    joinedSec: ready.joinedSec,
    overlapSec: ready.overlapSec,
    plannedSumSec: planned.sumSec,
    plannedJoinedSec: planned.joinedSec,
    plannedOverlapSec: planned.overlapSec,
    omissions,
    warning: joinOmissionWarning(omissions),
    usesPlannedDuration,
  };
}

export function joinPlanSummary(plan: JoinPlan): string {
  const joined = plan.plannedJoinedSec.toFixed(2);
  const sum = plan.plannedSumSec.toFixed(2);
  const overlap = plan.plannedOverlapSec.toFixed(2);
  const base =
    plan.plannedOverlapSec > 0.001
      ? `Planned joined cut ${joined}s. Enabled clips add to ${sum}s, and crossfades overlap ${overlap}s.`
      : `Planned joined cut ${joined}s. Hard cuts do not overlap, so that matches the enabled clips.`;
  const planned = plan.usesPlannedDuration ? " Shots without a clip use their shot duration." : "";
  return `${base}${planned}`;
}

/** Cost copy. The bill stays on each clip. The joined file is shorter when a fade overlaps. */
export function joinCostNote(plan: JoinPlan): string {
  const joined = plan.plannedJoinedSec.toFixed(2);
  const sum = plan.plannedSumSec.toFixed(2);
  const overlap = plan.plannedOverlapSec.toFixed(2);
  const length =
    plan.plannedOverlapSec > 0.001
      ? `The joined cut is ${joined}s. Clips add to ${sum}s, and crossfades overlap ${overlap}s. This estimate bills each clip, not that shorter file.`
      : `The joined cut is ${joined}s, the same as the enabled clips, because hard cuts do not overlap.`;
  const named = plan.omissions.filter((item) => item.reason === "disabled").map((item) => shotJoinName(item));
  const disabled = named.length > 0 ? ` Disabled and left out of the join: ${named.join("; ")}.` : "";
  return `${length}${disabled}`;
}

function bracket(label: string): string {
  return `[${label}]`;
}

/**
 * One ffmpeg filter_complex for every boundary.
 * A crossfade is xfade, and acrossfade when the clips have audio.
 * A hard cut is concat. A start-frame trim is applied only on that cut.
 * The first clip is input 0. seams[i] joins input i+1.
 */
export function buildJoinFilterGraph(input: {
  durations: number[];
  seams: JoinSeamSpec[];
  withAudio?: boolean;
  fps?: number;
}): string {
  const count = input.durations.length;
  if (count < 2) throw new Error("A join needs at least two clips.");
  if (input.seams.length !== count - 1) throw new Error("Each boundary needs a transition.");
  const withAudio = Boolean(input.withAudio);
  const fps = rateOf(input.fps ?? 24);
  const filters: string[] = [];
  let video = "0:v";
  let audio = "0:a";
  let leftDur = Math.max(0, input.durations[0] ?? 0);

  for (let index = 1; index < count; index += 1) {
    const seam = input.seams[index - 1];
    const drop = seam.mode === "cut" ? Math.max(0, Math.round(seam.droppedFrames)) : 0;
    const fade = seam.mode === "crossfade" && seam.fadeSec > 0 ? seam.fadeSec : 0;
    const dropSec = drop / fps;
    const incoming = Math.max(0, (input.durations[index] ?? 0) - dropSec);
    const last = index === count - 1;
    const videoOut = last ? "v" : `vj${index}`;
    const audioOut = last ? "a" : `aj${index}`;

    if (fade <= 0) {
      let rightVideo = `${index}:v`;
      let rightAudio = `${index}:a`;
      if (drop > 0) {
        rightVideo = `b${index}`;
        rightAudio = `ba${index}`;
        filters.push(`[${index}:v]trim=start_frame=${drop},setpts=PTS-STARTPTS[${rightVideo}]`);
        if (withAudio) {
          filters.push(`[${index}:a]atrim=start=${dropSec.toFixed(6)},asetpts=PTS-STARTPTS[${rightAudio}]`);
        }
      }
      if (withAudio) {
        filters.push(
          `${bracket(video)}${bracket(audio)}${bracket(rightVideo)}${bracket(rightAudio)}concat=n=2:v=1:a=1[${videoOut}][${audioOut}]`
        );
      } else {
        filters.push(`${bracket(video)}${bracket(rightVideo)}concat=n=2:v=1:a=0[${videoOut}]`);
      }
      video = videoOut;
      audio = audioOut;
      leftDur += incoming;
      continue;
    }

    const offset = Math.max(0, leftDur - fade);
    const duration = fade.toFixed(3);
    const off = offset.toFixed(3);
    filters.push(
      `${bracket(video)}${bracket(`${index}:v`)}xfade=transition=fade:duration=${duration}:offset=${off},format=yuv420p[${videoOut}]`
    );
    if (withAudio) {
      filters.push(`${bracket(audio)}${bracket(`${index}:a`)}acrossfade=d=${duration}:c1=tri:c2=tri[${audioOut}]`);
    }
    video = videoOut;
    audio = audioOut;
    leftDur += incoming - Math.min(fade, leftDur, incoming);
  }

  return filters.join(";");
}
