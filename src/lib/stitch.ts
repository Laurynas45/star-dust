import fs from "fs";
import {
  burnInProblem,
  cuesOnTimeline,
  findBurnFont,
  formatSrt,
  readSrtFile,
  subtitlesVideoFilter,
} from "./captions";
import {
  HISTORIC_NORMALIZE,
  LOUDNORM_FILTER,
  conformVideoFilter,
  loudnessOn,
  masterLoudnessOn,
  masterLoudnormFilter,
  resolveConformTarget,
} from "./conform";
import { contactVersion, writeContactSheet } from "./contact-sheet";
import { finishedTake } from "./continuity";
import {
  probeClipShape,
  probeDurationSec,
  probeHasAudio,
  probeVideoStream,
  runFfmpeg,
  type ClipShape,
} from "./ffmpeg";
import { describeFinish, musicFilter, musicFitsByLoop } from "./music-bed";
import { absoluteOutputPath, getProject, listJobs, listShots, resolveDataPath } from "./storage";
import { probeVideoFrames } from "./ffmpeg";
import {
  DEFAULT_SEAM_FADE_SEC,
  DROPPED_FRAME_NOTE,
  FRAME_BACK_SEAM_NOTE,
  SEAM_PREVIEW_SEC,
  FinishView,
  Job,
  MIN_SEAM_FADE_SEC,
  Project,
  SeamMode,
  Shot,
  clampChainTrimStartFrames,
  clampSeamFade,
  startFrameTrimNote,
} from "./types";

