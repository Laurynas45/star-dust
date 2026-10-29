import { approvalConfirmError } from "./approve";
import { resolveComfyChoice } from "./comfy-choice";
import { chainStaleMarks, completedTakesFor, cutTake } from "./chain-stale";
import { chainProviderNote, planChain, previousShot } from "./continuity";
import { creditEstimate, deductCredits } from "./credits";
import { buildEstimate, quoteRun, shotBill, withCredits } from "./cost";
import { clipKeyForSeed, effectiveSeed, freshSeed, upstreamCutKey } from "./input-key";
import {
  CLOUD_RISK_NOTE,
  LOW_MEMORY_MARK,
  WAN_FLF_MISSING_END,
  comfyWorkflowFromModelName,
  describeProviderUse,
  isPaidProvider,
  missingKeyMessage,
  modelNameFor,
} from "./provider-info";
import { generationIsRefused, MINOR_SEXUAL_REFUSAL } from "./safety";
import {
  clearApproval,
  clearTakeSelection,
  createJob,
  getJob,
  getProject,
  getSettings,
  getShot,
  listJobs,
  listShots,
  selectTake,
  updateShot,
} from "./storage";
import { PlannedShot, classifyShot, projectRenderPlan, skipReasonText } from "./takes";
import { imageExists } from "./uploads";
import {
  AppSettings,
  CostEstimate,
  CreditEstimate,
  ComfyWorkflowId,
  Job,
  HuntSeedCount,
  JobKind,
  ProviderId,
  Shot,
  effectivePrompt,
  huntSeedCount,
} from "./types";

export type SkippedShot = {
  shotId: string;
  position: number;
  reason: string;
  jobId?: string;
};

export type RenderFailure = {
  ok: false;
  status: number;
  error: string;
  refused?: boolean;
  needsModelAck?: boolean;
  modelName?: string;
  priceAvailable?: false;
  riskNote?: string;
  overBudget?: boolean;
  insufficientCredits?: boolean;
  needsApprovalConfirm?: boolean;
  cost?: CostEstimate;
};

export type RenderSuccess = {
  ok: true;
  jobs: Job[];
  skipped: SkippedShot[];
  cost?: CostEstimate;
};

export type RenderResult = RenderSuccess | RenderFailure;

function ackFailure(provider: ProviderId, acknowledgeModel?: string): RenderFailure | null {
  if (!isPaidProvider(provider)) return null;
  const settings = getSettings();
  const modelName = modelNameFor(provider, settings);
  if (acknowledgeModel !== modelName) {
    return {
      ok: false,
      status: 409,
      error: `Confirm the model before this run: ${modelName}. ${CLOUD_RISK_NOTE}`,
      needsModelAck: true,
      modelName,
      priceAvailable: false,
      riskNote: CLOUD_RISK_NOTE,
    };
  }
  return null;
}

function flfEndFailure(shot: Shot, provider: ProviderId, settings: AppSettings): RenderFailure | null {
  if (provider !== "comfyui") return null;
  if (comfyForShot(shot, settings).workflow !== "wan-flf") return null;
  if (shot.endImagePath) return null;
  return { ok: false, status: 400, error: `Shot ${shot.position}: ${WAN_FLF_MISSING_END}` };
}

function keyFailure(provider: ProviderId): RenderFailure | null {
  const missing = missingKeyMessage(provider);
  if (!missing) return null;
  return {
    ok: false,
    status: 400,
    error: missing,
    modelName: modelNameFor(provider, getSettings()),
    priceAvailable: false,
    riskNote: CLOUD_RISK_NOTE,
  };
}

function creditState(
  provider: ProviderId,
  seconds: number,
  cost?: CostEstimate
): CreditEstimate | undefined {
  if (cost?.credits) return cost.credits;
  if (!isPaidProvider(provider)) return undefined;
  return creditEstimate(Math.max(0, seconds), provider);
}

function insufficientFailure(
  provider: ProviderId,
  seconds: number,
  cost?: CostEstimate
): RenderFailure | null {
  const credits = creditState(provider, seconds, cost);
  if (!credits?.insufficient) return null;
  return {
    ok: false,
    status: 409,
    error: credits.label,
    insufficientCredits: true,
    cost: cost ? { ...cost, credits } : undefined,
    modelName: modelNameFor(provider, getSettings()),
    priceAvailable: false,
    riskNote: CLOUD_RISK_NOTE,
  };
}

