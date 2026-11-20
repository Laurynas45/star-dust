/**
 * ComfyUI LoRA lists on a project and a shot.
 * Pure checks: no disk, no network, no credits.
 * A shot list replaces the project list. It is not added to it.
 */

import { ComfyWorkflowId, LoraRef, isComfyWorkflowId } from "./types";

export const MAX_LORAS = 4;
export const LORA_STRENGTH_MIN = -2;
export const LORA_STRENGTH_MAX = 2;
export const DEFAULT_LORA_STRENGTH = 1;
export const LORA_FOLDER = "models/loras";

/** Shipped graphs whose diffusion model is a UNETLoader or CheckpointLoaderSimple. SVD is not one of them. */
const APPLIES_LORAS = new Set<ComfyWorkflowId>(["wan", "wan-flf", "ltx", "ltx25", "minimax-h3"]);

export function shippedGraphAppliesLoras(id: ComfyWorkflowId): boolean {
  return APPLIES_LORAS.has(id);
}

/** Custom graphs are left alone. SVD uses ImageOnlyCheckpointLoader, so it is left alone too. */
export function shouldInjectLoras(workflowId: string): boolean {
  return isComfyWorkflowId(workflowId) && shippedGraphAppliesLoras(workflowId);
}

export type LoraParse = { ok: true; loras: LoraRef[] } | { ok: false; error: string };

/** Why a file name cannot be sent as lora_name. Null means it can. */
export function loraNameProblem(name: string): string | null {
  if (name.length === 0) return "is empty";
  if (name !== name.trim()) return "has leading or trailing space";
  if (name.length > 200) return "is longer than 200 characters";
  if (/[\u0000-\u001f\u007f]/.test(name)) return "contains a control character";
  if (name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name)) {
    return "must be a file name, not a full path";
  }
  const parts = name.split(/[/\\]/);
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    return "must stay inside the LoRA folder";
  }
  return null;
}

/**
 * A list of { name, strength }.
 * A missing strength is 1. More than 4 entries, a bad name, or a strength
 * outside -2 to 2 is an error. The list is not trimmed to fit.
 */
export function parseLoraList(value: unknown, where = "loras"): LoraParse {
  if (!Array.isArray(value)) {
    return { ok: false, error: `${where} must be a list of { name, strength }.` };
  }
  if (value.length > MAX_LORAS) {
    return { ok: false, error: `${where} has ${value.length} LoRAs. The limit is ${MAX_LORAS}.` };
  }
  const loras: LoraRef[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const label = `${where} ${index + 1}`;
    const entry = value[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: `${label} is not an object.` };
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== "name" && key !== "strength") {
        return { ok: false, error: `${label} has an unknown field "${key}".` };
      }
    }
    if (typeof record.name !== "string") {
      return { ok: false, error: `${label} name must be the file name ComfyUI lists.` };
    }
    const problem = loraNameProblem(record.name);
    if (problem) return { ok: false, error: `${label} name ${problem}.` };
    let strength = DEFAULT_LORA_STRENGTH;
    if ("strength" in record && record.strength !== undefined) {
      if (typeof record.strength !== "number" || !Number.isFinite(record.strength)) {
        return {
          ok: false,
          error: `${label} strength must be a number from ${LORA_STRENGTH_MIN} to ${LORA_STRENGTH_MAX}.`,
        };
      }
      strength = record.strength;
    }
    if (strength < LORA_STRENGTH_MIN || strength > LORA_STRENGTH_MAX) {
      return {
        ok: false,
        error: `${label} strength is ${strength}. The range is ${LORA_STRENGTH_MIN} to ${LORA_STRENGTH_MAX}.`,
      };
    }
    loras.push({ name: record.name, strength });
  }
  return { ok: true, loras };
}

/** Shot list replaces the project list. Null on the shot means use the project list. */
export function effectiveLoras(
  project: { loras?: readonly LoraRef[] | null },
  shot?: { loras?: readonly LoraRef[] | null } | null
): LoraRef[] {
  if (shot && shot.loras != null) return shot.loras.map((lora) => ({ ...lora }));
  return (project.loras ?? []).map((lora) => ({ ...lora }));
}

/** Stable token for a content key. Empty when the list is empty. */
export function loraInputToken(loras: readonly LoraRef[]): string {
  if (loras.length === 0) return "";
  return loras.map((lora) => `${lora.name}@${lora.strength}`).join("|");
}

export function encodeProjectLoras(loras: readonly LoraRef[]): string | null {
  if (loras.length === 0) return null;
  return JSON.stringify(loras);
}

/** Null means inherit. An array, including an empty one, is stored as JSON. */
export function encodeShotLoras(loras: readonly LoraRef[] | null): string | null {
  if (loras == null) return null;
  return JSON.stringify(loras);
}

export function decodeProjectLoras(raw: unknown): LoraRef[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = parseLoraList(JSON.parse(raw), "Stored LoRAs");
    return parsed.ok ? parsed.loras : [];
  } catch {
    return [];
  }
}

export function decodeShotLoras(raw: unknown): LoraRef[] | null {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string") return null;
  try {
    const parsed = parseLoraList(JSON.parse(raw), "Stored LoRAs");
    return parsed.ok ? parsed.loras : null;
  } catch {
    return null;
  }
}
