/**
 * Optional sampler overrides on a project and a shot.
 * A shot number replaces the project number. Null means unset.
 * Unset steps or CFG keep the graph default.
 * Pure: no disk, no network, no credits.
 */

export const STEPS_MIN = 1;
export const STEPS_MAX = 100;
export const CFG_MIN = 0;
export const CFG_MAX = 30;

export type SamplerOverride = {
  steps: number | null;
  cfg: number | null;
};

export type SamplerNode = {
  class_type?: string;
  inputs?: Record<string, unknown>;
  _meta?: { title?: string };
};

export type SamplerTarget = {
  node: string;
  input: string;
};

export type SamplerApplyResult<T> = {
  /** Same object when nothing was written. */
  workflow: T;
  /** Values written onto the graph. A raised two-stage count is the number written. */
  applied: SamplerOverride;
  /** Set when a requested value was not written, or a two-stage count was raised. */
  notes: string[];
};

const NUMBER_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

export function formatCfg(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return String(rounded);
}

/** Text for the shot card and the contact sheet, beside the seed. Empty when both are unset. */
export function formatSamplerBesideSeed(steps: number | null | undefined, cfg: number | null | undefined): string {
  const parts: string[] = [];
  if (steps != null && Number.isFinite(steps)) parts.push(`${Math.trunc(steps)} steps`);
  if (cfg != null && Number.isFinite(cfg)) parts.push(`cfg ${formatCfg(cfg)}`);
  return parts.join(" · ");
}

/** Shot value replaces the project value. Null on the shot keeps the project value. */
export function effectiveSampler(
  project: { steps?: number | null; cfg?: number | null },
  shot?: { steps?: number | null; cfg?: number | null } | null
): SamplerOverride {
  return {
    steps: shot != null && shot.steps != null ? shot.steps : project.steps ?? null,
    cfg: shot != null && shot.cfg != null ? shot.cfg : project.cfg ?? null,
  };
}

/** Fields for a manifest. Omitted when unset. */
export function manifestSampler(override: SamplerOverride): { steps?: number; cfg?: number } {
  const fields: { steps?: number; cfg?: number } = {};
  if (override.steps != null) fields.steps = override.steps;
  if (override.cfg != null) fields.cfg = override.cfg;
  return fields;
}

/** Token for a content key. Empty when nothing was written, so older keys stay put. */
export function samplerKeyToken(applied: SamplerOverride): string {
  const parts: string[] = [];
  if (applied.steps != null) parts.push(`steps=${applied.steps}`);
  if (applied.cfg != null) parts.push(`cfg=${formatCfg(applied.cfg)}`);
  return parts.join("|");
}

export function parseStepsValue(
  value: unknown,
  where = "steps",
  opts?: { allowString?: boolean }
): { ok: true; steps: number } | { ok: false; error: string } {
  const numeric = coerceNumber(value, opts?.allowString === true);
  if (numeric == null || !Number.isInteger(numeric)) {
    return { ok: false, error: `${where} must be a whole number from ${STEPS_MIN} to ${STEPS_MAX}.` };
  }
  if (numeric < STEPS_MIN || numeric > STEPS_MAX) {
    return { ok: false, error: `${where} is ${numeric}. The range is ${STEPS_MIN} to ${STEPS_MAX}.` };
  }
  return { ok: true, steps: numeric };
}

/**
 * Reads steps and cfg when those keys are present.
 * Null clears the value. A missing key is left off the result.
 */
export function readSamplerFields(
  body: Record<string, unknown>
): { ok: true; steps?: number | null; cfg?: number | null } | { ok: false; error: string } {
  const value: { steps?: number | null; cfg?: number | null } = {};
  if ("steps" in body) {
    if (body.steps == null) value.steps = null;
    else {
      const parsed = parseStepsValue(body.steps, "steps");
      if (!parsed.ok) return parsed;
      value.steps = parsed.steps;
    }
  }
  if ("cfg" in body) {
    if (body.cfg == null) value.cfg = null;
    else {
      const parsed = parseCfgValue(body.cfg, "cfg");
      if (!parsed.ok) return parsed;
      value.cfg = parsed.cfg;
    }
  }
  return { ok: true, ...value };
}

