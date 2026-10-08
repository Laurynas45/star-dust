import fs from "fs";
import { finishedTake } from "./continuity";
import { probeDurationSec, runFfmpeg } from "./ffmpeg";
import { absoluteOutputPath, getProject, listJobs, listShots, resolveDataPath } from "./storage";
import {
  DEFAULT_SEAM_FADE_SEC,
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
  /** Set when a requested crossfade could not be applied. */
  note?: string;
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

type Included = { shotId: string; jobId: string; abs: string; shot: Shot };

/**
 * Colour and brightness are not matched. A measured grade on a short generated
 * clip is easy to get wrong, so the seam is only a hard cut or a short crossfade.
 */
function resolveSeam(project: Project, shot: Shot, durPrev: number, durNext: number): StitchSeam {
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
    included.push({ shotId: shot.id, jobId: job.id, abs, shot });
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
    included.push({ shotId: shot.id, jobId: job.id, abs, shot });
  }

  if (included.length === 0) {
    throw new Error("No completed preview clips to stitch.");
  }
  return concatClips(projectId, "preview", "preview", included, skipped);
}

function seamsFor(project: Project, included: Included[]): StitchSeam[] {
  const seams: StitchSeam[] = [];
  for (let index = 1; index < included.length; index += 1) {
    const prevDur = probeDurationSec(included[index - 1].abs);
    const nextDur = probeDurationSec(included[index].abs);
    seams.push(resolveSeam(project, included[index].shot, prevDur, nextDur));
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
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const { abs: outAbs, rel } = absoluteOutputPath(projectId, `${prefix}-${stamp}.mp4`);
  const planned = seamsFor(project, included);
  const seams = planned.some((seam) => seam.mode === "crossfade")
    ? await crossfadeJoin(project, projectId, stamp, included, outAbs)
    : planned;
  if (!planned.some((seam) => seam.mode === "crossfade")) {
    await hardCut(included, outAbs);
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

async function hardCut(included: Included[], outAbs: string): Promise<void> {
  const filters = included.map(
    (_, index) =>
      `[${index}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p[v${index}]`
  );
  const concat =
    included.map((_, index) => `[v${index}]`).join("") +
    `concat=n=${included.length}:v=1:a=0[v]`;
  const args = ["-y"];
  for (const part of included) args.push("-i", part.abs);
  args.push(
    "-filter_complex",
    [...filters, concat].join(";"),
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outAbs
  );
  await runFfmpeg(args);
}

const NORMALIZE =
  "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p";

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
      const seam = resolveSeam(
        project,
        included[index].shot,
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
    await runFfmpeg([
      "-y",
      "-i",
      a,
      "-i",
      b,
      "-filter_complex",
      "[0:v][1:v]concat=n=2:v=1:a=0[v]",
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
    `[0:v][1:v]xfade=transition=fade:duration=${seam.fadeSec.toFixed(3)}:offset=${offset.toFixed(3)},format=yuv420p[v]`,
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
