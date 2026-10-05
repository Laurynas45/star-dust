import fs from "fs";
import path from "path";
import { runFfmpeg } from "../ffmpeg";
import { absoluteOutputPath, getJob, resolveDataPath, updateJob } from "../storage";
import { presetById } from "../types";

function zoomExprs(presetId: string, zoom: number, frames: number) {
  if (presetId === "pan-right") {
    return {
      z: `min(zoom+0.0008,${zoom})`,
      x: `(iw-iw/zoom)*(on/${frames})`,
      y: `(ih-ih/zoom)/2`,
    };
  }
  if (zoom < 1) {
    const startZ = 1 / zoom;
    return {
      z: `${startZ}-(${startZ}-1)*on/${frames}`,
      x: `(iw-iw/zoom)/2`,
      y: `(ih-ih/zoom)/2`,
    };
  }
  return {
    z: `min(1+(${zoom}-1)*on/${frames},${zoom})`,
    x: `(iw-iw/zoom)/2`,
    y: `(ih-ih/zoom)/2`,
  };
}

function zoompan(presetId: string, zoom: number, frames: number, fps: number): string {
  const expr = zoomExprs(presetId, zoom, frames);
  return [
    "scale=1280:720:force_original_aspect_ratio=increase",
    "crop=1280:720",
    `zoompan=z='${expr.z}':x='${expr.x}':y='${expr.y}':d=${frames}:s=1280x720:fps=${fps}`,
    "format=yuv420p",
  ].join(",");
}

/**
 * Camera motion only. ffmpeg Ken Burns / zoompan from a still.
 * This is not an AI motion model.
 */
export async function runMockGenerate(jobId: string): Promise<void> {
  const existing = getJob(jobId);
  if (!existing || existing.status !== "queued") return;

  const job = updateJob(jobId, { status: "running", progress: 10 });
  if (!job) throw new Error("Job not found");

  const preset = presetById(job.presetId);
  const duration = job.durationSec && job.durationSec > 0 ? job.durationSec : preset.durationSec;
  const inputAbs = resolveDataPath(job.imagePath);
  if (!fs.existsSync(inputAbs)) {
    updateJob(jobId, { status: "failed", error: `Image not found: ${job.imagePath}`, progress: 0 });
    throw new Error("Image not found");
  }

  const { abs: outAbs, rel: outRel } = absoluteOutputPath(job.projectId, `${jobId}.mp4`);
  const fps = 24;
  const frames = Math.max(1, Math.round(fps * duration));
  updateJob(jobId, { progress: 30 });

  const endAbs = job.endImagePath ? resolveDataPath(job.endImagePath) : null;
  const useEnd = Boolean(endAbs && fs.existsSync(endAbs));

  let args: string[];
  if (useEnd && endAbs) {
    const fade = Math.min(0.5, duration / 4);
    const part = duration / 2 + fade / 2;
    const partFrames = Math.max(1, Math.round(part * fps));
    const offset = Math.max(0, duration / 2 - fade / 2);
    const chain = (labelIn: string, labelOut: string) =>
      `[${labelIn}]${zoompan(preset.id, preset.zoom, partFrames, fps)}[${labelOut}]`;
    const filter = [
      chain("0:v", "a"),
      chain("1:v", "b"),
      `[a][b]xfade=transition=fade:duration=${fade}:offset=${offset},format=yuv420p[v]`,
    ].join(";");
    args = [
      "-y",
      "-loop",
      "1",
      "-framerate",
      "1",
      "-t",
      "1",
      "-i",
      inputAbs,
      "-loop",
      "1",
      "-framerate",
      "1",
      "-t",
      "1",
      "-i",
      endAbs,
      "-filter_complex",
      filter,
      "-map",
      "[v]",
      "-t",
      String(duration),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outAbs,
    ];
  } else {
    args = [
      "-y",
      "-loop",
      "1",
      "-i",
      inputAbs,
      "-vf",
      zoompan(preset.id, preset.zoom, frames, fps),
      "-t",
      String(duration),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outAbs,
    ];
  }

  try {
    updateJob(jobId, { progress: 55 });
    await runFfmpeg(args, { jobId });
    if (getJob(jobId)?.status === "cancelled") return;
    updateJob(jobId, {
      status: "completed",
      progress: 100,
      outputPath: outRel.split(path.sep).join("/"),
      error: undefined,
    });
  } catch (err) {
    if (getJob(jobId)?.status === "cancelled") return;
    const message = err instanceof Error ? err.message : String(err);
    updateJob(jobId, { status: "failed", error: message, progress: 0 });
    throw err;
  }
}
