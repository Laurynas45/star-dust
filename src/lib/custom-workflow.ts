/**
 * A builder's own ComfyUI API graph, plus the mapping that names where
 * Star Dust writes the still, the prompt, and the rest.
 *
 * Pure: no disk, no network, no secrets. The files live in
 * custom-workflow-files.ts. A broken mapping is refused in full.
 * Nothing here changes the shipped graphs.
 */

export type GraphNode = {
  class_type?: string;
  inputs?: Record<string, unknown>;
  _meta?: { title?: string };
};

export type ApiGraph = Record<string, GraphNode>;

export type InputBinding = {
  node: string;
  input: string;
};

export type FrameRule = {
  /** The text from the mapping, such as 4n+1. */
  text: string;
  step: number;
  offset: number;
};

export type CustomFrameMap = {
  node: string;
  input: string;
  fps: number;
  rule: FrameRule | null;
  min: number | null;
  max: number | null;
};

export type CustomSizeMap = {
  width: InputBinding;
  height: InputBinding;
  maxWidth: number;
  maxHeight: number;
  snap: number;
};

export type CustomLowMemory = {
  maxFrames: number | null;
  maxWidth: number | null;
  maxHeight: number | null;
};

export type CustomGraphMap = {
  name: string;
  startImage: InputBinding;
  prompt: InputBinding | null;
  negativePrompt: InputBinding | null;
  seed: InputBinding | null;
  /** Where a step override is written. Null when the mapping does not name one. */
  steps: InputBinding | null;
  /** Where a CFG override is written. Null when the mapping does not name one. */
  cfg: InputBinding | null;
  frames: CustomFrameMap | null;
  size: CustomSizeMap | null;
  endImage: InputBinding | null;
  output: { node: string };
  lowMemory: CustomLowMemory | null;
};

export type CustomGraph = {
  id: `custom:${string}`;
  slug: string;
  /** Path shown to the builder. Not an absolute path. */
  apiFile: string;
  mapFile: string;
  nodes: ApiGraph;
  map: CustomGraphMap;
};

export type CustomGraphCard = {
  id: `custom:${string}`;
  slug: string;
  title: string;
  file: string;
  ok: boolean;
  errors: string[];
  goodAt: string;
  memory: string;
  defaults: string;
  lowMemory: string;
  detail: string;
  needsEndImage: boolean;
  readsPrompt: boolean;
};

const MAP_KEYS = [
  "name",
  "startImage",
  "prompt",
  "negativePrompt",
  "seed",
  "steps",
  "cfg",
  "frames",
  "size",
  "endImage",
  "output",
  "lowMemory",
] as const;

const BINDING_KEYS = ["node", "input"] as const;
const FRAME_KEYS = ["node", "input", "fps", "rule", "min", "max"] as const;
const SIZE_KEYS = ["width", "height", "maxWidth", "maxHeight", "snap"] as const;
const LOW_KEYS = ["maxFrames", "maxWidth", "maxHeight"] as const;
const OUTPUT_KEYS = ["node"] as const;

const RULE_TEXT = /^([1-9]\d*)n\+([0-9]+)$/;

export function parseFrameRule(text: string): FrameRule | null {
  const match = RULE_TEXT.exec(text.trim());
  if (!match) return null;
  const step = Number(match[1]);
  const offset = Number(match[2]);
  if (!Number.isInteger(step) || !Number.isInteger(offset)) return null;
  if (step < 1 || step > 1024) return null;
  if (offset < 0 || offset >= step) return null;
  return { text: `${step}n+${offset}`, step, offset };
}

export function formatCustomGraphFailure(id: string, errors: readonly string[]): string {
  return [`Custom graph ${id} cannot be used.`, ...errors, "Star Dust does not fall back to a shipped graph."].join(
    "\n"
  );
}

export function customEndMissingMessage(name: string, id: string): string {
  return `${name} (${id}) needs an end still. This shot has no end image, so the job was not started. Star Dust does not switch this graph to another one.`;
}

/**
 * Checks the mapping against the API graph.
 * Every problem is returned. A failure has no map, so a caller cannot apply part of it.
 */
