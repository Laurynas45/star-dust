/**
 * Inserts core LoraLoaderModelOnly nodes into a ComfyUI API graph.
 * An empty list returns the same object, so the queued prompt stays byte-identical.
 * Only UNETLoader and CheckpointLoaderSimple MODEL outputs (slot 0) are rewired.
 * Steps, CFG, and every other input stay as they are.
 */

import { LoraRef } from "./types";

export type LoraGraphNode = {
  class_type?: string;
  inputs?: Record<string, unknown>;
  _meta?: { title?: string };
};

const MODEL_LOADERS = new Set(["UNETLoader", "CheckpointLoaderSimple"]);

function isModelLink(value: unknown, nodeId: string): boolean {
  return Array.isArray(value) && value.length >= 2 && value[0] === nodeId && value[1] === 0;
}

function modelConsumers(workflow: Record<string, LoraGraphNode>, loaderId: string): { nodeId: string; input: string }[] {
  const found: { nodeId: string; input: string }[] = [];
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!node.inputs) continue;
    for (const [input, value] of Object.entries(node.inputs)) {
      if (isModelLink(value, loaderId)) found.push({ nodeId, input });
    }
  }
  return found;
}

function freshId(workflow: Record<string, LoraGraphNode>, base: string): string {
  if (!Object.prototype.hasOwnProperty.call(workflow, base)) return base;
  let suffix = 2;
  while (Object.prototype.hasOwnProperty.call(workflow, `${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

/**
 * Chains one LoraLoaderModelOnly per entry between each diffusion loader and
 * the nodes that read its MODEL output. Wan 14B has two loaders, so each gets
 * the same list. No matching loader, or an empty list, leaves the graph untouched.
 */
export function injectModelLoras<T extends Record<string, LoraGraphNode>>(
  workflow: T,
  loras: readonly LoraRef[]
): T {
  if (loras.length === 0) return workflow;
  const loaderIds = Object.keys(workflow).filter((id) => {
    const classType = workflow[id]?.class_type;
    return typeof classType === "string" && MODEL_LOADERS.has(classType);
  });
  const planned = loaderIds
    .map((loaderId) => ({ loaderId, consumers: modelConsumers(workflow, loaderId) }))
    .filter((item) => item.consumers.length > 0);
  if (planned.length === 0) return workflow;

  const next = structuredClone(workflow) as T;
  for (const item of planned) {
    let source: [string, number] = [item.loaderId, 0];
    loras.forEach((lora, index) => {
      const id = freshId(next, `lora_${item.loaderId}_${index + 1}`);
      (next as Record<string, LoraGraphNode>)[id] = {
        class_type: "LoraLoaderModelOnly",
        inputs: {
          model: [source[0], source[1]],
          lora_name: lora.name,
          strength_model: lora.strength,
        },
        _meta: { title: `LoRA ${index + 1}` },
      };
      source = [id, 0];
    });
    for (const consumer of item.consumers) {
      const node = next[consumer.nodeId];
      if (!node?.inputs) continue;
      node.inputs[consumer.input] = [source[0], source[1]];
    }
  }
  return next;
}
