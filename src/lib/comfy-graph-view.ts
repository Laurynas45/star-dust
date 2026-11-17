/**
 * Labels for the workflow pickers. No disk. Custom cards come from the settings API.
 */

import type { CustomGraphCard } from "./custom-workflow";
import { COMFY_WORKFLOW_ORDER, COMFY_WORKFLOWS, type ComfyWorkflowInfo } from "./provider-info";
import { ComfyGraphId, isComfyWorkflowId, isCustomGraphId } from "./types";

export type GraphBlurb = {
  title: string;
  file: string;
  goodAt: string;
  memory: string;
  defaults: string;
  lowMemory: string;
  missing: boolean;
};

export function graphBlurb(id: ComfyGraphId, cards: readonly CustomGraphCard[]): GraphBlurb {
  if (isComfyWorkflowId(id)) {
    const info: ComfyWorkflowInfo = COMFY_WORKFLOWS[id];
    return {
      title: info.title,
      file: info.file,
      goodAt: info.goodAt,
      memory: info.memory,
      defaults: info.defaults,
      lowMemory: info.lowMemory,
      missing: false,
    };
  }
  const card = cards.find((item) => item.id === id);
  if (!card) {
    return {
      title: id,
      file: `data/workflows/${id.slice("custom:".length)}.api.json`,
      goodAt: `${id} is not in data/workflows. Star Dust does not fall back to a shipped graph.`,
      memory: "",
      defaults: "",
      lowMemory: "The low-memory preset cannot run, because the graph files are missing.",
      missing: true,
    };
  }
  return {
    title: card.ok ? card.title : card.id,
    file: card.file,
    goodAt: card.ok ? card.goodAt : card.errors.join(" "),
    memory: card.memory,
    defaults: card.defaults,
    lowMemory: card.lowMemory,
    missing: !card.ok,
  };
}

export function graphChoices(
  cards: readonly CustomGraphCard[],
  selected: ComfyGraphId | null | undefined
): { id: ComfyGraphId; title: string }[] {
  const rows: { id: ComfyGraphId; title: string }[] = COMFY_WORKFLOW_ORDER.map((id) => ({
    id,
    title: COMFY_WORKFLOWS[id].title,
  }));
  for (const card of cards) {
    if (!card.ok) continue;
    rows.push({ id: card.id, title: card.title });
  }
  if (selected && isCustomGraphId(selected) && !rows.some((row) => row.id === selected)) {
    const card = cards.find((item) => item.id === selected);
    rows.push({
      id: selected,
      title: card && !card.ok ? `${selected} (mapping error)` : `${selected} (not in data/workflows)`,
    });
  }
  return rows;
}
