import fs from "fs";
import os from "os";
import path from "path";
import { chainedStillMatchesTake, completedTakesFor, cutIsPinned, cutTake } from "./chain-stale";
import { probeVideoFrames, runFfmpeg } from "./ffmpeg";
import { getJob, getProject, getShot, listJobs, listShots, resolveDataPath, updateJob, updateShot } from "./storage";
import { Job, Shot, chainFramePhrase, clampChainFrameBack, effectivePrompt, frameIndexFromEnd } from "./types";
import { storeImageIfAllowed } from "./uploads";

/** Placeholder image path. It is not the user's still, and it is not a file. */
export const CHAIN_PENDING_IMAGE = "uploads/.chain-pending";

export function chainIsFirstMessage(shot: Shot): string {
  return `Shot ${shot.position} is first in the list, so it has no previous frame. Turn off "Start from previous shot's last frame".`;
}

export function chainNeedsPreviousMessage(shot: Shot, prev: Shot): string {
  const frame = chainFramePhrase(shot.chainFrameBack ?? 0);
  return `Shot ${shot.position} needs shot ${prev.position}'s finished take before it can start from the ${frame}. Render shot ${prev.position} first. Your still was not used.`;
}

export function chainProviderNote(waiting: boolean, framesBack = 0): string {
  const back = clampChainFrameBack(framesBack);
  const frame = chainFramePhrase(back);
  if (waiting) {
    if (back === 0) {
      return "This shot waits for the previous shot's finished take, then uses that clip's last frame. Your still is not used.";
    }
    return `This shot waits for the previous shot's finished take, then uses the ${frame}. Your still is not used. The ending frame is often soft. Identity and details still drift.`;
  }
  if (back === 0) {
    return "The start still is the last frame of the previous shot. Pose and framing can continue from that frame. Identity and details drift across chained shots. The face is not held fixed.";
  }
  return `The start still is the ${frame} of the previous shot. The ending frame is often soft. Pose and framing can continue from that frame. Identity and details drift across chained shots. The face is not held fixed.`;
}

/** True when the stored still came from this take at the shot's current frame choice. */
export function chainedStillIsCurrent(shot: Shot, takeId: string): boolean {
  return chainedStillMatchesTake(shot, takeId);
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
  const takes = completedTakesFor(listJobs(shot.projectId), shot.id);
  return cutTake(shot.selectedJobId, takes);
}

/** True when the stitch is pinned to a chosen take, so a newer render does not replace it. */
export function cutTakeIsPinned(shot: Shot): boolean {
  return cutIsPinned(shot.selectedJobId, completedTakesFor(listJobs(shot.projectId), shot.id));
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
  if (!take || !chainedStillIsCurrent(shot, take.id)) return "";
  return shot.chainedStartImagePath ?? "";
}

/**
 * Decides the start still for a take.
 * A chained shot never receives the user's still unless the option is off.
 * When the previous take is not ready yet, the job waits and the provider does not start.
 * When this batch will replace the previous shot's take, the job also waits, even if a
 * still from the take that is about to leave the cut is already on disk.
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
  const inflight = inflightTake(prev);
  const prevWillReplace =
    batchShotIds.has(prev.id) || (Boolean(inflight) && !cutTakeIsPinned(prev));
  if (prevWillReplace) {
    return { ok: true, imagePath: CHAIN_PENDING_IMAGE, awaitPreviousFrame: true };
  }
  const ready = startImageForMatch(shot);
  if (ready) return { ok: true, imagePath: ready, awaitPreviousFrame: false };
  const take = finishedTake(prev);
  if (take || inflight) {
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

/**
 * Reads one frame near the end of a clip. framesBack 0 is the last frame.
 * The returned appliedBack is 0 only when the still is that exact last frame.
 */
export async function extractVideoFrame(
  videoAbs: string,
  framesBack: number,
  dest: string
): Promise<{ index: number; appliedBack: number; frameCount: number }> {
  const frameCount = probeVideoFrames(videoAbs);
  if (frameCount < 1) throw new Error("The clip has no video frames.");
  const picked = frameIndexFromEnd(frameCount, framesBack);
  await runFfmpeg([
    "-y",
    "-i",
    videoAbs,
    "-vf",
    `select=eq(n\\,${picked.index})`,
    "-frames:v",
    "1",
    "-f",
    "image2",
    dest,
  ]);
  return { frameCount, index: picked.index, appliedBack: picked.appliedBack };
}

/** Extracts a frame near the end of the previous shot and stores it as a still. Does not replace the user's image. */
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
      `Shot ${prev.position}'s clip file is missing, so shot ${shot.position} cannot start from its ${chainFramePhrase(shot.chainFrameBack ?? 0)}. Your still was not used.`
    );
  }
  const requested = clampChainFrameBack(shot.chainFrameBack ?? 0);
  const temp = path.join(os.tmpdir(), `star-dust-frame-${shot.id}-${take.id}.png`);
  try {
    const picked = await extractVideoFrame(videoAbs, requested, temp);
    if (getJob(jobId)?.status !== "queued") return false;
    const buffer = fs.readFileSync(temp);
    const stored = storeImageIfAllowed({
      projectId: shot.projectId,
      prompt: effectivePrompt(getProject(shot.projectId)?.styleBase, shot.prompt),
      filename: requested === 0 ? "last-frame.png" : `frame-back-${picked.appliedBack}.png`,
      buffer,
    });
    if (!stored.ok) return failChain(jobId, stored.error);
    updateShot(shot.id, {
      chainedStartImagePath: stored.path,
      chainedFromJobId: take.id,
      chainedFrameBack: picked.appliedBack,
      chainedFrameRequest: requested,
    });
    if (getJob(jobId)?.status !== "queued") return false;
    updateJob(jobId, { imagePath: stored.path, awaitPreviousFrame: false });
    return true;
  } catch (err) {
    if (getJob(jobId)?.status !== "queued") return false;
    const message = err instanceof Error ? err.message : String(err);
    return failChain(
      jobId,
      `Could not read the ${chainFramePhrase(requested)} of shot ${prev.position}. Your still was not used. ${message}`
    );
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
