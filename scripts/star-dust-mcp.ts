/**
 * MCP tools for a running Star Dust studio.
 * Every tool calls the HTTP API. Credit checks, safety checks, the licence
 * gate, and provider config stay on that server. This file does not import
 * billing code and does not grant credits.
 */
import fs from "fs/promises";
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { parseLoraList } from "../src/lib/loras";
import { COMFY_WORKFLOWS } from "../src/lib/provider-info";
import {
  COMFY_WORKFLOW_IDS,
  MAX_SHOT_SECONDS,
  MIN_SHOT_SECONDS,
  MOTION_PRESETS,
  isComfyGraphId,
  isComfyWorkflowId,
  isProviderId,
  type ComfyGraphId,
  type LoraRef,
} from "../src/lib/types";

const DEFAULT_STUDIO_URL = "http://localhost:3000";
const REQUEST_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 20_000;

const PRESET_IDS = MOTION_PRESETS.map((preset) => preset.id);
const PRESET_LIST = PRESET_IDS.join(", ");
const GRAPH_LIST = `${COMFY_WORKFLOW_IDS.join(", ")}, or custom:<slug>`;

export const STAR_DUST_TOOLS = [
  "list_backends",
  "create_project",
  "add_shot",
  "start_render",
  "get_job",
  "fetch_clip",
  "export_shotlist",
] as const;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function studioBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.STAR_DUST_URL?.trim() || DEFAULT_STUDIO_URL;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return withProtocol.replace(/\/+$/, "");
}

export class StudioError extends Error {}

type ApiResult = {
  method: string;
  path: string;
  status: number;
  ok: boolean;
  bytes: Buffer;
  contentType: string;
  disposition: string | null;
  json: unknown;
};

type SettingsEnv = {
  hasFalKey: boolean;
  hasReplicateToken: boolean;
  comfyuiUrlFromEnv: boolean;
  comfyuiAuthConfigured: boolean;
  hostedCredits: boolean;
  creditBalance: number | null;
  packUnlocked: boolean;
};

type CustomCard = {
  id: string;
  title: string;
  ok: boolean;
  errors: string[];
};

type SettingsPayload = {
  provider: string;
  comfyuiBaseUrl: string;
  falModel: string;
  replicateModel: string;
  comfyuiWorkflow: string;
  comfyLowMemory: boolean;
  env: SettingsEnv;
  customWorkflows: CustomCard[];
};

type GraphReport = {
  id: string;
  title: string;
  selected: boolean;
  ready: boolean;
  blocksQueue: boolean;
  message: string;
  nextSteps: string[];
  notes: string[];
  loadErrors: string[];
  unreachable: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function errorChain(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? err.cause.message : "";
  return [err.name, err.message, cause].filter(Boolean).join(" ");
}

function offlineMessage(base: string, err: unknown): string {
  const detail = errorChain(err);
  if (/AbortError|TimeoutError|timed out|UND_ERR_CONNECT_TIMEOUT/i.test(detail)) {
    return `Star Dust at ${base} did not answer in time. Check that it is running, then try again. (${detail})`;
  }
  return `Star Dust is not running at ${base}. Start it with npm run dev, or docker compose up, then try again. (${detail})`;
}

function looksLikeJson(bytes: Buffer): boolean {
  const start = bytes.toString("utf8", 0, Math.min(bytes.length, 32)).trimStart();
  return start.startsWith("{") || start.startsWith("[");
}

function assertNotPayment(path: string): void {
  const lower = path.toLowerCase();
  if (lower.startsWith("/api/credits") || lower.includes("stripe") || lower.includes("paypal")) {
    throw new StudioError("This MCP server does not call payment routes and does not add credits.");
  }
}

function failureSummary(base: string, result: ApiResult): string {
  const record = asRecord(result.json);
  const error = record && typeof record.error === "string" ? record.error : "";
  if (!error) {
    if (result.status === 404) {
      return `Star Dust has no ${result.method} ${result.path} at ${base}. Check STAR_DUST_URL. The studio origin is usually ${DEFAULT_STUDIO_URL}.`;
    }
    return `Star Dust returned HTTP ${result.status} for ${result.method} ${result.path}.`;
  }
  const parts = [error];
  if (record?.insufficientCredits === true) {
    parts.push(
      "The render was not started. This client does not add credits. Mock and ComfyUI do not spend hosted credits."
    );
  }
  if (record?.overBudget === true) {
    parts.push("The render was not started. The estimate is over the budget cap saved in Settings.");
  }
  if (record?.needsModelAck === true && typeof record.modelName === "string") {
    parts.push(
      `Call start_render again with acknowledgeModel set to ${JSON.stringify(record.modelName)} if you accept that model. Star Dust does not fetch a vendor price.`
    );
  }
  if (record?.needsApprovalConfirm === true) {
    parts.push("Call start_render again with confirmApproved true only if you mean to replace an approved take.");
  }
  return parts.join(" ");
}

function errorFields(result: ApiResult): Record<string, unknown> | undefined {
  const record = asRecord(result.json);
  if (!record) return undefined;
  const data: Record<string, unknown> = { httpStatus: result.status };
  for (const key of [
    "needsModelAck",
    "modelName",
    "insufficientCredits",
    "overBudget",
    "needsApprovalConfirm",
    "refused",
    "riskNote",
    "priceAvailable",
  ]) {
    if (record[key] !== undefined) data[key] = record[key];
  }
  return data;
}

function okResult(summary: string, data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: `${summary}\n\n${JSON.stringify({ summary, ...data }, null, 2)}` }],
  };
}

