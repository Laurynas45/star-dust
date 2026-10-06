import fs from "fs";
import path from "path";
import { licenseKeyPresent } from "./license";
import { getProject, listShots } from "./storage";
import { PackWorkflowInfo } from "./types";

export const PACK_WORKFLOW: PackWorkflowInfo = {
  id: "pack-hold",
  title: "Pack hold",
  detail:
    "Local worker plan for shot order, durations, and still paths. It does not call a model and does not replace Mock, fal, Replicate, or the shipped ComfyUI graphs.",
};

export const PACK_WORKFLOW_FILE = "workflows/pack-hold.json";

export function packUnlocked(env: NodeJS.ProcessEnv = process.env): boolean {
  return licenseKeyPresent(env);
}

export function visiblePackWorkflows(env: NodeJS.ProcessEnv = process.env): PackWorkflowInfo[] {
  return packUnlocked(env) ? [PACK_WORKFLOW] : [];
}

export function packHoldFileExists(): boolean {
  return fs.existsSync(path.join(process.cwd(), PACK_WORKFLOW_FILE));
}

export type WorkerShot = {
  position: number;
  prompt: string;
  durationSec: number;
  startImagePath?: string;
};

export type WorkerPlan =
  | {
      ok: true;
      unlocked: true;
      projectId: string;
      workflow: string;
      workflowFile: string;
      note: string;
      shots: WorkerShot[];
    }
  | { ok: false; unlocked: false; error: string }
  | { ok: false; unlocked: true; error: string };

const LOCKED =
  "Self-hosted pack is locked. Set STAR_DUST_LICENSE_KEY to unlock the local worker plan. Mock and the shipped providers still run. The key is not sent anywhere.";

/** Shot order for an operator's own worker. Reads SQLite only. */
export function workerPlan(projectId: string): WorkerPlan {
  if (!packUnlocked()) {
    return { ok: false, unlocked: false, error: LOCKED };
  }
  const project = getProject(projectId);
  if (!project) return { ok: false, unlocked: true, error: "Project not found" };
  const shots = listShots(projectId).map((shot) => ({
    position: shot.position,
    prompt: shot.prompt,
    durationSec: shot.durationSec,
    startImagePath: shot.startImagePath,
  }));
  return {
    ok: true,
    unlocked: true,
    projectId,
    workflow: PACK_WORKFLOW.id,
    workflowFile: PACK_WORKFLOW_FILE,
    note: "Local plan only. Star Dust did not contact a license server.",
    shots,
  };
}