export interface StitchSeam {
  position: number;
  mode: SeamMode;
  fadeSec: number;
  /** Set when a requested crossfade could not be applied, or when a repeated frame was dropped. */
  note?: string;
  /** Start frames removed from the incoming clip. 0 when this join is unchanged. */
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
  /** PNG next to the mp4. One labelled thumbnail per shot, in order. */
  contactSheetPath: string;
  /** Music bed and captions actually applied. Absent on a seam preview. */
  finish?: FinishView;
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

/** Same string the stitch used when every cut was 1280×720 at 24 fps. */
const NORMALIZE = HISTORIC_NORMALIZE;

/** Fallback when a caller does not pass the clip's own rate. A 1.5s window is then 36 frames. */
export const SEAM_PREVIEW_FPS = 24;

/** Frame span kept from one clip. A short clip keeps every frame. */
export function seamPreviewSpan(
  frameCount: number,
  edge: "head" | "tail",
  fps = SEAM_PREVIEW_FPS
): { start: number; frames: number } {
  const total = Number.isFinite(frameCount) ? Math.max(0, Math.floor(frameCount)) : 0;
  const rate = Number.isFinite(fps) && fps > 0 ? fps : SEAM_PREVIEW_FPS;
  const frames = Math.min(Math.round(SEAM_PREVIEW_SEC * rate), total);
  const start = edge === "head" ? 0 : Math.max(0, total - frames);
  return { start, frames };
}

export interface DuplicateDropInput {
  seamMode: SeamMode;
  chainFromPrevious: boolean;
  /** 0–4 start frames to trim when this join qualifies. Wins over dropEnabled. */
  trimFrames?: number;
  /** Legacy. True means trim 1, false means trim 0, when trimFrames is omitted. */
  dropEnabled?: boolean;
  previousJobId: string;
  chainedFromJobId?: string;
  /** Applied frames back. Null means an older extract, which was the last frame. */
  chainedFrameBack?: number | null;
  takeUsedChainedStill: boolean;
}

function requestedTrimFrames(input: DuplicateDropInput): number {
  if (typeof input.trimFrames === "number") return clampChainTrimStartFrames(input.trimFrames, 0);
  return input.dropEnabled ? 1 : 0;
}

/**
 * A chained hard cut can trim the incoming clip only when clip N+1 started from
 * clip N's exact last frame (applied frames back = 0). Trim 1 drops that
 * repeated frame. Trim 2–4 also drops the early frames a model often re-enacts.
 *
 * When the start still is earlier than the last frame, the frames that meet at
 * the cut are different. Trimming would remove frames that are not a copy of
 * that ending. Verified against a clip whose last frame and frame-back still
 * are different colours: the offset join is red then that earlier colour, so
 * nothing is trimmed. Crossfades and unchained shots are left unchanged.
 */
export function dropStartFramesForJoin(input: DuplicateDropInput): number {
  if (input.seamMode !== "cut") return 0;
  const requested = requestedTrimFrames(input);
  if (requested <= 0) return 0;
  if (!input.chainFromPrevious) return 0;
  if (!input.takeUsedChainedStill) return 0;
  if (!input.chainedFromJobId || input.chainedFromJobId !== input.previousJobId) return 0;
  const applied = input.chainedFrameBack == null ? 0 : input.chainedFrameBack;
  if (applied !== 0) return 0;
  return requested;
}

export function resolveChainTrimStartFrames(
  project: { chainTrimStartFrames?: number | null; dropDuplicateFrame?: boolean | null },
  shot: { chainTrimStartFrames?: number | null; dropDuplicateFrame?: boolean | null }
): number {
  if (shot.chainTrimStartFrames != null && Number.isFinite(shot.chainTrimStartFrames)) {
    return clampChainTrimStartFrames(shot.chainTrimStartFrames);
  }
  if (typeof shot.dropDuplicateFrame === "boolean") return shot.dropDuplicateFrame ? 1 : 0;
  if (project.chainTrimStartFrames != null && Number.isFinite(project.chainTrimStartFrames)) {
    return clampChainTrimStartFrames(project.chainTrimStartFrames);
  }
  if (typeof project.dropDuplicateFrame === "boolean") return project.dropDuplicateFrame ? 1 : 0;
  return 1;
}

/** True when the resolved trim removes at least one start frame. */
export function duplicateFrameDropEnabled(
  project: { chainTrimStartFrames?: number | null; dropDuplicateFrame?: boolean | null },
  shot: { chainTrimStartFrames?: number | null; dropDuplicateFrame?: boolean | null }
): boolean {
  return resolveChainTrimStartFrames(project, shot) > 0;
}

/** Never trim a clip down to zero frames. */
export function applyDropLimit(requested: number, frameCount: number): number {
  if (requested <= 0) return 0;
  if (!Number.isFinite(frameCount) || frameCount <= requested) return 0;
  return requested;
}

export function hardCutFilterComplex(dropStartFrames: number[], videoFilter = NORMALIZE): string {
  const filters = dropStartFrames.map((drop, index) => {
    const trim = drop > 0 ? `,trim=start_frame=${drop},setpts=PTS-STARTPTS` : "";
    return `[${index}:v]${videoFilter}${trim}[v${index}]`;
  });
  const concat =
    dropStartFrames.map((_, index) => `[v${index}]`).join("") +
    `concat=n=${dropStartFrames.length}:v=1:a=0[v]`;
  return [...filters, concat].join(";");
}

export function hardCutArgs(
  inputs: string[],
  output: string,
  dropStartFrames: number[],
  videoFilter = NORMALIZE
): string[] {
  const args = ["-y"];
  for (const file of inputs) args.push("-i", file);
  args.push(
    "-filter_complex",
    hardCutFilterComplex(dropStartFrames, videoFilter),
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

export function crossfadeFilter(fadeSec: number, offsetSec: number, withAudio = false): string {
  const video = `[0:v][1:v]xfade=transition=fade:duration=${fadeSec.toFixed(3)}:offset=${offsetSec.toFixed(3)},format=yuv420p[v]`;
  if (!withAudio) return video;
  return `${video};[0:a][1:a]acrossfade=d=${fadeSec.toFixed(3)}:c1=tri:c2=tri[a]`;
}

/**
 * ffmpeg args that conform one clip. The video filter uses the fps filter,
 * which duplicates or drops frames and keeps the clip's duration.
 * A silent clip gets an infinite silent source trimmed to the video with -shortest
 * when the cut needs an audio stream.
 */
export function conformClipArgs(input: {
  src: string;
  dest: string;
  videoFilter: string;
  withAudio: boolean;
  hasAudio: boolean;
}): string[] {
  if (!input.withAudio) {
    return [
      "-y",
      "-i",
      input.src,
      "-vf",
      input.videoFilter,
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      input.dest,
    ];
  }
  if (!input.hasAudio) {
    return [
      "-y",
      "-i",
      input.src,
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-vf",
      input.videoFilter,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-shortest",
      "-movflags",
      "+faststart",
      input.dest,
    ];
  }
  return [
    "-y",
    "-i",
    input.src,
    "-vf",
    input.videoFilter,
    "-af",
    "aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    input.dest,
  ];
}

/** Concat already-conformed clips, including a silent or real audio track on each. */
export function preparedConcatFilter(dropStartFrames: number[], fps: number): string {
  const filters: string[] = [];
  const parts: string[] = [];
  const rate = Math.max(1, fps);
  dropStartFrames.forEach((drop, index) => {
    const videoTrim = drop > 0 ? `trim=start_frame=${drop},setpts=PTS-STARTPTS` : "setpts=PTS-STARTPTS";
    filters.push(`[${index}:v]${videoTrim}[v${index}]`);
    const audioTrim =
      drop > 0
        ? `atrim=start=${(drop / rate).toFixed(6)},asetpts=PTS-STARTPTS`
        : "asetpts=PTS-STARTPTS";
    filters.push(`[${index}:a]${audioTrim}[a${index}]`);
    parts.push(`[v${index}][a${index}]`);
  });
  filters.push(`${parts.join("")}concat=n=${dropStartFrames.length}:v=1:a=1[v][a]`);
  return filters.join(";");
}

export function pairCutAudioFilter(dropStartFrames: number, fps: number): string {
  if (dropStartFrames <= 0) return "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]";
  const start = (dropStartFrames / Math.max(1, fps)).toFixed(6);
  return `[1:v]trim=start_frame=${dropStartFrames},setpts=PTS-STARTPTS[b];[1:a]atrim=start=${start},asetpts=PTS-STARTPTS[ba];[0:v][0:a][b][ba]concat=n=2:v=1:a=1[v][a]`;
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
  const trimFrames = resolveChainTrimStartFrames(project, next.shot);
  const requested = dropStartFramesForJoin({
    seamMode: seam.mode,
    chainFromPrevious: next.shot.chainFromPrevious,
    trimFrames,
    previousJobId: previous.jobId,
    chainedFromJobId: next.shot.chainedFromJobId,
    chainedFrameBack: next.shot.chainedFrameBack,
    takeUsedChainedStill,
  });
  const dropped = applyDropLimit(requested, next.frameCount);
  let note = seam.note;
  if (dropped > 0) {
    note = dropped === 1 ? DROPPED_FRAME_NOTE : startFrameTrimNote(dropped);
  } else if (
    !note &&
    seam.mode === "cut" &&
    trimFrames > 0 &&
    next.shot.chainFromPrevious &&
    takeUsedChainedStill &&
    next.shot.chainedFromJobId === previous.jobId &&
    (next.shot.chainedFrameBack ?? 0) > 0
  ) {
    note = FRAME_BACK_SEAM_NOTE;
  } else if (!note && requested > 0 && dropped === 0) {
    note =
      next.frameCount <= 1
        ? "This clip is a single frame, so the repeated frame was kept."
        : "This clip is too short to trim those start frames, so they were kept.";
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

/**
 * Joins between the clips the stitch would include, in that order.
 * The first clip has no join. A crossfade that does not fit becomes a hard cut.
 * A chained hard cut from the exact last frame reports the start frames removed.
 */
export function planStitchSeams(
  project: Project,
  parts: { shotId: string; jobId: string; abs: string; shot: Shot; imagePath: string }[]
): StitchSeam[] {
  return seamsFor(
    project,
    withFrameCounts(parts.map((part) => ({ ...part, frameCount: 0 })))
  );
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
  const shapes = counted.map((part) => probeClipShape(part.abs));
  const target = resolveConformTarget(project, shapes);
  const videoFilter = conformVideoFilter(target.width, target.height, target.fps);
  const anyAudio = shapes.some((shape) => shape.hasAudio);
  const withAudio = anyAudio;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const { abs: outAbs, rel } = absoluteOutputPath(projectId, `${prefix}-${stamp}.mp4`);
  const planned = seamsFor(project, counted);
  const crossfade = planned.some((seam) => seam.mode === "crossfade");
  const seams = crossfade
    ? await crossfadeJoin(project, projectId, stamp, counted, shapes, outAbs, videoFilter, withAudio, target.fps)
    : planned;
  if (!crossfade) {
    const drops = planned.map((seam) => seam.droppedFrames);
    if (withAudio) {
      await hardCutWithAudio(projectId, stamp, counted, shapes, outAbs, drops, videoFilter, target.fps);
    } else {
      await hardCut(counted, outAbs, drops, videoFilter);
    }
  }
  const decorate = prefix === "stitch" || prefix === "preview";
  const durationSec = probeDurationSec(outAbs);
  const finish = decorate
    ? await applyProgram(project, outAbs, rel, anyAudio, target.fps, durationSec)
    : undefined;
  if (!decorate && loudnessOn(project.loudnessNormalize, anyAudio)) await applyLoudnorm(outAbs);
  const jobs = listJobs(projectId);
  const { abs: sheetAbs, rel: sheetRel } = absoluteOutputPath(projectId, `${prefix}-${stamp}-contact.png`);
  await writeContactSheet(
    counted.map((part, index) => {
      const job = jobs.find((item) => item.id === part.jobId);
      if (!job) {
        throw new Error("A clip in this stitch has no take record, so the contact sheet was not written.");
      }
      const preview = job.kind === "preview";
      const pool = jobs.filter((item) => {
        if (item.shotId !== part.shotId || item.status !== "completed" || !item.outputPath) return false;
        return preview ? item.kind === "preview" : item.kind !== "preview";
      });
      const probed = shapes[index]?.durationSec ?? 0;
      return {
        abs: part.abs,
        shotId: part.shotId,
        version: contactVersion(pool, part.jobId),
        preview,
        provider: job.provider,
        seed: job.seed ?? null,
        durationSec: probed > 0 ? probed : job.durationSec ?? 0,
      };
    }),
    sheetAbs
  );
  return {
    outputPath: rel,
    includedShotIds: included.map((part) => part.shotId),
    includedJobIds: included.map((part) => part.jobId),
    skipped,
    kind,
    seams,
    durationSec: probeDurationSec(outAbs),
    contactSheetPath: sheetRel,
    finish,
  };
}

async function applyProgram(
  project: Project,
  outAbs: string,
  rel: string,
  anyClipAudio: boolean,
  fps: number,
  durationSec: number
): Promise<FinishView> {
  const musicPath = project.musicBedPath;
  let hasMusic = false;
  let musicLoops: boolean | null = null;
  if (musicPath) {
    const musicAbs = resolveDataPath(musicPath);
    if (!fs.existsSync(musicAbs)) {
      throw new Error("The music bed file is missing. Upload it again.");
    }
    if (!probeHasAudio(musicAbs)) {
      throw new Error("The music bed has no audio stream.");
    }
    if (!(durationSec > 0)) {
      throw new Error("The stitch has no duration, so the music bed was not mixed.");
    }
    musicLoops = musicFitsByLoop(probeDurationSec(musicAbs), durationSec);
    const mixed = `${outAbs}.music.mp4`;
    try {
      await runFfmpeg([
        "-y",
        "-i",
        outAbs,
        "-stream_loop",
        "-1",
        "-i",
        musicAbs,
        "-filter_complex",
        musicFilter({
          durationSec,
          levelDb: project.musicLevelDb,
          fadeInSec: project.musicFadeInSec,
          fadeOutSec: project.musicFadeOutSec,
          duck: anyClipAudio,
        }),
        "-map",
        "0:v:0",
        "-map",
        "[a]",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-shortest",
        "-movflags",
        "+faststart",
        mixed,
      ]);
      fs.renameSync(mixed, outAbs);
      hasMusic = true;
    } catch (error) {
      fs.rmSync(mixed, { force: true });
      throw error;
    }
  }

  let captionCount = 0;
  let captionMode = project.captionMode;
  let sidecarPath: string | undefined;
  if (project.captionsPath) {
    const captionsAbs = resolveDataPath(project.captionsPath);
    if (!fs.existsSync(captionsAbs)) {
      throw new Error("The SRT file is missing. Import it again.");
    }
    const parsed = readSrtFile(captionsAbs);
    if (parsed.errors.length > 0) {
      throw new Error(parsed.errors.join(" "));
    }
    const cues = cuesOnTimeline(parsed.cues, fps, durationSec);
    if (cues.length === 0) {
      throw new Error("Every caption sits past the end of this cut, so nothing was written.");
    }
    captionCount = cues.length;
    if (captionMode !== "burn" && captionMode !== "sidecar") captionMode = "burn";
    const srtAbs = outAbs.replace(/\.mp4$/i, ".srt");
    fs.writeFileSync(srtAbs, formatSrt(cues));
    if (captionMode === "sidecar") {
      sidecarPath = rel.replace(/\.mp4$/i, ".srt");
    } else {
      const problem = burnInProblem();
      if (problem) {
        fs.rmSync(srtAbs, { force: true });
        throw new Error(problem);
      }
      const font = findBurnFont();
      if (!font) {
        fs.rmSync(srtAbs, { force: true });
        throw new Error("Burn-in needs DejaVu Sans from the fonts-dejavu-core package.");
      }
      const burned = `${outAbs}.burn.mp4`;
      const audioArgs = probeHasAudio(outAbs) ? ["-c:a", "copy"] : ["-an"];
      try {
        await runFfmpeg([
          "-y",
          "-i",
          outAbs,
          "-vf",
          subtitlesVideoFilter(srtAbs, font),
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          ...audioArgs,
          "-movflags",
          "+faststart",
          burned,
        ]);
        fs.renameSync(burned, outAbs);
        fs.rmSync(srtAbs, { force: true });
      } catch (error) {
        fs.rmSync(burned, { force: true });
        fs.rmSync(srtAbs, { force: true });
        const message = error instanceof Error ? error.message : "Burn-in failed.";
        throw new Error(
          message.includes("Burn-in") ? message : `Burn-in failed. Captions were not drawn. ${message}`
        );
      }
    }
  }

  const mastered = masterLoudnessOn(project.loudnessNormalize, anyClipAudio, hasMusic);
  if (mastered) await applyLoudnorm(outAbs, masterLoudnormFilter(hasMusic));
  const view = describeFinish({
    hasMusic,
    anyClipAudio,
    captionCount,
    captionMode: captionCount > 0 ? captionMode : null,
    loudnessOn: mastered,
    musicLoops,
  });
  if (sidecarPath) view.sidecarPath = sidecarPath;
  return view;
}

async function hardCut(
  included: Included[],
  outAbs: string,
  droppedFrames: number[],
  videoFilter: string
): Promise<void> {
  const drops = [0, ...droppedFrames];
  await runFfmpeg(hardCutArgs(included.map((part) => part.abs), outAbs, drops, videoFilter));
}

async function hardCutWithAudio(
  projectId: string,
  stamp: string,
  included: Included[],
  shapes: ClipShape[],
  outAbs: string,
  droppedFrames: number[],
  videoFilter: string,
  fps: number
): Promise<void> {
  const temps: string[] = [];
  try {
    const prepared: string[] = [];
    for (let index = 0; index < included.length; index += 1) {
      const { abs } = absoluteOutputPath(projectId, `conform-${stamp}-${index}.mp4`);
      temps.push(abs);
      await runFfmpeg(
        conformClipArgs({
          src: included[index].abs,
          dest: abs,
          videoFilter,
          withAudio: true,
          hasAudio: shapes[index]?.hasAudio ?? false,
        })
      );
      prepared.push(abs);
    }
    const drops = [0, ...droppedFrames];
    await runFfmpeg([
      "-y",
      ...prepared.flatMap((file) => ["-i", file]),
      "-filter_complex",
      preparedConcatFilter(drops, fps),
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-movflags",
      "+faststart",
      outAbs,
    ]);
  } finally {
    for (const file of temps) fs.rmSync(file, { force: true });
  }
}

async function applyLoudnorm(file: string, filter: string = LOUDNORM_FILTER): Promise<void> {
  const temp = `${file}.loud.mp4`;
  try {
    await runFfmpeg([
      "-y",
      "-i",
      file,
      "-af",
      filter,
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-ar",
      "48000",
      "-movflags",
      "+faststart",
      temp,
    ]);
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

async function crossfadeJoin(
  project: Project,
  projectId: string,
  stamp: string,
  included: Included[],
  shapes: ClipShape[],
  outAbs: string,
  videoFilter: string,
  withAudio: boolean,
  fps: number
): Promise<StitchSeam[]> {
  const temps: string[] = [];
  const applied: StitchSeam[] = [];
  try {
    const normalized: string[] = [];
    for (let index = 0; index < included.length; index += 1) {
      const { abs } = absoluteOutputPath(projectId, `seam-${stamp}-${index}.mp4`);
      temps.push(abs);
      await runFfmpeg(
        conformClipArgs({
          src: included[index].abs,
          dest: abs,
          videoFilter,
          withAudio,
          hasAudio: shapes[index]?.hasAudio ?? false,
        })
      );
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
      await joinPair(current, normalized[index], dest, seam, withAudio, fps);
      current = dest;
    }
    return applied;
  } finally {
    for (const file of temps) fs.rmSync(file, { force: true });
  }
}

async function joinPair(
  a: string,
  b: string,
  out: string,
  seam: StitchSeam,
  withAudio: boolean,
  fps: number
): Promise<void> {
  const audioOut = withAudio
    ? ["-map", "[a]", "-c:a", "aac", "-ar", "48000", "-ac", "2"]
    : [];
  if (seam.mode === "cut" || seam.fadeSec <= 0) {
    const drop = seam.mode === "cut" ? seam.droppedFrames : 0;
    await runFfmpeg([
      "-y",
      "-i",
      a,
      "-i",
      b,
      "-filter_complex",
      withAudio ? pairCutAudioFilter(drop, fps) : pairCutFilter(drop),
      "-map",
      "[v]",
      ...audioOut,
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
    crossfadeFilter(seam.fadeSec, offset, withAudio),
    "-map",
    "[v]",
    ...audioOut,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    out,
  ]);
}

async function trimWindow(src: string, dest: string, edge: "head" | "tail"): Promise<void> {
  const info = probeVideoStream(src);
  const span = seamPreviewSpan(info.frames, edge, info.fps);
  if (span.frames < 1) throw new Error("The clip has no video frames.");
  const end = span.start + span.frames;
  await runFfmpeg([
    "-y",
    "-i",
    src,
    "-vf",
    `trim=start_frame=${span.start}:end_frame=${end},setpts=PTS-STARTPTS`,
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    dest,
  ]);
}

/**
 * A short local mp4 of one join: about the last 1.5s of the previous take
 * and the first 1.5s of the next, with the same hard cut or crossfade the
 * full stitch uses. ffmpeg only. Does not create or replace a take.
 */
export async function previewSeam(projectId: string, shotId: string): Promise<StitchResult> {
  const project = getProject(projectId);
  if (!project) throw new Error("Project not found");
  const shots = listShots(projectId);
  const index = shots.findIndex((shot) => shot.id === shotId);
  if (index < 0) throw new Error("Shot not found");
  if (index === 0) throw new Error("The first shot has no join to preview.");
  const prev = shots[index - 1];
  const next = shots[index];
  const prevTake = finishedTake(prev);
  const nextTake = finishedTake(next);
  if (!prevTake?.outputPath || !nextTake?.outputPath) {
    throw new Error("Both shots need a finished take before this join can be previewed.");
  }
  const prevAbs = resolveDataPath(prevTake.outputPath);
  const nextAbs = resolveDataPath(nextTake.outputPath);
  if (!fs.existsSync(prevAbs) || !fs.existsSync(nextAbs)) {
    throw new Error("A clip file is missing, so this join cannot be previewed.");
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const prevTrim = absoluteOutputPath(projectId, `seam-preview-src-${stamp}-prev.mp4`);
  const nextTrim = absoluteOutputPath(projectId, `seam-preview-src-${stamp}-next.mp4`);
  try {
    await trimWindow(prevAbs, prevTrim.abs, "tail");
    await trimWindow(nextAbs, nextTrim.abs, "head");
    const included: Included[] = [
      {
        shotId: prev.id,
        jobId: prevTake.id,
        abs: prevTrim.abs,
        shot: prev,
        imagePath: prevTake.imagePath,
        frameCount: 0,
      },
      {
        shotId: next.id,
        jobId: nextTake.id,
        abs: nextTrim.abs,
        shot: next,
        imagePath: nextTake.imagePath,
        frameCount: 0,
      },
    ];
    return await concatClips(projectId, "seam-preview", "takes", included, []);
  } finally {
    fs.rmSync(prevTrim.abs, { force: true });
    fs.rmSync(nextTrim.abs, { force: true });
  }
}