export function parseCfgValue(
  value: unknown,
  where = "cfg",
  opts?: { allowString?: boolean }
): { ok: true; cfg: number } | { ok: false; error: string } {
  const numeric = coerceNumber(value, opts?.allowString === true);
  if (numeric == null) {
    return { ok: false, error: `${where} must be a number from ${CFG_MIN} to ${CFG_MAX}.` };
  }
  if (numeric < CFG_MIN || numeric > CFG_MAX) {
    return { ok: false, error: `${where} is ${formatCfg(numeric)}. The range is ${CFG_MIN} to ${CFG_MAX}.` };
  }
  return { ok: true, cfg: numeric };
}

/**
 * Mock, fal, and Replicate store the numbers and do not sample with them.
 * fal and Replicate have no num_inference_steps or guidance field on the request.
 */
export function hostSamplerSentence(provider: "mock" | "fal" | "replicate", override: SamplerOverride): string {
  const named = namedOverride(override);
  const both = override.steps != null && override.cfg != null;
  const plural = both || override.steps != null;
  if (provider === "mock") {
    const what = both ? "them" : override.steps != null ? "that step count" : "that CFG";
    return `${named} ${plural ? "are" : "is"} stored. Mock does not use ${what}. The clip is still camera motion on the still.`;
  }
  const name = provider === "fal" ? "fal" : "Replicate";
  return `${named} ${plural ? "are" : "is"} stored. The ${name} request has no num_inference_steps or guidance field, so ${plural ? "they are" : "it is"} not sent.`;
}

export function unreadGraphSentence(override: SamplerOverride): string {
  return `${namedOverride(override)} ${override.steps != null && override.cfg != null ? "were" : "was"} not applied. This graph could not be read, so the sample is unchanged.`;
}

/**
 * Writes steps and CFG onto a shipped graph by the nodes that graph actually has.
 * An empty override returns the same object.
 * A fixed sigma list does not gain a step count. The note says so.
 */
export function applyShippedSampler<T extends Record<string, SamplerNode>>(
  workflow: T,
  override: SamplerOverride
): SamplerApplyResult<T> {
  if (override.steps == null && override.cfg == null) {
    return { workflow, applied: { steps: null, cfg: null }, notes: [] };
  }
  const notes: string[] = [];
  let appliedSteps: number | null = null;
  let appliedCfg: number | null = null;
  const next = structuredClone(workflow);

  if (override.cfg != null && writeCfg(next, override.cfg)) appliedCfg = override.cfg;
  if (override.steps != null) {
    const written = writeSteps(next, override.steps, notes);
    if (written != null) appliedSteps = written;
  }

  if (override.steps != null && appliedSteps == null) {
    notes.push(stepsSkippedNote(next, override.steps));
  }
  if (override.cfg != null && appliedCfg == null) {
    notes.push(cfgSkippedNote(next, override.cfg));
  }

  if (appliedSteps == null && appliedCfg == null) {
    return { workflow, applied: { steps: null, cfg: null }, notes };
  }
  return { workflow: next, applied: { steps: appliedSteps, cfg: appliedCfg }, notes };
}

/**
 * Writes steps and CFG only where the mapping names a target.
 * An unmapped value is left off the graph and named in notes.
 */
