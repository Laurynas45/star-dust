/**
 * Loads the shipped graphs and turns a fetched /object_info body into a check.
 * No HTTP here, so the ComfyUI client can import this without a cycle.
 */

import fs from "fs";
import path from "path";
import {
  COMFY_CHECK_HONESTY,
  ComfyCheckSource,
  ComfyServerCheck,
  ComfyWorkflowCheck,
  checkComfyReadiness,
  modelSlotsFor,
  statusMessage,
  workflowCheckFromReadiness,
} from "./comfy-readiness";
import { COMFY_WORKFLOW_ORDER, COMFY_WORKFLOWS } from "./provider-info";
import { ComfyWorkflowId } from "./types";

export function loadShippedWorkflow(id: ComfyWorkflowId): unknown {
  const file = path.join(process.cwd(), COMFY_WORKFLOWS[id].file);
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

export function assessShippedWorkflows(
  ids: readonly ComfyWorkflowId[],
  objectInfo: unknown
): ComfyWorkflowCheck[] {
  const unique = ids.filter((id, index) => ids.indexOf(id) === index);
  const ordered = [...unique].sort(
    (a, b) => COMFY_WORKFLOW_ORDER.indexOf(a) - COMFY_WORKFLOW_ORDER.indexOf(b)
  );
  return ordered.map((id) =>
    workflowCheckFromReadiness(id, checkComfyReadiness(loadShippedWorkflow(id), objectInfo, modelSlotsFor(id)))
  );
}

export function serverCheck(args: {
  reachable: boolean;
  url: string;
  source: ComfyCheckSource;
  timedOut: boolean;
  httpStatus: number | null;
  detail: string;
  workflows: ComfyWorkflowCheck[];
}): ComfyServerCheck {
  const check: ComfyServerCheck = {
    reachable: args.reachable,
    url: args.url,
    source: args.source,
    message: "",
    honesty: COMFY_CHECK_HONESTY,
    blocksQueue: !args.reachable || args.workflows.some((workflow) => !workflow.ok),
    timedOut: args.timedOut,
    httpStatus: args.httpStatus,
    detail: args.detail,
    workflows: args.workflows,
  };
  check.message = statusMessage(check, check.source !== "env");
  return check;
}