export function validateCustomGraph(
  graph: unknown,
  mapping: unknown
): { ok: true; nodes: ApiGraph; map: CustomGraphMap } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const nodes = readGraph(graph, errors);
  const draft = readMap(mapping, errors);
  if (nodes && draft.bindings.length > 0) checkBindings(nodes, draft.bindings, errors);
  if (!draft.map || errors.length > 0 || !nodes) {
    return { ok: false, errors: errors.length > 0 ? errors : ["The mapping could not be read."] };
  }
  const record: ApiGraph = {};
  for (const [id, node] of Array.from(nodes.entries())) record[id] = node;
  return { ok: true, nodes: record, map: draft.map };
}

export function lowMemorySummary(map: CustomGraphMap): { text: string; changes: boolean } {
  const caps: string[] = [];
  if (map.lowMemory?.maxFrames != null) caps.push(`caps the frame count at ${map.lowMemory.maxFrames}`);
  if (map.lowMemory?.maxWidth != null && map.lowMemory.maxHeight != null) {
    caps.push(`fits the still inside ${map.lowMemory.maxWidth}×${map.lowMemory.maxHeight}`);
  }
  if (caps.length === 0) {
    return {
      changes: false,
      text: "The low-memory preset does nothing for this graph. It does not change the frame count or the size.",
    };
  }
  return {
    changes: true,
    text: `The low-memory preset ${caps.join(" and ")}. The weights are still whatever the graph loads.`,
  };
}

export function defaultsSummary(map: CustomGraphMap): string {
  const parts: string[] = [];
  if (map.frames) {
    const rule = map.frames.rule ? `, snapped to ${map.frames.rule.text}` : "";
    const floor = map.frames.min != null ? `, at least ${map.frames.min}` : "";
    const cap = map.frames.max != null ? `, capped at ${map.frames.max} frames` : "";
    parts.push(`Shot seconds become a frame count at ${map.frames.fps} fps${rule}${floor}${cap}`);
  } else {
    parts.push("The frame count stays as it is in the export");
  }
  if (map.size) {
    parts.push(`the still is fitted inside ${map.size.maxWidth}×${map.size.maxHeight}`);
  } else {
    parts.push("the size stays as it is in the export");
  }
  return `${parts.join(". ")}.`;
}

export function customGraphCard(graph: CustomGraph): CustomGraphCard {
  const memory =
    "No measured VRAM or system RAM. This graph loads whatever files are already named in it. The licence for those weights is yours.";
  const reads = graph.map.prompt
    ? "Star Dust writes the shot prompt."
    : "The mapping does not name a prompt, so the prompt is not written.";
  const end = graph.map.endImage
    ? "An end still is required. A shot without one does not run."
    : "An end still is not sent.";
  const low = lowMemorySummary(graph.map);
  return {
    id: graph.id,
    slug: graph.slug,
    title: graph.map.name,
    file: graph.apiFile,
    ok: true,
    errors: [],
    goodAt: `Your ComfyUI graph. Star Dust injects the start image. ${reads} ${end} Star Dust does not install nodes. Star Dust does not download weights.`,
    memory,
    defaults: defaultsSummary(graph.map),
    lowMemory: low.text,
    detail: `${graph.apiFile} and ${graph.mapFile}. The video is read from node ${graph.map.output.node}.`,
    needsEndImage: graph.map.endImage !== null,
    readsPrompt: graph.map.prompt !== null,
  };
}

export function failedCustomCard(id: `custom:${string}`, slug: string, errors: string[]): CustomGraphCard {
  return {
    id,
    slug,
    title: id,
    file: `data/workflows/${slug}.api.json`,
    ok: false,
    errors,
    goodAt: errors.join(" "),
    memory: "",
    defaults: "",
    lowMemory: "The low-memory preset cannot run, because this mapping is not usable.",
    detail: formatCustomGraphFailure(id, errors),
    needsEndImage: false,
    readsPrompt: false,
  };
}

export type CustomGraphNote = {
  id: `custom:${string}`;
  ok: boolean;
  title: string;
  file: string;
  errors: string[];
  readsPrompt: boolean;
  needsEndImage: boolean;
  sendsSeed: boolean;
  sendsSteps: boolean;
  sendsCfg: boolean;
  sendsFrames: boolean;
  sendsSize: boolean;
  frameSummary: string;
  sizeSummary: string;
  lowMemory: string;
  lowMemoryChanges: boolean;
  outputNode: string;
};