/** Spends hosted credits after the key check. No-op when Stripe and PayPal are unset. */
function chargeCredits(
  provider: ProviderId,
  seconds: number,
  detail: string,
  cost?: CostEstimate
): RenderFailure | null {
  const credits = creditState(provider, seconds, cost);
  if (!credits?.hosted || credits.required <= 0) return null;
  const spent = deductCredits(credits.required, detail);
  if (!spent.ok) {
    const fresh = creditEstimate(seconds, provider);
    if (cost && fresh) cost.credits = fresh;
    return insufficientFailure(provider, seconds, cost);
  }
  if (cost?.credits) {
    cost.credits = { ...cost.credits, balance: spent.balance, insufficient: false };
  }
  return null;
}

function prepareShot(shotId: string):
  | { ok: true; shot: Shot }
  | RenderFailure {
  const shot = getShot(shotId);
  if (!shot) return { ok: false, status: 404, error: "Shot not found" };
  if (!shot.startImagePath || !imageExists(shot.startImagePath)) {
    return {
      ok: false,
      status: 400,
      error: `Shot ${shot.position} is missing a start image.`,
    };
  }
  if (shot.endImagePath && !imageExists(shot.endImagePath)) {
    return {
      ok: false,
      status: 400,
      error: `Shot ${shot.position} end image is missing from disk.`,
    };
  }
  const project = getProject(shot.projectId);
  if (generationIsRefused(effectivePrompt(project?.styleBase, shot.prompt), [])) {
    return { ok: false, status: 400, error: MINOR_SEXUAL_REFUSAL, refused: true };
  }
  return { ok: true, shot };
}

function comfyForShot(shot: Shot, settings: AppSettings) {
  return resolveComfyChoice({
    settings,
    project: getProject(shot.projectId),
    shot,
  });
}

function modelForShot(shot: Shot, provider: ProviderId, settings: AppSettings): string {
  return modelNameFor(
    provider,
    settings,
    provider === "comfyui" ? comfyForShot(shot, settings) : undefined
  );
}

function queueJob(
  shot: Shot,
  provider: ProviderId,
  kind: JobKind,
  createdAt?: string,
  chain?: { imagePath: string; awaitPreviousFrame: boolean },
  identity?: { seed: number; inputKey: string }
): Job {
  const settings = getSettings();
  const project = getProject(shot.projectId);
  const described = describeProviderUse({
    provider,
    settings,
    hasCharacterSheet: Boolean(project?.characterSheetPath),
    hasEndImage: Boolean(shot.endImagePath),
    comfy: provider === "comfyui" ? comfyForShot(shot, settings) : undefined,
  });
  const providerNote = chain
    ? `${described.providerNote} ${chainProviderNote(chain.awaitPreviousFrame, shot.chainFrameBack)}`
    : described.providerNote;
  return createJob({
    projectId: shot.projectId,
    shotId: shot.id,
    prompt: effectivePrompt(project?.styleBase, shot.prompt),
    presetId: shot.presetId,
    provider,
    kind,
    imagePath: chain?.imagePath ?? shot.startImagePath!,
    endImagePath: shot.endImagePath,
    characterSheetPath: project?.characterSheetPath,
    characterNote: described.characterNote,
    providerNote,
    modelName: described.modelName,
    durationSec: shot.durationSec,
    awaitPreviousFrame: chain?.awaitPreviousFrame ?? false,
    seed: identity?.seed,
    inputKey: kind === "preview" ? undefined : identity?.inputKey,
    status: "queued",
    createdAt,
  });
}

type RunnableShot = {
  shot: Shot;
  imagePath: string;
  awaitPreviousFrame: boolean;
  stale: boolean;
  refreshesCut: boolean;
};

