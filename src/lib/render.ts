import { buildEstimate } from "./cost";
import {
  CLOUD_RISK_NOTE,
  describeProviderUse,
  isPaidProvider,
  missingKeyMessage,
  modelNameFor,
} from "./provider-info";
import { generationIsRefused, MINOR_SEXUAL_REFUSAL } from "./safety";
import { createJob, getProject, getSettings, getShot, listJobs, listShots } from "./storage";
import { classifyShot, skipReasonText } from "./takes";
import { imageExists } from "./uploads";
import { CostEstimate, Job, JobKind, ProviderId, Shot } from "./types";

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
  const modelName = modelNameFor(provider, settings);
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
  const key = keyFailure(provider);
  if (key) return key;
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
    const decision = classifyShot(shot, existing, provider, modelName);
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
  const cost = buildEstimate({ provider, modelName, seconds, settings });
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
  const key = keyFailure(provider);
  if (key) return { ...key, cost };

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
  const ack = ackFailure(provider, opts?.acknowledgeModel);
  if (ack) return ack;
  const key = keyFailure(provider);
  if (key) return key;
  const described = describeProviderUse({
    provider,
    settings,
    hasCharacterSheet:
      Boolean(source.characterSheetPath) || Boolean(getProject(source.projectId)?.characterSheetPath),
    hasEndImage: Boolean(source.endImagePath),
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