function failResult(summary: string, data?: Record<string, unknown>): CallToolResult {
  const textBody = data ? `${summary}\n\n${JSON.stringify({ summary, ...data }, null, 2)}` : summary;
  return { isError: true, content: [{ type: "text", text: textBody }] };
}

async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return failResult(err instanceof Error ? err.message : String(err));
  }
}

export class StarDustClient {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private fetchImpl: FetchLike = globalThis.fetch
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl?: FetchLike): StarDustClient {
    return new StarDustClient(studioBaseUrl(env), fetchImpl);
  }

  fail(result: ApiResult): CallToolResult {
    return failResult(failureSummary(this.baseUrl, result), errorFields(result));
  }

  getJson(path: string): Promise<ApiResult> {
    return this.request("GET", path);
  }

  postJson(path: string, body: unknown): Promise<ApiResult> {
    return this.request("POST", path, { json: body });
  }

  putJson(path: string, body: unknown): Promise<ApiResult> {
    return this.request("PUT", path, { json: body });
  }

  postForm(path: string, form: FormData): Promise<ApiResult> {
    return this.request("POST", path, { form });
  }

  getBytes(path: string): Promise<ApiResult> {
    return this.request("GET", path);
  }

  async download(url: string): Promise<{ bytes: Buffer; contentType: string }> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch (err) {
      throw new StudioError(`Could not download ${url}. ${errorChain(err)}`);
    }
    if (!response.ok) {
      throw new StudioError(`Could not download ${url}. The URL returned HTTP ${response.status}.`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) throw new StudioError(`Could not download ${url}. The file was empty.`);
    return { bytes, contentType: response.headers.get("content-type") ?? "" };
  }

  private async request(
    method: string,
    requestPath: string,
    opts?: { json?: unknown; form?: FormData }
  ): Promise<ApiResult> {
    assertNotPayment(requestPath);
    const headers: Record<string, string> = {};
    let body: BodyInit | undefined;
    if (opts?.form) {
      body = opts.form;
    } else if (opts?.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${requestPath}`, {
        method,
        headers,
        body,
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new StudioError(offlineMessage(this.baseUrl, err));
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") ?? "";
    let json: unknown;
    if (bytes.length === 0) json = null;
    else if (contentType.includes("json") || looksLikeJson(bytes)) {
      try {
        json = JSON.parse(bytes.toString("utf8"));
      } catch {
        json = undefined;
      }
    }
    return {
      method,
      path: requestPath,
      status: response.status,
      ok: response.ok,
      bytes,
      contentType,
      disposition: response.headers.get("content-disposition"),
      json,
    };
  }
}

function boolFlag(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseSettings(value: unknown): SettingsPayload {
  const record = asRecord(value);
  const env = asRecord(record?.env);
  if (!record || typeof record.provider !== "string" || !env) {
    throw new StudioError(
      "Star Dust settings were not the expected JSON. Check STAR_DUST_URL. The studio origin is usually http://localhost:3000."
    );
  }
  const cards: CustomCard[] = [];
  if (Array.isArray(record.customWorkflows)) {
    for (const item of record.customWorkflows) {
      const card = asRecord(item);
      if (!card || typeof card.id !== "string") continue;
      cards.push({
        id: card.id,
        title: typeof card.title === "string" ? card.title : card.id,
        ok: card.ok !== false,
        errors: Array.isArray(card.errors) ? card.errors.filter((entry): entry is string => typeof entry === "string") : [],
      });
    }
  }
  const balance = env.creditBalance;
  return {
    provider: record.provider,
    comfyuiBaseUrl: typeof record.comfyuiBaseUrl === "string" ? record.comfyuiBaseUrl : "",
    falModel: typeof record.falModel === "string" ? record.falModel : "",
    replicateModel: typeof record.replicateModel === "string" ? record.replicateModel : "",
    comfyuiWorkflow: typeof record.comfyuiWorkflow === "string" ? record.comfyuiWorkflow : "",
    comfyLowMemory: boolFlag(record.comfyLowMemory),
    env: {
      hasFalKey: boolFlag(env.hasFalKey),
      hasReplicateToken: boolFlag(env.hasReplicateToken),
      comfyuiUrlFromEnv: boolFlag(env.comfyuiUrlFromEnv),
      comfyuiAuthConfigured: boolFlag(env.comfyuiAuthConfigured),
      hostedCredits: boolFlag(env.hostedCredits),
      creditBalance: typeof balance === "number" && Number.isFinite(balance) ? balance : null,
      packUnlocked: boolFlag(env.packUnlocked),
    },
    customWorkflows: cards,
  };
}

function graphTitle(id: string, settings: SettingsPayload): string {
  if (isComfyWorkflowId(id)) return COMFY_WORKFLOWS[id].title;
  return settings.customWorkflows.find((card) => card.id === id)?.title || id;
}

function graphIds(settings: SettingsPayload): ComfyGraphId[] {
  const ids: ComfyGraphId[] = [];
  const add = (value: unknown) => {
    if (isComfyGraphId(value) && !ids.includes(value)) ids.push(value);
  };
  add(settings.comfyuiWorkflow);
  for (const id of COMFY_WORKFLOW_IDS) add(id);
  for (const card of settings.customWorkflows) add(card.id);
  return ids;
}

function issueSteps(workflow: Record<string, unknown>, keys: string[]): string[] {
  const steps: string[] = [];
  for (const key of keys) {
    const list = workflow[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const step = text(asRecord(item)?.nextStep);
      if (step) steps.push(step);
    }
  }
  return steps;
}

function parseGraph(
  id: string,
  selected: string,
  settings: SettingsPayload,
  result: ApiResult,
  base: string
): GraphReport {
  const body = asRecord(result.json);
  const card = settings.customWorkflows.find((item) => item.id === id);
  const loadErrors = card?.errors ?? [];
  const loadFailed = Boolean(card && !card.ok);
  if (!result.ok || !body) {
    return {
      id,
      title: graphTitle(id, settings),
      selected: id === selected,
      ready: false,
      blocksQueue: true,
      message: failureSummary(base, result),
      nextSteps: [],
      notes: [],
      loadErrors,
      unreachable: false,
    };
  }
  const workflows = Array.isArray(body.workflows) ? body.workflows : [];
  const workflow =
    workflows.map(asRecord).find((item) => item?.id === id) ?? asRecord(workflows[0]);
  const nextSteps = workflow ? issueSteps(workflow, ["missingNodes", "missingModels", "inputBlocks"]) : [];
  const notes = workflow ? issueSteps(workflow, ["vaeWarnings", "inputNotes"]) : [];
  const unreachable = body.reachable === false;
  const blocksQueue = unreachable || body.blocksQueue === true || workflow?.blocksQueue === true;
  const ready =
    Boolean(workflow) &&
    body.reachable === true &&
    !blocksQueue &&
    workflow?.ok !== false &&
    !loadFailed &&
    loadErrors.length === 0;
  const serverMessage = text(body.message) || (unreachable ? "ComfyUI did not answer." : "");
  const message = unreachable
    ? serverMessage || "ComfyUI did not answer."
    : nextSteps[0] || loadErrors[0] || (loadFailed ? `${id} did not load on the server.` : "") || serverMessage || "ComfyUI readiness did not return this graph.";
  return {
    id,
    title: text(workflow?.title) || graphTitle(id, settings),
    selected: id === selected,
    ready,
    blocksQueue,
    message,
    nextSteps,
    notes,
    loadErrors,
    unreachable,
  };
}

function paidProvider(id: "fal" | "replicate", settings: SettingsPayload): Record<string, unknown> {
  const keyReady = id === "fal" ? settings.env.hasFalKey : settings.env.hasReplicateToken;
  const keyName = id === "fal" ? "FAL_KEY" : "REPLICATE_API_TOKEN";
  const model = id === "fal" ? settings.falModel : settings.replicateModel;
  let ready = false;
  let detail: string;
  if (!keyReady) {
    detail = `Not ready. The Star Dust server has no ${keyName}. Add it to the server environment. A render will not start until that key is set.`;
  } else if (settings.env.hostedCredits && settings.env.creditBalance === null) {
    detail = `The ${keyName} is set, but the server did not report a credit balance. A paid render may be blocked. Model: ${model}.`;
  } else if (settings.env.hostedCredits && (settings.env.creditBalance ?? 0) <= 0) {
    detail = `Not ready. The ${keyName} is set, but the hosted credit balance is ${settings.env.creditBalance}. A paid render is blocked until the balance covers the shot. This client does not add credits. Model: ${model}.`;
  } else if (settings.env.hostedCredits) {
    ready = true;
    detail = `Ready. The ${keyName} is set. Hosted credit balance is ${settings.env.creditBalance}. A render that needs more than that is blocked. Model: ${model}.`;
  } else {
    ready = true;
    detail = `Ready. The ${keyName} is set. Hosted credits are off, so this provider does not spend the studio balance. The server still applies a budget cap when one is saved. Model: ${model}.`;
  }
  return { id, title: id === "fal" ? "fal" : "Replicate", ready, detail, model };
}

function creditDetail(env: SettingsEnv): string {
  if (!env.hostedCredits) {
    return "Hosted credits are off. Mock and ComfyUI do not spend a balance. fal and Replicate use the key on the server.";
  }
  return `Hosted credits are on. Balance is ${env.creditBalance ?? "unreported"}. A paid fal or Replicate render is blocked when the balance is too low. This client does not add credits.`;
}

function packDetail(unlocked: boolean): string {
  return unlocked
    ? "Self-hosted pack is unlocked on the server."
    : "Self-hosted pack is locked. Mock and the shipped providers still run. This client does not set a license key.";
}

async function listBackends(client: StarDustClient): Promise<CallToolResult> {
  const settingsResult = await client.getJson("/api/settings");
  if (!settingsResult.ok) return client.fail(settingsResult);
  const settings = parseSettings(settingsResult.json);
  const ids = graphIds(settings);
  const graphs: GraphReport[] = [];
  let unreachable: string | null = null;
  let honesty = "";
  for (const id of ids) {
    if (unreachable) {
      graphs.push({
        id,
        title: graphTitle(id, settings),
        selected: id === settings.comfyuiWorkflow,
        ready: false,
        blocksQueue: true,
        message: unreachable,
        nextSteps: [],
        notes: [],
        loadErrors: settings.customWorkflows.find((card) => card.id === id)?.errors ?? [],
        unreachable: true,
      });
      continue;
    }
    const result = await client.postJson("/api/comfyui/readiness", { workflow: id });
    const graph = parseGraph(id, settings.comfyuiWorkflow, settings, result, client.baseUrl);
    if (!honesty) honesty = text(asRecord(result.json)?.honesty) || "";
    if (graph.unreachable) unreachable = graph.message;
    graphs.push(graph);
  }
  const selected = graphs.find((graph) => graph.selected) ?? graphs[0];
  const comfyReady = Boolean(selected?.ready);
  const comfyDetail = comfyReady
    ? `Ready. ${selected?.title ?? "The selected graph"} passed the server readiness check.${
        settings.comfyLowMemory ? " The low-memory preset is on." : " The low-memory preset is off."
      }`
    : `Not ready. ${selected?.message ?? "ComfyUI was not checked."}${
        settings.comfyLowMemory ? " The low-memory preset is on." : ""
      }`;
  const mock = {
    id: "mock",
    title: "Mock",
    ready: true,
    detail: "Ready. Camera motion only (ffmpeg Ken Burns). Not AI motion. No key. The server still runs the render.",
  };
  const fal = paidProvider("fal", settings);
  const replicate = paidProvider("replicate", settings);
  const comfy: Record<string, unknown> = {
    id: "comfyui",
    title: "ComfyUI",
    ready: comfyReady,
    detail: comfyDetail,
    workflow: settings.comfyuiWorkflow || null,
    lowMemory: settings.comfyLowMemory,
    urlFromEnv: settings.env.comfyuiUrlFromEnv,
    authConfigured: settings.env.comfyuiAuthConfigured,
    ...(settings.env.comfyuiUrlFromEnv
      ? { host: "COMFYUI_BASE_URL is set. The URL is not shown." }
      : { savedBaseUrl: settings.comfyuiBaseUrl }),
    honesty,
    graphs: graphs.map((graph) => ({
      id: graph.id,
      title: graph.title,
      selected: graph.selected,
      ready: graph.ready,
      blocksQueue: graph.blocksQueue,
      message: graph.message,
      nextSteps: graph.nextSteps,
      notes: graph.notes,
      loadErrors: graph.loadErrors,
    })),
  };
  const summary = [
    `Selected provider is ${settings.provider}.`,
    mock.ready ? "Mock is ready." : "Mock is not ready.",
    fal.ready ? "fal is ready." : "fal is not ready.",
    replicate.ready ? "Replicate is ready." : "Replicate is not ready.",
    comfyReady ? `ComfyUI (${settings.comfyuiWorkflow}) is ready.` : `ComfyUI (${settings.comfyuiWorkflow || "unset"}) is not ready.`,
  ].join(" ");
  return okResult(summary, {
    studioUrl: client.baseUrl,
    selectedProvider: settings.provider,
    hostedCredits: settings.env.hostedCredits,
    creditBalance: settings.env.creditBalance,
    credits: creditDetail(settings.env),
    packUnlocked: settings.env.packUnlocked,
    pack: packDetail(settings.env.packUnlocked),
    providers: [mock, fal, replicate, comfy],
  });
}

async function createProject(
  client: StarDustClient,
  args: { name: string; description?: string | null; loras?: LoraRef[] | null }
): Promise<CallToolResult> {
  const name = args.name.trim();
  if (!name) return failResult("Project name is required.");
  let loras: LoraRef[] | undefined;
  if (args.loras != null) {
    const parsed = parseLoraList(args.loras, "loras");
    if (!parsed.ok) return failResult(parsed.error);
    loras = parsed.loras;
  }
  const result = await client.postJson("/api/projects", {
    name,
    description: args.description?.trim() ?? "",
    ...(loras ? { loras } : {}),
  });
  if (!result.ok || asRecord(result.json)?.ok === false) return client.fail(result);
  const project = asRecord(result.json);
  const id = text(project?.id);
  if (!id) return failResult("Star Dust created a project but did not return an id.");
  return okResult(`Created project ${id}.`, {
    id,
    name: text(project?.name) || name,
    description: typeof project?.description === "string" ? project.description : "",
    loras: Array.isArray(project?.loras) ? project.loras : loras ?? [],
  });
}

type Still = { filename: string; bytes: Buffer; type: string };

function mimeFor(filename: string, contentType = ""): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg" || contentType.includes("jpeg")) return "image/jpeg";
  if (ext === ".webp" || contentType.includes("webp")) return "image/webp";
  if (ext === ".gif" || contentType.includes("gif")) return "image/gif";
  return "image/png";
}

function filenameFromUrl(url: URL, contentType: string): string {
  const base = path.posix.basename(decodeURIComponent(url.pathname));
  if (base && base !== "." && path.posix.extname(base)) return base.slice(0, 120);
  if (contentType.includes("jpeg")) return "image.jpg";
  if (contentType.includes("webp")) return "image.webp";
  if (contentType.includes("gif")) return "image.gif";
  return "image.png";
}

async function readLocal(filePath: string, label: string): Promise<Still> {
  const abs = path.resolve(filePath);
  let info: Awaited<ReturnType<typeof fs.stat>>;
  try {
    info = await fs.stat(abs);
  } catch {
    throw new StudioError(`No ${label} at ${abs}.`);
  }
  if (!info.isFile()) throw new StudioError(`${abs} is not a file. Pass the ${label} file path.`);
  const bytes = await fs.readFile(abs);
  if (bytes.length === 0) throw new StudioError(`The ${label} at ${abs} is empty.`);
  const filename = path.basename(abs);
  return { filename, bytes, type: mimeFor(filename) };
}

async function stillFromUrl(client: StarDustClient, raw: string, label: string): Promise<Still> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new StudioError(`${label} URL is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new StudioError(`${label} URL must be http or https.`);
  }
  const downloaded = await client.download(url.href);
  const filename = filenameFromUrl(url, downloaded.contentType);
  return { filename, bytes: downloaded.bytes, type: mimeFor(filename, downloaded.contentType) };
}