function queueRunnable(items: RunnableShot[], provider: ProviderId): Job[] {
  const identities = new Map<string, { seed: number; inputKey: string }>();
  const base = Date.now();
  return items.map((item, index) => {
    let upstream = "";
    if (item.shot.chainFromPrevious) {
      const prev = previousShot(item.shot);
      const prevItem = prev ? items.find((entry) => entry.shot.id === prev.id) : undefined;
      const prevIdentity = prev ? identities.get(prev.id) : undefined;
      upstream =
        prevItem?.refreshesCut && prevIdentity ? prevIdentity.inputKey : upstreamCutKey(item.shot);
    }
    const seed = effectiveSeed(item.shot);
    const inputKey = clipKeyForSeed(item.shot, seed, upstream);
    identities.set(item.shot.id, { seed, inputKey });
    if (item.stale) clearTakeSelection(item.shot.id);
    return queueJob(
      item.shot,
      provider,
      "take",
      new Date(base + index).toISOString(),
      item.shot.chainFromPrevious
        ? { imagePath: item.imagePath, awaitPreviousFrame: item.awaitPreviousFrame }
        : undefined,
      { seed, inputKey }
    );
  });
}

function approvalBlock(shot: Shot): RenderFailure {
  const styleBase = getProject(shot.projectId)?.styleBase ?? "";
  const job = shot.approvedJobId ? getJob(shot.approvedJobId) : undefined;
  return {
    ok: false,
    status: 409,
    error: approvalConfirmError(shot, job, styleBase),
    needsApprovalConfirm: true,
  };
}

export function renderShot(
  shotId: string,
  opts?: { acknowledgeModel?: string; force?: boolean; confirmApproved?: boolean }
): RenderResult {
  const prepared = prepareShot(shotId);
  if (!prepared.ok) return prepared;
  if (prepared.shot.approvedJobId && !opts?.confirmApproved) return approvalBlock(prepared.shot);
  const shot = getShot(shotId);
  if (!shot) return { ok: false, status: 404, error: "Shot not found" };
  const settings = getSettings();
  const provider = settings.provider;
  const modelName = modelNameFor(
    provider,
    settings,
    provider === "comfyui" ? comfyForShot(shot, settings) : undefined
  );
  const existing = listJobs(shot.projectId);
  const decision = classifyShot(shot, existing, provider, modelName);
  const force = Boolean(opts?.force || opts?.confirmApproved);
  if (decision.action === "skip" && (decision.reason === "inflight" || !force)) {
    if (decision.reason === "inflight") {
      return { ok: false, status: 409, error: skipReasonText("inflight") };
    }
    return {
      ok: true,
      jobs: [],
      skipped: [
        {
          shotId: shot.id,
          position: shot.position,
          reason: skipReasonText("match"),
          jobId: decision.jobId,
        },
      ],
    };
  }
  const plan = planChain(shot, new Set());
  if (!plan.ok) return { ok: false, status: 400, error: plan.error };
  const missingEnd = flfEndFailure(shot, provider, settings);
  if (missingEnd) return missingEnd;
  const ack = ackFailure(provider, opts?.acknowledgeModel);
  if (ack) return ack;
  const seconds = Number(shot.durationSec) || 0;
  const short = insufficientFailure(provider, seconds);
  if (short) return short;
  const key = keyFailure(provider);
  if (key) return key;
  const charged = chargeCredits(provider, seconds, `shot ${shot.id}`);
  if (charged) return charged;
  const mark = chainStaleMarks({
    shots: listShots(shot.projectId),
    jobs: existing,
    provider,
    styleBase: getProject(shot.projectId)?.styleBase ?? "",
    modelNameForShot: (item) => modelForShot(item, provider, settings),
  }).find((item) => item.id === shot.id);
  if (shot.approvedJobId) clearApproval(shot.id);
  if (mark?.immediate) clearTakeSelection(shot.id);
  const chain = shot.chainFromPrevious ? plan : undefined;
  const seeded = getShot(shot.id) ?? shot;
  const upstream = seeded.chainFromPrevious ? upstreamCutKey(seeded) : "";
  return {
    ok: true,
    jobs: [
      queueJob(seeded, provider, "take", undefined, chain, {
        seed: effectiveSeed(seeded),
        inputKey: clipKeyForSeed(seeded, effectiveSeed(seeded), upstream),
      }),
    ],
    skipped: [],
  };
}

