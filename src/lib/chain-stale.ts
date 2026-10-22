import {
  Job,
  ProviderId,
  Shot,
  clampChainFrameBack,
  effectivePrompt,
} from "./types";

/**
 * A chained shot stores the take it was extracted from.
 * The still is current for that take only when the id matches and the
 * frame choice has not moved since the extract.
 */
export function chainedStillMatchesTake(
  shot: Pick<
    Shot,
    "chainedStartImagePath" | "chainedFromJobId" | "chainFrameBack" | "chainedFrameRequest"
  >,
  takeId: string | undefined
): boolean {
  if (!takeId || !shot.chainedStartImagePath || shot.chainedFromJobId !== takeId) return false;
  const requested = clampChainFrameBack(shot.chainFrameBack ?? 0);
  const used = shot.chainedFrameRequest ?? 0;
  return used === requested;
}

/** True when the stored still was extracted from this take, ignoring a later frame-choice edit. */
export function chainedStillFromTake(
  shot: Pick<Shot, "chainedStartImagePath" | "chainedFromJobId">,
  takeId: string | undefined
): boolean {
  return Boolean(takeId && shot.chainedStartImagePath && shot.chainedFromJobId === takeId);
}

/**
 * Image a matching take must have used.
 * Empty when this shot chains and the stored still is not from the previous shot's current take.
 */
export function expectedStartImage(
  shot: Pick<
    Shot,
    | "chainFromPrevious"
    | "startImagePath"
    | "chainedStartImagePath"
    | "chainedFromJobId"
    | "chainFrameBack"
    | "chainedFrameRequest"
  >,
  prevCutTakeId: string | undefined
): string {
  if (!shot.chainFromPrevious) return shot.startImagePath ?? "";
  if (!chainedStillMatchesTake(shot, prevCutTakeId)) return "";
  return shot.chainedStartImagePath ?? "";
}

export type CutCandidate = {
  id: string;
  createdAt: string;
  imagePath: string;
  shotId?: string;
  kind?: string;
  status: string;
  outputPath?: string;
};

/**
 * The take the stitch uses.
 * An approved take wins. Otherwise the selected completed take, otherwise the newest.
 */
