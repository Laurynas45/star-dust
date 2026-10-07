import { resolveComfyChoice } from "./comfy-choice";
import { creditEstimate, deductCredits } from "./credits";
import { buildEstimate, withCredits } from "./cost";
import {
  CLOUD_RISK_NOTE,
  LOW_MEMORY_MARK,
  comfyWorkflowFromModelName,
  describeProviderUse,
  isPaidProvider,
  missingKeyMessage,
  modelNameFor,
} from "./provider-info";
import { generationIsRefused, MINOR_SEXUAL_REFUSAL } from "./safety";
import { createJob, getProject, getSettings, getShot, listJobs, listShots } from "./storage";
import { classifyShot, skipReasonText } from "./takes";
import { imageExists } from "./uploads";
import { AppSettings, CostEstimate, CreditEstimate, ComfyWorkflowId, Job, JobKind, ProviderId, Shot } from "./types";

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
  if (generationIsRefused(shot.prompt, [])) {
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

function queueJob(
  shot: Shot,
  provider: ProviderId,
  kind: JobKind,
  createdAt?: string
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
  return createJob({
    projectId: shot.projectId,
    shotId: shot.id,
    prompt: shot.prompt,
    presetId: shot.presetId,
    provider,
    kind,
    imagePath: shot.startImagePath!,
    endImagePath: shot.endImagePath,
    characterSheetPath: project?.characterSheetPath,
    characterNote: described.characterNote,
    providerNote: described.providerNote,
    modelName: described.modelName,
    durationSec: shot.durationSec,
    status: "queued",
    createdAt,
  });
}

export function renderShot(
  shotId: string,
  opts?: { acknowledgeModel?: string; force?: boolean }
): RenderResult {
  const prepared = prepareShot(shotId);
  if (!prepared.ok) return prepared;
  const settings = getSettings();
  const provider = settings.provider;
  const modelName = modelNameFor(
    provider,
    settings,
    provider === "comfyui" ? comfyForShot(prepared.shot, settings) : undefined
  );
  const decision = classifyShot(
    prepared.shot,
    listJobs(prepared.shot.projectId),
    provider,
    modelName
  );
  if (decision.action === "skip" && (decision.reason === "inflight" || !opts?.force)) {
    if (decision.reason === "inflight") {
      return { ok: false, status: 409, error: skipReasonText("inflight") };
    }
    return {
      ok: true,
      jobs: [],
      skipped: [
        {
          shotId: prepared.shot.id,
          position: prepared.shot.position,
          reason: skipReasonText("match"),
          jobId: decision.jobId,
        },
      ],
    };
  }
  const ack = ackFailure(provider, opts?.acknowledgeModel);
  if (ack) return ack;
  const seconds = Number(prepared.shot.durationSec) || 0;
  const short = insufficientFailure(provider, seconds);
  if (short) return short;
  const key = keyFailure(provider);
  if (key) return key;
  const charged = chargeCredits(provider, seconds, `shot ${prepared.shot.id}`);
  if (charged) return charged;
  return { ok: true, jobs: [queueJob(prepared.shot, provider, "take")], skipped: [] };
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
  const skipped: SkippedShot[] = [];
  const pending: Shot[] = [];
  for (const shot of shots) {
    const shotModel =
      provider === "comfyui"
        ? modelNameFor(provider, settings, comfyForShot(shot, settings))
        : modelName;
    const decision = classifyShot(shot, existing, provider, shotModel);
    if (decision.action === "skip") {
      skipped.push({
        shotId: shot.id,
        position: shot.position,
        reason: skipReasonText(decision.reason),
        jobId: decision.jobId,
      });
    } else {
      pending.push(shot);
    }
  }

  const seconds = pending.reduce((sum, shot) => sum + (Number(shot.durationSec) || 0), 0);
  const cost = withCredits(
    buildEstimate({ provider, modelName, seconds, settings }),
    provider,
    seconds
  );
  if (pending.length === 0) {
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

  const base = Date.now();
  const jobs = pending.map((shot, index) =>
    queueJob(shot, provider, "take", new Date(base + index).toISOString())
  );
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
  if (!imageExists(source.imagePath)) {
    return { ok: false, status: 400, error: "Start image is missing from disk." };
  }
  const settings = getSettings();
  const provider = source.provider;
  const shot = source.shotId ? getShot(source.shotId) : undefined;
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
    imagePath: source.imagePath,
    endImagePath: source.endImagePath,
    characterSheetPath:
      source.characterSheetPath ?? getProject(source.projectId)?.characterSheetPath,
    characterNote: described.characterNote,
    providerNote: described.providerNote,
    modelName: described.modelName,
    durationSec: source.durationSec,
    status: "queued",
  });
  return { ok: true, jobs: [job], skipped: [] };
}