export function renderAll(
  projectId: string,
  opts?: { acknowledgeModel?: string }
): RenderResult {
  const project = getProject(projectId);
  if (!project) return { ok: false, status: 404, error: "Project not found" };
  const shots = listShots(projectId);
  if (shots.length === 0) {
    return { ok: false, status: 400, error: "Add a shot before rendering." };
  }
  for (const shot of shots) {
    const prepared = prepareShot(shot.id);
    if (!prepared.ok) return prepared;
  }

  const settings = getSettings();
  const provider = settings.provider;
  const modelName = modelNameFor(provider, settings);
  const existing = listJobs(projectId);
  const plan = projectRenderPlan(shots, existing, provider, (shot) => modelForShot(shot, provider, settings), project.styleBase);
  for (const item of plan) {
    if (item.action === "skip" && item.selectJobId) selectTake(item.shot.id, item.selectJobId);
  }
  const skipped: SkippedShot[] = [];
  const pending: PlannedShot[] = [];
  for (const item of plan) {
    if (item.action === "skip") {
      skipped.push({
        shotId: item.shot.id,
        position: item.shot.position,
        reason: skipReasonText(item.reason ?? "match"),
        jobId: item.jobId,
      });
    } else {
      pending.push(item);
    }
  }

  const refreshIds = new Set(pending.filter((item) => item.refreshesCut).map((item) => item.shot.id));
  const runnable: RunnableShot[] = [];
  for (const item of pending) {
    const chain = planChain(item.shot, refreshIds);
    if (!chain.ok) {
      skipped.push({ shotId: item.shot.id, position: item.shot.position, reason: chain.error });
    } else {
      runnable.push({
        shot: item.shot,
        imagePath: chain.imagePath,
        awaitPreviousFrame: chain.awaitPreviousFrame,
        stale: item.stale,
        refreshesCut: item.refreshesCut,
      });
    }
  }

  for (const item of runnable) {
    const missingEnd = flfEndFailure(item.shot, provider, settings);
    if (missingEnd) return missingEnd;
  }

  const seconds = runnable.reduce((sum, item) => sum + (Number(item.shot.durationSec) || 0), 0);
  const runnableIds = new Set(runnable.map((item) => item.shot.id));
  const bills = shots.map((shot) => shotBill(shot, existing, runnableIds.has(shot.id)));
  const cost = withCredits(
    buildEstimate({ provider, modelName, settings, shots: bills, scope: "project" }),
    provider,
    seconds
  );
  if (runnable.length === 0) {
    return { ok: true, jobs: [], skipped, cost };
  }

  const ack = ackFailure(provider, opts?.acknowledgeModel);
  if (ack) return { ...ack, cost };
  if (cost.overBudget) {
    return {
      ok: false,
      status: 409,
      error: cost.label,
      overBudget: true,
      cost,
      modelName,
      priceAvailable: false,
      riskNote: CLOUD_RISK_NOTE,
    };
  }
  const short = insufficientFailure(provider, seconds, cost);
  if (short) return short;
  const key = keyFailure(provider);
  if (key) return { ...key, cost };
  const charged = chargeCredits(provider, seconds, `render-all ${projectId}`, cost);
  if (charged) return charged;

  const jobs = queueRunnable(runnable, provider);
  return { ok: true, jobs, skipped, cost };
}

/**
 * Renders every shot with Mock and does not touch the shot's selected take.
 * Preview clips are camera motion on stills, not AI motion.
 */
export function previewAll(projectId: string): RenderResult {
  const project = getProject(projectId);
  if (!project) return { ok: false, status: 404, error: "Project not found" };
  const shots = listShots(projectId);
  if (shots.length === 0) {
    return { ok: false, status: 400, error: "Add a shot before previewing." };
  }
  for (const shot of shots) {
    const prepared = prepareShot(shot.id);
    if (!prepared.ok) return prepared;
  }
  const base = Date.now();
  const jobs = shots.map((shot, index) =>
    queueJob(shot, "mock", "preview", new Date(base + index).toISOString())
  );
  return { ok: true, jobs, skipped: [] };
}

