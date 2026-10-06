import fs from "fs";
import { runFfmpeg } from "./ffmpeg";
import { absoluteOutputPath, listJobs, listShots, resolveDataPath } from "./storage";
import { Job, Shot } from "./types";

export interface StitchResult {
  outputPath: string;
  includedShotIds: string[];
  includedJobIds: string[];
  skipped: { shotId: string; position: number; reason: string }[];
  kind: "takes" | "preview";
}

function newestCompleted(jobs: Job[]): Job | undefined {
  return [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function takeForStitch(shot: Shot): Job | undefined {
  const takes = listJobs(shot.projectId).filter(
    (job) =>
      job.shotId === shot.id &&
      job.kind !== "preview" &&
      job.status === "completed" &&
      job.outputPath
  );
  if (shot.selectedJobId) {
    const chosen = takes.find((job) => job.id === shot.selectedJobId);
    if (chosen) return chosen;
  }
  return newestCompleted(takes);
}

export async function stitchProject(projectId: string): Promise<StitchResult> {
  const shots = listShots(projectId);
  const included: { shotId: string; jobId: string; abs: string }[] = [];
  const skipped: StitchResult["skipped"] = [];

  for (const shot of shots) {
    const job = takeForStitch(shot);
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
    included.push({ shotId: shot.id, jobId: job.id, abs });
  }

  if (included.length === 0) {
    throw new Error("No completed shots to stitch. Render at least one shot first.");
  }
  return concatClips(projectId, "stitch", "takes", included, skipped);
}

export async function stitchPreview(projectId: string, jobIds: string[]): Promise<StitchResult> {
  const wanted = new Set(jobIds);
  const shots = listShots(projectId);
  const included: { shotId: string; jobId: string; abs: string }[] = [];
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
    included.push({ shotId: shot.id, jobId: job.id, abs });
  }

  if (included.length === 0) {
    throw new Error("No completed preview clips to stitch.");
  }
  return concatClips(projectId, "preview", "preview", included, skipped);
}

async function concatClips(
  projectId: string,
  prefix: string,
  kind: StitchResult["kind"],
  included: { shotId: string; jobId: string; abs: string }[],
  skipped: StitchResult["skipped"]
): Promise<StitchResult> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const { abs: outAbs, rel } = absoluteOutputPath(projectId, `${prefix}-${stamp}.mp4`);
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
  return {
    outputPath: rel,
    includedShotIds: included.map((part) => part.shotId),
    includedJobIds: included.map((part) => part.jobId),
    skipped,
    kind,
  };
}