async function loadStill(
  client: StarDustClient,
  filePath: string | null | undefined,
  fileUrl: string | null | undefined,
  label: string
): Promise<Still | undefined> {
  const local = optionalText(filePath);
  const remote = optionalText(fileUrl);
  if (local && remote) throw new StudioError(`Pass ${label} path or URL, not both.`);
  if (local) return readLocal(local, label);
  if (remote) return stillFromUrl(client, remote, label);
  return undefined;
}

function appendStill(form: FormData, field: string, still: Still) {
  form.append(field, new Blob([new Uint8Array(still.bytes)], { type: still.type }), still.filename);
}

type AddShotArgs = {
  projectId: string;
  prompt: string;
  imagePath?: string | null;
  imageUrl?: string | null;
  endImagePath?: string | null;
  endImageUrl?: string | null;
  durationSec?: number | null;
  presetId?: string | null;
  provider?: string | null;
  comfyWorkflow?: string | null;
  comfyLowMemory?: boolean | null;
  generatedAudio?: boolean | null;
  chainFromPrevious?: boolean | null;
  loras?: LoraRef[] | null;
};

async function addShot(client: StarDustClient, args: AddShotArgs): Promise<CallToolResult> {
  const projectId = args.projectId.trim();
  if (!projectId) return failResult("projectId is required.");
  const prompt = args.prompt.trim();
  if (!prompt) return failResult("Prompt is required.");
  if (args.durationSec != null && (args.durationSec < MIN_SHOT_SECONDS || args.durationSec > MAX_SHOT_SECONDS)) {
    return failResult(`durationSec must be from ${MIN_SHOT_SECONDS} to ${MAX_SHOT_SECONDS}.`);
  }
  const presetId = optionalText(args.presetId);
  if (presetId && !PRESET_IDS.includes(presetId)) {
    return failResult(`presetId must be one of: ${PRESET_LIST}.`);
  }
  const provider = optionalText(args.provider);
  if (provider && !isProviderId(provider)) {
    return failResult("provider must be mock, fal, replicate, or comfyui.");
  }
  const workflow = optionalText(args.comfyWorkflow);
  if (workflow && !isComfyGraphId(workflow)) {
    return failResult(`comfyWorkflow must be ${GRAPH_LIST}.`);
  }
  let loras: LoraRef[] | undefined;
  if (args.loras != null) {
    const parsed = parseLoraList(args.loras, "loras");
    if (!parsed.ok) return failResult(parsed.error);
    loras = parsed.loras;
  }
  const start = await loadStill(client, args.imagePath, args.imageUrl, "a start image");
  if (!start) return failResult("Pass imagePath (a local file) or imageUrl (http or https).");
  const end = await loadStill(client, args.endImagePath, args.endImageUrl, "an end image");

  if (provider) {
    const saved = await client.putJson("/api/settings", { provider });
    if (!saved.ok || asRecord(saved.json)?.ok === false) return client.fail(saved);
  }

  const form = new FormData();
  form.append("prompt", prompt);
  appendStill(form, "startImage", start);
  if (end) appendStill(form, "endImage", end);
  if (args.durationSec != null) form.append("durationSec", String(args.durationSec));
  if (presetId) form.append("presetId", presetId);
  if (workflow) form.append("comfyuiWorkflow", workflow);
  if (typeof args.comfyLowMemory === "boolean") form.append("comfyLowMemory", args.comfyLowMemory ? "true" : "false");
  if (typeof args.generatedAudio === "boolean") form.append("generatedAudio", args.generatedAudio ? "true" : "false");
  if (args.chainFromPrevious === true) form.append("chainFromPrevious", "1");
  if (loras) form.append("loras", JSON.stringify(loras));

  const result = await client.postForm(`/api/projects/${encodeURIComponent(projectId)}/shots`, form);
  if (!result.ok || asRecord(result.json)?.ok === false) {
    const failed = client.fail(result);
    if (!provider) return failed;
    const extra = ` The studio provider was set to ${provider} before the shot failed.`;
    const block = failed.content[0];
    if (block?.type === "text") block.text = `${extra.trim()}\n\n${block.text}`;
    return failed;
  }
  const shot = asRecord(result.json);
  const id = text(shot?.id);
  if (!id) return failResult("Star Dust stored the shot but did not return an id.");
  const summary = provider
    ? `Added shot ${id}. Studio provider is ${provider}.`
    : `Added shot ${id}.`;
  return okResult(summary, {
    id,
    projectId,
    prompt: text(shot?.prompt) || prompt,
    durationSec: typeof shot?.durationSec === "number" ? shot.durationSec : args.durationSec ?? null,
    presetId: text(shot?.presetId) || presetId || null,
    provider: provider || null,
    comfyWorkflow: text(shot?.comfyuiWorkflow) || workflow || null,
    comfyLowMemory: typeof shot?.comfyLowMemory === "boolean" ? shot.comfyLowMemory : args.comfyLowMemory ?? null,
    generatedAudio: typeof shot?.generatedAudio === "boolean" ? shot.generatedAudio : args.generatedAudio ?? null,
    startImagePath: text(shot?.startImagePath) || null,
    endImagePath: text(shot?.endImagePath) || null,
    loras: Array.isArray(shot?.loras) ? shot.loras : loras ?? null,
  });
}