export function noteFromGraph(graph: CustomGraph): CustomGraphNote {
  const low = lowMemorySummary(graph.map);
  return {
    id: graph.id,
    ok: true,
    title: graph.map.name,
    file: graph.apiFile,
    errors: [],
    readsPrompt: graph.map.prompt !== null,
    needsEndImage: graph.map.endImage !== null,
    sendsSeed: graph.map.seed !== null,
    sendsSteps: graph.map.steps !== null,
    sendsCfg: graph.map.cfg !== null,
    sendsFrames: graph.map.frames !== null,
    sendsSize: graph.map.size !== null,
    frameSummary: graph.map.frames
      ? defaultsSummary(graph.map)
      : "The frame count stays as it is in the export.",
    sizeSummary: graph.map.size
      ? `the still fitted inside ${graph.map.size.maxWidth}×${graph.map.size.maxHeight}`
      : "the size stays as it is in the export",
    lowMemory: low.text,
    lowMemoryChanges: low.changes,
    outputNode: graph.map.output.node,
  };
}

export function noteFromFailure(id: `custom:${string}`, errors: string[]): CustomGraphNote {
  const slug = id.slice("custom:".length);
  return {
    id,
    ok: false,
    title: id,
    file: `data/workflows/${slug}.api.json`,
    errors,
    readsPrompt: false,
    needsEndImage: false,
    sendsSeed: false,
    sendsSteps: false,
    sendsCfg: false,
    sendsFrames: false,
    sendsSize: false,
    frameSummary: "",
    sizeSummary: "",
    lowMemory: "The low-memory preset cannot run, because this mapping is not usable.",
    lowMemoryChanges: false,
    outputNode: "",
  };
}

export function formatCustomProviderNote(
  note: CustomGraphNote,
  opts: {
    modelName: string;
    lowMemory: boolean;
    hasEndImage: boolean;
    hasCharacterSheet: boolean;
    serverNote: string;
  }
): { providerNote: string; characterNote?: string } {
  if (!note.ok) {
    return {
      providerNote: formatCustomGraphFailure(note.id, note.errors),
      characterNote: opts.hasCharacterSheet
        ? "Character sheet was not sent. This custom graph is not usable, so the face will not match the sheet."
        : undefined,
    };
  }
  const sends: string[] = ["the start image"];
  if (note.readsPrompt) sends.push("the prompt");
  if (note.needsEndImage) sends.push("the end image");
  if (note.sendsFrames) sends.push("a frame count from the shot duration");
  if (note.sendsSize) sends.push("the output size");
  if (note.sendsSeed) sends.push("the seed");
  if (note.sendsSteps) sends.push("the step count when the shot or project sets one");
  if (note.sendsCfg) sends.push("CFG when the shot or project sets one");
  const parts = [
    `${opts.modelName} posts ${note.file}, polls history, and downloads the video from node ${note.outputNode}. ${note.title}. Star Dust sends ${sends.join(", ")}. ${note.frameSummary} Star Dust does not install custom nodes. Star Dust does not download weights. The licence for the weights is yours. ${opts.serverNote}`,
  ];
  if (opts.lowMemory) {
    parts.push(`The low-memory preset is on. ${note.lowMemory}`);
  } else if (!note.lowMemoryChanges) {
    parts.push(note.lowMemory);
  }
  if (note.needsEndImage) {
    parts.push(
      opts.hasEndImage
        ? "The end image is sent to the mapped input."
        : customEndMissingMessage(note.title, note.id)
    );
  } else if (opts.hasEndImage) {
    parts.push("The end image was not sent. This mapping does not name an end image.");
  }
  if (!note.readsPrompt) {
    parts.push("The mapping does not name a prompt input, so the text prompt is not written.");
  }
  const characterNote = opts.hasCharacterSheet
    ? "Character sheet was not sent. This custom graph has no reference-image input, so the face will not match the sheet."
    : undefined;
  return { providerNote: parts.join(" "), characterNote };
}

/** Active frame cap. Low memory uses its own cap only when the mapping sets one. */
export function frameCap(map: CustomGraphMap, lowMemory: boolean): number | null {
  if (!map.frames) return null;
  if (lowMemory && map.lowMemory?.maxFrames != null) return map.lowMemory.maxFrames;
  return map.frames.max;
}