export function cutTake<T extends { id: string; createdAt: string }>(
  selectedJobId: string | undefined,
  takes: readonly T[],
  approvedJobId?: string
): T | undefined {
  if (approvedJobId) {
    const approved = takes.find((take) => take.id === approvedJobId);
    if (approved) return approved;
  }
  if (selectedJobId) {
    const chosen = takes.find((take) => take.id === selectedJobId);
    if (chosen) return chosen;
  }
  return [...takes].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export function completedTakesFor<T extends CutCandidate>(jobs: readonly T[], shotId: string): T[] {
  return jobs.filter(
    (job) =>
      job.shotId === shotId &&
      job.kind !== "preview" &&
      job.status === "completed" &&
      Boolean(job.outputPath)
  );
}

export function cutIsPinned(selectedJobId: string | undefined, takes: readonly { id: string }[]): boolean {
  return Boolean(selectedJobId && takes.some((take) => take.id === selectedJobId));
}

type MatchJob = Pick<
  Job,
  | "kind"
  | "provider"
  | "modelName"
  | "imagePath"
  | "endImagePath"
  | "prompt"
  | "presetId"
  | "durationSec"
  | "seed"
>;

type MatchShot = Pick<Shot, "endImagePath" | "prompt" | "presetId" | "durationSec" | "seed">;

/**
 * Same provider, model, image(s), prompt, duration, and preset.
 * When the shot has a stored seed, the take's seed must match too.
 * Previews never match.
 */
export function takeFieldsMatch(
  job: MatchJob,
  shot: MatchShot,
  expectedImage: string,
  provider: ProviderId,
  modelName: string,
  styleBase = ""
): boolean {
  if (job.kind === "preview") return false;
  if (job.provider !== provider) return false;
  if ((job.modelName ?? "") !== modelName) return false;
  if (job.imagePath !== expectedImage) return false;
  if ((job.endImagePath ?? "") !== (shot.endImagePath ?? "")) return false;
  if (job.prompt !== effectivePrompt(styleBase, shot.prompt)) return false;
  if (job.presetId !== shot.presetId) return false;
  if (job.durationSec == null || Number(job.durationSec) !== Number(shot.durationSec)) return false;
  if (shot.seed != null && job.seed !== shot.seed) return false;
  return true;
}

export type ChainStaleShot = Pick<
  Shot,
  | "id"
  | "chainFromPrevious"
  | "chainFrameBack"
  | "chainedFromJobId"
  | "chainedStartImagePath"
  | "chainedFrameRequest"
  | "selectedJobId"
  | "approvedJobId"
  | "startImagePath"
  | "endImagePath"
  | "prompt"
  | "presetId"
  | "durationSec"
  | "comfyuiWorkflow"
  | "comfyLowMemory"
  | "seed"
>;

export type ChainStaleJob = CutCandidate &
  Pick<
    Job,
    "provider" | "modelName" | "endImagePath" | "prompt" | "presetId" | "durationSec" | "kind" | "seed"
  >;

export type ChainStaleMark = {
  id: string;
  /**
   * This shot's cut was rendered from a frame that is no longer the one in the cut,
   * or an earlier shot in the unbroken chain will replace that frame.
   */
  stale: boolean;
  /** The stored still itself is not from the previous shot's current take. */
  immediate: boolean;
};

/**
 * Walks the shot list once.
 * A chained shot is out of date when its still was not taken from the previous
 * shot's current take, or when an earlier shot in that unbroken chain is out of
 * date or is about to replace its take. An unchained shot stops the walk.
 * Shots before the changed take are left alone.
 * An approved shot is an anchor: it is never out of date, and it stops the
 * walk, so only unapproved shots between approved takes are marked.
 */
export function chainStaleMarks<T extends ChainStaleShot>(args: {
  shots: readonly T[];
  jobs: readonly ChainStaleJob[];
  provider: ProviderId;
  styleBase: string;
  modelNameForShot: (shot: T) => string;
}): ChainStaleMark[] {
  const cutIds = new Map<string, string | undefined>();
  for (const shot of args.shots) {
    const takes = completedTakesFor(args.jobs, shot.id);
    cutIds.set(shot.id, cutTake(shot.selectedJobId, takes, shot.approvedJobId)?.id);
  }

  let upstreamWillChange = false;
  return args.shots.map((shot, index) => {
    const takes = completedTakesFor(args.jobs, shot.id);
    const prev = index > 0 ? args.shots[index - 1] : undefined;
    const prevCutId = prev ? cutIds.get(prev.id) : undefined;
    const expected = expectedStartImage(shot, prevCutId);
    const modelName = args.modelNameForShot(shot);
    const hasMatchingTake = takes.some((job) =>
      takeFieldsMatch(job, shot, expected, args.provider, modelName, args.styleBase)
    );
    const approvedHeld = Boolean(shot.approvedJobId);
    const pinned = cutIsPinned(shot.selectedJobId, takes) || approvedHeld;
    const inflight = args.jobs.some(
      (job) =>
        job.shotId === shot.id &&
        job.kind !== "preview" &&
        (job.status === "queued" || job.status === "running")
    );
    const replacesCut = !pinned && (inflight || !hasMatchingTake);
    const hasCutTake = Boolean(cutIds.get(shot.id));
    const fromPrev = Boolean(prev && chainedStillFromTake(shot, prevCutId));
    let stale = false;
    let immediate = false;
    if (!approvedHeld && shot.chainFromPrevious && prev && hasCutTake) {
      immediate = !fromPrev;
      stale = immediate || upstreamWillChange;
    }
    if (approvedHeld) {
      upstreamWillChange = false;
    } else {
      upstreamWillChange = stale || replacesCut;
      if (!shot.chainFromPrevious) upstreamWillChange = replacesCut;
    }
    return { id: shot.id, stale, immediate };
  });
}

export function chainStaleShotIds<T extends ChainStaleShot>(args: {
  shots: readonly T[];
  jobs: readonly ChainStaleJob[];
  provider: ProviderId;
  styleBase: string;
  modelNameForShot: (shot: T) => string;
}): string[] {
  return chainStaleMarks(args)
    .filter((mark) => mark.stale)
    .map((mark) => mark.id);
}
