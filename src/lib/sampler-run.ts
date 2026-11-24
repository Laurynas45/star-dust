/**
 * Loads the graph a shot will run and says which sampler overrides are written.
 * Mock, fal, and Replicate record the numbers and do not sample with them.
 */

import { loadCustomGraphById } from "./custom-workflow-files";
import { loadShippedWorkflow } from "./providers/comfyui";
import {
  SamplerApplyResult,
  SamplerNode,
  SamplerOverride,
  applyCustomSampler,
  applyShippedSampler,
  hostSamplerSentence,
  unreadGraphSentence,
} from "./sampler";
import { ComfyGraphId, ProviderId, isComfyWorkflowId, isCustomGraphId } from "./types";

export function planSampler(
  provider: ProviderId,
  workflowId: ComfyGraphId | null,
  override: SamplerOverride
): SamplerApplyResult<Record<string, SamplerNode>> {
  const empty = { workflow: {}, applied: { steps: null, cfg: null }, notes: [] as string[] };
  if (override.steps == null && override.cfg == null) return empty;
  if (provider !== "comfyui" || !workflowId) {
    if (provider === "mock" || provider === "fal" || provider === "replicate") {
      return { ...empty, notes: [hostSamplerSentence(provider, override)] };
    }
    return empty;
  }
  if (isCustomGraphId(workflowId)) {
    const loaded = loadCustomGraphById(workflowId);
    if (!loaded.ok) return { ...empty, notes: [unreadGraphSentence(override)] };
    return applyCustomSampler(loaded.graph.nodes, loaded.graph.map, override);
  }
  if (!isComfyWorkflowId(workflowId)) return { ...empty, notes: [unreadGraphSentence(override)] };
  return applyShippedSampler(loadShippedWorkflow(workflowId), override);
}
