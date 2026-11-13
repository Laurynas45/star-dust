/**
 * Compares a shipped ComfyUI API graph with GET /object_info.
 * Pure: no network, no disk, no secrets.
 *
 * ComfyUI's node map (server.py node_info) is `{ [class_type]: { input, output, name, ... } }`.
 * A classic loader lists files as the first element of the input spec:
 *   "unet_name": [["file.safetensors"], { "tooltip": "..." }]
 * A schema node (GET_NODE_INFO_V1) lists them on the combo metadata:
 *   "ckpt_name": ["COMBO", { "options": ["file.safetensors"] }]
 * Connected types are not file lists: "model": ["MODEL", {}].
 *
 * validate_inputs rejects a required input the prompt omits, and it does not
 * write the schema default. A missing optional input is skipped. A combo value
 * outside the server's list is "Value not in list".
 */

import {
  COMFY_CHECKPOINT,
  COMFY_WORKFLOWS,
  LTX_CHECKPOINT,
  LTX_TEXT_ENCODER,
  WAN_DIFFUSION,
  WAN_FLF_HIGH_NOISE,
  WAN_FLF_LOW_NOISE,
  WAN_FLF_VAE,
  WAN_TEXT_ENCODER,
  WAN_VAE,
} from "./provider-info";
import { ComfyWorkflowId } from "./types";

export const COMFY_CHECK_HONESTY =
  "This check looks at node names and the model filenames Star Dust will send. It does not measure memory. It does not promise quality, a character lock, or lip-sync.";

const CHECKPOINTS = "models/checkpoints";
const DIFFUSION = "models/diffusion_models";
const TEXT_ENCODERS = "models/text_encoders";
const VAE_FOLDER = "models/vae";

export type ModelSlot = {
  classType: string;
  /** When set, only the node with this _meta.title is patched. */
  title?: string;
  input: string;
  filename: string;
  /** Folder under the ComfyUI install. The next step names this path. */
  folder: string;
};

export type WorkflowNode = {
  class_type?: string;
  inputs?: Record<string, unknown>;
  _meta?: { title?: string };
};

export type ReadinessIssue = {
  kind: "node" | "model" | "vae" | "input";
  classType: string;
  nodeId: string;
  title?: string;
  input?: string;
  filename?: string;
  folder?: string;
  /** Combo values from /object_info, when this finding is about a list. */
  allowed?: string[];
  /** Value Star Dust will send for an omitted required input. */
  fill?: string | number | boolean;
  nextStep: string;
};

export type WanVariant = "5b" | "14b";

export type ComfyReadiness = {
  ok: boolean;
  /** Missing nodes, missing files, or an object_info body that is not a node map. */
  blocksQueue: boolean;
  invalid: boolean;
  missingNodes: ReadinessIssue[];
  missingModels: ReadinessIssue[];
  /**
   * Wan VAE filename does not match the 5B or 14B model.
   * A note only. It does not block the queue.
   */
  vaeWarnings: ReadinessIssue[];
  /**
   * Required inputs the graph omits and Star Dust can fill.
   * A note only. It does not block the queue.
   */
  inputNotes: ReadinessIssue[];
  /**
   * Omitted required inputs with nothing safe to send, or combo values
   * outside the server's list. These block the queue.
   */
  inputBlocks: ReadinessIssue[];
};

export type ComfyWorkflowCheck = {
  id: ComfyWorkflowId;
  title: string;
  file: string;
  ok: boolean;
  blocksQueue: boolean;
  missingNodes: ReadinessIssue[];
  missingModels: ReadinessIssue[];
  vaeWarnings: ReadinessIssue[];
  inputNotes: ReadinessIssue[];
  inputBlocks: ReadinessIssue[];
};

export type ComfyCheckSource = "env" | "settings" | "cli";

export type ComfyServerCheck = {
  reachable: boolean;
  /** Public base URL. Empty in UI payloads when the host comes from COMFYUI_BASE_URL. */
  url: string;
  source: ComfyCheckSource;
  message: string;
  honesty: string;
  blocksQueue: boolean;
  timedOut: boolean;
  httpStatus: number | null;
  /** Short failure detail. Not a URL and not a secret. */
  detail: string;
  workflows: ComfyWorkflowCheck[];
  /**
   * The /object_info body, kept for the queue fill. toPublicCheck removes it.
   * Not a URL and not an auth header.
   */
  objectInfo?: unknown;
};