export function sizeLimits(
  map: CustomGraphMap,
  lowMemory: boolean
): { maxWidth: number; maxHeight: number; snap: number } | null {
  if (!map.size) return null;
  if (lowMemory && map.lowMemory?.maxWidth != null && map.lowMemory.maxHeight != null) {
    return {
      maxWidth: map.lowMemory.maxWidth,
      maxHeight: map.lowMemory.maxHeight,
      snap: map.size.snap,
    };
  }
  return { maxWidth: map.size.maxWidth, maxHeight: map.size.maxHeight, snap: map.size.snap };
}

/**
 * Shot seconds become a frame count.
 * The rule snaps to An+B. A cap snaps down so the result still matches the rule.
 */
export function snapFrameCount(durationSec: number, frames: CustomFrameMap, cap: number | null): number {
  const seconds = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 4;
  const raw = Math.max(1, Math.round(seconds * frames.fps));
  const min = frames.min ?? 1;
  let length = alignUp(raw, frames.rule, min);
  if (cap != null && length > cap) length = alignDown(cap, frames.rule);
  if (length < min) length = alignUp(min, frames.rule, min);
  return length;
}

/** Fit a still inside the box. A still that is already inside is not enlarged. Sides snap. */
export function fitInsideBox(
  width: number,
  height: number,
  limits: { maxWidth: number; maxHeight: number; snap: number }
): { width: number; height: number } {
  const { maxWidth, maxHeight, snap } = limits;
  if (!(width > 0) || !(height > 0)) return { width: maxWidth, height: maxHeight };
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  let nextWidth = Math.max(snap, Math.round((width * scale) / snap) * snap);
  let nextHeight = Math.max(snap, Math.round((height * scale) / snap) * snap);
  if (nextWidth > maxWidth) nextWidth = Math.floor(maxWidth / snap) * snap;
  if (nextHeight > maxHeight) nextHeight = Math.floor(maxHeight / snap) * snap;
  if (nextWidth < snap) nextWidth = snap;
  if (nextHeight < snap) nextHeight = snap;
  return { width: nextWidth, height: nextHeight };
}

export type CustomInjectInput = {
  imageName: string;
  endImageName?: string | null;
  prompt: string;
  seed: number;
  durationSec: number;
  width: number;
  height: number;
  lowMemory: boolean;
};

/**
 * Writes the mapped values into a copy of the graph.
 * The negative prompt is not written: Star Dust has no negative field, so the export's text stays.
 * Model filenames already in the graph stay. Throws if a mapped input is missing, so a partial write is not returned.
 */
export function injectCustomWorkflow(nodes: ApiGraph, map: CustomGraphMap, opts: CustomInjectInput): ApiGraph {
  const next = structuredClone(nodes);
  writeBinding(next, map.startImage, opts.imageName);
  if (map.endImage) {
    if (!opts.endImageName) {
      throw new Error("End image is mapped and no filename was provided.");
    }
    writeBinding(next, map.endImage, opts.endImageName);
  }
  if (map.prompt) writeBinding(next, map.prompt, opts.prompt);
  if (map.seed) writeBinding(next, map.seed, opts.seed);
  if (map.frames) {
    writeBinding(next, map.frames, snapFrameCount(opts.durationSec, map.frames, frameCap(map, opts.lowMemory)));
  }
  const limits = sizeLimits(map, opts.lowMemory);
  if (map.size && limits) {
    const fitted = fitInsideBox(opts.width, opts.height, limits);
    writeBinding(next, map.size.width, fitted.width);
    writeBinding(next, map.size.height, fitted.height);
  }
  return next;
}

/** Box the preflight note compares a still with. Null when this graph does not map a size. */
export function preflightBox(
  map: CustomGraphMap,
  lowMemory: boolean
): { width: number; height: number; writes: string; name: string } | null {
  const limits = sizeLimits(map, lowMemory);
  if (!limits) return null;
  return {
    width: limits.maxWidth,
    height: limits.maxHeight,
    writes: `This custom graph fits the still inside ${limits.maxWidth}×${limits.maxHeight}`,
    name: "this custom graph's box",
  };
}

type ParsedBinding = { label: string; node: string; input: string | null };

function writeBinding(nodes: ApiGraph, binding: { node: string; input: string }, value: unknown) {
  const node = nodes[binding.node];
  if (!node?.inputs || !Object.prototype.hasOwnProperty.call(node.inputs, binding.input)) {
    throw new Error(`Custom graph injection missed node ${binding.node} input ${binding.input}.`);
  }
  node.inputs[binding.input] = value;
}