function retakeChain(shotId: string): Shot[] | undefined {
  const shot = getShot(shotId);
  if (!shot) return undefined;
  const shots = listShots(shot.projectId);
  const index = shots.findIndex((item) => item.id === shot.id);
  if (index < 0) return undefined;
  const chain = [shots[index]];
  for (let cursor = index + 1; cursor < shots.length; cursor += 1) {
    if (!shots[cursor].chainFromPrevious) break;
    if (shots[cursor].approvedJobId) break;
    chain.push(shots[cursor]);
  }
  return chain;
}

function inflightTakeJob(jobs: Job[], shotId: string): Job | undefined {
  return jobs.find(
    (job) =>
      job.shotId === shotId &&
      job.kind !== "preview" &&
      (job.status === "queued" || job.status === "running")
  );
}

type InspectedRun = {
  shots: Shot[];
  runnable: RunnableShot[];
  seconds: number;
  provider: ProviderId;
  modelName: string;
};

function inspectShots(shots: Shot[], refreshIds: ReadonlySet<string>): InspectedRun | RenderFailure {
  for (const shot of shots) {
    const prepared = prepareShot(shot.id);
    if (!prepared.ok) return prepared;
  }
  const project = getProject(shots[0].projectId);
  if (!project) return { ok: false, status: 404, error: "Project not found" };
  const settings = getSettings();
  const provider = settings.provider;
  const existing = listJobs(project.id);
  for (const shot of shots) {
    if (inflightTakeJob(existing, shot.id)) {
      return { ok: false, status: 409, error: "Already queued or running" };
    }
    const missingEnd = flfEndFailure(shot, provider, settings);
    if (missingEnd) return missingEnd;
  }
  const runnable: RunnableShot[] = [];
  for (const shot of shots) {
    const chain = planChain(shot, refreshIds);
    if (!chain.ok) return { ok: false, status: 400, error: chain.error };
    runnable.push({
      shot,
      imagePath: chain.imagePath,
      awaitPreviousFrame: chain.awaitPreviousFrame,
      stale: false,
      refreshesCut: refreshIds.has(shot.id),
    });
  }
  const seconds = shots.reduce((sum, shot) => sum + (Number(shot.durationSec) || 0), 0);
  return {
    shots,
    runnable,
    seconds,
    provider,
    modelName: modelNameFor(provider, settings),
  };
}

function chargeRun(
  inspected: InspectedRun,
  unpaidLabel: string,
  detail: string,
  acknowledgeModel?: string,
  repeat?: number
): { ok: true; cost: CostEstimate } | RenderFailure {
  const cost = quoteRun({
    seconds: inspected.seconds,
    unpaidLabel,
    shots: inspected.shots,
    jobs: inspected.shots[0] ? listJobs(inspected.shots[0].projectId) : [],
    repeat,
  });
  const ack = ackFailure(inspected.provider, acknowledgeModel);
  if (ack) return { ...ack, cost };
  if (cost.overBudget) {
    return {
      ok: false,
      status: 409,
      error: cost.label,
      overBudget: true,
      cost,
      modelName: inspected.modelName,
      priceAvailable: false,
      riskNote: CLOUD_RISK_NOTE,
    };
  }
  const short = insufficientFailure(inspected.provider, inspected.seconds, cost);
  if (short) return short;
  const key = keyFailure(inspected.provider);
  if (key) return { ...key, cost };
  const charged = chargeCredits(inspected.provider, inspected.seconds, detail, cost);
  if (charged) return charged;
  return { ok: true, cost };
}

export function quoteRetake(shotId: string): { ok: true; cost: CostEstimate } | RenderFailure {
  const chain = retakeChain(shotId);
  if (!chain) return { ok: false, status: 404, error: "Shot not found" };
  const inspected = inspectShots(chain, new Set(chain.map((shot) => shot.id)));
  if (!("runnable" in inspected)) return inspected;
  const label = `Retake renders ${chain.length} shot${chain.length === 1 ? "" : "s"}, ${inspected.seconds} seconds. No charge. Earlier takes stay on disk.`;
  return {
    ok: true,
    cost: quoteRun({
      seconds: inspected.seconds,
      unpaidLabel: label,
      shots: chain,
      jobs: listJobs(chain[0].projectId),
    }),
  };
}

