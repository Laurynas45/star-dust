import fs from "fs";
import { finishedTake } from "./continuity";
import { probeDurationSec, runFfmpeg } from "./ffmpeg";
import { absoluteOutputPath, getProject, listJobs, listShots, resolveDataPath } from "./storage";
import { probeVideoFrames } from "./ffmpeg";
import {
  DEFAULT_SEAM_FADE_SEC,
  DROPPED_FRAME_NOTE,
  FRAME_BACK_SEAM_NOTE,
  Job,
  MIN_SEAM_FADE_SEC,
  Project,
  SeamMode,
  Shot,
  clampSeamFade,
} from "./types";

export interface StitchSeam {
  position: number;
  mode: SeamMode;
  fadeSec: number;
  /** Set when a requested crossfade could not be applied, or when a repeated frame was dropped. */
  note?: string;
  /** 1 when this hard cut drops the incoming clip's first frame. Otherwise 0. */
  droppedFrames: number;
}

export interface StitchResult {
  outputPath: string;
  includedShotIds: string[];
  includedJobIds: string[];
  skipped: { shotId: string; position: number; reason: string }[];
  kind: "takes" | "preview";
  seams: StitchSeam[];
  durationSec: number;
}

function newestCompleted(jobs: Job[]): Job | undefined {
  return [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

type Included = {
  shotId: string;
  jobId: string;
  abs: string;
  shot: Shot;
  imagePath: string;
  frameCount: number;
};

const NORMALIZE =
  "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p";

export interface DuplicateDropInput {
  seamMode: SeamMode;
  chainFromPrevious: boolean;
  dropEnabled: boolean;
  previousJobId: string;
  chainedFromJobId?: string;
  /** Applied frames back. Null means an older extract, which was the last frame. */
  chainedFrameBack?: number | null;
  takeUsedChainedStill: boolean;
}

/**
 * A chained hard cut repeats a frame only when clip N+1's first frame is clip N's
 * last frame. That is true when this take was rendered from the previous take's
 * exact last frame (applied frames back = 0).
 *
 * When the start still is earlier than the last frame, the frames that meet at
 * the cut are different. Dropping one would remove a frame that is not a copy.
 * Verified against a clip whose last frame and frame-back still are different
 * colours: the offset join is red then that earlier colour, so nothing is trimmed.
 * Crossfades and unchained shots are left unchanged.
 */
export function dropStartFramesForJoin(input: DuplicateDropInput): number {
  if (input.seamMode !== "cut") return 0;
  if (!input.dropEnabled) return 0;
  if (!input.chainFromPrevious) return 0;
  if (!input.takeUsedChainedStill) return 0;
  if (!input.chainedFromJobId || input.chainedFromJobId !== input.previousJobId) return 0;
  const applied = input.chainedFrameBack == null ? 0 : input.chainedFrameBack;
  if (applied !== 0) return 0;
  return 1;
}

export function duplicateFrameDropEnabled(
  project: { dropDuplicateFrame?: boolean },
  shot: { dropDuplicateFrame?: boolean | null }
): boolean {
  if (shot.dropDuplicateFrame != null) return shot.dropDuplicateFrame;
  return project.dropDuplicateFrame !== false;
}

/** A one-frame clip cannot lose its only frame. */
export function applyDropLimit(requested: number, frameCount: number): number {
  if (requested <= 0) return 0;
  if (!Number.isFinite(frameCount) || frameCount <= requested) return 0;
  return requested;
}

export function hardCutFilterComplex(dropStartFrames: number[]): string {
  const filters = dropStartFrames.map((drop, index) => {
    const trim = drop > 0 ? `,trim=start_frame=${drop},setpts=PTS-STARTPTS` : "";
    return `[${index}:v]${NORMALIZE}${trim}[v${index}]`;
  });
  const concat =
    dropStartFrames.map((_, index) => `[v${index}]`).join("") +
    `concat=n=${dropStartFrames.length}:v=1:a=0[v]`;
  return [...filters, concat].join(";");
}

export function hardCutArgs(inputs: string[], output: string, dropStartFrames: number[]): string[] {
  const args = ["-y"];
  for (const file of inputs) args.push("-i", file);
  args.push(
    "-filter_complex",
    hardCutFilterComplex(dropStartFrames),
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    output
  );
  return args;
}

/** Unchanged from the historical hard-cut concat when no frame is dropped. */
export function pairCutFilter(dropStartFrames: number): string {
  if (dropStartFrames <= 0) return "[0:v][1:v]concat=n=2:v=1:a=0[v]";
  return `[1:v]trim=start_frame=${dropStartFrames},setpts=PTS-STARTPTS[b];[0:v][b]concat=n=2:v=1:a=0[v]`;
}

export function crossfadeFilter(fadeSec: number, offsetSec: number): string {
  return `[0:v][1:v]xfade=transition=fade:duration=${fadeSec.toFixed(3)}:offset=${offsetSec.toFixed(3)},format=yuv420p[v]`;
}

/**
 * Colour and brightness are not matched. A measured grade on a short generated
 * clip is easy to get wrong, so the seam is only a hard cut or a short crossfade.
 */
function resolveSeam(
  project: Project,
  shot: Shot,
  durPrev: number,
  durNext: number
): Omit<StitchSeam, "droppedFrames"> {
  const requested = shot.seamMode ?? project.seamMode ?? "cut";
  if (requested !== "crossfade") {
    return { position: shot.position, mode: "cut", fadeSec: 0 };
  }
  const fadeRequest = clampSeamFade(
    shot.seamFadeSec == null ? project.seamFadeSec ?? DEFAULT_SEAM_FADE_SEC : shot.seamFadeSec
  );
  const longestSafe = Math.min(durPrev, durNext) / 2;
  if (!(longestSafe >= MIN_SEAM_FADE_SEC)) {
    return {
      position: shot.position,
      mode: "cut",
      fadeSec: 0,
      note: "Crossfade needs at least 0.25s on both clips, so this join is a hard cut.",
    };
  }
  const fadeSec = Math.round(Math.min(fadeRequest, longestSafe) * 1000) / 1000;
  const note =
    fadeSec + 0.001 < fadeRequest
      ? `Crossfade shortened to ${fadeSec}s so it fits both clips.`
      : undefined;
  return { position: shot.position, mode: "crossfade", fadeSec, note };
}

function annotateSeam(
  project: Project,
  previous: Included,
  next: Included,
  durPrev: number,
  durNext: number
): StitchSeam {
  const seam = resolveSeam(project, next.shot, durPrev, durNext);
  const takeUsedChainedStill =
    Boolean(next.shot.chainedStartImagePath) && next.imagePath === next.shot.chainedStartImagePath;
  const dropEnabled = duplicateFrameDropEnabled(project, next.shot);
  const requested = dropStartFramesForJoin({
    seamMode: seam.mode,
    chainFromPrevious: next.shot.chainFromPrevious,
    dropEnabled,
    previousJobId: previous.jobId,
    chainedFromJobId: next.shot.chainedFromJobId,
    chainedFrameBack: next.shot.chainedFrameBack,
    takeUsedChainedStill,
  });
  const dropped = applyDropLimit(requested, next.frameCount);
  let note = seam.note;
  if (dropped > 0) {
    note = DROPPED_FRAME_NOTE;
  } else if (
    !note &&
    seam.mode === "cut" &&
    dropEnabled &&
    next.shot.chainFromPrevious &&
    takeUsedChainedStill &&
    next.shot.chainedFromJobId === previous.jobId &&
    (next.shot.chainedFrameBack ?? 0) > 0
  ) {
    note = FRAME_BACK_SEAM_NOTE;
  } else if (!note && requested > 0 && dropped === 0) {
    note = "This clip is a single frame, so the repeated frame was kept.";
  }
  return { ...seam, droppedFrames: dropped, note };
}

export async function stitchProject(projectId: string): Promise<StitchResult> {
  const shots = listShots(projectId);
  const included: Included[] = [];
  const skipped: StitchResult["skipped"] = [];

  for (const shot of shots) {
    const job = finishedTake(shot);
    if (!job?.outputPath) {
      skipped.push({
        shotId: shot.id,
        position: shot.position,
        reason: "No completed take",
      });
      continue;
    }
    const abs = resolveDataPath(job.outputPath);
    if (!fs.existsSync(abs)) {
      skipped.push({
        shotId: shot.id,
        position: shot.position,
        reason: "Clip file is missing",
      });
      continue;
    }
    included.push({ shotId: shot.id, jobId: job.id, abs, shot, imagePath: job.imagePath, frameCount: 0 });
  }

  if (included.length === 0) {
    throw new Error("No completed shots to stitch. Render at least one shot first.");
  }
  return concatClips(projectId, "stitch", "takes", included, skipped);
}

export async function stitchPreview(projectId: string, jobIds: string[]): Promise<StitchResult> {
  const wanted = new Set(jobIds);
  const shots = listShots(projectId);
  const included: Included[] = [];
  const skipped: StitchResult["skipped"] = [];

  for (const shot of shots) {
    const job = newestCompleted(
      listJobs(projectId).filter(
        (item) =>
          item.shotId === shot.id &&
          item.kind === "preview" &&
          wanted.has(item.id) &&
          item.status === "completed" &&
          item.outputPath
      )
    );
    if (!job?.outputPath) {
      skipped.push({
        shotId: shot.id,
        position: shot.position,
        reason: "No completed preview clip",
      });
      continue;
    }
    const abs = resolveDataPath(job.outputPath);
    if (!fs.existsSync(abs)) {
      skipped.push({
        shotId: shot.id,
        position: shot.position,
        reason: "Preview file is missing",
      });
      continue;
    }
    included.push({ shotId: shot.id, jobId: job.id, abs, shot, imagePath: job.imagePath, frameCount: 0 });
  }

  if (included.length === 0) {
    throw new Error("No completed preview clips to stitch.");
  }
  return concatClips(projectId, "preview", "preview", included, skipped);
}

function withFrameCounts(included: Included[]): Included[] {
  return included.map((part) => ({ ...part, frameCount: probeVideoFrames(part.abs) }));
}

function seamsFor(project: Project, included: Included[]): StitchSeam[] {
  const seams: StitchSeam[] = [];
  for (let index = 1; index < included.length; index += 1) {
    const prevDur = probeDurationSec(included[index - 1].abs);
    const nextDur = probeDurationSec(included[index].abs);
    seams.push(annotateSeam(project, included[index - 1], included[index], prevDur, nextDur));
  }
  return seams;
}

async function concatClips(
  projectId: string,
  prefix: string,
  kind: StitchResult["kind"],
  included: Included[],
  skipped: StitchResult["skipped"]
): Promise<StitchResult> {
  const project = getProject(projectId);
  if (!project) throw new Error("Project not found");
  const counted = withFrameCounts(included);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const { abs: outAbs, rel } = absoluteOutputPath(projectId, `${prefix}-${stamp}.mp4`);
  const planned = seamsFor(project, counted);
  const seams = planned.some((seam) => seam.mode === "crossfade")
    ? await crossfadeJoin(project, projectId, stamp, counted, outAbs)
    : planned;
  if (!planned.some((seam) => seam.mode === "crossfade")) {
    await hardCut(
      counted,
      outAbs,
      planned.map((seam) => seam.droppedFrames)
    );
  }
  return {
    outputPath: rel,
    includedShotIds: included.map((part) => part.shotId),
    includedJobIds: included.map((part) => part.jobId),
    skipped,
    kind,
    seams,
    durationSec: probeDurationSec(outAbs),
  };
}

async function hardCut(included: Included[], outAbs: string, droppedFrames: number[]): Promise<void> {
  const drops = [0, ...droppedFrames];
  await runFfmpeg(hardCutArgs(included.map((part) => part.abs), outAbs, drops));
}

async function crossfadeJoin(
  project: Project,
  projectId: string,
  stamp: string,
  included: Included[],
  outAbs: string
): Promise<StitchSeam[]> {
  const temps: string[] = [];
  const applied: StitchSeam[] = [];
  try {
    const normalized: string[] = [];
    for (let index = 0; index < included.length; index += 1) {
      const { abs } = absoluteOutputPath(projectId, `seam-${stamp}-${index}.mp4`);
      temps.push(abs);
      await runFfmpeg([
        "-y",
        "-i",
        included[index].abs,
        "-vf",
        NORMALIZE,
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        abs,
      ]);
      normalized.push(abs);
    }
    let current = normalized[0];
    for (let index = 1; index < normalized.length; index += 1) {
      const incoming: Included = {
        ...included[index],
        abs: normalized[index],
        frameCount: probeVideoFrames(normalized[index]),
      };
      const seam = annotateSeam(
        project,
        included[index - 1],
        incoming,
        probeDurationSec(current),
        probeDurationSec(normalized[index])
      );
      applied.push(seam);
      const last = index === normalized.length - 1;
      const dest = last
        ? outAbs
        : absoluteOutputPath(projectId, `seam-${stamp}-join-${index}.mp4`).abs;
      if (!last) temps.push(dest);
      await joinPair(current, normalized[index], dest, seam);
      current = dest;
    }
    return applied;
  } finally {
    for (const file of temps) fs.rmSync(file, { force: true });
  }
}

async function joinPair(a: string, b: string, out: string, seam: StitchSeam): Promise<void> {
  if (seam.mode === "cut" || seam.fadeSec <= 0) {
    const drop = seam.mode === "cut" ? seam.droppedFrames : 0;
    await runFfmpeg([
      "-y",
      "-i",
      a,
      "-i",
      b,
      "-filter_complex",
      pairCutFilter(drop),
      "-map",
      "[v]",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      out,
    ]);
    return;
  }
  const offset = Math.max(0, probeDurationSec(a) - seam.fadeSec);
  await runFfmpeg([
    "-y",
    "-i",
    a,
    "-i",
    b,
    "-filter_complex",
    crossfadeFilter(seam.fadeSec, offset),
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    out,
  ]);
}
