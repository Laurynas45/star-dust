import { ProviderId } from "../types";
import { getJob, getSettings, listJobs, updateJob } from "../storage";
import { killFfmpeg } from "../ffmpeg";
import { runMockGenerate } from "./mock";
import { runFalGenerate } from "./fal";
import { runReplicateGenerate } from "./replicate";
import { comfyAuthHeaders, resolveComfyBase, runComfyuiGenerate } from "./comfyui";

let chain: Promise<void> = Promise.resolve();
const scheduled = new Set<string>();
let resumed = false;

export async function startJob(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job || job.status !== "queued") return;
  const provider: ProviderId = job.provider || getSettings().provider;
  switch (provider) {
    case "mock":
      await runMockGenerate(jobId);
      break;
    case "fal":
      await runFalGenerate(jobId);
      break;
    case "replicate":
      await runReplicateGenerate(jobId);
      break;
    case "comfyui":
      await runComfyuiGenerate(jobId);
      break;
    default:
      await runMockGenerate(jobId);
  }
}

export function enqueueJob(jobId: string) {
  if (scheduled.has(jobId)) return;
  scheduled.add(jobId);
  chain = chain
    .then(async () => {
      try {
        await startJob(jobId);
      } catch (err) {
        console.error(`[Star Dust] job ${jobId} failed:`, err);
      } finally {
        scheduled.delete(jobId);
      }
    })
    .catch((err) => {
      scheduled.delete(jobId);
      console.error(`[Star Dust] queue error:`, err);
    });
}

export function ensureJobWorker() {
  if (resumed) return;
  resumed = true;
  const queued = listJobs()
    .filter((job) => job.status === "queued")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const job of queued) enqueueJob(job.id);
}

export function requestCancel(jobId: string) {
  const job = getJob(jobId);
  if (!job) return undefined;
  if (job.status !== "queued" && job.status !== "running") return job;
  const updated = updateJob(jobId, {
    status: "cancelled",
    error: "Cancelled",
    progress: job.progress ?? 0,
  });
  killFfmpeg(jobId);
  if (job.provider === "comfyui") {
    const base = resolveComfyBase(getSettings()).base;
    void fetch(`${base}/interrupt`, { method: "POST", headers: comfyAuthHeaders() }).catch(() => undefined);
  }
  return updated;
}

export async function waitForQueue(): Promise<void> {
  await chain;
}