/**
 * New seed on this shot only. Renders this shot and the unbroken chain after it,
 * stopping at the next approved take. Earlier takes stay. Downstream unapproved
 * shots are marked out of date by the same chain walk Render all uses.
 * An approved shot is not rendered unless the user confirms.
 */
export function retakeShot(
  shotId: string,
  opts?: { acknowledgeModel?: string; confirmApproved?: boolean }
): RenderResult {
  const current = getShot(shotId);
  if (!current) return { ok: false, status: 404, error: "Shot not found" };
  if (current.approvedJobId && !opts?.confirmApproved) return approvalBlock(current);
  const chain = retakeChain(shotId);
  if (!chain) return { ok: false, status: 404, error: "Shot not found" };
  const refreshIds = new Set(chain.map((shot) => shot.id));
  const inspected = inspectShots(chain, refreshIds);
  if (!("runnable" in inspected)) return inspected;
  const label = `Retake renders ${chain.length} shot${chain.length === 1 ? "" : "s"}, ${inspected.seconds} seconds. No charge. Earlier takes stay on disk.`;
  const paid = chargeRun(inspected, label, `retake ${shotId}`, opts?.acknowledgeModel);
  if (!paid.ok) return paid;
  const head = chain[0];
  const nextSeed = freshSeed([effectiveSeed(head)]);
  if (head.approvedJobId) clearApproval(head.id);
  updateShot(head.id, { seed: nextSeed });
  for (const shot of chain) clearTakeSelection(shot.id);
  const runnable = inspected.runnable.map((item) => {
    const fresh = getShot(item.shot.id) ?? item.shot;
    return { ...item, shot: fresh, refreshesCut: true };
  });
  return { ok: true, jobs: queueRunnable(runnable, inspected.provider), skipped: [], cost: paid.cost };
}

export function quoteHunt(
  shotId: string,
  count: HuntSeedCount
): { ok: true; cost: CostEstimate } | RenderFailure {
  const shot = getShot(shotId);
  if (!shot) return { ok: false, status: 404, error: "Shot not found" };
  const inspected = inspectShots([shot], new Set());
  if (!("runnable" in inspected)) return inspected;
  const seconds = inspected.seconds * count;
  const each = inspected.seconds;
  const label = `Try ${count} seeds: ${each} seconds each, ${seconds} seconds in total. No charge. This is not a vendor quote.`;
  return {
    ok: true,
    cost: quoteRun({
      seconds,
      unpaidLabel: label,
      shots: [shot],
      jobs: listJobs(shot.projectId),
      repeat: count,
    }),
  };
}

/**
 * Renders 2, 3, or 4 seeds of one shot. Each candidate is a take.
 * The shot's sequence seed stays until the user picks a take.
 * The take already in the cut stays selected.
 */
export function huntShot(
  shotId: string,
  countInput: unknown,
  opts?: { acknowledgeModel?: string; confirmApproved?: boolean }
): RenderResult {
  const count = huntSeedCount(countInput);
  if (!count) return { ok: false, status: 400, error: "Choose 2, 3, or 4 seeds." };
  const shot = getShot(shotId);
  if (!shot) return { ok: false, status: 404, error: "Shot not found" };
  if (shot.approvedJobId && !opts?.confirmApproved) return approvalBlock(shot);
  const inspected = inspectShots([shot], new Set());
  if (!("runnable" in inspected)) return inspected;
  const seconds = inspected.seconds * count;
  const label = `Try ${count} seeds: ${inspected.seconds} seconds each, ${seconds} seconds in total. No charge. This is not a vendor quote.`;
  const paid = chargeRun(
    { ...inspected, seconds },
    label,
    `hunt ${shotId} x${count}`,
    opts?.acknowledgeModel,
    count
  );
  if (!paid.ok) return paid;
  const takes = completedTakesFor(listJobs(shot.projectId), shot.id);
  const cut = cutTake(shot.selectedJobId, takes, shot.approvedJobId);
  if (cut && !shot.selectedJobId) selectTake(shot.id, cut.id);
  const current = getShot(shot.id) ?? shot;
  const plan = inspected.runnable[0];
  const upstream = current.chainFromPrevious ? upstreamCutKey(current) : "";
  const seeds: number[] = [];
  const avoid = [effectiveSeed(current)];
  for (let index = 0; index < count; index += 1) {
    const seed = freshSeed(avoid);
    seeds.push(seed);
    avoid.push(seed);
  }
  const base = Date.now();
  const chain = current.chainFromPrevious
    ? { imagePath: plan.imagePath, awaitPreviousFrame: plan.awaitPreviousFrame }
    : undefined;
  const jobs = seeds.map((seed, index) =>
    queueJob(current, inspected.provider, "take", new Date(base + index).toISOString(), chain, {
      seed,
      inputKey: clipKeyForSeed(current, seed, upstream),
    })
  );
  return { ok: true, jobs, skipped: [], cost: paid.cost };
}

