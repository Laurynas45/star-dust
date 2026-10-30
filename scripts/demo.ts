import { spawnSync } from "child_process";
import fs from "fs";
import { resolveDataPath, getProject, listJobs, listShots, updateProject } from "../src/lib/storage";
import { renderShot } from "../src/lib/render";
import { enqueueJob, waitForQueue } from "../src/lib/providers";
import { stitchProject } from "../src/lib/stitch";
import { SAMPLE_PROJECT_ID } from "../src/lib/types";

async function renderOne(projectId: string, shotId: string, prompt: string) {
  const result = renderShot(shotId);
  if (!result.ok) throw new Error(result.error);
  let jobId = result.jobs[0]?.id;
  if (jobId) {
    enqueueJob(jobId);
    await waitForQueue();
  } else {
    const existing = listJobs(projectId)
      .filter(
        (job) =>
          job.shotId === shotId &&
          job.kind !== "preview" &&
          job.status === "completed" &&
          job.outputPath
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!existing) throw new Error(result.skipped[0]?.reason || `Demo did not render ${prompt}`);
    jobId = existing.id;
  }
  const jobs = listJobs(projectId);
  const job = jobs.find((item) => item.id === jobId);
  if (!job || job.status !== "completed" || !job.outputPath) {
    throw new Error(`Demo job ${job?.status ?? "missing"}: ${job?.error ?? "no mp4"}`);
  }
  const abs = resolveDataPath(job.outputPath);
  const size = fs.statSync(abs).size;
  if (size < 1000) throw new Error(`mp4 too small (${size} bytes): ${abs}`);
  return abs;
}

async function main() {
  const project = getProject(SAMPLE_PROJECT_ID);
  if (!project) throw new Error("Sample project Harbor dusk was not seeded");
  const shots = listShots(project.id);
  if (shots.length < 2) throw new Error("Sample shot list needs two shots to crossfade");

  const clips: string[] = [];
  for (const shot of shots) {
    clips.push(await renderOne(project.id, shot.id, shot.prompt));
  }

  updateProject(project.id, { seamMode: "crossfade", seamFadeUnit: "frames", seamFadeFrames: 4 });
  const stitched = await stitchProject(project.id);
  if (!stitched.seams.some((seam) => seam.mode === "crossfade" && seam.frames === 4)) {
    throw new Error("Demo stitch did not crossfade 4 frames");
  }
  const abs = resolveDataPath(stitched.outputPath);
  const size = fs.statSync(abs).size;
  if (size < 1000) throw new Error(`stitched mp4 too small (${size} bytes)`);
  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", abs],
    { encoding: "utf8" }
  );
  if (probe.status !== 0) throw new Error(probe.stderr || "ffprobe failed");
  const duration = Number(String(probe.stdout).trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("stitched mp4 has no duration");
  if (!(stitched.overlapSec > 0.1)) throw new Error("crossfade did not shorten the join");

  console.log("Star Dust demo");
  console.log(`project: ${project.name}`);
  console.log(`shots: ${shots.map((shot) => shot.prompt).join(" | ")}`);
  console.log(`provider: mock (camera motion only, ffmpeg Ken Burns)`);
  console.log(`clips: ${clips.join(", ")}`);
  console.log(`stitched: ${abs}`);
  console.log(`bytes: ${size}`);
  console.log(`duration: ${duration}`);
  console.log(`overlap: ${stitched.overlapSec}s (4-frame crossfade)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
