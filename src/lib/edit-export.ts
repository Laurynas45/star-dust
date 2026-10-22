import { createHash } from "crypto";
import fs from "fs";
import JSZip from "jszip";
import { completedTakesFor, cutTake } from "./chain-stale";
import { probeVideoStream, type VideoStreamInfo } from "./ffmpeg";
import { COMFY_WORKFLOWS, comfyWorkflowFromModelName } from "./provider-info";
import { getProject, listJobs, listShots, resolveDataPath } from "./storage";
import { planStitchSeams } from "./stitch";
import {
  Job,
  ProviderId,
  Shot,
  chainFramePhrase,
  styleBaseText,
} from "./types";

/** Review timeline rate. The stitch normalizes every clip to this before a join. */
export const EDIT_FPS = 24;

export interface ChainSource {
  fromShot: string | null;
  fromVersion: number | null;
  fromFilename: string | null;
  framesBack: number;
  frame: string;
}

export interface TakeManifest {
  shot: string;
  version: number;
  filename: string;
  prompt: string;
  sharedStyleText: string;
  provider: ProviderId;
  comfyuiWorkflowName: string | null;
  seed: number | null;
  frames: number;
  fps: number;
  width: number;
  height: number;
  size: string;
  chainSource: ChainSource | null;
  sourceStillSha256: string;
}

export interface EditEvent {
  filename: string;
  reel: string;
  transition: "C" | "D";
  dissolveFrames: number;
  srcInFrame: number;
  srcOutFrame: number;
  recInFrame: number;
  recOutFrame: number;
}

const SENSITIVE_ENV =
  /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|AUTH|LICENSE)(?:_|$)|COMFYUI_(?:BASE_URL|AUTH_HEADER)/i;

/** Values from the environment that must not be written into an export. */
export function sensitiveEnvValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || !SENSITIVE_ENV.test(name)) continue;
    const trimmed = value.trim();
    if (trimmed.length < 8) continue;
    values.push(trimmed);
  }
  return values;
}

export function assertExportHasNoSecrets(text: string, env: NodeJS.ProcessEnv = process.env): void {
  for (const value of sensitiveEnvValues(env)) {
    if (text.includes(value)) {
      throw new Error(
        "Export blocked because it would include an API key, auth header, or environment value."
      );
    }
  }
}

/** Shot 1 is SH010, shot 2 is SH020, so a later insert can sit between them. */
export function shotCode(position: number): string {
  const number = Math.max(1, Math.round(position)) * 10;
  return `SH${String(number).padStart(3, "0")}`;
}

export function versionLabel(version: number): string {
  const number = Math.max(1, Math.round(version));
  return `v${String(number).padStart(2, "0")}`;
}

/** Stable name for one take. A later take gets a higher version and a different file name. */
export function takeFilename(position: number, version: number): string {
  return `${shotCode(position)}_${versionLabel(version)}.mp4`;
}

export function orderedTakes<T extends { id: string; createdAt: string }>(takes: readonly T[]): T[] {
  return [...takes].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  );
}

/** 1-based place of this take among the shot's completed takes, oldest first. */
export function takeVersion(takesOldestFirst: readonly { id: string }[], jobId: string): number {
  const index = takesOldestFirst.findIndex((take) => take.id === jobId);
  if (index < 0) {
    throw new Error("That take is not one of this shot's completed takes.");
  }
  return index + 1;
}

