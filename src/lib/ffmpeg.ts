import { spawn, spawnSync, type ChildProcess } from "child_process";

const processes = new Map<string, ChildProcess>();

export function killFfmpeg(jobId: string) {
  const proc = processes.get(jobId);
  if (proc && !proc.killed) proc.kill("SIGTERM");
}

export function probeDurationSec(file: string): number {
  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ],
    { encoding: "utf8" }
  );
  if (probe.error) {
    const code = (probe.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error("ffprobe is not on PATH. Install ffmpeg and try again.");
    }
    throw probe.error;
  }
  const value = Number(String(probe.stdout).trim());
  if (probe.status !== 0 || !Number.isFinite(value) || value < 0) {
    throw new Error(probe.stderr || "Could not read clip duration");
  }
  return value;
}

export interface VideoStreamInfo {
  durationSec: number;
  frames: number;
  fps: number;
  width: number;
  height: number;
}

function ffprobeError(probe: ReturnType<typeof spawnSync>, fallback: string): Error {
  if (probe.error) {
    const code = (probe.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return new Error("ffprobe is not on PATH. Install ffmpeg and try again.");
    }
    return probe.error;
  }
  return new Error(String(probe.stderr || fallback));
}

function parseFrameRate(rate: string): number {
  const [num, den] = rate.split("/").map((part) => Number(part));
  if (!Number.isFinite(num) || num <= 0) return 0;
  if (!Number.isFinite(den) || den === 0) return num;
  return num / den;
}

/** Pixel size of a still. Null when the file cannot be read. Does not invent a size. */
export function probeImageSize(file: string): { width: number; height: number } | null {
  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      file,
    ],
    { encoding: "utf8" }
  );
  if (probe.status !== 0 || probe.error) return null;
  try {
    const parsed = JSON.parse(String(probe.stdout)) as {
      streams?: { width?: unknown; height?: unknown }[];
    };
    const width = Number(parsed.streams?.[0]?.width);
    const height = Number(parsed.streams?.[0]?.height);
    if (!Number.isFinite(width) || width < 1 || !Number.isFinite(height) || height < 1) return null;
    return { width: Math.round(width), height: Math.round(height) };
  } catch {
    return null;
  }
}

/** Width, height, frame rate, and frame count of the first video stream. */
export function probeVideoStream(file: string): VideoStreamInfo {
  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-count_frames",
      "-show_entries",
      "stream=width,height,r_frame_rate,nb_read_frames,nb_frames,duration",
      "-of",
      "json",
      file,
    ],
    { encoding: "utf8" }
  );
  if (probe.status !== 0 || probe.error) {
    throw ffprobeError(probe, "Could not read the video stream");
  }
  let parsed: { streams?: Record<string, unknown>[] };
  try {
    parsed = JSON.parse(String(probe.stdout)) as { streams?: Record<string, unknown>[] };
  } catch {
    throw new Error("Could not read the video stream");
  }
  const stream = parsed.streams?.[0];
  if (!stream) throw new Error("Could not read the video stream");
  const width = Number(stream.width);
  const height = Number(stream.height);
  const fps = parseFrameRate(String(stream.r_frame_rate ?? ""));
  const readFrames = Number(stream.nb_read_frames);
  const taggedFrames = Number(stream.nb_frames);
  const streamDuration = Number(stream.duration);
  const frames = Number.isFinite(readFrames) && readFrames >= 0
    ? Math.floor(readFrames)
    : Number.isFinite(taggedFrames) && taggedFrames >= 0
      ? Math.floor(taggedFrames)
      : 0;
  if (!Number.isFinite(width) || width < 1 || !Number.isFinite(height) || height < 1 || fps <= 0) {
    throw new Error("Could not read the video stream");
  }
  const durationSec = Number.isFinite(streamDuration) && streamDuration >= 0
    ? streamDuration
    : frames > 0
      ? frames / fps
      : probeDurationSec(file);
  const resolvedFrames = frames > 0 ? frames : Math.max(1, Math.round(durationSec * fps));
  return { durationSec, frames: resolvedFrames, fps, width, height };
}

export function probeVideoFrames(file: string): number {
  return probeVideoStream(file).frames;
}

let filterList: string | null = null;

/** ffmpeg -filters text. Cached for the process. */
export function ffmpegFilters(): string {
  if (filterList != null) return filterList;
  const probe = spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" });
  if (probe.error) {
    const code = (probe.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error("ffmpeg is not on PATH. Install ffmpeg and try again.");
    }
    throw probe.error;
  }
  filterList = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`;
  return filterList;
}

export function probeHasAudio(file: string): boolean {
  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", file],
    { encoding: "utf8" }
  );
  if (probe.error) {
    const code = (probe.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error("ffprobe is not on PATH. Install ffmpeg and try again.");
    throw probe.error;
  }
  return String(probe.stdout).includes("audio");
}

export interface ClipShape {
  durationSec: number;
  fps: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

/** Frame rate, size, duration, and whether the file has an audio stream. No frame count. */
export function probeClipShape(file: string): ClipShape {
  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,width,height,r_frame_rate,duration:format=duration",
      "-of",
      "json",
      file,
    ],
    { encoding: "utf8" }
  );
  if (probe.status !== 0 || probe.error) {
    throw ffprobeError(probe, "Could not read the clip");
  }
  let parsed: { streams?: Record<string, unknown>[]; format?: { duration?: unknown } };
  try {
    parsed = JSON.parse(String(probe.stdout)) as {
      streams?: Record<string, unknown>[];
      format?: { duration?: unknown };
    };
  } catch {
    throw new Error("Could not read the clip");
  }
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  if (!video) throw new Error("Could not read the clip");
  const width = Number(video.width);
  const height = Number(video.height);
  const fps = parseFrameRate(String(video.r_frame_rate ?? ""));
  if (!Number.isFinite(width) || width < 1 || !Number.isFinite(height) || height < 1 || fps <= 0) {
    throw new Error("Could not read the clip");
  }
  const formatDuration = Number(parsed.format?.duration);
  const streamDuration = Number(video.duration);
  const durationSec =
    Number.isFinite(formatDuration) && formatDuration > 0
      ? formatDuration
      : Number.isFinite(streamDuration) && streamDuration > 0
        ? streamDuration
        : 0;
  return {
    durationSec,
    fps,
    width,
    height,
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
  };
}

export function runFfmpeg(args: string[], opts?: { jobId?: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    if (opts?.jobId) processes.set(opts.jobId, proc);
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => {
      if (opts?.jobId) processes.delete(opts.jobId);
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        reject(new Error("ffmpeg is not on PATH. Install ffmpeg and try again."));
        return;
      }
      reject(err);
    });
    proc.on("close", (code) => {
      if (opts?.jobId) processes.delete(opts.jobId);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-800)}`));
    });
  });
}