type StartRenderArgs = {
  projectId: string;
  shotId?: string | null;
  acknowledgeModel?: string | null;
  force?: boolean | null;
  confirmApproved?: boolean | null;
};

function compactJob(value: unknown, base: string): Record<string, unknown> {
  const job = asRecord(value) ?? {};
  const outputPath = text(job.outputPath) || null;
  return {
    id: text(job.id) || null,
    projectId: text(job.projectId) || null,
    shotId: text(job.shotId) || null,
    status: text(job.status) || null,
    provider: text(job.provider) || null,
    modelName: text(job.modelName) || null,
    error: text(job.error) || null,
    outputPath,
    mediaUrl: outputPath ? mediaUrl(base, outputPath) : null,
  };
}

async function startRender(client: StarDustClient, args: StartRenderArgs): Promise<CallToolResult> {
  const projectId = args.projectId.trim();
  if (!projectId) return failResult("projectId is required.");
  const shotId = optionalText(args.shotId);
  if ((args.force === true || args.confirmApproved === true) && !shotId) {
    return failResult("force and confirmApproved apply to one shot. Pass shotId, or omit them to render the project.");
  }
  const body: Record<string, unknown> = {};
  const acknowledgeModel = optionalText(args.acknowledgeModel);
  if (acknowledgeModel) body.acknowledgeModel = acknowledgeModel;
  if (shotId && args.force === true) body.force = true;
  if (shotId && args.confirmApproved === true) body.confirmApproved = true;
  const requestPath = shotId
    ? `/api/projects/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(shotId)}/render`
    : `/api/projects/${encodeURIComponent(projectId)}/render`;
  const result = await client.postJson(requestPath, body);
  if (!result.ok || asRecord(result.json)?.ok === false) return client.fail(result);
  const payload = asRecord(result.json) ?? {};
  const jobs = Array.isArray(payload.jobs) ? payload.jobs.map((job) => compactJob(job, client.baseUrl)) : [];
  const skipped = Array.isArray(payload.skipped) ? payload.skipped : [];
  const summary =
    jobs.length > 0
      ? `Queued ${jobs.length} job${jobs.length === 1 ? "" : "s"}. Poll get_job, then fetch_clip when the status is completed.`
      : skipped.length > 0
        ? "No new job. Star Dust skipped the shot. Read skipped for the existing job id, or pass force true with shotId to render again."
        : "No job was queued.";
  return okResult(summary, { jobs, skipped });
}