export function framesToTimecode(frame: number, fps = EDIT_FPS): string {
  const whole = Math.max(0, Math.round(frame));
  const ff = whole % fps;
  const totalSec = Math.floor(whole / fps);
  const ss = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const mm = totalMin % 60;
  const hh = Math.floor(totalMin / 60);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

export function dissolveFrames(fadeSec: number): number {
  if (!Number.isFinite(fadeSec) || fadeSec <= 0) return 0;
  return Math.max(0, Math.round(fadeSec * EDIT_FPS));
}

/** Frame count on the 24 fps review timeline the stitch builds. */
export function reviewFrames(info: VideoStreamInfo): number {
  if (Math.abs(info.fps - EDIT_FPS) < 0.05) return Math.max(1, info.frames);
  return Math.max(1, Math.round(info.durationSec * EDIT_FPS));
}

/**
 * CMX3600 events for the included clips.
 * A hard cut butts the next record in against the previous record out, and a
 * start-frame trim moves the source in point. A crossfade overlaps by the
 * dissolve length, which is the stitch fade converted at 24 fps.
 */
export function timelineEvents(
  clips: { filename: string; frames: number }[],
  seams: { mode: "cut" | "crossfade"; fadeSec: number; droppedFrames: number }[]
): EditEvent[] {
  let timelineEnd = 0;
  return clips.map((clip, index) => {
    const seam = index === 0 ? undefined : seams[index - 1];
    const drop = seam?.mode === "cut" ? Math.max(0, Math.round(seam.droppedFrames)) : 0;
    const fade = seam?.mode === "crossfade" ? dissolveFrames(seam.fadeSec) : 0;
    const frames = Math.max(1, Math.round(clip.frames));
    const srcIn = Math.min(drop, frames - 1);
    const srcOut = frames;
    const used = Math.max(1, srcOut - srcIn);
    const overlap = Math.min(fade, timelineEnd);
    const recIn = timelineEnd - overlap;
    const recOut = recIn + used;
    timelineEnd = recOut;
    return {
      filename: clip.filename,
      reel: clip.filename.replace(/\.mp4$/i, ""),
      transition: overlap > 0 ? "D" : "C",
      dissolveFrames: overlap,
      srcInFrame: srcIn,
      srcOutFrame: srcOut,
      recInFrame: recIn,
      recOutFrame: recOut,
    };
  });
}

export function formatCmx3600(title: string, events: EditEvent[]): string {
  const safeTitle = title.replace(/[\r\n]+/g, " ").trim() || "Star Dust";
  const lines = [
    `TITLE: ${safeTitle}`,
    "FCM: NON-DROP FRAME",
    "*",
    "* STAR DUST EXPORT",
    "* Cuts, dissolves, and in/out only. This is not a Premiere or Resolve project.",
    "* MP4 is a review codec, not a mastering codec.",
    "* Timecode is 24 fps non-drop, the review rate the stitch uses.",
    "* This does not lock a character, lip-sync, or build a long film.",
    "",
  ];
  events.forEach((event, index) => {
    const number = String(index + 1).padStart(3, "0");
    const reel = event.reel.length >= 8 ? event.reel : event.reel.padEnd(8, " ");
    const transition =
      event.transition === "D"
        ? `D    ${String(event.dissolveFrames).padStart(3, "0")}`
        : "C       ";
    lines.push(
      `${number}  ${reel} V     ${transition} ${framesToTimecode(event.srcInFrame)} ${framesToTimecode(event.srcOutFrame)} ${framesToTimecode(event.recInFrame)} ${framesToTimecode(event.recOutFrame)}`
    );
    lines.push(`* FROM CLIP NAME: ${event.filename}`);
  });
  lines.push("");
  return lines.join("\n");
}

function workflowName(job: Job): string | null {
  if (job.provider !== "comfyui") return null;
  const id = comfyWorkflowFromModelName(job.modelName);
  if (!id) return job.modelName?.replace(/\s*·\s*low-memory preset\s*$/i, "").trim() || null;
  const info = COMFY_WORKFLOWS[id];
  return `${info.title} (${info.file})`;
}

function roundFps(fps: number): number {
  return Math.round(fps * 1000) / 1000;
}

function chainSourceFor(shot: Shot, job: Job, shots: Shot[], jobs: Job[]): ChainSource | null {
  if (!shot.chainFromPrevious) return null;
  if (!shot.chainedStartImagePath || job.imagePath !== shot.chainedStartImagePath) return null;
  const framesBack = shot.chainedFrameBack == null ? 0 : shot.chainedFrameBack;
  const fromJob = shot.chainedFromJobId
    ? jobs.find((item) => item.id === shot.chainedFromJobId)
    : undefined;
  const fromShot = fromJob?.shotId ? shots.find((item) => item.id === fromJob.shotId) : undefined;
  if (!fromShot || !fromJob) {
    return {
      fromShot: null,
      fromVersion: null,
      fromFilename: null,
      framesBack,
      frame: chainFramePhrase(framesBack),
    };
  }
  const takes = orderedTakes(completedTakesFor(jobs, fromShot.id));
  const version = takes.some((take) => take.id === fromJob.id) ? takeVersion(takes, fromJob.id) : null;
  return {
    fromShot: shotCode(fromShot.position),
    fromVersion: version,
    fromFilename: version == null ? null : takeFilename(fromShot.position, version),
    framesBack,
    frame: chainFramePhrase(framesBack),
  };
}

function manifestFor(
  shot: Shot,
  job: Job,
  version: number,
  sharedStyleText: string,
  info: VideoStreamInfo,
  shots: Shot[],
  jobs: Job[]
): TakeManifest {
  const stillAbs = resolveDataPath(job.imagePath);
  if (!fs.existsSync(stillAbs)) {
    throw new Error(`Source still is missing for shot ${shot.position}.`);
  }
  const sourceStillSha256 = createHash("sha256").update(fs.readFileSync(stillAbs)).digest("hex");
  return {
    shot: shotCode(shot.position),
    version,
    filename: takeFilename(shot.position, version),
    prompt: job.prompt,
    sharedStyleText,
    provider: job.provider,
    comfyuiWorkflowName: workflowName(job),
    seed: job.seed == null ? null : job.seed,
    frames: info.frames,
    fps: roundFps(info.fps),
    width: info.width,
    height: info.height,
    size: `${info.width}x${info.height}`,
    chainSource: chainSourceFor(shot, job, shots, jobs),
    sourceStillSha256,
  };
}

function zipSlug(name: string): string {
  const slug = name.replace(/[^a-z0-9-_]+/gi, "-").replace(/^-|-$/g, "");
  return slug || "star-dust";
}

export interface EditExport {
  filename: string;
  bytes: Buffer;
  edl: string;
  manifests: TakeManifest[];
}

/**
 * Zip of the take each shot would stitch: the approved take when one is set,
 * otherwise the current take. One mp4 and one JSON manifest per take, plus a
 * CMX3600 EDL. API keys, auth headers, and environment values are not written.
 */
export async function buildEditExport(projectId: string): Promise<EditExport> {
  const project = getProject(projectId);
  if (!project) throw new Error("Project not found");
  const shots = listShots(projectId);
  const jobs = listJobs(projectId);
  const sharedStyle = styleBaseText(project.styleBase);
  const chosen: {
    shot: Shot;
    job: Job;
    abs: string;
    version: number;
    filename: string;
    info: VideoStreamInfo;
  }[] = [];

  for (const shot of shots) {
    const takes = orderedTakes(completedTakesFor(jobs, shot.id));
    const job = cutTake(shot.selectedJobId, takes, shot.approvedJobId);
    if (!job?.outputPath) continue;
    const abs = resolveDataPath(job.outputPath);
    if (!fs.existsSync(abs)) continue;
    const version = takeVersion(takes, job.id);
    chosen.push({
      shot,
      job,
      abs,
      version,
      filename: takeFilename(shot.position, version),
      info: probeVideoStream(abs),
    });
  }

  if (chosen.length === 0) {
    throw new Error("No completed shots to export. Render at least one shot first.");
  }

  const filenames = new Set<string>();
  for (const part of chosen) {
    if (filenames.has(part.filename)) {
      throw new Error(`Two takes would share ${part.filename}. Export stopped so nothing is overwritten.`);
    }
    filenames.add(part.filename);
  }

  const seams = planStitchSeams(
    project,
    chosen.map((part) => ({
      shotId: part.shot.id,
      jobId: part.job.id,
      abs: part.abs,
      shot: part.shot,
      imagePath: part.job.imagePath,
    }))
  );
  const events = timelineEvents(
    chosen.map((part) => ({ filename: part.filename, frames: reviewFrames(part.info) })),
    seams
  );
  const edl = formatCmx3600(project.name, events);
  const manifests = chosen.map((part) =>
    manifestFor(part.shot, part.job, part.version, sharedStyle, part.info, shots, jobs)
  );

  const zip = new JSZip();
  zip.file("cut.edl", edl);
  chosen.forEach((part, index) => {
    zip.file(part.filename, fs.readFileSync(part.abs));
    zip.file(part.filename.replace(/\.mp4$/i, ".json"), `${JSON.stringify(manifests[index], null, 2)}\n`);
  });

  const text = [edl, ...manifests.map((item) => JSON.stringify(item)), ...Array.from(filenames)].join("\n");
  assertExportHasNoSecrets(text);

  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  return {
    filename: `${zipSlug(project.name)}-edit.zip`,
    bytes,
    edl,
    manifests,
  };
}
