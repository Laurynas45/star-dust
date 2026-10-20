import { ChainStaleJob, chainStaleMarks, completedTakesFor, cutIsPinned, cutTake, takeFieldsMatch } from "./chain-stale";
import { startImageForMatch } from "./continuity";
import { desiredClipKey } from "./input-key";
import { getProject } from "./storage";
import { Job, ProviderId, REUSE_SKIP_REASON, Shot } from "./types";

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
  return REUSE_SKIP_REASON;
}

export type ShotDecision =
  | { action: "run" }
  | { action: "skip"; reason: SkipReason; jobId: string };

function matchDecision(
  shot: Shot,
  jobs: Job[],
  provider: ProviderId,
  modelName: string,
  styleBase: string,
  upstreamOverride?: string
): ShotDecision {
  const takes = jobs.filter((job) => job.shotId === shot.id && !isPreview(job));
  const inflight = takes.find((job) => job.status === "queued" || job.status === "running");
  if (inflight) return { action: "skip", reason: "inflight", jobId: inflight.id };
  const finished = takes
    .filter((job) => job.status === "completed" && Boolean(job.outputPath))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const desired = desiredClipKey(shot, upstreamOverride);
  const keyed = finished.find((job) => Boolean(job.inputKey) && job.inputKey === desired);
  if (keyed) return { action: "skip", reason: "match", jobId: keyed.id };
  // Rows from before content keys have no inputKey. They still match on the
  // older fields until a retake stores a seed on the shot.
  if (shot.seed == null) {
    const legacy = finished.find(
      (job) => !job.inputKey && takeInputsMatch(job, shot, provider, modelName, styleBase)
    );
    if (legacy) return { action: "skip", reason: "match", jobId: legacy.id };
  }
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
  /** Reuse should put this finished take in the cut. */
  selectJobId?: string;
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
  /** inputKey that will be in the cut, or null when this plan will render a new one. */
  const plannedCut = new Map<string, string | null>();
  return shots.map((shot, index) => {
    const mark = marks.get(shot.id) ?? { id: shot.id, stale: false, immediate: false };
    const prev = index > 0 ? shots[index - 1] : undefined;
    let upstreamOverride: string | undefined;
    if (shot.chainFromPrevious && prev && plannedCut.has(prev.id)) {
      const planned = plannedCut.get(prev.id);
      upstreamOverride = planned == null ? "pending-render" : planned;
    }
    const base = matchDecision(shot, jobs, provider, modelNameForShot(shot), styleBase, upstreamOverride);
    const takes = completedTakesFor(jobs, shot.id);
    const pinned = cutIsPinned(shot.selectedJobId, takes);
    const cut = cutTake(shot.selectedJobId, takes);
    if (base.action === "skip" && base.reason === "inflight") {
      cutWillChange = !pinned;
      if (!pinned) plannedCut.set(shot.id, null);
      else if (cut?.inputKey) plannedCut.set(shot.id, cut.inputKey);
      return {
        shot,
        action: "skip",
        reason: "inflight",
        jobId: base.jobId,
        stale: mark.stale,
        refreshesCut: false,
      };
    }
    const keyMatch = base.action === "skip" && base.reason === "match";
    // A shot whose cut will change pulls the unbroken chain with it, including
    // when the change is a new content key the field compare does not see.
    // A finished clip for the upstream key we are about to use is still reused.
    const chainedFromChangingCut = cutWillChange && shot.chainFromPrevious;
    const run =
      base.action === "run" ||
      (mark.stale && mark.immediate) ||
      (mark.stale && cutWillChange && !keyMatch) ||
      (chainedFromChangingCut && !keyMatch);
    if (!run) {
      const matched = jobs.find((job) => job.id === base.jobId);
      const selectJobId = matched && cut?.id !== matched.id ? matched.id : undefined;
      if (matched?.inputKey) plannedCut.set(shot.id, matched.inputKey);
      cutWillChange = Boolean(selectJobId);
      return {
        shot,
        action: "skip",
        reason: "match",
        jobId: base.action === "skip" ? base.jobId : undefined,
        stale: mark.stale,
        refreshesCut: false,
        selectJobId,
      };
    }
    const refreshesCut = !pinned || mark.stale;
    cutWillChange = refreshesCut;
    if (refreshesCut) plannedCut.set(shot.id, null);
    else if (cut?.inputKey) plannedCut.set(shot.id, cut.inputKey);
    return { shot, action: "run", stale: mark.stale, refreshesCut };
  });
}