function progressOf(job: Record<string, unknown>): { label: string; percent?: number } | null {
  const activity = asRecord(job.activity);
  if (!activity || typeof activity.label !== "string") return null;
  const progress: { label: string; percent?: number } = { label: activity.label };
  if (typeof activity.percent === "number") progress.percent = activity.percent;
  return progress;
}

async function getJob(client: StarDustClient, args: { jobId: string }): Promise<CallToolResult> {
  const jobId = args.jobId.trim();
  if (!jobId) return failResult("jobId is required.");
  const result = await client.getJson(`/api/jobs/${encodeURIComponent(jobId)}`);
  if (!result.ok) return client.fail(result);
  const job = asRecord(result.json);
  if (!job) return failResult("Star Dust did not return the job.");
  const status = text(job.status) || "unknown";
  const progress = progressOf(job);
  const outputPath = text(job.outputPath) || null;
  const error = text(job.error) || null;
  const summary =
    status === "completed"
      ? `Job ${jobId} is completed.${outputPath ? " fetch_clip can copy the mp4." : ""}`
      : status === "failed"
        ? `Job ${jobId} failed.${error ? ` ${error}` : ""}`
        : `Job ${jobId} is ${status}.${progress ? ` ${progress.label}.` : ""} Call get_job again until it completes or fails.`;
  return okResult(summary, {
    id: text(job.id) || jobId,
    projectId: text(job.projectId) || null,
    shotId: text(job.shotId) || null,
    status,
    provider: text(job.provider) || null,
    modelName: text(job.modelName) || null,
    durationSec: typeof job.durationSec === "number" ? job.durationSec : null,
    progress,
    error,
    outputPath,
    mediaUrl: outputPath ? mediaUrl(client.baseUrl, outputPath) : null,
  });
}

