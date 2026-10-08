import { startImageForMatch } from "./continuity";
import { Job, ProviderId, Shot } from "./types";

export function isPreview(job: Job): boolean {
  return job.kind === "preview";
}

/** Same provider, model, image(s), prompt, duration, and preset. Previews never match. */
export function takeInputsMatch(
  job: Job,
  shot: Shot,
  provider: ProviderId,
  modelName: string
): boolean {
  if (isPreview(job)) return false;
  if (job.provider !== provider) return false;
  if ((job.modelName ?? "") !== modelName) return false;
  if (job.imagePath !== startImageForMatch(shot)) return false;
  if ((job.endImagePath ?? "") !== (shot.endImagePath ?? "")) return false;
  if (job.prompt !== shot.prompt) return false;
  if (job.presetId !== shot.presetId) return false;
  if (job.durationSec == null || Number(job.durationSec) !== Number(shot.durationSec)) return false;
  return true;
}

export type SkipReason = "inflight" | "match";

export function skipReasonText(reason: SkipReason): string {
  if (reason === "inflight") return "Already queued or running";
  return "Completed take already matches these inputs";
}

export function classifyShot(
  shot: Shot,
  jobs: Job[],
  provider: ProviderId,
  modelName: string
): { action: "run" } | { action: "skip"; reason: SkipReason; jobId: string } {
  const takes = jobs.filter((job) => job.shotId === shot.id && !isPreview(job));
  const inflight = takes.find((job) => job.status === "queued" || job.status === "running");
  if (inflight) return { action: "skip", reason: "inflight", jobId: inflight.id };
  const matches = takes
    .filter(
      (job) =>
        job.status === "completed" &&
        Boolean(job.outputPath) &&
        takeInputsMatch(job, shot, provider, modelName)
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (matches[0]) return { action: "skip", reason: "match", jobId: matches[0].id };
  return { action: "run" };
}