function alignUp(value: number, rule: FrameRule | null, min: number): number {
  let length = Math.round(value);
  if (length < min) length = min;
  if (!rule) return length;
  const rem = mod(length - rule.offset, rule.step);
  if (rem !== 0) length += rule.step - rem;
  return length;
}

function alignDown(value: number, rule: FrameRule | null): number {
  let length = Math.floor(value);
  if (!rule) return length;
  const rem = mod(length - rule.offset, rule.step);
  if (rem !== 0) length -= rem;
  return length;
}

function mod(value: number, step: number): number {
  return ((value % step) + step) % step;
}

function readGraph(graph: unknown, errors: string[]): Map<string, GraphNode> | null {
  if (!isRecord(graph)) {
    errors.push("The graph must be a JSON object of node ids, from ComfyUI's Export (API).");
    return null;
  }
  if (Array.isArray(graph.nodes)) {
    errors.push(
      "This file is a ComfyUI graph export, not an API export. In ComfyUI use Export (API). Star Dust reads that format only."
    );
    return null;
  }
  const nodes = new Map<string, GraphNode>();
  for (const [id, value] of Object.entries(graph)) {
    if (!isNode(value)) {
      errors.push(`Graph key "${id}" is not a node. An API export is a map of node ids to { class_type, inputs }.`);
      continue;
    }
    nodes.set(id, value);
  }
  if (nodes.size === 0) {
    errors.push("The graph has no nodes.");
    return null;
  }
  return nodes;
}

function readMap(mapping: unknown, errors: string[]): { map: CustomGraphMap | null; bindings: ParsedBinding[] } {
  const bindings: ParsedBinding[] = [];
  if (!isRecord(mapping)) {
    errors.push("The mapping must be a JSON object.");
    return { map: null, bindings };
  }
  const unknown = Object.keys(mapping).filter((key) => !MAP_KEYS.includes(key as (typeof MAP_KEYS)[number]));
  for (const key of unknown) {
    errors.push(`Unknown mapping field "${key}".`);
  }
  const name = readName(mapping.name, errors);
  const startImage = readBinding(mapping.startImage, "startImage", errors, true);
  const prompt = readOptionalBinding(mapping.prompt, "prompt", errors);
  const negativePrompt = readOptionalBinding(mapping.negativePrompt, "negativePrompt", errors);
  const seed = readOptionalBinding(mapping.seed, "seed", errors);
  const steps = readOptionalBinding(mapping.steps, "steps", errors);
  const cfg = readOptionalBinding(mapping.cfg, "cfg", errors);
  const endImage = readOptionalBinding(mapping.endImage, "endImage", errors);
  const frames = readFrames(mapping.frames, errors);
  const size = readSize(mapping.size, errors);
  const output = readOutput(mapping.output, errors);
  const lowMemory = readLowMemory(mapping.lowMemory, frames.ok ? frames.value : null, size.ok ? size.value : null, errors);
  pushBinding(bindings, "startImage", startImage);
  pushBinding(bindings, "prompt", prompt);
  pushBinding(bindings, "negativePrompt", negativePrompt);
  pushBinding(bindings, "seed", seed);
  pushBinding(bindings, "steps", steps);
  pushBinding(bindings, "cfg", cfg);
  pushBinding(bindings, "endImage", endImage);
  if (frames.binding) bindings.push(frames.binding);
  if (size.width) bindings.push({ label: "size.width", node: size.width.node, input: size.width.input });
  if (size.height) bindings.push({ label: "size.height", node: size.height.node, input: size.height.input });
  if (output) bindings.push({ label: "output", node: output.node, input: null });
  const shapeFailed =
    !name ||
    !startImage ||
    prompt === undefined ||
    negativePrompt === undefined ||
    seed === undefined ||
    steps === undefined ||
    cfg === undefined ||
    endImage === undefined ||
    !frames.ok ||
    !size.ok ||
    !output ||
    lowMemory === undefined;
  if (shapeFailed) return { map: null, bindings };
  return {
    map: {
      name,
      startImage,
      prompt,
      negativePrompt,
      seed,
      steps,
      cfg,
      frames: frames.value,
      size: size.value,
      endImage,
      output,
      lowMemory,
    },
    bindings,
  };
}

function pushBinding(bindings: ParsedBinding[], label: string, value: InputBinding | null | undefined) {
  if (!value) return;
  bindings.push({ label, node: value.node, input: value.input });
}