/** Filenames Star Dust writes into each shipped graph. Same constants as the patch functions. */
export function modelSlotsFor(workflow: ComfyWorkflowId): ModelSlot[] {
  if (workflow === "svd") {
    return [
      {
        classType: "ImageOnlyCheckpointLoader",
        input: "ckpt_name",
        filename: COMFY_CHECKPOINT,
        folder: CHECKPOINTS,
      },
    ];
  }
  if (workflow === "wan") {
    return [
      { classType: "UNETLoader", input: "unet_name", filename: WAN_DIFFUSION, folder: DIFFUSION },
      { classType: "CLIPLoader", input: "clip_name", filename: WAN_TEXT_ENCODER, folder: TEXT_ENCODERS },
      { classType: "VAELoader", input: "vae_name", filename: WAN_VAE, folder: VAE_FOLDER },
    ];
  }
  if (workflow === "wan-flf") {
    return [
      {
        classType: "UNETLoader",
        title: "High-noise diffusion",
        input: "unet_name",
        filename: WAN_FLF_HIGH_NOISE,
        folder: DIFFUSION,
      },
      {
        classType: "UNETLoader",
        title: "Low-noise diffusion",
        input: "unet_name",
        filename: WAN_FLF_LOW_NOISE,
        folder: DIFFUSION,
      },
      { classType: "CLIPLoader", input: "clip_name", filename: WAN_TEXT_ENCODER, folder: TEXT_ENCODERS },
      { classType: "VAELoader", input: "vae_name", filename: WAN_FLF_VAE, folder: VAE_FOLDER },
    ];
  }
  return [
    { classType: "CheckpointLoaderSimple", input: "ckpt_name", filename: LTX_CHECKPOINT, folder: CHECKPOINTS },
    {
      classType: "LTXAVTextEncoderLoader",
      input: "text_encoder",
      filename: LTX_TEXT_ENCODER,
      folder: TEXT_ENCODERS,
    },
    { classType: "LTXAVTextEncoderLoader", input: "ckpt_name", filename: LTX_CHECKPOINT, folder: CHECKPOINTS },
    { classType: "LTXVAudioVAELoader", input: "ckpt_name", filename: LTX_CHECKPOINT, folder: CHECKPOINTS },
  ];
}

/**
 * File choices for one loader input.
 * Returns null when the spec is not a combo list (a MODEL socket, an INT, and so on).
 * An empty array means the loader is installed and lists no files.
 */
export function modelChoicesFromInput(spec: unknown): string[] | null {
  if (!Array.isArray(spec) || spec.length === 0) return null;
  const first = spec[0];
  if (Array.isArray(first)) {
    return first.filter((item): item is string => typeof item === "string").map((item) => item.trim());
  }
  const meta = spec[1];
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const options = (meta as { options?: unknown }).options;
    if (Array.isArray(options)) {
      return options.filter((item): item is string => typeof item === "string").map((item) => item.trim());
    }
  }
  return null;
}

