import { ChainStaleJob, chainStaleMarks, completedTakesFor, cutIsPinned, takeFieldsMatch } from "./chain-stale";
import { startImageForMatch } from "./continuity";
import { getProject } from "./storage";
import { Job, ProviderId, Shot } from "./types";

export function isPreview(job: Job): boolean {
  return job.kind === "preview";
}

/** Same provider, model, image(s), prompt, duration, and preset. Previews never match. */
export function takeInputsMatch(
  job: Job,
  shot: Shot,
  provider: ProviderId,
  modelName: string,
  styleBase = ""
): boolean {
  return takeFieldsMatch(job, shot, startImageForMatch(shot), provider, modelName, styleBase);
}

export type SkipReason = "inflight" | "match";

export function skipReasonText(reason: SkipReason): string {
  if (reason === "inflight") return "Already queued or running";
  return "Completed take already matches these inputs";
}

export type ShotDecision =
  | { action: "run" }
  | { action: "skip"; reason: SkipReason; jobId: string };

function matchDecision(
  shot: Shot,
  jobs: Job[],
  provider: ProviderId,
  modelName: string,
  styleBase: string
): ShotDecision {
  const takes = jobs.filter((job) => job.shotId === shot.id && !isPreview(job));
  const inflight = takes.find((job) => job.status === "queued" || job.status === "running");
  if (inflight) return { action: "skip", reason: "inflight", jobId: inflight.id };
  const matches = takes
    .filter(
      (job) =>
        job.status === "completed" &&
        Boolean(job.outputPath) &&
        takeInputsMatch(job, shot, provider, modelName, styleBase)
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (matches[0]) return { action: "skip", reason: "match", jobId: matches[0].id };
  return { action: "run" };
}

export function classifyShot(
  shot: Shot,
  jobs: Job[],
  provider: ProviderId,
  modelName: string
): ShotDecision {
  const styleBase = getProject(shot.projectId)?.styleBase ?? "";
  return matchDecision(shot, jobs, provider, modelName, styleBase);
}

export type PlannedShot = {
  shot: Shot;
  action: "run" | "skip";
  reason?: SkipReason;
  jobId?: string;
  /** Out of date because an upstream take in this chain changed or will change. */
  stale: boolean;
  /** Queuing this shot replaces the take the stitch uses. */
  refreshesCut: boolean;
};

/**
 * Render all plan.
 * A matching take is reused, except when this shot's chain is out of date and
 * either its own still is from an older take, or an earlier shot in this same
 * plan will replace the take the chain was built from.
 * Unchained shots, and shots before that change, stay on the matching-take skip.
 */
export function projectRenderPlan(
  shots: Shot[],
  jobs: Job[],
  provider: ProviderId,
  modelNameForShot: (shot: Shot) => string,
  styleBase: string
): PlannedShot[] {
  const marks = new Map(
    chainStaleMarks({
      shots,
      jobs: jobs as ChainStaleJob[],
      provider,
      styleBase,
      modelNameForShot,
    }).map((mark) => [mark.id, mark])
  );
  let cutWillChange = false;
  return shots.map((shot) => {
    const mark = marks.get(shot.id) ?? { id: shot.id, stale: false, immediate: false };
    const base = matchDecision(shot, jobs, provider, modelNameForShot(shot), styleBase);
    const takes = completedTakesFor(jobs, shot.id);
    const pinned = cutIsPinned(shot.selectedJobId, takes);
    if (base.action === "skip" && base.reason === "inflight") {
      cutWillChange = !pinned;
      return {
        shot,
        action: "skip",
        reason: "inflight",
        jobId: base.jobId,
        stale: mark.stale,
        refreshesCut: false,
      };
    }
    const run = base.action === "run" || (mark.stale && (mark.immediate || cutWillChange));
    if (!run) {
      cutWillChange = false;
      return {
        shot,
        action: "skip",
        reason: "match",
        jobId: base.action === "skip" ? base.jobId : undefined,
        stale: mark.stale,
        refreshesCut: false,
      };
    }
    const refreshesCut = !pinned || mark.stale;
    cutWillChange = refreshesCut;
    return { shot, action: "run", stale: mark.stale, refreshesCut };
  });
}