function checkBindings(nodes: Map<string, GraphNode>, bindings: ParsedBinding[], errors: string[]) {
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (binding.input) {
      const key = `${binding.node}.${binding.input}`;
      if (seen.has(key)) {
        errors.push(`${binding.label} uses node "${binding.node}" input "${binding.input}", which another field also uses.`);
      }
      seen.add(key);
    }
    const node = nodes.get(binding.node);
    if (!node) {
      errors.push(`${binding.label} node "${binding.node}" is not in the graph.`);
      continue;
    }
    if (!binding.input) continue;
    if (!node.inputs || !Object.prototype.hasOwnProperty.call(node.inputs, binding.input)) {
      errors.push(`${binding.label} node "${binding.node}" has no input "${binding.input}".`);
      continue;
    }
    if (isLink(node.inputs[binding.input])) {
      errors.push(
        `${binding.label} node "${binding.node}" input "${binding.input}" is wired to another node. Star Dust writes a value there and does not rewire the graph.`
      );
    }
  }
}

function readName(value: unknown, errors: string[]): string | null {
  if (typeof value !== "string") {
    errors.push("name must be a display name.");
    return null;
  }
  if (/[\u0000-\u001f]/.test(value)) {
    errors.push("name cannot contain a line break or a control character.");
    return null;
  }
  const name = value.trim();
  if (!name) {
    errors.push("name is empty.");
    return null;
  }
  if (name.length > 80) {
    errors.push("name is longer than 80 characters.");
    return null;
  }
  return name;
}

function readOptionalBinding(
  value: unknown,
  label: string,
  errors: string[]
): InputBinding | null | undefined {
  if (value === undefined) return null;
  const binding = readBinding(value, label, errors, false);
  if (!binding) return undefined;
  return binding;
}

function readBinding(value: unknown, label: string, errors: string[], required: boolean): InputBinding | null {
  if (value === undefined || value === null) {
    if (required) errors.push(`${label} is required.`);
    else errors.push(`${label} must be { node, input }, or omit the field.`);
    return null;
  }
  if (!isRecord(value)) {
    errors.push(`${label} must be { node, input }.`);
    return null;
  }
  pushUnknown(value, BINDING_KEYS, label, errors);
  const node = readId(value.node, `${label} node`, errors);
  const input = readId(value.input, `${label} input`, errors);
  if (!node || !input) return null;
  return { node, input };
}

function readOutput(value: unknown, errors: string[]): { node: string } | null {
  if (!isRecord(value)) {
    errors.push('output is required. Use { "node": "<id>" }, the node that saves the video.');
    return null;
  }
  pushUnknown(value, OUTPUT_KEYS, "output", errors);
  const node = readId(value.node, "output node", errors);
  if (!node) return null;
  return { node };
}

function readFrames(
  value: unknown,
  errors: string[]
): { ok: boolean; value: CustomFrameMap | null; binding: ParsedBinding | null } {
  if (value === undefined) return { ok: true, value: null, binding: null };
  if (!isRecord(value)) {
    errors.push("frames must be an object with node, input, and fps.");
    return { ok: false, value: null, binding: null };
  }
  pushUnknown(value, FRAME_KEYS, "frames", errors);
  const node = readId(value.node, "frames node", errors);
  const input = readId(value.input, "frames input", errors);
  if (typeof value.fps !== "number" || !Number.isFinite(value.fps) || value.fps <= 0 || value.fps > 240) {
    errors.push("frames fps must be a number greater than 0 and at most 240.");
  }
  let rule: FrameRule | null = null;
  if (value.rule !== undefined) {
    if (typeof value.rule !== "string") {
      errors.push('frames rule must be a string such as "4n+1" or "8n+1".');
    } else {
      rule = parseFrameRule(value.rule);
      if (!rule) {
        errors.push(
          `frames rule "${value.rule}" is not a length rule. Use 4n+1, 8n+1, or another An+B with B smaller than A. Omit rule to keep the rounded count, and use max to cap it.`
        );
      }
    }
  }
  const min = readBound(value.min, "frames min", errors);
  const max = readBound(value.max, "frames max", errors);
  if (min != null && max != null && min > max) {
    errors.push(`frames min is ${min} and max is ${max}. min cannot be greater than max.`);
  }
  if (rule && min != null && max != null && !ruleFits(rule, min, max)) {
    errors.push(`frames rule ${rule.text} has no length from ${min} to ${max}.`);
  } else if (rule && max != null && min == null && !ruleFits(rule, 1, max)) {
    errors.push(`frames rule ${rule.text} has no length from 1 to ${max}.`);
  }
  const fpsOk = typeof value.fps === "number" && Number.isFinite(value.fps) && value.fps > 0 && value.fps <= 240;
  const binding = node && input ? { label: "frames", node, input } : null;
  if (!node || !input || !fpsOk || min === undefined || max === undefined) {
    return { ok: false, value: null, binding };
  }
  if (value.rule !== undefined && rule === null) return { ok: false, value: null, binding };
  if (min != null && max != null && min > max) return { ok: false, value: null, binding };
  if (rule && min != null && max != null && !ruleFits(rule, min, max)) return { ok: false, value: null, binding };
  if (rule && max != null && min == null && !ruleFits(rule, 1, max)) return { ok: false, value: null, binding };
  return {
    ok: true,
    value: { node, input, fps: value.fps as number, rule, min, max },
    binding,
  };
}

