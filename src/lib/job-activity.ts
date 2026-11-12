/**
 * Live phase for a running job. Kept in memory for this process.
 * Not written to SQLite and not part of the take content key.
 */
import {
  ComfySnapshot,
  comfySnapshotHasSignal,
  formatComfySnapshot,
  formatElapsed,
  samplingPercent,
} from "./comfy-progress";
import { Job } from "./types";

export interface JobActivity {
  /** Plain text. No URL and no auth header. */
  label: string;
  /** Sampler step as a percent. Absent when ComfyUI has not reported a step. */
  percent?: number;
}

export interface ComfyLive {
  snapshot: ComfySnapshot;
  wsOpen: boolean;
  socketDown: boolean;
}

type Entry = {
  startedAt: number;
  live?: ComfyLive;
};

const entries = new Map<string, Entry>();

export function noteRunStarted(jobId: string, at = Date.now()): void {
  const current = entries.get(jobId);
  if (current) return;
  entries.set(jobId, { startedAt: at });
}

export function setComfyLive(jobId: string, live: ComfyLive): void {
  const current = entries.get(jobId) ?? { startedAt: Date.now() };
  current.live = live;
  entries.set(jobId, current);
}

export function clearJobActivity(jobId: string): void {
  entries.delete(jobId);
}

function startedAtFor(job: Job, entry: Entry | undefined): number {
  if (entry) return entry.startedAt;
  const parsed = Date.parse(job.createdAt);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** Label for a queued or running job. Other providers are elapsed time only. */
export function activityFor(job: Job, now = Date.now()): JobActivity | undefined {
  if (job.status !== "queued" && job.status !== "running") return undefined;
  const entry = entries.get(job.id);
  const elapsed = formatElapsed(now - startedAtFor(job, entry));
  const live = entry?.live;
  if (job.provider !== "comfyui" || !live || !comfySnapshotHasSignal(live.snapshot)) {
    return { label: elapsed };
  }
  if (live.socketDown && !live.snapshot.seenExecution && live.snapshot.phase !== "queued") {
    return { label: elapsed };
  }
  const percent = samplingPercent(live.snapshot);
  return {
    label: formatComfySnapshot(live.snapshot, elapsed),
    ...(percent != null ? { percent } : {}),
  };
}

/** Attach the live line for the UI. Completed jobs are unchanged. */
export function presentJob(job: Job, now = Date.now()): Job {
  if (job.status !== "queued" && job.status !== "running") {
    entries.delete(job.id);
    return job;
  }
  const activity = activityFor(job, now);
  if (!activity) return job;
  return { ...job, activity };
}
