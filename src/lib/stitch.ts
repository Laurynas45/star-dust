import fs from "fs";
import { runFfmpeg } from "./ffmpeg";
import { absoluteOutputPath, getJob, listJobs, listShots, resolveDataPath } from "./storage";

export interface StitchResult {
  outputPath: string;
  includedShotIds: string[];
  skipped: { shotId: string; position: number; reason: string }[];
}

export async function stitchProject(projectId: string): Promise<StitchResult> {
  const shots = listShots(projectId);
  const included: { shotId: string; abs: string }[] = [];
  const skipped: StitchResult["skipped"] = [];

  for (const shot of shots) {
    const jobId = latestCompletedJobId(shot.id);
    if (!jobId) {
      skipped.push({
        shotId: shot.id,
        position: shot.position,
        reason: "No completed clip",
      });
      continue;
    }
    const job = getJob(jobId);
    if (!job?.outputPath) {
      skipped.push({
        shotId: shot.id,
        position: shot.position,
        reason: "Completed job has no file",
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
    included.push({ shotId: shot.id, abs });
  }

  if (included.length === 0) {
    throw new Error("No completed shots to stitch. Render at least one shot first.");
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const { abs: outAbs, rel } = absoluteOutputPath(projectId, `stitch-${stamp}.mp4`);
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
    skipped,
  };
}

function latestCompletedJobId(shotId: string): string | undefined {
  const jobs = listJobs().filter(
    (job) => job.shotId === shotId && job.status === "completed" && job.outputPath
  );
  jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return jobs[0]?.id;
}
