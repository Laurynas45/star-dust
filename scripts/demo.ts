import { spawnSync } from "child_process";
import fs from "fs";
import { resolveDataPath, getJob, getProject, listJobs, listShots } from "../src/lib/storage";
import { renderShot } from "../src/lib/render";
import { enqueueJob, waitForQueue } from "../src/lib/providers";
import { SAMPLE_PROJECT_ID } from "../src/lib/types";

async function main() {
  const project = getProject(SAMPLE_PROJECT_ID);
  if (!project) throw new Error("Sample project Harbor dusk was not seeded");
  const shot = listShots(project.id)[0];
  if (!shot) throw new Error("Sample shot list is empty");

  const result = renderShot(shot.id);
  if (!result.ok) throw new Error(result.error);
  let jobId = result.jobs[0]?.id;
  if (jobId) {
    enqueueJob(jobId);
    await waitForQueue();
  } else {
    const existing = listJobs(project.id)
      .filter(
        (job) =>
          job.shotId === shot.id &&
          job.kind !== "preview" &&
          job.status === "completed" &&
          job.outputPath
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!existing) throw new Error(result.skipped[0]?.reason || "Demo did not render an mp4");
    jobId = existing.id;
  }

  const job = getJob(jobId);
  if (!job || job.status !== "completed" || !job.outputPath) {
    throw new Error(`Demo job ${job?.status ?? "missing"}: ${job?.error ?? "no mp4"}`);
  }
  const abs = resolveDataPath(job.outputPath);
  const size = fs.statSync(abs).size;
  if (size < 1000) throw new Error(`mp4 too small (${size} bytes): ${abs}`);

  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "format=duration", "-of", "default=nw=1", abs],
    { encoding: "utf8" }
  );
  if (probe.status !== 0) {
    throw new Error(probe.stderr || "ffprobe failed");
  }

  console.log("Star Dust demo");
  console.log(`project: ${project.name}`);
  console.log(`shot: ${shot.prompt}`);
  console.log(`provider: mock (camera motion only, ffmpeg Ken Burns)`);
  console.log(`mp4: ${abs}`);
  console.log(`bytes: ${size}`);
  console.log(probe.stdout.trim());
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
