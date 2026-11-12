/**
 * ComfyUI progress messages and the line shown while a job runs.
 * Pure functions. No sockets, no secrets, and no server URL.
 */

export type ComfyNodeInfo = { classType?: string; title?: string };

export type ComfyNodes = Record<string, ComfyNodeInfo>;

export type ComfyPhase = "queued" | "sampling" | "decoding" | "running";

export interface ComfySnapshot {
  phase: ComfyPhase;
  queuePosition?: number;
  step?: number;
  stepMax?: number;
  nodeId?: string;
  nodeClass?: string;
  nodeTitle?: string;
  /** "stage 1" or "stage 2" when the graph has more than one sampler. */
  stage?: string;
  seenExecution: boolean;
}

export type QueuePlacement =
  | { where: "pending"; position: number }
  | { where: "running" }
  | { where: "absent" };

const SAMPLER_CLASSES = new Set(["KSampler", "KSamplerAdvanced", "SamplerCustomAdvanced"]);

export function emptyComfySnapshot(): ComfySnapshot {
  return { phase: "running", seenExecution: false };
}

export function nodesFromWorkflow(
  workflow: Record<string, { class_type?: string; _meta?: { title?: string } }>
): ComfyNodes {
  const nodes: ComfyNodes = {};
  for (const [id, node] of Object.entries(workflow)) {
    nodes[id] = { classType: node?.class_type, title: node?._meta?.title };
  }
  return nodes;
}

function nodeKind(info: ComfyNodeInfo | undefined): "sampler" | "decode" | "other" {
  const classType = info?.classType || "";
  const title = info?.title || "";
  if (/decode/i.test(classType) || /decode/i.test(title)) return "decode";
  if (SAMPLER_CLASSES.has(classType)) return "sampler";
  return "other";
}

/** Stage label for a sampler. High-noise is stage 1 and low-noise is stage 2. */
export function samplerStageLabel(nodes: ComfyNodes, nodeId: string): string | undefined {
  const samplers = Object.entries(nodes).filter(([, info]) => nodeKind(info) === "sampler");
  if (samplers.length < 2) return undefined;
  const info = nodes[nodeId];
  if (!info || nodeKind(info) !== "sampler") return undefined;
  const title = info.title || "";
  if (/high[- ]noise/i.test(title)) return "stage 1";
  if (/low[- ]noise/i.test(title)) return "stage 2";
  const index = samplers.findIndex(([id]) => id === nodeId);
  if (index < 0) return undefined;
  return `stage ${index + 1}`;
}

/** Drop anything that could carry a URL. Titles from the shipped graphs are short. */
export function cleanNodeLabel(value: string | undefined): string {
  if (!value) return "";
  const text = value.replace(/[\r\n\t]+/g, " ").trim();
  if (!text || /:\/\//.test(text)) return "";
  return text.slice(0, 80);
}

function asStep(value: number): number | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Number.isInteger(value) ? value : Math.round(value);
}

function promptOwns(data: Record<string, unknown>, promptId: string, allowMissing: boolean): boolean {
  const id = typeof data.prompt_id === "string" ? data.prompt_id : "";
  if (!id) return allowMissing;
  return id === promptId;
}

function withNode(snapshot: ComfySnapshot, nodeId: string, nodes: ComfyNodes): ComfySnapshot {
  const info = nodes[nodeId];
  const kind = nodeKind(info);
  const next: ComfySnapshot = {
    ...snapshot,
    seenExecution: true,
    phase: "running",
    nodeId,
    nodeClass: info?.classType,
    nodeTitle: info?.title,
    queuePosition: undefined,
    step: undefined,
    stepMax: undefined,
    stage: undefined,
  };
  if (kind === "decode") next.phase = "decoding";
  else if (kind === "sampler") {
    next.phase = "sampling";
    next.stage = samplerStageLabel(nodes, nodeId);
  }
  return next;
}

function withProgress(
  snapshot: ComfySnapshot,
  nodeId: string | undefined,
  value: number,
  max: number,
  nodes: ComfyNodes
): ComfySnapshot {
  let next = nodeId ? withNode(snapshot, nodeId, nodes) : { ...snapshot, seenExecution: true };
  if (next.phase === "decoding") {
    return { ...next, step: undefined, stepMax: undefined, stage: undefined };
  }
  const step = asStep(value);
  const stepMax = asStep(max);
  if (step == null || stepMax == null || stepMax <= 0) return next;
  const kind = nodeId ? nodeKind(nodes[nodeId]) : "other";
  if (kind === "decode") {
    return { ...next, phase: "decoding", step: undefined, stepMax: undefined, stage: undefined };
  }
  next = {
    ...next,
    seenExecution: true,
    phase: "sampling",
    step,
    stepMax,
    queuePosition: undefined,
  };
  if (kind === "sampler" && nodeId) next.stage = samplerStageLabel(nodes, nodeId);
  return next;
}

function dataOf(message: unknown): { type: string; data: Record<string, unknown> } | null {
  if (!message || typeof message !== "object") return null;
  const record = message as { type?: unknown; data?: unknown };
  if (typeof record.type !== "string") return null;
  const data =
    record.data && typeof record.data === "object" && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {};
  return { type: record.type, data };
}

function nodeIdOf(data: Record<string, unknown>): string | undefined {
  const raw = data.node ?? data.display_node;
  if (raw == null || raw === "") return undefined;
  return String(raw);
}