export function checkComfyReadiness(
  workflow: unknown,
  objectInfo: unknown,
  slots: readonly ModelSlot[]
): ComfyReadiness {
  if (!isRecord(objectInfo)) {
    const issue: ReadinessIssue = {
      kind: "node",
      classType: "object_info",
      nodeId: "",
      nextStep:
        "ComfyUI answered GET /object_info, but the body was not a map of node class names. Update ComfyUI and run this check again.",
    };
    return {
      ok: false,
      blocksQueue: true,
      invalid: true,
      missingNodes: [issue],
      missingModels: [],
      vaeWarnings: [],
      inputNotes: [],
      inputBlocks: [],
    };
  }

  const nodes = collectNodes(workflow);
  const missingNodes: ReadinessIssue[] = [];
  const missingClasses = new Set<string>();
  for (const { id, node } of nodes) {
    const classType = node.class_type;
    if (!classType || typeof classType !== "string") continue;
    if (Object.prototype.hasOwnProperty.call(objectInfo, classType) && isRecord(objectInfo[classType])) {
      continue;
    }
    if (missingClasses.has(classType)) continue;
    missingClasses.add(classType);
    missingNodes.push({
      kind: "node",
      classType,
      nodeId: id,
      title: node._meta?.title,
      nextStep: missingNodeStep(classType),
    });
  }

  const missingModels: ReadinessIssue[] = [];
  for (const slot of slots) {
    const matches = nodes.filter((entry) => slotMatches(entry.node, slot));
    if (matches.length === 0) {
      missingNodes.push({
        kind: "node",
        classType: slot.classType,
        nodeId: "",
        title: slot.title,
        input: slot.input,
        filename: slot.filename,
        folder: slot.folder,
        nextStep: `The shipped graph has no ${slotLabel(slot)} node, so Star Dust cannot write ${slot.filename}.`,
      });
      continue;
    }
    for (const match of matches) {
      if (missingClasses.has(slot.classType)) continue;
      const spec = inputSpec(objectInfo[slot.classType], slot.input);
      const choices = modelChoicesFromInput(spec);
      if (choices === null) {
        missingModels.push({
          kind: "model",
          classType: slot.classType,
          nodeId: match.id,
          title: slot.title,
          input: slot.input,
          filename: slot.filename,
          folder: slot.folder,
          nextStep: `${slot.classType} is installed, but /object_info has no file list for ${slot.input}. Update ComfyUI. Star Dust sends ${slot.filename} for that input, from ComfyUI/${slot.folder}.`,
        });
        continue;
      }
      if (!choices.some((option) => option === slot.filename)) {
        missingModels.push({
          kind: "model",
          classType: slot.classType,
          nodeId: match.id,
          title: slot.title,
          input: slot.input,
          filename: slot.filename,
          folder: slot.folder,
          nextStep: missingFileStep(slot),
        });
      }
    }
  }

  missingNodes.sort(byIssue);
  missingModels.sort(byIssue);
  const vaeWarnings = wanVaePairingWarnings(slots);
  const inputs = collectInputFindings(workflow, objectInfo, slots);
  const ok = missingNodes.length === 0 && missingModels.length === 0 && inputs.blocks.length === 0;
  return {
    ok,
    blocksQueue: !ok,
    invalid: false,
    missingNodes,
    missingModels,
    vaeWarnings,
    inputNotes: inputs.notes,
    inputBlocks: inputs.blocks,
  };
}

type Scalar = string | number | boolean;

/**
 * ComfyUI validate_inputs (execution.py, current master and v0.44):
 * an omitted required input is required_input_missing, even when the schema
 * has a default. The closed PR that would fill defaults was not merged.
 * An omitted optional input is skipped. A present combo value outside the
 * list is value_not_in_list. CreateVideo.chroma_subsampling is optional in
 * v0.44; it fails an API prompt only when a server lists it as required, or
 * when the prompt sends a value such as 'none' that the list does not allow.
 */
function collectInputFindings(
  workflow: unknown,
  objectInfo: Record<string, unknown>,
  slots: readonly ModelSlot[]
): { notes: ReadinessIssue[]; blocks: ReadinessIssue[] } {
  const notes: ReadinessIssue[] = [];
  const blocks: ReadinessIssue[] = [];
  for (const { id, node } of collectNodes(workflow)) {
    const classType = node.class_type;
    if (!classType) continue;
    const info = objectInfo[classType];
    if (!isRecord(info)) continue;
    const groups = inputGroups(info);
    const inputs = nodeInputs(node);
    const seen = new Set<string>();
    const visit = (name: string, spec: unknown, required: boolean) => {
      if (!name || seen.has(name)) return;
      seen.add(name);
      if (coveredByModelSlot(node, name, slots)) return;
      const set = Boolean(inputs && Object.prototype.hasOwnProperty.call(inputs, name));
      const value = set && inputs ? inputs[name] : undefined;
      if (!set) {
        if (!required) return;
        const fill = safeRequiredValue(spec);
        if (fill === null) {
          blocks.push(inputBlock(node, id, name, spec, "missing"));
          return;
        }
        notes.push(inputNote(node, id, name, spec, fill));
        return;
      }
      if (isUploadSpec(spec) || isNodeLink(value)) return;
      const options = comboOptions(spec);
      if (!options || !isScalar(value)) return;
      if (options.some((option) => option === value)) return;
      blocks.push(inputBlock(node, id, name, spec, "list", value));
    };
    for (const [name, spec] of Object.entries(groups.required)) visit(name, spec, true);
    for (const [name, spec] of Object.entries(groups.optional)) visit(name, spec, false);
  }
  notes.sort(byIssue);
  blocks.sort(byIssue);
  return { notes, blocks };
}

