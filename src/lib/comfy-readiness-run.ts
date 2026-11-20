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
  literalModelSlots,
  modelSlotsFor,
  statusMessage,
  workflowCheckFromReadiness,
} from "./comfy-readiness";
import { loadCustomGraphById } from "./custom-workflow-files";
import { compareGraphIds, COMFY_WORKFLOW_ORDER, COMFY_WORKFLOWS } from "./provider-info";
import { ComfyGraphId, ComfyWorkflowId, isComfyWorkflowId } from "./types";

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

/**
 * Shipped graphs and custom graphs.
 * A custom graph that is missing or whose mapping is broken is a failing row.
 * It is not replaced with a shipped graph. The caller can skip the network
 * when every requested id failed this way.
 */
export function prepareGraphChecks(ids: readonly ComfyGraphId[]): {
  runnable: ComfyGraphId[];
  failed: ComfyWorkflowCheck[];
} {
  const unique = ids.filter((id, index) => ids.indexOf(id) === index);
  const runnable: ComfyGraphId[] = [];
  const failed: ComfyWorkflowCheck[] = [];
  for (const id of unique) {
    if (isComfyWorkflowId(id)) {
      runnable.push(id);
      continue;
    }
    const loaded = loadCustomGraphById(id);
    if (!loaded.ok) {
      failed.push(customFailureCheck(id, loaded.errors));
      continue;
    }
    runnable.push(id);
  }
  return { runnable, failed };
}

export function assessWorkflows(ids: readonly ComfyGraphId[], objectInfo: unknown): ComfyWorkflowCheck[] {
  const unique = ids.filter((id, index) => ids.indexOf(id) === index);
  const checks: ComfyWorkflowCheck[] = [];
  for (const id of unique) {
    if (isComfyWorkflowId(id)) {
      checks.push(
        workflowCheckFromReadiness(id, checkComfyReadiness(loadShippedWorkflow(id), objectInfo, modelSlotsFor(id)))
      );
      continue;
    }
    const loaded = loadCustomGraphById(id);
    if (!loaded.ok) {
      checks.push(customFailureCheck(id, loaded.errors));
      continue;
    }
    checks.push(
      workflowCheckFromReadiness(
        id,
        checkComfyReadiness(loaded.graph.nodes, objectInfo, literalModelSlots(loaded.graph.nodes), {
          source: "custom",
        }),
        { title: loaded.graph.map.name, file: loaded.graph.apiFile }
      )
    );
  }
  checks.sort((a, b) => compareGraphIds(a.id, b.id));
  return checks;
}

function customFailureCheck(id: ComfyGraphId, errors: string[]): ComfyWorkflowCheck {
  const slug = id.startsWith("custom:") ? id.slice("custom:".length) : id;
  return {
    id,
    title: id,
    file: `data/workflows/${slug}.api.json`,
    ok: false,
    blocksQueue: true,
    missingNodes: [
      ...errors.map((error, index) => ({
        kind: "node" as const,
        classType: "mapping",
        nodeId: String(index + 1),
        nextStep: error,
      })),
      {
        kind: "node" as const,
        classType: "mapping",
        nodeId: String(errors.length + 1),
        nextStep: "Star Dust does not fall back to a shipped graph.",
      },
    ],
    missingModels: [],
    vaeWarnings: [],
    inputNotes: [],
    inputBlocks: [],
  };
}

export function serverCheck(args: {
  reachable: boolean;
  url: string;
  source: ComfyCheckSource;
  timedOut: boolean;
  httpStatus: number | null;
  detail: string;
  workflows: ComfyWorkflowCheck[];
  loraNames?: string[];
  loraIssues?: ComfyServerCheck["loraIssues"];
}): ComfyServerCheck {
  const loraBlock = (args.loraIssues?.length ?? 0) > 0;
  const check: ComfyServerCheck = {
    reachable: args.reachable,
    url: args.url,
    source: args.source,
    message: "",
    honesty: COMFY_CHECK_HONESTY,
    blocksQueue: !args.reachable || args.workflows.some((workflow) => !workflow.ok) || loraBlock,
    timedOut: args.timedOut,
    httpStatus: args.httpStatus,
    detail: args.detail,
    workflows: args.workflows,
    ...(args.loraNames ? { loraNames: args.loraNames, loraIssues: args.loraIssues ?? [] } : {}),
  };
  check.message = statusMessage(check, check.source !== "env");
  return check;
}