/**
 * Apply one `/ws` message for `promptId`.
 * A message whose prompt_id is someone else's is ignored.
 * Progress and executing messages with no prompt_id are kept: older ComfyUI
 * sends those only on the client socket that queued the prompt.
 */
export function applyComfyMessage(
  snapshot: ComfySnapshot,
  message: unknown,
  promptId: string,
  nodes: ComfyNodes
): ComfySnapshot {
  const parsed = dataOf(message);
  if (!parsed || !promptId) return snapshot;
  const { type, data } = parsed;

  if (type === "execution_start") {
    if (!promptOwns(data, promptId, false)) return snapshot;
    return {
      ...snapshot,
      seenExecution: true,
      phase: snapshot.phase === "queued" ? "running" : snapshot.phase,
      queuePosition: undefined,
    };
  }

  if (type === "executing") {
    if (!promptOwns(data, promptId, true)) return snapshot;
    const nodeId = nodeIdOf(data);
    if (!nodeId) {
      return {
        ...snapshot,
        seenExecution: true,
        phase: "running",
        nodeId: undefined,
        nodeClass: undefined,
        nodeTitle: undefined,
        stage: undefined,
        step: undefined,
        stepMax: undefined,
        queuePosition: undefined,
      };
    }
    return withNode(snapshot, nodeId, nodes);
  }

  if (type === "progress") {
    if (!promptOwns(data, promptId, true)) return snapshot;
    return withProgress(snapshot, nodeIdOf(data), Number(data.value), Number(data.max), nodes);
  }

  if (type === "progress_state") {
    if (!promptOwns(data, promptId, true)) return snapshot;
    const table = data.nodes;
    if (!table || typeof table !== "object") return snapshot;
    let next = snapshot;
    for (const [id, raw] of Object.entries(table as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const rowPrompt = typeof row.prompt_id === "string" ? row.prompt_id : "";
      if (rowPrompt && rowPrompt !== promptId) continue;
      if (!rowPrompt && !promptOwns(data, promptId, true)) continue;
      const state = typeof row.state === "string" ? row.state : "running";
      if (state !== "running") continue;
      const nodeRaw = row.real_node_id ?? row.node_id ?? id;
      const nodeId = nodeRaw == null ? undefined : String(nodeRaw);
      next = withProgress(next, nodeId, Number(row.value), Number(row.max), nodes);
    }
    return next;
  }

  return snapshot;
}

/** Position in `GET /queue`. Pending is 1-based. Null when the body is not a queue. */
export function queuePlacement(body: unknown, promptId: string): QueuePlacement | null {
  if (!body || typeof body !== "object" || !promptId) return null;
  const record = body as { queue_running?: unknown; queue_pending?: unknown };
  if (!Array.isArray(record.queue_running) && !Array.isArray(record.queue_pending)) return null;
  const idOf = (item: unknown): string => (Array.isArray(item) && typeof item[1] === "string" ? item[1] : "");
  const running = Array.isArray(record.queue_running) ? record.queue_running : [];
  const pending = Array.isArray(record.queue_pending) ? record.queue_pending : [];
  if (running.some((item) => idOf(item) === promptId)) return { where: "running" };
  const index = pending.findIndex((item) => idOf(item) === promptId);
  if (index >= 0) return { where: "pending", position: index + 1 };
  return { where: "absent" };
}

export function comfySnapshotHasSignal(snapshot: ComfySnapshot): boolean {
  if (snapshot.phase === "queued" || snapshot.phase === "sampling" || snapshot.phase === "decoding") return true;
  return Boolean(cleanNodeLabel(snapshot.nodeTitle) || cleanNodeLabel(snapshot.nodeClass));
}

/** Whole seconds. `3m 41s`, `41s`, `1h 2m 3s`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** The phase line without the clock. `elapsed` is already formatted. */
export function formatComfySnapshot(snapshot: ComfySnapshot, elapsed: string): string {
  if (snapshot.phase === "queued") {
    const position = snapshot.queuePosition ? ` · position ${snapshot.queuePosition}` : "";
    return `Queued${position} · ${elapsed}`;
  }
  if (snapshot.phase === "sampling") {
    const steps =
      snapshot.step != null && snapshot.stepMax != null && snapshot.stepMax > 0
        ? ` ${snapshot.step}/${snapshot.stepMax}`
        : "";
    const stage = snapshot.stage ? ` · ${snapshot.stage}` : "";
    return `Sampling${steps}${stage} · ${elapsed}`;
  }
  if (snapshot.phase === "decoding") return `Decoding · ${elapsed}`;
  const name = cleanNodeLabel(snapshot.nodeTitle) || cleanNodeLabel(snapshot.nodeClass);
  if (name) return `${name} · ${elapsed}`;
  return elapsed;
}

/** 0–99 while a sampler step is known. Decode and queue have no bar. */
export function samplingPercent(snapshot: ComfySnapshot): number | undefined {
  if (snapshot.phase !== "sampling") return undefined;
  if (snapshot.step == null || snapshot.stepMax == null || snapshot.stepMax <= 0) return undefined;
  const ratio = snapshot.step / snapshot.stepMax;
  if (!Number.isFinite(ratio)) return undefined;
  return Math.min(99, Math.max(0, Math.round(ratio * 100)));
}