/**
 * Writes omitted required inputs before a prompt is posted.
 * Does not replace a value the graph already has. Model-file slots and upload
 * widgets are left to the patch that names those files. When /object_info is
 * not a node map, the graph is returned unchanged.
 */
export function fillMissingRequiredInputs(
  workflow: unknown,
  objectInfo: unknown,
  slots: readonly ModelSlot[]
): {
  workflow: Record<string, WorkflowNode>;
  filled: Array<{ nodeId: string; classType: string; input: string; value: Scalar }>;
  blocked: ReadinessIssue[];
} {
  const copy = isRecord(workflow) ? (structuredClone(workflow) as Record<string, WorkflowNode>) : {};
  if (!isRecord(workflow) || !isRecord(objectInfo)) {
    return { workflow: copy, filled: [], blocked: [] };
  }
  const { notes, blocks } = collectInputFindings(workflow, objectInfo, slots);
  if (blocks.length > 0) return { workflow: copy, filled: [], blocked: blocks };
  const filled: Array<{ nodeId: string; classType: string; input: string; value: Scalar }> = [];
  for (const note of notes) {
    if (!note.input || note.fill === undefined) continue;
    const node = copy[note.nodeId];
    if (!node || !isNode(node)) continue;
    if (!node.inputs || !isRecord(node.inputs)) node.inputs = {};
    if (Object.prototype.hasOwnProperty.call(node.inputs, note.input)) continue;
    node.inputs[note.input] = note.fill;
    filled.push({ nodeId: note.nodeId, classType: note.classType, input: note.input, value: note.fill });
  }
  return { workflow: copy, filled, blocked: [] };
}

