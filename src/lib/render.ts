import {
  CLOUD_RISK_NOTE,
  describeProviderUse,
  isPaidProvider,
  missingKeyMessage,
  modelNameFor,
} from "./provider-info";
import { generationIsRefused, MINOR_SEXUAL_REFUSAL } from "./safety";
import { createJob, getProject, getSettings, getShot, listShots } from "./storage";
import { imageExists } from "./uploads";
import { Job, ProviderId } from "./types";

export type RenderFailure = {
  ok: false;
  status: number;
  error: string;
  refused?: boolean;
  needsModelAck?: boolean;
  modelName?: string;
  priceAvailable?: false;
  riskNote?: string;
};

export type RenderSuccess = { ok: true; jobs: Job[] };

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
  | { ok: true; shot: NonNullable<ReturnType<typeof getShot>> }
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

export function renderShot(
  shotId: string,
  opts?: { acknowledgeModel?: string }
): RenderResult {
  const prepared = prepareShot(shotId);
  if (!prepared.ok) return prepared;
  const settings = getSettings();
  const provider = settings.provider;
  const ack = ackFailure(provider, opts?.acknowledgeModel);
  if (ack) return ack;
  const key = keyFailure(provider);
  if (key) return key;

  const project = getProject(prepared.shot.projectId);
  const described = describeProviderUse({
    provider,
    settings,
    hasCharacterSheet: Boolean(project?.characterSheetPath),
    hasEndImage: Boolean(prepared.shot.endImagePath),
  });
  const job = createJob({
    projectId: prepared.shot.projectId,
    shotId: prepared.shot.id,
    prompt: prepared.shot.prompt,
    presetId: prepared.shot.presetId,
    provider,
    imagePath: prepared.shot.startImagePath!,
    endImagePath: prepared.shot.endImagePath,
    characterSheetPath: project?.characterSheetPath,
    characterNote: described.characterNote,
    providerNote: described.providerNote,
    modelName: described.modelName,
    durationSec: prepared.shot.durationSec,
    status: "queued",
  });
  return { ok: true, jobs: [job] };
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
  const ack = ackFailure(provider, opts?.acknowledgeModel);
  if (ack) return ack;
  const key = keyFailure(provider);
  if (key) return key;

  const jobs: Job[] = [];
  const base = Date.now();
  shots.forEach((shot, index) => {
    const described = describeProviderUse({
      provider,
      settings,
      hasCharacterSheet: Boolean(project.characterSheetPath),
      hasEndImage: Boolean(shot.endImagePath),
    });
    jobs.push(
      createJob({
        projectId,
        shotId: shot.id,
        prompt: shot.prompt,
        presetId: shot.presetId,
        provider,
        imagePath: shot.startImagePath!,
        endImagePath: shot.endImagePath,
        characterSheetPath: project.characterSheetPath,
        characterNote: described.characterNote,
        providerNote: described.providerNote,
        modelName: described.modelName,
        durationSec: shot.durationSec,
        status: "queued",
        createdAt: new Date(base + index).toISOString(),
      })
    );
  });
  return { ok: true, jobs };
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
    hasCharacterSheet: Boolean(source.characterSheetPath) || Boolean(getProject(source.projectId)?.characterSheetPath),
    hasEndImage: Boolean(source.endImagePath),
  });
  const job = createJob({
    projectId: source.projectId,
    shotId: source.shotId,
    prompt: source.prompt,
    presetId: source.presetId,
    provider,
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
  return { ok: true, jobs: [job] };
}