export function retryFromJob(
  source: Job,
  opts?: { acknowledgeModel?: string }
): RenderResult {
  if (source.status === "queued" || source.status === "running") {
    return { ok: false, status: 409, error: "Cancel the job before retrying it." };
  }
  if (generationIsRefused(source.prompt, [])) {
    return { ok: false, status: 400, error: MINOR_SEXUAL_REFUSAL, refused: true };
  }
  const shotForChain = source.shotId ? getShot(source.shotId) : undefined;
  const chainPlan =
    shotForChain?.chainFromPrevious && source.kind !== "preview"
      ? planChain(shotForChain, new Set())
      : null;
  if (chainPlan && !chainPlan.ok) return { ok: false, status: 400, error: chainPlan.error };
  if (!chainPlan && !imageExists(source.imagePath)) {
    return { ok: false, status: 400, error: "Start image is missing from disk." };
  }
  const settings = getSettings();
  const provider = source.provider;
  const shot = shotForChain;
  const namedWorkflow = comfyWorkflowFromModelName(source.modelName);
  const fallbackWorkflow: ComfyWorkflowId = namedWorkflow ?? settings.comfyuiWorkflow;
  const comfy = shot
    ? resolveComfyChoice({ settings, project: getProject(source.projectId), shot })
    : {
        workflow: fallbackWorkflow,
        lowMemory: source.modelName ? source.modelName.includes(LOW_MEMORY_MARK) : settings.comfyLowMemory,
      };
  const ack = ackFailure(provider, opts?.acknowledgeModel);
  if (ack) return ack;
  if (provider === "comfyui" && comfy.workflow === "wan-flf" && !source.endImagePath) {
    const where = shot ? `Shot ${shot.position}: ` : "";
    return { ok: false, status: 400, error: `${where}${WAN_FLF_MISSING_END}` };
  }
  const seconds = source.kind === "preview" ? 0 : Number(source.durationSec) || 0;
  const short = insufficientFailure(provider, seconds);
  if (short) return short;
  const key = keyFailure(provider);
  if (key) return key;
  const charged = chargeCredits(provider, seconds, `retry ${source.id}`);
  if (charged) return charged;
  const described = describeProviderUse({
    provider,
    settings,
    hasCharacterSheet:
      Boolean(source.characterSheetPath) || Boolean(getProject(source.projectId)?.characterSheetPath),
    hasEndImage: Boolean(source.endImagePath),
    comfy: provider === "comfyui" ? comfy : undefined,
  });
  const job = createJob({
    projectId: source.projectId,
    shotId: source.shotId,
    prompt: source.prompt,
    presetId: source.presetId,
    provider,
    kind: source.kind === "preview" ? "preview" : "take",
    imagePath: chainPlan && chainPlan.ok ? chainPlan.imagePath : source.imagePath,
    endImagePath: source.endImagePath,
    characterSheetPath:
      source.characterSheetPath ?? getProject(source.projectId)?.characterSheetPath,
    characterNote: described.characterNote,
    providerNote:
      chainPlan && chainPlan.ok
        ? `${described.providerNote} ${chainProviderNote(chainPlan.awaitPreviousFrame, shotForChain?.chainFrameBack ?? 0)}`
        : described.providerNote,
    modelName: described.modelName,
    durationSec: source.durationSec,
    awaitPreviousFrame: chainPlan && chainPlan.ok ? chainPlan.awaitPreviousFrame : false,
    seed: source.seed,
    inputKey: source.kind === "preview" ? undefined : source.inputKey,
    status: "queued",
  });
  return { ok: true, jobs: [job], skipped: [] };
}