function mediaUrl(base: string, outputPath: string): string {
  const encoded = outputPath
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${base}/api/media/${encoded}`;
}

function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) return path.basename(decodeURIComponent(star[1].trim()));
  const quoted = /filename="([^"]+)"/i.exec(header);
  if (quoted) return path.basename(quoted[1]);
  const plain = /filename=([^;]+)/i.exec(header);
  if (plain) return path.basename(plain[1].trim());
  return fallback;
}

async function writeOutput(requested: string, fallbackName: string, bytes: Buffer): Promise<string> {
  const info = await fs.stat(requested).catch(() => null);
  const asDirectory =
    requested.endsWith("/") ||
    requested.endsWith("\\") ||
    Boolean(info?.isDirectory()) ||
    (!info && path.extname(requested) === "");
  const dest = asDirectory ? path.join(path.resolve(requested), fallbackName) : path.resolve(requested);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, bytes);
  return dest;
}

async function fetchClip(
  client: StarDustClient,
  args: { jobId: string; outputPath?: string | null }
): Promise<CallToolResult> {
  const jobId = args.jobId.trim();
  if (!jobId) return failResult("jobId is required.");
  const result = await client.getJson(`/api/jobs/${encodeURIComponent(jobId)}`);
  if (!result.ok) return client.fail(result);
  const job = asRecord(result.json);
  if (!job) return failResult("Star Dust did not return the job.");
  const status = text(job.status) || "unknown";
  const outputPath = text(job.outputPath);
  if (status !== "completed" || !outputPath) {
    const progress = progressOf(job);
    const error = text(job.error);
    const waiting =
      status === "failed"
        ? `Job ${jobId} failed.${error ? ` ${error}` : ""} There is no clip to copy.`
        : `Job ${jobId} is ${status}.${progress ? ` ${progress.label}.` : ""} Call get_job again, then fetch_clip when the status is completed.`;
    return failResult(waiting, {
      id: jobId,
      status,
      progress,
      error: error || null,
    });
  }
  const relative = outputPath
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => encodeURIComponent(part))
    .join("/");
  const media = await client.getBytes(`/api/media/${relative}`);
  if (!media.ok || media.contentType.includes("json")) {
    return failResult(
      `The job finished but the clip was not found at ${mediaUrl(client.baseUrl, outputPath)}. ${failureSummary(client.baseUrl, media)}`
    );
  }
  if (media.bytes.length === 0) return failResult("The clip download was empty.");
  const requested = optionalText(args.outputPath);
  const filename = path.posix.basename(outputPath) || "clip.mp4";
  const localPath = requested ? await writeOutput(requested, filename, media.bytes) : null;
  const summary = localPath
    ? `Copied the clip to ${localPath}.`
    : `Clip is ready at ${mediaUrl(client.baseUrl, outputPath)}. Pass outputPath to copy it.`;
  return okResult(summary, {
    id: jobId,
    status,
    outputPath,
    mediaUrl: mediaUrl(client.baseUrl, outputPath),
    localPath,
    bytes: media.bytes.length,
  });
}

async function exportShotList(
  client: StarDustClient,
  args: { projectId: string; outputPath?: string | null }
): Promise<CallToolResult> {
  const projectId = args.projectId.trim();
  if (!projectId) return failResult("projectId is required.");
  const result = await client.getBytes(`/api/projects/${encodeURIComponent(projectId)}/export/shotlist`);
  if (!result.ok || result.contentType.includes("json")) return client.fail(result);
  if (result.bytes.length === 0) return failResult("The shot list export was empty.");
  const filename = filenameFromDisposition(result.disposition, "shotlist.zip");
  const requested = optionalText(args.outputPath) || path.join(process.cwd(), filename);
  const localPath = await writeOutput(requested, filename, result.bytes);
  return okResult(`Wrote the shot list zip to ${localPath}.`, {
    projectId,
    localPath,
    bytes: result.bytes.length,
    url: `${client.baseUrl}/api/projects/${encodeURIComponent(projectId)}/export/shotlist`,
    schema: "stardust.shotlist/1",
  });
}

const providerEnum = z.enum(["mock", "fal", "replicate", "comfyui"]);

export function createStarDustMcpServer(client: StarDustClient): McpServer {
  const server = new McpServer({ name: "star-dust", version: "0.1.0" });

  server.registerTool(
    "list_backends",
    {
      title: "List backends",
      description:
        "List Star Dust providers (mock, fal, Replicate, ComfyUI) and whether each one is ready on the running server. ComfyUI graphs include SVD, Wan 2.2 TI2V-5B, Wan 2.2 14B first-last frame, LTX-2.3, LTX-2.5, MiniMax H3, and any custom:<slug> graph. Readiness comes from GET /api/settings and POST /api/comfyui/readiness. A missing key, a low credit balance, a locked pack, and a ComfyUI graph that would not queue are reported here. This does not start a render, spend credits, or change settings.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => guard(() => listBackends(client))
  );

  server.registerTool(
    "create_project",
    {
      title: "Create project",
      description:
        "Create a Star Dust project with POST /api/projects. Returns the project id for add_shot and start_render. loras is an optional list of { name, strength } for ComfyUI. At most 4. strength defaults to 1 and must be from -2 to 2. name is the file name ComfyUI lists.",
      inputSchema: {
        name: z.string().describe("Project name."),
        description: z.string().optional().describe("Short description. Optional."),
        loras: z
          .array(z.object({ name: z.string(), strength: z.number().optional() }).strict())
          .optional()
          .describe("Optional ComfyUI LoRAs. name is the file name ComfyUI lists. strength defaults to 1, from -2 to 2. At most 4."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => guard(() => createProject(client, args))
  );

  server.registerTool(
    "add_shot",
    {
      title: "Add shot",
      description: `Add one shot. The still is uploaded to POST /api/projects/{id}/shots, so the server stores it and runs its safety check. Pass imagePath (a local file) or imageUrl (http or https). durationSec is ${MIN_SHOT_SECONDS} to ${MAX_SHOT_SECONDS}. presetId is ${PRESET_LIST}. provider sets the studio provider the same way the Providers page does, and the next render uses it. comfyWorkflow (${GRAPH_LIST}), comfyLowMemory, and generatedAudio are stored on the shot. generatedAudio applies to LTX-2.3 and LTX-2.5. Omit it to inherit the project, which defaults to on for those graphs. Off saves a silent mp4. SVD, Wan, and custom:<slug> ignore it. loras is an optional list that replaces the project LoRA list. The first shot cannot chain from a previous shot. Keys, credits, the licence gate, and ComfyUI readiness are still enforced when you render.`,
      inputSchema: {
        projectId: z.string().describe("Project id from create_project."),
        prompt: z.string().describe("Shot prompt. The server refuses sexual content involving a minor."),
        imagePath: z.string().optional().describe("Local still to upload as the start image. Pass this or imageUrl."),
        imageUrl: z.string().optional().describe("http(s) still URL. This tool downloads it and uploads the bytes."),
        endImagePath: z.string().optional().describe("Optional local end still. Wan 2.2 14B first-last frame requires one."),
        endImageUrl: z.string().optional().describe("Optional http(s) end still."),
        durationSec: z.number().finite().optional().describe(`Clip length in seconds, from ${MIN_SHOT_SECONDS} to ${MAX_SHOT_SECONDS}.`),
        presetId: z.string().optional().describe(`Motion preset: ${PRESET_LIST}. Mock uses it for the Ken Burns move.`),
        provider: providerEnum.optional().describe("Sets the studio provider: mock, fal, replicate, or comfyui. Omit to keep the current one."),
        comfyWorkflow: z.string().optional().describe(`ComfyUI graph on this shot: ${GRAPH_LIST}.`),
        comfyLowMemory: z.boolean().optional().describe("Use the graph's low-memory preset on this shot."),
        generatedAudio: z
          .boolean()
          .optional()
          .describe("LTX-2.3 and LTX-2.5 only. True decodes generated audio into the mp4. False saves a silent mp4. Omit to inherit the project. Other graphs ignore it."),
        chainFromPrevious: z.boolean().optional().describe("When true, and this is not the first shot, the next take starts from the previous shot's last frame."),
        loras: z
          .array(z.object({ name: z.string(), strength: z.number().optional() }).strict())
          .optional()
          .describe("Optional ComfyUI LoRAs for this shot. Replaces the project list. name is the file name ComfyUI lists. strength defaults to 1, from -2 to 2. At most 4."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => guard(() => addShot(client, args))
  );

  server.registerTool(
    "start_render",
    {
      title: "Start render",
      description:
        "Start a render through the studio API. Pass shotId to render one shot. Omit shotId to render every shot in the project. The server checks keys, the hosted credit balance, safety, and ComfyUI readiness, and it will not queue a shot that fails those checks. This tool does not add credits. For fal or Replicate the server can refuse until acknowledgeModel is the model name it returns. A matching finished take is skipped. Pass shotId and force true to render that shot again. An approved take needs shotId and confirmApproved true.",
      inputSchema: {
        projectId: z.string().describe("Project id."),
        shotId: z.string().optional().describe("Shot id. Omit to render the whole project."),
        acknowledgeModel: z.string().optional().describe("Model name the server asked you to confirm for fal or Replicate."),
        force: z.boolean().optional().describe("With shotId, render again even when a matching take exists."),
        confirmApproved: z.boolean().optional().describe("With shotId, replace an approved take. Only pass true when that is intended."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => guard(() => startRender(client, args))
  );

  server.registerTool(
    "get_job",
    {
      title: "Get job",
      description:
        "Read one render job from GET /api/jobs/{id}. Returns status, error, and the live progress line the studio already keeps: a ComfyUI phase and step percent, or elapsed time for Mock, fal, and Replicate. Poll until status is completed or failed.",
      inputSchema: {
        jobId: z.string().describe("Job id from start_render."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => guard(() => getJob(client, args))
  );

  server.registerTool(
    "fetch_clip",
    {
      title: "Fetch clip",
      description:
        "Get the finished mp4 for a job. Returns the server media URL and stored path. Pass outputPath to copy the file there. A path with no extension, or an existing directory, is a folder and the clip is written inside it (for example ./assets). If the job is not completed, the error includes status and progress.",
      inputSchema: {
        jobId: z.string().describe("Job id from start_render or get_job."),
        outputPath: z.string().optional().describe("Local file or folder for the mp4. Omit to return the URL only."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => guard(() => fetchClip(client, args))
  );

  server.registerTool(
    "export_shotlist",
    {
      title: "Export shot list",
      description:
        "Download the project shot list from GET /api/projects/{id}/export/shotlist. The zip holds shotlist.json and the stills it names (schema stardust.shotlist/1). API keys, rates, and license data are not in the zip. outputPath is a file or a folder. Omit it to write shotlist.zip in the working directory.",
      inputSchema: {
        projectId: z.string().describe("Project id."),
        outputPath: z.string().optional().describe("Where to write the zip. A path with no extension is a folder."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => guard(() => exportShotList(client, args))
  );

  return server;
}