export function applyCustomSampler<T extends Record<string, SamplerNode>>(
  workflow: T,
  map: { steps: SamplerTarget | null; cfg: SamplerTarget | null },
  override: SamplerOverride
): SamplerApplyResult<T> {
  if (override.steps == null && override.cfg == null) {
    return { workflow, applied: { steps: null, cfg: null }, notes: [] };
  }
  const notes: string[] = [];
  let appliedSteps: number | null = null;
  let appliedCfg: number | null = null;
  const next = structuredClone(workflow);

  if (override.steps != null) {
    if (!map.steps) {
      notes.push(
        `Steps ${override.steps} were not applied. This custom graph's mapping does not name a steps input.`
      );
    } else if (writeTarget(next, map.steps, override.steps)) {
      appliedSteps = override.steps;
    } else {
      notes.push(
        `Steps ${override.steps} were not applied. The mapped steps input ${map.steps.node}.${map.steps.input} is not a value this graph can take.`
      );
    }
  }
  if (override.cfg != null) {
    if (!map.cfg) {
      notes.push(
        `CFG ${formatCfg(override.cfg)} was not applied. This custom graph's mapping does not name a cfg input.`
      );
    } else if (writeTarget(next, map.cfg, override.cfg)) {
      appliedCfg = override.cfg;
    } else {
      notes.push(
        `CFG ${formatCfg(override.cfg)} was not applied. The mapped cfg input ${map.cfg.node}.${map.cfg.input} is not a value this graph can take.`
      );
    }
  }

  if (appliedSteps == null && appliedCfg == null) {
    return { workflow, applied: { steps: null, cfg: null }, notes };
  }
  return { workflow: next, applied: { steps: appliedSteps, cfg: appliedCfg }, notes };
}

/**
 * New step boundaries for a two-stage schedule.
 * The split stays the same fraction of the total, rounded.
 * Each stage gets at least one step. A request below that uses one step per stage.
 */
export function scaleStageStarts(
  originalSteps: number,
  starts: readonly number[],
  requested: number
): { steps: number; starts: number[]; raised: boolean } {
  const count = starts.length;
  let steps = requested;
  let raised = false;
  if (steps < count) {
    steps = count;
    raised = true;
  }
  const scaled = starts.map((start) => Math.round((start / originalSteps) * steps));
  for (let index = 1; index < count; index += 1) {
    if (scaled[index] <= scaled[index - 1]) scaled[index] = scaled[index - 1] + 1;
  }
  if (count > 0 && scaled[count - 1] > steps - 1) {
    scaled[count - 1] = steps - 1;
    for (let index = count - 2; index >= 1; index -= 1) {
      if (scaled[index] > scaled[index + 1] - 1) scaled[index] = scaled[index + 1] - 1;
    }
  }
  if (count > 0) scaled[0] = starts[0] === 0 ? 0 : scaled[0];
  return { steps, starts: scaled, raised };
}

function namedOverride(override: SamplerOverride): string {
  const parts: string[] = [];
  if (override.steps != null) parts.push(`Steps ${override.steps}`);
  if (override.cfg != null) parts.push(`CFG ${formatCfg(override.cfg)}`);
  return parts.join(" and ");
}

function coerceNumber(value: unknown, allowString: boolean): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (!allowString || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!NUMBER_TEXT.test(trimmed)) return null;
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : null;
}

function writeTarget(workflow: Record<string, SamplerNode>, target: SamplerTarget, value: number): boolean {
  const node = workflow[target.node];
  if (!node?.inputs || !Object.prototype.hasOwnProperty.call(node.inputs, target.input)) return false;
  if (Array.isArray(node.inputs[target.input])) return false;
  node.inputs[target.input] = value;
  return true;
}

function writeCfg(workflow: Record<string, SamplerNode>, cfg: number): boolean {
  let wrote = false;
  for (const node of Object.values(workflow)) {
    if (!node.inputs) continue;
    if (node.class_type === "KSampler" || node.class_type === "KSamplerAdvanced" || node.class_type === "CFGGuider") {
      if ("cfg" in node.inputs && !Array.isArray(node.inputs.cfg)) {
        node.inputs.cfg = cfg;
        wrote = true;
      }
    }
    if (node.class_type === "LTXVDualCFGGuider") {
      if ("video_cfg" in node.inputs && !Array.isArray(node.inputs.video_cfg)) {
        node.inputs.video_cfg = cfg;
        wrote = true;
      }
      if ("audio_cfg" in node.inputs && !Array.isArray(node.inputs.audio_cfg)) {
        node.inputs.audio_cfg = cfg;
        wrote = true;
      }
    }
  }
  return wrote;
}

