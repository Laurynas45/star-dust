import fs from "fs";
import os from "os";
import path from "path";
import { runFfmpeg } from "./ffmpeg";
import { getJob, getProject, getShot, listJobs, listShots, resolveDataPath, updateJob, updateShot } from "./storage";
import { Job, Shot, effectivePrompt } from "./types";
import { storeImageIfAllowed } from "./uploads";

/** Placeholder image path. It is not the user's still, and it is not a file. */
export const CHAIN_PENDING_IMAGE = "uploads/.chain-pending";

export function chainIsFirstMessage(shot: Shot): string {
  return `Shot ${shot.position} is first in the list, so it has no previous frame. Turn off "Start from previous shot's last frame".`;
}

export function chainNeedsPreviousMessage(shot: Shot, prev: Shot): string {
  return `Shot ${shot.position} needs shot ${prev.position}'s finished take before it can start from the last frame. Render shot ${prev.position} first. Your still was not used.`;
}

export function chainProviderNote(waiting: boolean): string {
  if (waiting) {
    return "This shot waits for the previous shot's finished take, then uses that clip's last frame. Your still is not used.";
  }
  return "The start still is the last frame of the previous shot. Pose and framing can continue from that frame. Identity and details drift across chained shots. The face is not held fixed.";
}

export type ChainPlan =
  | { ok: true; imagePath: string; awaitPreviousFrame: boolean }
  | { ok: false; error: string };

export function previousShot(shot: Shot): Shot | undefined {
  const shots = listShots(shot.projectId);
  const index = shots.findIndex((item) => item.id === shot.id);
  if (index <= 0) return undefined;
  return shots[index - 1];
}

export function finishedTake(shot: Shot): Job | undefined {
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
  return [...takes].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export function inflightTake(shot: Shot): Job | undefined {
  return listJobs(shot.projectId).find(
    (job) =>
      job.shotId === shot.id &&
      job.kind !== "preview" &&
      (job.status === "queued" || job.status === "running")
  );
}

/** Image a matching take must have used. Empty when the chained frame is missing or stale. */
export function startImageForMatch(shot: Shot): string {
  if (!shot.chainFromPrevious) return shot.startImagePath ?? "";
  const prev = previousShot(shot);
  const take = prev ? finishedTake(prev) : undefined;
  if (!take || !shot.chainedStartImagePath || shot.chainedFromJobId !== take.id) return "";
  return shot.chainedStartImagePath;
}

/**
 * Decides the start still for a take.
 * A chained shot never receives the user's still unless the option is off.
 * When the previous take is not ready yet, the job waits and the provider does not start.
 */
export function planChain(shot: Shot, batchShotIds: ReadonlySet<string>): ChainPlan {
  if (!shot.chainFromPrevious) {
    if (!shot.startImagePath) {
      return { ok: false, error: `Shot ${shot.position} is missing a start image.` };
    }
    return { ok: true, imagePath: shot.startImagePath, awaitPreviousFrame: false };
  }
  const prev = previousShot(shot);
  if (!prev) return { ok: false, error: chainIsFirstMessage(shot) };
  const ready = startImageForMatch(shot);
  if (ready) return { ok: true, imagePath: ready, awaitPreviousFrame: false };
  const take = finishedTake(prev);
  const inflight = inflightTake(prev);
  if (take || inflight || batchShotIds.has(prev.id)) {
    return { ok: true, imagePath: CHAIN_PENDING_IMAGE, awaitPreviousFrame: true };
  }
  return { ok: false, error: chainNeedsPreviousMessage(shot, prev) };
}

function failChain(jobId: string, error: string): false {
  const current = getJob(jobId);
  if (!current || current.status !== "queued") return false;
  updateJob(jobId, { status: "failed", error, progress: 0, awaitPreviousFrame: false });
  return false;
}

/** Extracts the previous shot's last frame and stores it as a still. Does not replace the user's image. */
export async function resolveJobChain(jobId: string): Promise<boolean> {
  const job = getJob(jobId);
  if (!job || job.status !== "queued") return false;
  if (!job.awaitPreviousFrame) return true;
  const shot = job.shotId ? getShot(job.shotId) : undefined;
  if (!shot?.chainFromPrevious) {
    return failChain(jobId, "This shot is not set to start from the previous shot's last frame.");
  }
  const prev = previousShot(shot);
  if (!prev) return failChain(jobId, chainIsFirstMessage(shot));
  const take = finishedTake(prev);
  if (!take?.outputPath) {
    const waiting = inflightTake(prev);
    return failChain(
      jobId,
      waiting
        ? `Shot ${shot.position} is waiting on shot ${prev.position}'s take. Your still was not used.`
        : chainNeedsPreviousMessage(shot, prev)
    );
  }
  const videoAbs = resolveDataPath(take.outputPath);
  if (!fs.existsSync(videoAbs)) {
    return failChain(
      jobId,
      `Shot ${prev.position}'s clip file is missing, so shot ${shot.position} cannot start from its last frame. Your still was not used.`
    );
  }
  const temp = path.join(os.tmpdir(), `star-dust-last-${shot.id}-${take.id}.png`);
  try {
    await runFfmpeg(["-y", "-i", videoAbs, "-map", "0:v:0", "-update", "1", "-f", "image2", temp]);
    if (getJob(jobId)?.status !== "queued") return false;
    const buffer = fs.readFileSync(temp);
    const stored = storeImageIfAllowed({
      projectId: shot.projectId,
      prompt: effectivePrompt(getProject(shot.projectId)?.styleBase, shot.prompt),
      filename: "last-frame.png",
      buffer,
    });
    if (!stored.ok) return failChain(jobId, stored.error);
    updateShot(shot.id, { chainedStartImagePath: stored.path, chainedFromJobId: take.id });
    if (getJob(jobId)?.status !== "queued") return false;
    updateJob(jobId, { imagePath: stored.path, awaitPreviousFrame: false });
    return true;
  } catch (err) {
    if (getJob(jobId)?.status !== "queued") return false;
    const message = err instanceof Error ? err.message : String(err);
    return failChain(
      jobId,
      `Could not read the last frame of shot ${prev.position}. Your still was not used. ${message}`
    );
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