function isScalar(value: unknown): value is Scalar {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function specMeta(spec: unknown): Record<string, unknown> | null {
  if (!Array.isArray(spec) || spec.length < 2) return null;
  const meta = spec[1];
  return isRecord(meta) ? meta : null;
}

function isUploadSpec(spec: unknown): boolean {
  const meta = specMeta(spec);
  return meta?.image_upload === true || meta?.video_upload === true;
}

function comboOptions(spec: unknown): Scalar[] | null {
  if (!Array.isArray(spec) || spec.length === 0) return null;
  const first = spec[0];
  if (Array.isArray(first)) return first.filter(isScalar);
  if (first === "COMBO") {
    const options = specMeta(spec)?.options;
    if (!Array.isArray(options)) return [];
    return options.filter(isScalar);
  }
  return null;
}

function declaredDefault(spec: unknown): Scalar | undefined {
  const meta = specMeta(spec);
  if (!meta || !Object.prototype.hasOwnProperty.call(meta, "default")) return undefined;
  return isScalar(meta.default) ? meta.default : undefined;
}

/** Upload lists are not a filename Star Dust may invent. */
function safeRequiredValue(spec: unknown): Scalar | null {
  if (isUploadSpec(spec)) return null;
  const options = comboOptions(spec);
  if (options) {
    if (options.length === 0) return null;
    const fallback = declaredDefault(spec);
    if (fallback !== undefined && options.some((option) => option === fallback)) return fallback;
    const auto = options.find((option) => option === "auto");
    if (auto !== undefined) return auto;
    return options[0];
  }
  const fallback = declaredDefault(spec);
  return fallback === undefined ? null : fallback;
}

function inputGroups(nodeInfo: Record<string, unknown>): {
  required: Record<string, unknown>;
  optional: Record<string, unknown>;
} {
  const input = nodeInfo.input;
  if (!isRecord(input)) return { required: {}, optional: {} };
  return {
    required: isRecord(input.required) ? input.required : {},
    optional: isRecord(input.optional) ? input.optional : {},
  };
}

function nodeInputs(node: WorkflowNode): Record<string, unknown> | null {
  if (!node.inputs || !isRecord(node.inputs)) return null;
  return node.inputs;
}

function coveredByModelSlot(node: WorkflowNode, inputName: string, slots: readonly ModelSlot[]): boolean {
  return slots.some((slot) => slot.input === inputName && slotMatches(node, slot));
}

function isNodeLink(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [id, slot] = value;
  const idOk = typeof id === "string" || typeof id === "number";
  return idOk && typeof slot === "number" && Number.isFinite(slot);
}

function inputNodeLabel(node: WorkflowNode, nodeId: string): string {
  const classType = node.class_type || "node";
  if (!nodeId) return classType;
  const title = node._meta?.title;
  return title ? `${classType} (node ${nodeId}, ${title})` : `${classType} (node ${nodeId})`;
}

function allowedList(spec: unknown): string[] | undefined {
  const options = comboOptions(spec);
  if (!options || options.length === 0) return undefined;
  return options.map((option) => String(option));
}

function allowedPhrase(allowed: string[] | undefined): string {
  if (!allowed || allowed.length === 0) return "";
  const shown = allowed.slice(0, 12);
  const more = allowed.length > shown.length ? `, and ${allowed.length - shown.length} more` : "";
  return ` Allowed values: ${shown.join(", ")}${more}.`;
}

function shownFill(value: Scalar): string | null {
  const text = String(value);
  if (text.length > 80 || /:\/\//.test(text) || /[\r\n]/.test(text)) return null;
  return text;
}

function shownReceived(value: Scalar): string | null {
  if (typeof value === "string") {
    if (value.length > 80 || /:\/\//.test(value) || /[\r\n]/.test(value)) return null;
    return `'${value}'`;
  }
  const text = String(value);
  if (text.length > 80) return null;
  return text;
}

function inputNote(node: WorkflowNode, nodeId: string, name: string, spec: unknown, fill: Scalar): ReadinessIssue {
  const allowed = allowedList(spec);
  const shown = shownFill(fill);
  return {
    kind: "input",
    classType: node.class_type || "",
    nodeId,
    title: node._meta?.title,
    input: name,
    allowed,
    fill,
    nextStep: `${inputNodeLabel(node, nodeId)} does not set required input ${name}.${allowedPhrase(allowed)} ComfyUI rejects a prompt that omits a required input, and it does not fill a default. Star Dust will send ${shown === null ? "a listed value" : shown}. This does not block the queue.`,
  };
}

function inputBlock(
  node: WorkflowNode,
  nodeId: string,
  name: string,
  spec: unknown,
  reason: "missing" | "list",
  received?: Scalar
): ReadinessIssue {
  const allowed = allowedList(spec);
  const label = inputNodeLabel(node, nodeId);
  const nextStep =
    reason === "list"
      ? `${label} sets ${name} to ${received === undefined ? "a value that is not in the list" : (shownReceived(received) ?? "a value that is not in the list")}.${allowedPhrase(allowed)} ComfyUI rejects a value that is not in that list. Star Dust does not replace a value the graph already sets. The shot is not queued.`
      : `${label} does not set required input ${name}.${allowedPhrase(allowed)} ComfyUI rejects a prompt that omits a required input, and this input has no default Star Dust can send. The shot is not queued.`;
  return {
    kind: "input",
    classType: node.class_type || "",
    nodeId,
    title: node._meta?.title,
    input: name,
    allowed,
    nextStep,
  };
}

function fileBase(name: string): string {
  const parts = name.split(/[/\\]/);
  return (parts[parts.length - 1] ?? "").trim();
}

/** 5B and 14B from a diffusion filename Star Dust sends. Other files are not Wan. */
export function wanVariantFromDiffusion(filename: string): WanVariant | null {
  const base = fileBase(filename).toLowerCase();
  if (!base.includes("wan")) return null;
  if (base.includes("14b")) return "14b";
  if (base.includes("5b") || base.includes("ti2v")) return "5b";
  return null;
}

/** True when the VAE filename is the one paired with that Wan variant. */
export function vaeMatchesWanVariant(vaeName: string, variant: WanVariant): boolean {
  const base = fileBase(vaeName).toLowerCase();
  if (variant === "5b") return base === WAN_VAE.toLowerCase() || base.startsWith("wan2.2_vae");
  return base === WAN_FLF_VAE.toLowerCase() || base.startsWith("wan_2.1_vae") || base.startsWith("wan2.1_vae");
}

/**
 * Warns when a Wan diffusion slot is paired with the other variant's VAE.
 * Wan 2.2 5B needs wan2.2_vae. Wan 2.2 14B uses wan_2.1_vae.
 * SVD and LTX have no Wan diffusion slot, so they produce no note.
 */
export function wanVaePairingWarnings(slots: readonly ModelSlot[]): ReadinessIssue[] {
  const variants: WanVariant[] = [];
  const vaes: string[] = [];
  for (const slot of slots) {
    if (slot.input === "unet_name") {
      const variant = wanVariantFromDiffusion(slot.filename);
      if (variant && !variants.includes(variant)) variants.push(variant);
    }
    if (slot.input === "vae_name") vaes.push(slot.filename);
  }
  if (variants.length === 0 || vaes.length === 0) return [];
  const notes: ReadinessIssue[] = [];
  for (const variant of variants) {
    for (const vae of vaes) {
      if (vaeMatchesWanVariant(vae, variant)) continue;
      notes.push({
        kind: "vae",
        classType: "VAELoader",
        nodeId: "",
        input: "vae_name",
        filename: vae,
        folder: VAE_FOLDER,
        nextStep: vaePairingNote(variant, vae),
      });
    }
  }
  notes.sort(byIssue);
  return notes;
}

function vaePairingNote(variant: WanVariant, vaeName: string): string {
  if (variant === "5b") {
    return `Wan 2.2 5B is paired with ${WAN_VAE}. This graph sends ${vaeName}. Wan 2.2 14B uses ${WAN_FLF_VAE}. A mismatched VAE is a reported cause of an all-black clip. This does not block the queue, and it does not promise the picture.`;
  }
  return `Wan 2.2 14B is paired with ${WAN_FLF_VAE}. This graph sends ${vaeName}. Wan 2.2 5B needs ${WAN_VAE}. A mismatched VAE is a reported cause of an all-black clip. This does not block the queue, and it does not promise the picture.`;
}

export function hostPhrase(check: Pick<ComfyServerCheck, "source" | "url">, revealUrl: boolean): string {
  if (check.source === "env" && !revealUrl) return "the server from COMFYUI_BASE_URL";
  if (check.url) return check.url;
  return "the ComfyUI server";
}

export function describeUnreachable(check: ComfyServerCheck, revealUrl: boolean): string {
  const where = hostPhrase(check, revealUrl);
  if (check.timedOut) {
    return `ComfyUI did not answer GET /object_info at ${where} within ${check.detail}. The check stopped instead of waiting.`;
  }
  if (check.detail === "body was not JSON") {
    return `ComfyUI at ${where} returned a body for GET /object_info that was not JSON.`;
  }
  if (check.httpStatus === 401 || check.httpStatus === 403) {
    return `ComfyUI at ${where} returned HTTP ${check.httpStatus} for GET /object_info. For a remote GPU, set COMFYUI_AUTH_HEADER in the environment. The value is not stored and is not shown here.`;
  }
  if (check.httpStatus) {
    return `ComfyUI at ${where} returned HTTP ${check.httpStatus} for GET /object_info.`;
  }
  return `ComfyUI unreachable at ${where} (${check.detail || "request failed"}).`;
}

export function statusMessage(check: ComfyServerCheck, revealUrl: boolean): string {
  if (!check.reachable) return describeUnreachable(check, revealUrl);
  const failed = check.workflows.filter((workflow) => !workflow.ok);
  const vae = check.workflows.filter((workflow) => workflow.vaeWarnings.length > 0);
  const inputs = check.workflows.filter((workflow) => workflow.inputNotes.length > 0);
  if (failed.length === 0 && vae.length === 0 && inputs.length === 0) {
    return "Every checked graph can run on this server. Every node is listed, and every model filename Star Dust will send is in that loader's list.";
  }
  if (failed.length === 0) {
    const parts = ["Every checked graph can run on this server."];
    if (vae.length > 0) {
      const names = vae.map((workflow) => workflow.title).join(", ");
      parts.push(
        `${names} sends a VAE filename that does not match the Wan model. That note does not block the queue.`
      );
    }
    if (inputs.length > 0) {
      const names = inputs.map((workflow) => workflow.title).join(", ");
      parts.push(
        `${names} omits a required input this server added. Star Dust sends a listed value before the shot is queued. That does not block the queue.`
      );
    }
    return parts.join(" ");
  }
  const names = failed.map((workflow) => workflow.title).join(", ");
  return `${names} would not run. A render that uses a failing graph is refused before the shot is queued.`;
}

/** UI payload. The env host is left blank so the page does not show COMFYUI_BASE_URL. */
export function toPublicCheck(check: ComfyServerCheck): ComfyServerCheck {
  const revealUrl = check.source !== "env";
  const publicCheck: ComfyServerCheck = {
    ...check,
    url: revealUrl ? check.url : "",
    message: statusMessage(check, revealUrl),
  };
  delete publicCheck.objectInfo;
  return publicCheck;
}

export function formatQueueRefusal(
  check: ComfyServerCheck,
  opts?: { revealUrl?: boolean; closing?: string }
): string {
  const revealUrl = opts?.revealUrl ?? check.source !== "env";
  const closing = opts?.closing ?? "This render was not queued.";
  const lines = [statusMessage(check, revealUrl)];
  for (const workflow of check.workflows) {
    const issues = [
      ...workflow.missingNodes,
      ...workflow.missingModels,
      ...workflow.inputBlocks,
      ...workflow.vaeWarnings,
    ];
    if (issues.length === 0) continue;
    lines.push(`${workflow.title} (${workflow.file}):`);
    for (const issue of issues) lines.push(issue.nextStep);
  }
  lines.push(closing);
  return lines.join("\n");
}

export function formatComfyCheckTable(check: ComfyServerCheck): string {
  const lines = ["ComfyUI check", hostPhrase(check, true), "", COMFY_CHECK_HONESTY, ""];
  if (!check.reachable) {
    lines.push(describeUnreachable(check, true));
    lines.push("");
    lines.push("Result: fail");
    return lines.join("\n");
  }
  const titleWidth = Math.max(22, ...check.workflows.map((workflow) => workflow.title.length));
  lines.push(`${pad("Workflow", titleWidth)}  Nodes     Models    Result`);
  for (const workflow of check.workflows) {
    const nodes = workflow.missingNodes.length > 0 ? "MISSING" : "pass";
    const models = workflow.missingModels.length > 0 ? "MISSING" : "pass";
    const result = workflow.ok ? "pass" : "fail";
    lines.push(`${pad(workflow.title, titleWidth)}  ${pad(nodes, 8)}  ${pad(models, 8)}  ${result}`);
  }
  lines.push("");
  for (const workflow of check.workflows) {
    const issues = [...workflow.missingNodes, ...workflow.missingModels, ...workflow.inputBlocks];
    const notes = [...workflow.vaeWarnings, ...workflow.inputNotes];
    if (issues.length === 0 && notes.length === 0) continue;
    lines.push(workflow.title);
    for (const issue of issues) lines.push(`- ${issue.nextStep}`);
    for (const note of notes) lines.push(`- ${note.nextStep}`);
    if (notes.length > 0) lines.push("The VAE note does not block the queue.");
    lines.push("");
  }
  lines.push(check.blocksQueue ? "Result: fail" : "Result: pass");
  return lines.join("\n");
}

/** CLI names for --workflow. The internal id is accepted too. */
export function workflowIdFromFlag(flag: string): ComfyWorkflowId | null {
  const key = flag.trim().toLowerCase().replace(/\.api\.json$/, "").replace(/^workflows\//, "");
  const table: Record<string, ComfyWorkflowId> = {
    svd: "svd",
    "svd-i2v": "svd",
    "comfyui-svd-i2v": "svd",
    wan: "wan",
    "wan22-ti2v-5b": "wan",
    "comfyui-wan22-ti2v-5b": "wan",
    "ti2v-5b": "wan",
    "wan-flf": "wan-flf",
    "wan22-14b-flf2v": "wan-flf",
    "comfyui-wan22-14b-flf2v": "wan-flf",
    flf2v: "wan-flf",
    "14b-flf2v": "wan-flf",
    ltx: "ltx",
    "ltx23-i2v": "ltx",
    "comfyui-ltx23-i2v": "ltx",
    "ltx-2.3": "ltx",
    "ltx-2.3-i2v": "ltx",
  };
  return table[key] ?? null;
}

export const COMFY_CHECK_WORKFLOW_FLAGS = [
  "svd",
  "wan22-ti2v-5b",
  "wan22-14b-flf2v",
  "ltx23-i2v",
] as const;

function missingNodeStep(classType: string): string {
  return `Missing node ${classType}. Update ComfyUI. The shipped graph uses this node, and this server's /object_info list does not include it. A node ComfyUI removed or renamed, such as an older Wan Block Swap node, shows up this way. Star Dust does not install nodes.`;
}

function missingFileStep(slot: ModelSlot): string {
  const which = slot.title ? `${slot.classType} (${slot.title})` : slot.classType;
  return `Missing file ${slot.filename}. Put it in ComfyUI/${slot.folder} so ${which} lists that exact name under ${slot.input}, then restart ComfyUI. A file inside a subfolder is listed with the subfolder prefix and does not match the name Star Dust sends. Star Dust does not download weights.`;
}

function slotLabel(slot: ModelSlot): string {
  return slot.title ? `${slot.classType} (${slot.title})` : slot.classType;
}

function slotMatches(node: WorkflowNode, slot: ModelSlot): boolean {
  if (node.class_type !== slot.classType) return false;
  if (slot.title && node._meta?.title !== slot.title) return false;
  return true;
}

function inputSpec(nodeInfo: unknown, inputName: string): unknown {
  if (!isRecord(nodeInfo)) return undefined;
  const input = nodeInfo.input;
  if (!isRecord(input)) return undefined;
  const required = isRecord(input.required) ? input.required : undefined;
  const optional = isRecord(input.optional) ? input.optional : undefined;
  if (required && Object.prototype.hasOwnProperty.call(required, inputName)) return required[inputName];
  if (optional && Object.prototype.hasOwnProperty.call(optional, inputName)) return optional[inputName];
  return undefined;
}

function collectNodes(workflow: unknown): Array<{ id: string; node: WorkflowNode }> {
  if (!isRecord(workflow)) return [];
  const direct = Object.entries(workflow).filter((entry): entry is [string, WorkflowNode] => isNode(entry[1]));
  if (direct.length > 0) return direct.map(([id, node]) => ({ id, node }));
  if (isRecord(workflow.prompt)) return collectNodes(workflow.prompt);
  return [];
}

function isNode(value: unknown): value is WorkflowNode {
  return isRecord(value) && typeof value.class_type === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function byIssue(a: ReadinessIssue, b: ReadinessIssue): number {
  const id = nodeSort(a.nodeId, b.nodeId);
  if (id !== 0) return id;
  if (a.classType !== b.classType) return a.classType.localeCompare(b.classType);
  return (a.input ?? "").localeCompare(b.input ?? "");
}

function nodeSort(a: string, b: string): number {
  const left = Number(a);
  const right = Number(b);
  if (Number.isFinite(left) && Number.isFinite(right) && String(left) === a && String(right) === b && left !== right) {
    return left - right;
  }
  return a.localeCompare(b);
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

export function workflowCheckFromReadiness(
  id: ComfyWorkflowId,
  readiness: ComfyReadiness
): ComfyWorkflowCheck {
  return {
    id,
    title: COMFY_WORKFLOWS[id].title,
    file: COMFY_WORKFLOWS[id].file,
    ok: readiness.ok,
    blocksQueue: readiness.blocksQueue,
    missingNodes: readiness.missingNodes,
    missingModels: readiness.missingModels,
    vaeWarnings: readiness.vaeWarnings,
    inputNotes: readiness.inputNotes,
    inputBlocks: readiness.inputBlocks,
  };
}