function writeSteps(workflow: Record<string, SamplerNode>, steps: number, notes: string[]): number | null {
  const advanced = Object.entries(workflow).filter(([, node]) => node.class_type === "KSamplerAdvanced" && node.inputs);
  let wrote = false;
  let written: number | null = null;
  if (advanced.length >= 2) {
    const scaled = writeAdvancedSplit(advanced, steps, notes);
    if (scaled != null) {
      wrote = true;
      written = scaled;
    }
  } else if (advanced.length === 1) {
    const node = advanced[0][1];
    if (node.inputs && "steps" in node.inputs && typeof node.inputs.steps === "number") {
      node.inputs.steps = steps;
      wrote = true;
      written = steps;
    }
  }
  for (const node of Object.values(workflow)) {
    if (!node.inputs || node.class_type === "KSamplerAdvanced") continue;
    if (
      (node.class_type === "KSampler" || node.class_type === "BasicScheduler" || node.class_type === "LTXVScheduler") &&
      "steps" in node.inputs &&
      typeof node.inputs.steps === "number"
    ) {
      node.inputs.steps = steps;
      wrote = true;
      written = steps;
    }
  }
  return wrote ? written : null;
}

function writeAdvancedSplit(
  advanced: [string, SamplerNode][],
  requested: number,
  notes: string[]
): number | null {
  const stages = advanced
    .map(([id, node]) => ({
      id,
      node,
      steps: Number(node.inputs?.steps),
      start: Number(node.inputs?.start_at_step),
      end: Number(node.inputs?.end_at_step),
    }))
    .filter((stage) => Number.isFinite(stage.steps) && Number.isFinite(stage.start) && Number.isFinite(stage.end))
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  if (stages.length < 2) return null;
  const schedule = stages[0].steps;
  if (!(schedule > 0)) return null;
  const scaled = scaleStageStarts(
    schedule,
    stages.map((stage) => stage.start),
    requested
  );
  stages.forEach((stage, index) => {
    const inputs = stage.node.inputs;
    if (!inputs) return;
    const sentinel = stage.end > schedule;
    inputs.steps = scaled.steps;
    inputs.start_at_step = scaled.starts[index];
    if (!sentinel) {
      const next = scaled.starts[index + 1];
      inputs.end_at_step = next == null ? scaled.steps : next;
    }
  });
  if (scaled.raised) {
    notes.push(
      `Steps ${requested} cannot give each of the ${stages.length} sample stages at least 1 step. The schedule uses ${scaled.steps} steps, one in each stage.`
    );
  }
  return scaled.steps;
}

function stepsSkippedNote(workflow: Record<string, SamplerNode>, steps: number): string {
  const fixed = Object.values(workflow).some((node) => node.class_type === "ManualSigmas");
  if (fixed) {
    return `Steps ${steps} were not applied. This graph samples from a fixed sigma list (ManualSigmas), which has no step count.`;
  }
  return `Steps ${steps} were not applied. This graph has no step-count input Star Dust can set.`;
}

function cfgSkippedNote(workflow: Record<string, SamplerNode>, cfg: number): string {
  const basic = Object.values(workflow).some((node) => node.class_type === "BasicGuider");
  if (basic) {
    return `CFG ${formatCfg(cfg)} was not applied. This graph uses BasicGuider, which has no CFG input.`;
  }
  return `CFG ${formatCfg(cfg)} was not applied. This graph has no CFG input Star Dust can set.`;
}