function readSize(value: unknown, errors: string[]): {
  ok: boolean;
  value: CustomSizeMap | null;
  width: InputBinding | null;
  height: InputBinding | null;
} {
  if (value === undefined) return { ok: true, value: null, width: null, height: null };
  if (!isRecord(value)) {
    errors.push("size must be an object with width, height, maxWidth, and maxHeight.");
    return { ok: false, value: null, width: null, height: null };
  }
  pushUnknown(value, SIZE_KEYS, "size", errors);
  const width = readBinding(value.width, "size.width", errors, true);
  const height = readBinding(value.height, "size.height", errors, true);
  const snap = value.snap === undefined ? 32 : value.snap;
  if (typeof snap !== "number" || !Number.isInteger(snap) || snap < 1 || snap > 512) {
    errors.push("size snap must be a whole number from 1 to 512. Omit it to use 32.");
  }
  const maxWidth = readBound(value.maxWidth, "size maxWidth", errors);
  const maxHeight = readBound(value.maxHeight, "size maxHeight", errors);
  if (maxWidth === null) errors.push("size maxWidth is required.");
  if (maxHeight === null) errors.push("size maxHeight is required.");
  const snapOk = typeof snap === "number" && Number.isInteger(snap) && snap >= 1 && snap <= 512;
  if (snapOk && maxWidth != null && maxWidth < snap) errors.push(`size maxWidth ${maxWidth} is smaller than snap ${snap}.`);
  if (snapOk && maxHeight != null && maxHeight < snap) {
    errors.push(`size maxHeight ${maxHeight} is smaller than snap ${snap}.`);
  }
  if (snapOk && maxWidth != null && maxWidth >= snap && maxWidth % snap !== 0) {
    errors.push(`size maxWidth ${maxWidth} is not divisible by snap ${snap}.`);
  }
  if (snapOk && maxHeight != null && maxHeight >= snap && maxHeight % snap !== 0) {
    errors.push(`size maxHeight ${maxHeight} is not divisible by snap ${snap}.`);
  }
  if (!width || !height || !snapOk || maxWidth == null || maxHeight == null) {
    return { ok: false, value: null, width, height };
  }
  if (maxWidth < snap || maxHeight < snap || maxWidth % snap !== 0 || maxHeight % snap !== 0) {
    return { ok: false, value: null, width, height };
  }
  return { ok: true, value: { width, height, maxWidth, maxHeight, snap }, width, height };
}

function readLowMemory(
  value: unknown,
  frames: CustomFrameMap | null,
  size: CustomSizeMap | null,
  errors: string[]
): CustomLowMemory | null | undefined {
  if (value === undefined) return null;
  if (!isRecord(value)) {
    errors.push("lowMemory must be an object. Omit it when the preset should do nothing.");
    return undefined;
  }
  pushUnknown(value, LOW_KEYS, "lowMemory", errors);
  const maxFrames = readBound(value.maxFrames, "lowMemory maxFrames", errors);
  const maxWidth = readBound(value.maxWidth, "lowMemory maxWidth", errors);
  const maxHeight = readBound(value.maxHeight, "lowMemory maxHeight", errors);
  if (value.maxWidth !== undefined && value.maxHeight === undefined) {
    errors.push("lowMemory maxHeight is required when maxWidth is set.");
  }
  if (value.maxHeight !== undefined && value.maxWidth === undefined) {
    errors.push("lowMemory maxWidth is required when maxHeight is set.");
  }
  if ((maxFrames != null || value.maxFrames !== undefined) && !frames) {
    errors.push("lowMemory maxFrames is set, but frames is not mapped. Omit it. The preset cannot cap a frame count this graph does not name.");
  }
  if ((maxWidth != null || maxHeight != null || value.maxWidth !== undefined || value.maxHeight !== undefined) && !size) {
    errors.push("lowMemory sets a box, but size is not mapped. Omit it. The preset cannot resize a graph that does not name width and height.");
  }
  if (frames && maxFrames != null) {
    if (frames.min != null && maxFrames < frames.min) {
      errors.push(`lowMemory maxFrames is ${maxFrames}. frames min is ${frames.min}. The cap cannot be below the minimum.`);
    }
    if (frames.max != null && maxFrames > frames.max) {
      errors.push(`lowMemory maxFrames is ${maxFrames}. frames max is ${frames.max}. The low-memory cap cannot be higher than the normal cap.`);
    }
    const floor = frames.min ?? 1;
    if (frames.rule && !ruleFits(frames.rule, floor, maxFrames)) {
      errors.push(`lowMemory maxFrames ${maxFrames} does not match frames rule ${frames.rule.text}.`);
    }
  }
  if (size && maxWidth != null && maxHeight != null) {
    if (maxWidth > size.maxWidth || maxHeight > size.maxHeight) {
      errors.push(
        `lowMemory box ${maxWidth}×${maxHeight} is larger than the normal box ${size.maxWidth}×${size.maxHeight}.`
      );
    }
    if (maxWidth < size.snap || maxHeight < size.snap || maxWidth % size.snap !== 0 || maxHeight % size.snap !== 0) {
      errors.push(`lowMemory box ${maxWidth}×${maxHeight} must use whole multiples of snap ${size.snap}.`);
    }
  }
  if (maxFrames === undefined || maxWidth === undefined || maxHeight === undefined) return undefined;
  const widthSet = value.maxWidth !== undefined;
  const heightSet = value.maxHeight !== undefined;
  if (widthSet !== heightSet) return undefined;
  if (!frames && (value.maxFrames !== undefined || maxFrames != null)) return undefined;
  if (!size && (widthSet || heightSet)) return undefined;
  if (frames && maxFrames != null) {
    if (frames.min != null && maxFrames < frames.min) return undefined;
    if (frames.max != null && maxFrames > frames.max) return undefined;
    if (frames.rule && !ruleFits(frames.rule, frames.min ?? 1, maxFrames)) return undefined;
  }
  if (size && maxWidth != null && maxHeight != null) {
    if (maxWidth > size.maxWidth || maxHeight > size.maxHeight) return undefined;
    if (maxWidth < size.snap || maxHeight < size.snap || maxWidth % size.snap !== 0 || maxHeight % size.snap !== 0) {
      return undefined;
    }
  }
  return { maxFrames, maxWidth, maxHeight };
}

function ruleFits(rule: FrameRule, min: number, max: number): boolean {
  if (max < min) return false;
  const first = alignUp(min, rule, min);
  return first <= max;
}

function readBound(value: unknown, label: string, errors: string[]): number | null | undefined {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10000) {
    errors.push(`${label} must be a whole number from 1 to 10000.`);
    return undefined;
  }
  return value;
}

function readId(value: unknown, label: string, errors: string[]): string | null {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    errors.push(`${label} must be a string. Use the node id from the API export, such as "7".`);
    return null;
  }
  if (value.length > 64 || /[/\\]/.test(value) || value.includes("..")) {
    errors.push(`${label} "${value}" is not a node id.`);
    return null;
  }
  return value;
}

function pushUnknown(value: Record<string, unknown>, allowed: readonly string[], label: string, errors: string[]) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${label} field "${key}" is not used.`);
  }
}

function isLink(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 2) return false;
  const [id, slot] = value;
  const idOk = typeof id === "string" || typeof id === "number";
  return idOk && typeof slot === "number" && Number.isFinite(slot);
}

function isNode(value: unknown): value is GraphNode {
  return isRecord(value) && typeof value.class_type === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

