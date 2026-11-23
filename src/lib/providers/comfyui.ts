import fs from "fs";
import path from "path";
import { finishRenderedClip } from "../clip-check";
import { startComfyProgressWatch, type ComfyProgressWatch } from "../comfy-watch";
import { nodesFromWorkflow } from "../comfy-progress";
import { runFfmpeg } from "../ffmpeg";
import { clearJobActivity, noteRunStarted } from "../job-activity";
import { LTX_FPS, ltxFrameCount, ltxFrameSize } from "../ltx";
import { LTX25_FPS, ltx25FrameCount, ltx25FrameSize, ltx25StageSize } from "../ltx25";
import { H3_FPS, h3FrameCount, h3FrameSize } from "../minimax-h3";
import {
  COMFY_CHECKPOINT,
  LOW_MEMORY_MARK,
  SVD_LOW_FRAME,
  H3_AUDIO_VAE,
  H3_DIFFUSION,
  H3_TEXT_ENCODER,
  H3_VIDEO_VAE,
  LTX_CHECKPOINT,
  LTX_TEXT_ENCODER,
  LTX25_AUDIO_VAE,
  LTX25_DIFFUSION,
  LTX25_TEXT_ENCODER,
  LTX25_UPSCALER,
  LTX25_VIDEO_VAE,
  WAN_DIFFUSION,
  WAN_FLF_HIGH_NOISE,
  WAN_FLF_LOW_NOISE,
  WAN_FLF_MISSING_END,
  WAN_FLF_VAE,
  WAN_TEXT_ENCODER,
  WAN_VAE,
  comfyWorkflowFromModelName,
  generatedAudioFromModelName,
} from "../provider-info";
import {
  absoluteOutputPath,
  getJob,
  getProject,
  getSettings,
  getShot,
  resolveDataPath,
  updateJob,
} from "../storage";
import {
  checkLoraFiles,
  fillMissingRequiredInputs,
  formatQueueRefusal,
  literalModelSlots,
  ltxAudioDecodeAvailable,
  modelSlotsFor,
  toPublicCheck,
  type ComfyCheckSource,
} from "../comfy-readiness";
import { injectModelLoras } from "../lora-graph";
import { effectiveLoras, shouldInjectLoras } from "../loras";
import { assessWorkflows, prepareGraphChecks, serverCheck } from "../comfy-readiness-run";
import {
  customEndMissingMessage,
  formatCustomGraphFailure,
  injectCustomWorkflow,
  type CustomGraph,
} from "../custom-workflow";
import { loadCustomGraphById } from "../custom-workflow-files";
import { ComfyGraphId, LoraRef, isComfyWorkflowId, isCustomGraphId } from "../types";
import {
  WAN_FPS,
  WAN_LOW_MAX_FRAMES,
  WAN_MAX_FRAMES,
  WAN_MAX_HEIGHT,
  WAN_MAX_WIDTH,
  imagePixelSize,
  wanFlfFrameSize,
  wanFrameCount,
  wanFrameSize,
} from "../wan";

type WorkflowNode = {
  class_type?: string;
  inputs?: Record<string, unknown>;
  _meta?: { title?: string };
};

type Workflow = Record<string, WorkflowNode>;

type ComfyFile = { filename?: string; subfolder?: string; type?: string };

const POLL_MS = Number(process.env.STAR_DUST_COMFY_POLL_MS || 2000);
const MAX_POLLS = Number(process.env.STAR_DUST_COMFY_MAX_POLLS || 600);

function fail(jobId: string, error: string): never {
  const current = getJob(jobId);
  if (current && current.status !== "cancelled") {
    updateJob(jobId, { status: "failed", error, progress: 0 });
  }
  throw new Error(error);
}

/** Drop userinfo and query strings so a proxy token in the URL is not stored on the job. */
export function publicComfyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.replace(/[\r\n]/g, "");
  }
}

export function resolveComfyBase(settings: { comfyuiBaseUrl: string }): {
  base: string;
  source: "env" | "settings";
} {
  const fromEnv = process.env.COMFYUI_BASE_URL?.trim();
  if (fromEnv) return { base: fromEnv.replace(/\/$/, ""), source: "env" };
  const stored = (settings.comfyuiBaseUrl || "http://127.0.0.1:8188").trim() || "http://127.0.0.1:8188";
  return { base: stored.replace(/\/$/, ""), source: "settings" };
}

export function comfyAuthConfigured(): boolean {
  const value = process.env.COMFYUI_AUTH_HEADER?.trim();
  if (!value) return false;
  return !/[\r\n]/.test(value);
}

/** Header name and value from the environment. Never written to SQLite or the UI. */
export function comfyAuthHeaders(): Record<string, string> {
  const value = process.env.COMFYUI_AUTH_HEADER?.trim();
  if (!value || /[\r\n]/.test(value)) return {};
  const name = process.env.COMFYUI_AUTH_HEADER_NAME?.trim() || "Authorization";
  if (!/^[A-Za-z0-9-]+$/.test(name)) return {};
  return { [name]: value };
}

function comfyFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  for (const [key, value] of Object.entries(comfyAuthHeaders())) headers.set(key, value);
  return fetch(url, { ...init, headers });
}

function netFailure(url: string, err: unknown): string {
  const where = publicComfyUrl(url);
  const cause = err instanceof Error ? (err as Error & { cause?: { code?: string; message?: string } }).cause : undefined;
  const code = cause?.code || "";
  const detail = cause?.message || (err instanceof Error ? err.message : String(err));
  const status = code || detail;
  return `ComfyUI unreachable at ${where} (${status}).`;
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 800);
  } catch {
    return "";
  }
}

/**
 * Turns an OOM, a missing node, or a missing model into a short next step.
 * Returns null when the body is not one of those cases.
 */
export function explainComfyProblem(raw: string, url: string): string | null {
  const text = raw.replace(/\s+/g, " ").trim().slice(0, 800);
  if (!text) return null;
  const lower = text.toLowerCase();
  const where = publicComfyUrl(url);
  if (
    /out of memory|outofmemory|cuda error: out of memory|hip out of memory|allocation on device|not enough memory|cuda oom|\boom\b/.test(
      lower
    )
  ) {
    return `ComfyUI ran out of memory at ${where}. That can be GPU VRAM, or system RAM when weights are offloaded. Turn on the low-memory preset (about 480p, short clip) before raising resolution or length. The job was not left running. Server said: ${text}`;
  }
  if (
    /not in list|failed validation|ckpt_name|unet_name|clip_name|vae_name|safetensors|\.gguf|model .*not found|not found in/.test(
      lower
    )
  ) {
    return `ComfyUI could not find a model file for this workflow at ${where}. The README lists the filenames for SVD, Wan 2.2 TI2V-5B, Wan 2.2 14B FLF2V, LTX-2.3, LTX-2.5, and MiniMax H3. A custom graph uses the filenames already in that file. Star Dust does not download weights. The licence for those weights is yours. The job was not left running. Server said: ${text}`;
  }
  if (/does not exist|missing node|unknown node|node type|class_type|custom node/.test(lower)) {
    return `ComfyUI is missing a node for this workflow at ${where}. SVD, Wan 2.2 TI2V-5B, Wan 2.2 14B first-last frame, the shipped LTX-2.3 graph, LTX-2.5, and MiniMax H3 use core nodes from a current ComfyUI. MiniMax H3 needs ComfyUI 0.31.0 or later. Optional GGUF loading needs the ComfyUI-GGUF custom node, which the shipped graph does not use. A custom graph uses the nodes in the file you exported. Star Dust does not install custom nodes. The job was not left running. Server said: ${text}`;
  }
  return null;
}

function httpFailure(url: string, status: number, body: string): string {
  const where = publicComfyUrl(url);
  if (status === 401 || status === 403) {
    return `ComfyUI at ${where} returned HTTP ${status}. For a remote GPU, set COMFYUI_AUTH_HEADER in the environment. The value is not stored and is not shown here. The job was not left running.`;
  }
  const explained = explainComfyProblem(body, url);
  if (explained) return explained;
  const snippet = body.replace(/\s+/g, " ").trim().slice(0, 800);
  return `ComfyUI at ${where} returned HTTP ${status}.${snippet ? ` ${snippet}` : ""}`;
}

export function loadWorkflow(): Workflow {
  const file = path.join(process.cwd(), "workflows", "comfyui-svd-i2v.api.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as Workflow;
}

export function loadWanWorkflow(): Workflow {
  const file = path.join(process.cwd(), "workflows", "comfyui-wan22-ti2v-5b.api.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as Workflow;
}

export function loadWanFlfWorkflow(): Workflow {
  const file = path.join(process.cwd(), "workflows", "comfyui-wan22-14b-flf2v.api.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as Workflow;
}

export function loadLtxWorkflow(): Workflow {
  const file = path.join(process.cwd(), "workflows", "comfyui-ltx23-i2v.api.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as Workflow;
}

export function loadLtx25Workflow(): Workflow {
  const file = path.join(process.cwd(), "workflows", "comfyui-ltx25-i2v.api.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as Workflow;
}

export function loadMinimaxH3Workflow(): Workflow {
  const file = path.join(process.cwd(), "workflows", "comfyui-minimax-h3-i2v.api.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as Workflow;
}

export function comfyPlanForJob(
  job: { modelName?: string },
  settings: { comfyuiWorkflow: ComfyGraphId; comfyLowMemory?: boolean }
): { workflow: ComfyGraphId; lowMemory: boolean; generatedAudio: boolean } {
  const named = comfyWorkflowFromModelName(job.modelName);
  const workflow = named ?? settings.comfyuiWorkflow;
  const lowMemory = job.modelName
    ? job.modelName.includes(LOW_MEMORY_MARK)
    : Boolean(settings.comfyLowMemory);
  const generatedAudio = generatedAudioFromModelName(job.modelName) && (workflow === "ltx" || workflow === "ltx25");
  return { workflow, lowMemory, generatedAudio };
}

export function comfyWorkflowForJob(
  job: { modelName?: string },
  settings: { comfyuiWorkflow: ComfyGraphId; comfyLowMemory?: boolean }
): ComfyGraphId {
  return comfyPlanForJob(job, settings).workflow;
}

export function patchWorkflow(
  workflow: Workflow,
  opts: { imageName: string; seed: number; frames: number; fps: number; width?: number; height?: number }
): Workflow {
  const next = structuredClone(workflow);
  for (const node of Object.values(next)) {
    if (!node.inputs) continue;
    if (node.class_type === "LoadImage") node.inputs.image = opts.imageName;
    if (node.class_type === "ImageOnlyCheckpointLoader") {
      node.inputs.ckpt_name = COMFY_CHECKPOINT;
    }
    if (node.class_type === "SVD_img2vid_Conditioning") {
      node.inputs.video_frames = opts.frames;
      node.inputs.fps = opts.fps;
      if (opts.width) node.inputs.width = opts.width;
      if (opts.height) node.inputs.height = opts.height;
    }
    if (node.class_type === "KSampler") node.inputs.seed = opts.seed;
    if (node.class_type === "SaveAnimatedWEBP") node.inputs.fps = opts.fps;
  }
  return next;
}

export function patchWanWorkflow(
  workflow: Workflow,
  opts: {
    imageName: string;
    prompt: string;
    seed: number;
    frames: number;
    width: number;
    height: number;
    fps: number;
  }
): Workflow {
  const next = structuredClone(workflow);
  for (const node of Object.values(next)) {
    if (!node.inputs) continue;
    if (node.class_type === "LoadImage") node.inputs.image = opts.imageName;
    if (node.class_type === "UNETLoader") node.inputs.unet_name = WAN_DIFFUSION;
    if (node.class_type === "CLIPLoader") node.inputs.clip_name = WAN_TEXT_ENCODER;
    if (node.class_type === "VAELoader") node.inputs.vae_name = WAN_VAE;
    if (node.class_type === "CLIPTextEncode" && node._meta?.title === "Positive prompt") {
      node.inputs.text = opts.prompt;
    }
    if (node.class_type === "Wan22ImageToVideoLatent") {
      node.inputs.width = opts.width;
      node.inputs.height = opts.height;
      node.inputs.length = opts.frames;
    }
    if (node.class_type === "KSampler") node.inputs.seed = opts.seed;
    if (node.class_type === "SaveAnimatedWEBP") node.inputs.fps = opts.fps;
  }
  return next;
}

export function patchWanFlfWorkflow(
  workflow: Workflow,
  opts: {
    startImageName: string;
    endImageName: string;
    prompt: string;
    seed: number;
    frames: number;
    width: number;
    height: number;
    fps: number;
  }
): Workflow {
  const next = structuredClone(workflow);
  for (const node of Object.values(next)) {
    if (!node.inputs) continue;
    if (node.class_type === "LoadImage" && node._meta?.title === "Start image") {
      node.inputs.image = opts.startImageName;
    }
    if (node.class_type === "LoadImage" && node._meta?.title === "End image") {
      node.inputs.image = opts.endImageName;
    }
    if (node.class_type === "UNETLoader" && node._meta?.title === "High-noise diffusion") {
      node.inputs.unet_name = WAN_FLF_HIGH_NOISE;
    }
    if (node.class_type === "UNETLoader" && node._meta?.title === "Low-noise diffusion") {
      node.inputs.unet_name = WAN_FLF_LOW_NOISE;
    }
    if (node.class_type === "CLIPLoader") node.inputs.clip_name = WAN_TEXT_ENCODER;
    if (node.class_type === "VAELoader") node.inputs.vae_name = WAN_FLF_VAE;
    if (node.class_type === "CLIPTextEncode" && node._meta?.title === "Positive prompt") {
      node.inputs.text = opts.prompt;
    }
    if (node.class_type === "WanFirstLastFrameToVideo") {
      node.inputs.width = opts.width;
      node.inputs.height = opts.height;
      node.inputs.length = opts.frames;
    }
    if (node.class_type === "KSamplerAdvanced" && node._meta?.title === "High-noise sampler") {
      node.inputs.noise_seed = opts.seed;
    }
    if (node.class_type === "CreateVideo") node.inputs.fps = opts.fps;
  }
  return next;
}

export function patchLtxWorkflow(
  workflow: Workflow,
  opts: {
    imageName: string;
    prompt: string;
    seed: number;
    frames: number;
    width: number;
    height: number;
    fps: number;
    /** On decodes the audio latent into the mp4. Off leaves the silent file. */
    generatedAudio?: boolean;
  }
): Workflow {
  const next = structuredClone(workflow);
  for (const node of Object.values(next)) {
    if (!node.inputs) continue;
    if (node.class_type === "LoadImage") node.inputs.image = opts.imageName;
    if (node.class_type === "CheckpointLoaderSimple") node.inputs.ckpt_name = LTX_CHECKPOINT;
    if (node.class_type === "LTXVAudioVAELoader") node.inputs.ckpt_name = LTX_CHECKPOINT;
    if (node.class_type === "LTXAVTextEncoderLoader") {
      node.inputs.ckpt_name = LTX_CHECKPOINT;
      node.inputs.text_encoder = LTX_TEXT_ENCODER;
    }
    if (node.class_type === "CLIPTextEncode" && node._meta?.title === "Positive prompt") {
      node.inputs.text = opts.prompt;
    }
    if (node.class_type === "EmptyLTXVLatentVideo") {
      node.inputs.width = opts.width;
      node.inputs.height = opts.height;
      node.inputs.length = opts.frames;
    }
    if (node.class_type === "LTXVEmptyLatentAudio") {
      node.inputs.frames_number = opts.frames;
      node.inputs.frame_rate = opts.fps;
    }
    if (node.class_type === "LTXVConditioning") node.inputs.frame_rate = opts.fps;
    if (node.class_type === "RandomNoise") node.inputs.noise_seed = opts.seed;
    if (node.class_type === "CreateVideo") node.inputs.fps = opts.fps;
  }
  applyLtxGeneratedAudio(next, opts.generatedAudio === true);
  return next;
}

const LTX25_I2V_ONLY = ["13", "19", "20", "21", "22", "23", "24", "26", "27", "28", "29"];
const LTX25_FLF_ONLY = ["33", "34", "35", "36", "37", "38"];

/**
 * Two-stage image-to-video, unless the shot has an end still.
 * An end still switches the queued prompt to the single-stage first-last path:
 * LTXVAddGuide at frame 0 and at frame -1, then one sample, no latent upscaler.
 * Generated audio decodes the separated audio latent into CreateVideo.
 * Off leaves that latent unused, so the saved file stays silent.
 */
export function patchLtx25Workflow(
  workflow: Workflow,
  opts: {
    imageName: string;
    endImageName?: string | null;
    prompt: string;
    seed: number;
    frames: number;
    width: number;
    height: number;
    fps: number;
    /** On decodes the audio latent into the mp4. Off leaves the silent file. */
    generatedAudio?: boolean;
  }
): Workflow {
  const next = structuredClone(workflow);
  const end = Boolean(opts.endImageName);
  for (const id of end ? LTX25_I2V_ONLY : LTX25_FLF_ONLY) delete next[id];
  for (const node of Object.values(next)) {
    if (!node.inputs) continue;
    if (node.class_type === "LoadImage" && node._meta?.title === "Start image") {
      node.inputs.image = opts.imageName;
    }
    if (node.class_type === "LoadImage" && node._meta?.title === "End image" && opts.endImageName) {
      node.inputs.image = opts.endImageName;
    }
    if (node.class_type === "UNETLoader") {
      node.inputs.unet_name = LTX25_DIFFUSION;
      node.inputs.weight_dtype = "default";
    }
    if (node.class_type === "CLIPLoader") {
      node.inputs.clip_name = LTX25_TEXT_ENCODER;
      node.inputs.type = "ltxv";
      node.inputs.device = "default";
    }
    if (node.class_type === "VAELoader" && node._meta?.title === "Load video VAE") {
      node.inputs.vae_name = LTX25_VIDEO_VAE;
    }
    if (node.class_type === "VAELoader" && node._meta?.title === "Load audio VAE") {
      node.inputs.vae_name = LTX25_AUDIO_VAE;
    }
    if (node.class_type === "LatentUpscaleModelLoader") node.inputs.model_name = LTX25_UPSCALER;
    if (node.class_type === "CLIPTextEncode" && node._meta?.title === "Positive prompt") {
      node.inputs.text = opts.prompt;
    }
    if (node.class_type === "EmptyLTXVLatentVideo") {
      const size = end ? { width: opts.width, height: opts.height } : ltx25StageSize(opts.width, opts.height);
      node.inputs.width = size.width;
      node.inputs.height = size.height;
      node.inputs.length = opts.frames;
    }
    if (node.class_type === "LTXVEmptyLatentAudio") {
      node.inputs.frames_number = opts.frames;
      node.inputs.frame_rate = opts.fps;
    }
    if (node.class_type === "LTXVConditioning") node.inputs.frame_rate = opts.fps;
    if (node.class_type === "RandomNoise" && node._meta?.title === "First stage noise") {
      node.inputs.noise_seed = opts.seed;
    }
    if (node.class_type === "RandomNoise" && node._meta?.title === "Second stage noise") {
      node.inputs.noise_seed = 42;
    }
    if (node.class_type === "LTXVAddGuide" && node._meta?.title === "First frame guide") {
      node.inputs.frame_idx = 0;
      node.inputs.strength = 0.7;
    }
    if (node.class_type === "LTXVAddGuide" && node._meta?.title === "Last frame guide") {
      node.inputs.frame_idx = -1;
      node.inputs.strength = 1;
    }
    if (node.class_type === "CreateVideo") node.inputs.fps = opts.fps;
  }
  const concat = next["16"];
  const guider = next["15"];
  const sampler = next["17"];
  const decode = next["30"];
  if (end) {
    if (concat?.inputs) concat.inputs.video_latent = ["36", 2];
    if (guider?.inputs) {
      guider.inputs.positive = ["36", 0];
      guider.inputs.negative = ["36", 1];
    }
    if (sampler?.inputs) sampler.inputs.sampler = ["38", 0];
    if (decode?.inputs) decode.inputs.samples = ["37", 2];
    const crop = next["37"];
    if (crop?.inputs) {
      crop.inputs.positive = ["36", 0];
      crop.inputs.negative = ["36", 1];
      crop.inputs.latent = ["18", 0];
    }
  } else {
    if (concat?.inputs) concat.inputs.video_latent = ["19", 0];
    if (guider?.inputs) {
      guider.inputs.positive = ["9", 0];
      guider.inputs.negative = ["9", 1];
    }
    if (sampler?.inputs) sampler.inputs.sampler = ["13", 0];
    if (decode?.inputs) decode.inputs.samples = ["29", 0];
  }
  applyLtxGeneratedAudio(next, opts.generatedAudio === true);
  return next;
}

/**
 * Official LTX-2 I2V templates use the core node LTXVAudioVAEDecode.
 * samples is LTXVSeparateAVLatent output 1 (the audio latent).
 * audio_vae is the same VAE LTXVEmptyLatentAudio already uses.
 * CreateVideo.audio takes that AUDIO output. SaveVideo writes the file.
 * Off deletes the decode node and the audio input, which is today's silent mp4.
 */
function applyLtxGeneratedAudio(workflow: Workflow, enabled: boolean): void {
  for (const id of Object.keys(workflow)) {
    if (workflow[id]?.class_type === "LTXVAudioVAEDecode") delete workflow[id];
  }
  for (const node of Object.values(workflow)) {
    if (node.class_type === "CreateVideo" && node.inputs && Object.prototype.hasOwnProperty.call(node.inputs, "audio")) {
      delete node.inputs.audio;
    }
  }
  if (!enabled) return;
  const separateId = ltxAudioSeparateId(workflow);
  const audioVae = ltxAudioVaeLink(workflow);
  if (!separateId || !audioVae) return;
  const id = nextWorkflowId(workflow);
  workflow[id] = {
    class_type: "LTXVAudioVAEDecode",
    inputs: {
      samples: [separateId, 1],
      audio_vae: audioVae,
    },
    _meta: { title: "LTXV Audio VAE Decode" },
  };
  for (const node of Object.values(workflow)) {
    if (node.class_type === "CreateVideo" && node.inputs) node.inputs.audio = [id, 0];
  }
}

function workflowLink(value: unknown): [string, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const [id, slot] = value;
  if ((typeof id !== "string" && typeof id !== "number") || typeof slot !== "number") return null;
  return [String(id), slot];
}

/** The separate node whose video output is the one the picture decode uses. */
function ltxAudioSeparateId(workflow: Workflow): string | null {
  const decode = Object.entries(workflow).find(([, node]) => node.class_type === "VAEDecodeTiled");
  const samples = workflowLink(decode?.[1].inputs?.samples);
  if (!samples) return null;
  const source = workflow[samples[0]];
  if (!source) return null;
  if (source.class_type === "LTXVSeparateAVLatent" && samples[1] === 0) return samples[0];
  if (source.class_type === "LTXVCropGuides") {
    const latent = workflowLink(source.inputs?.latent);
    if (!latent) return null;
    const separate = workflow[latent[0]];
    if (separate?.class_type === "LTXVSeparateAVLatent" && latent[1] === 0) return latent[0];
  }
  return null;
}

function ltxAudioVaeLink(workflow: Workflow): [string, number] | null {
  const empty = Object.values(workflow).find((node) => node.class_type === "LTXVEmptyLatentAudio");
  return workflowLink(empty?.inputs?.audio_vae);
}

function nextWorkflowId(workflow: Workflow): string {
  let max = 0;
  for (const id of Object.keys(workflow)) {
    const value = Number(id);
    if (Number.isInteger(value) && value > max) max = value;
  }
  return String(max + 1);
}

export function patchMinimaxH3Workflow(
  workflow: Workflow,
  opts: {
    imageName: string;
    endImageName?: string | null;
    prompt: string;
    seed: number;
    frames: number;
    width: number;
    height: number;
    fps: number;
  }
): Workflow {
  const next = structuredClone(workflow);
  for (const node of Object.values(next)) {
    if (!node.inputs) continue;
    if (node.class_type === "LoadImage" && node._meta?.title === "Start image") {
      node.inputs.image = opts.imageName;
    }
    if (node.class_type === "UNETLoader") node.inputs.unet_name = H3_DIFFUSION;
    if (node.class_type === "CLIPLoader") node.inputs.clip_name = H3_TEXT_ENCODER;
    if (node.class_type === "VAELoader" && node._meta?.title === "Load video VAE") {
      node.inputs.vae_name = H3_VIDEO_VAE;
    }
    if (node.class_type === "VAELoader" && node._meta?.title === "Load audio VAE") {
      node.inputs.vae_name = H3_AUDIO_VAE;
    }
    if (node.class_type === "MiniMaxH3ImageToVideo") {
      node.inputs.prompt = opts.prompt;
      node.inputs.width = opts.width;
      node.inputs.height = opts.height;
      node.inputs.length = opts.frames;
      if (!opts.endImageName) delete node.inputs.last_frame;
    }
    if (node.class_type === "RandomNoise") node.inputs.noise_seed = opts.seed;
    if (node.class_type === "CreateVideo") node.inputs.fps = opts.fps;
  }
  if (opts.endImageName) {
    next["16"] = {
      class_type: "LoadImage",
      inputs: { image: opts.endImageName },
      _meta: { title: "End image" },
    };
    const latent = Object.values(next).find((node) => node.class_type === "MiniMaxH3ImageToVideo");
    if (latent?.inputs) latent.inputs.last_frame = ["16", 0];
  }
  return next;
}

/** Uses the clip's stored seed so a reused key would send the same seed. */
export function providerSeed(seed: number | undefined): number {
  if (seed != null && Number.isFinite(seed)) return Math.floor(Math.abs(seed)) % 1_000_000_000;
  return Math.floor(Math.random() * 1_000_000_000);
}

async function uploadComfyImage(
  base: string,
  jobId: string,
  absPath: string,
  label: string
): Promise<string> {
  const uploadUrl = `${base}/upload/image`;
  const bytes = fs.readFileSync(absPath);
  const form = new FormData();
  form.append("image", new Blob([bytes]), path.basename(absPath));
  form.append("overwrite", "true");
  let upload: Response;
  try {
    upload = await comfyFetch(uploadUrl, { method: "POST", body: form });
  } catch (err) {
    fail(jobId, netFailure(uploadUrl, err));
  }
  if (!upload.ok) {
    const body = await readErrorBody(upload);
    fail(jobId, httpFailure(uploadUrl, upload.status, body));
  }
  const uploaded = (await upload.json()) as { name?: string; subfolder?: string };
  const imageName = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
  if (!imageName) {
    fail(jobId, `ComfyUI at ${publicComfyUrl(uploadUrl)} returned HTTP 200 without a filename for the ${label}.`);
  }
  return imageName;
}

function collectFiles(value: unknown, found: ComfyFile[]) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectFiles(item, found);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.filename === "string") {
    found.push({
      filename: record.filename,
      subfolder: typeof record.subfolder === "string" ? record.subfolder : "",
      type: typeof record.type === "string" ? record.type : "output",
    });
  }
  for (const nested of Object.values(record)) collectFiles(nested, found);
}

/** GET /queue. A miss is not an error: the job still polls /history. */
async function fetchComfyQueue(base: string): Promise<unknown | null> {
  try {
    const res = await comfyFetch(`${base}/queue`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined);
      return null;
    }
    return await res.json();
  } catch {
    return null;
  }
}

function historyError(entry: { status?: { status_str?: string; messages?: unknown } }, historyUrl: string): string | null {
  const status = entry.status?.status_str;
  if (status !== "error") return null;
  const raw = JSON.stringify(entry.status?.messages ?? entry.status).slice(0, 800);
  return (
    explainComfyProblem(raw, historyUrl) ||
    `ComfyUI history status error at ${publicComfyUrl(historyUrl)}: ${raw}`
  );
}

/**
 * Queues the selected graph, polls /history, and downloads the file.
 * Shipped graphs are SVD, Wan 2.2 TI2V-5B, Wan 2.2 14B FLF2V, LTX-2.3, LTX-2.5, and MiniMax H3.
 * A custom graph is the API export named by the mapping in data/workflows.
 * Not a node editor. If the server is down, or it reports OOM or a missing node or model, the job fails.
 * FLF2V requires an end image and does not fall back to TI2V-5B.
 * A missing custom graph fails with its slug and does not fall back either.
 */
export async function runComfyuiGenerate(jobId: string): Promise<void> {
  const initial = getJob(jobId);
  if (!initial || (initial.status !== "queued" && initial.status !== "running")) return;

  const settings = getSettings();
  const planned = comfyPlanForJob(initial, settings);
  let customGraph: CustomGraph | null = null;
  if (isCustomGraphId(planned.workflow)) {
    const loaded = loadCustomGraphById(planned.workflow);
    if (!loaded.ok) fail(jobId, formatCustomGraphFailure(planned.workflow, loaded.errors));
    customGraph = loaded.graph;
    if (customGraph.map.endImage && !initial.endImagePath) {
      fail(jobId, customEndMissingMessage(customGraph.map.name, customGraph.id));
    }
  }
  const { base, source } = resolveComfyBase(settings);
  const healthUrl = `${base}/system_stats`;

  let health: Response;
  try {
    health = await comfyFetch(healthUrl, { signal: AbortSignal.timeout(8000) });
  } catch (err) {
    fail(jobId, netFailure(healthUrl, err));
  }
  if (!health.ok) {
    const body = await readErrorBody(health);
    fail(jobId, httpFailure(healthUrl, health.status, body));
  }

  if (getJob(jobId)?.status === "cancelled") return;
  const job = updateJob(jobId, { status: "running", progress: 10 });
  if (!job) throw new Error("Job not found");
  noteRunStarted(jobId);
  let progressWatch: ComfyProgressWatch | null = null;
  try {
  const duration = job.durationSec && job.durationSec > 0 ? job.durationSec : 4;
  const plan = comfyPlanForJob(job, settings);
  if (plan.workflow === "wan-flf" && !job.endImagePath) fail(jobId, WAN_FLF_MISSING_END);

  const inputAbs = resolveDataPath(job.imagePath);
  if (!fs.existsSync(inputAbs)) fail(jobId, `Image not found: ${job.imagePath}`);
  const endAbs = job.endImagePath ? resolveDataPath(job.endImagePath) : null;
  if (
    plan.workflow === "wan-flf" ||
    (plan.workflow === "minimax-h3" && job.endImagePath) ||
    (plan.workflow === "ltx25" && job.endImagePath) ||
    (customGraph?.map.endImage && job.endImagePath)
  ) {
    if (!endAbs || !fs.existsSync(endAbs)) {
      fail(jobId, `End image not found: ${job.endImagePath}`);
    }
  }

  const readiness = await checkComfyServer([plan.workflow], { base, source });
  const requestedLoras = shouldInjectLoras(plan.workflow) ? lorasForJob(job) : [];
  // Stand-in servers used in tests do not expose /object_info. A real ComfyUI does.
  // The render API refuses a 404 before a job exists. Here, 404 keeps the older path.
  if (!(readiness.httpStatus === 404 && !readiness.reachable) && readiness.blocksQueue) {
    fail(
      jobId,
      formatQueueRefusal(readiness, {
        revealUrl: true,
        closing: "The job was not left running. ComfyUI was not asked to run this graph.",
      })
    );
  }
  if (requestedLoras.length > 0 && readiness.reachable && readiness.objectInfo !== undefined) {
    const loraCheck = checkLoraFiles(readiness.objectInfo, requestedLoras);
    if (!loraCheck.ok) {
      fail(
        jobId,
        [
          ...loraCheck.missing.map((issue) => issue.nextStep),
          "The job was not left running. ComfyUI was not asked to run this graph.",
        ].join("\n")
      );
    }
  }

  const bytes = fs.readFileSync(inputAbs);
  const imageName = await uploadComfyImage(base, jobId, inputAbs, "start image");
  const sendEnd =
    (plan.workflow === "wan-flf" ||
      plan.workflow === "minimax-h3" ||
      plan.workflow === "ltx25" ||
      Boolean(customGraph?.map.endImage)) &&
    Boolean(endAbs);
  const endImageName = sendEnd && endAbs ? await uploadComfyImage(base, jobId, endAbs, "end image") : null;

  const seed = providerSeed(job.seed);
  const writeLtxAudio =
    plan.generatedAudio &&
    !(
      readiness.reachable &&
      readiness.objectInfo !== undefined &&
      !ltxAudioDecodeAvailable(readiness.objectInfo)
    );
  let workflow: Workflow;
  if (plan.workflow === "ltx25") {
    const pixels = imagePixelSize(bytes);
    const size = pixels
      ? ltx25FrameSize(pixels.width, pixels.height, plan.lowMemory)
      : ltx25FrameSize(0, 0, plan.lowMemory);
    workflow = patchLtx25Workflow(loadLtx25Workflow(), {
      imageName,
      endImageName,
      prompt: job.prompt,
      seed,
      frames: ltx25FrameCount(duration, plan.lowMemory),
      width: size.width,
      height: size.height,
      fps: LTX25_FPS,
      generatedAudio: writeLtxAudio,
    });
  } else if (plan.workflow === "ltx") {
    const pixels = imagePixelSize(bytes);
    const size = pixels
      ? ltxFrameSize(pixels.width, pixels.height, plan.lowMemory)
      : ltxFrameSize(0, 0, plan.lowMemory);
    workflow = patchLtxWorkflow(loadLtxWorkflow(), {
      imageName,
      prompt: job.prompt,
      seed,
      frames: ltxFrameCount(duration, plan.lowMemory),
      width: size.width,
      height: size.height,
      fps: LTX_FPS,
      generatedAudio: writeLtxAudio,
    });
  } else if (plan.workflow === "wan") {
    const pixels = imagePixelSize(bytes);
    const size = pixels
      ? wanFrameSize(pixels.width, pixels.height)
      : { width: WAN_MAX_WIDTH, height: WAN_MAX_HEIGHT };
    workflow = patchWanWorkflow(loadWanWorkflow(), {
      imageName,
      prompt: job.prompt,
      seed,
      frames: wanFrameCount(duration, plan.lowMemory ? WAN_LOW_MAX_FRAMES : WAN_MAX_FRAMES),
      width: size.width,
      height: size.height,
      fps: WAN_FPS,
    });
  } else if (plan.workflow === "wan-flf") {
    if (!endImageName) fail(jobId, WAN_FLF_MISSING_END);
    const pixels = imagePixelSize(bytes);
    const size = wanFlfFrameSize(pixels?.width ?? 0, pixels?.height ?? 0, plan.lowMemory);
    workflow = patchWanFlfWorkflow(loadWanFlfWorkflow(), {
      startImageName: imageName,
      endImageName,
      prompt: job.prompt,
      seed,
      frames: wanFrameCount(duration, plan.lowMemory ? WAN_LOW_MAX_FRAMES : WAN_MAX_FRAMES),
      width: size.width,
      height: size.height,
      fps: WAN_FPS,
    });
  } else if (plan.workflow === "minimax-h3") {
    const pixels = imagePixelSize(bytes);
    const size = h3FrameSize(pixels?.width ?? 0, pixels?.height ?? 0, plan.lowMemory);
    workflow = patchMinimaxH3Workflow(loadMinimaxH3Workflow(), {
      imageName,
      endImageName,
      prompt: job.prompt,
      seed,
      frames: h3FrameCount(duration, plan.lowMemory),
      width: size.width,
      height: size.height,
      fps: H3_FPS,
    });
  } else if (customGraph && isCustomGraphId(plan.workflow)) {
    const pixels = imagePixelSize(bytes);
    if (customGraph.map.endImage && !endImageName) {
      fail(jobId, customEndMissingMessage(customGraph.map.name, customGraph.id));
    }
    workflow = injectCustomWorkflow(customGraph.nodes, customGraph.map, {
      imageName,
      endImageName,
      prompt: job.prompt,
      seed,
      durationSec: duration,
      width: pixels?.width ?? 0,
      height: pixels?.height ?? 0,
      lowMemory: plan.lowMemory,
    });
  } else {
    const fps = 6;
    const frames = plan.lowMemory ? 14 : Math.max(14, Math.min(25, Math.round(duration * fps)));
    workflow = patchWorkflow(loadWorkflow(), {
      imageName,
      seed,
      frames,
      fps,
      width: plan.lowMemory ? SVD_LOW_FRAME.width : undefined,
      height: plan.lowMemory ? SVD_LOW_FRAME.height : undefined,
    });
  }

  if (requestedLoras.length > 0) workflow = injectModelLoras(workflow, requestedLoras);

  // Stand-in servers used in tests do not expose /object_info. Leave the graph alone then.
  // A real ComfyUI lists required inputs. Omitted ones fail validation, and the server does not fill defaults.
  if (readiness.reachable && readiness.objectInfo !== undefined) {
    const slots = isComfyWorkflowId(plan.workflow) ? modelSlotsFor(plan.workflow) : literalModelSlots(workflow);
    const filled = fillMissingRequiredInputs(workflow, readiness.objectInfo, slots);
    if (filled.blocked.length > 0) {
      fail(
        jobId,
        [...filled.blocked.map((issue) => issue.nextStep), "The job was not left running. ComfyUI was not asked to run this graph."].join(
          "\n"
        )
      );
    }
    workflow = filled.workflow;
  }

  const watch = startComfyProgressWatch({
    jobId,
    base,
    clientId: jobId,
    nodes: nodesFromWorkflow(workflow),
    headers: comfyAuthHeaders(),
    fetchQueue: () => fetchComfyQueue(base),
  });
  progressWatch = watch;
  await watch.ready;

  const promptUrl = `${base}/prompt`;
  let promptRes: Response;
  try {
    promptRes = await comfyFetch(promptUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: jobId }),
    });
  } catch (err) {
    fail(jobId, netFailure(promptUrl, err));
  }
  if (!promptRes.ok) {
    const body = await readErrorBody(promptRes);
    fail(jobId, httpFailure(promptUrl, promptRes.status, body));
  }
  const queued = (await promptRes.json()) as {
    prompt_id?: string;
    node_errors?: Record<string, unknown>;
    error?: unknown;
  };
  if (queued.node_errors && Object.keys(queued.node_errors).length > 0) {
    const raw = JSON.stringify(queued.node_errors).slice(0, 800);
    fail(
      jobId,
      explainComfyProblem(raw, promptUrl) ||
        `ComfyUI at ${publicComfyUrl(promptUrl)} returned HTTP 200 with node errors: ${raw}`
    );
  }
  if (queued.error) {
    const raw = JSON.stringify(queued.error).slice(0, 800);
    fail(jobId, explainComfyProblem(raw, promptUrl) || httpFailure(promptUrl, 200, raw));
  }
  if (!queued.prompt_id) {
    fail(jobId, `ComfyUI at ${publicComfyUrl(promptUrl)} returned HTTP 200 without a prompt_id.`);
  }
  updateJob(jobId, { remoteId: queued.prompt_id, progress: 25 });
  watch.setPromptId(queued.prompt_id);

  const historyUrl = `${base}/history/${queued.prompt_id}`;
  type HistoryEntry = {
    outputs?: unknown;
    status?: { status_str?: string; completed?: boolean; messages?: unknown };
  };
  let entry: HistoryEntry | null = null;

  for (let i = 0; i < MAX_POLLS; i++) {
    if (getJob(jobId)?.status === "cancelled") return;
    await watch.pollQueue();
    let hist: Response;
    try {
      hist = await comfyFetch(historyUrl, { signal: AbortSignal.timeout(8000) });
    } catch (err) {
      fail(jobId, netFailure(historyUrl, err));
    }
    if (!hist.ok) {
      const body = await readErrorBody(hist);
      fail(jobId, httpFailure(historyUrl, hist.status, body));
    }
    const data = (await hist.json()) as Record<string, HistoryEntry>;
    entry = data[queued.prompt_id] ?? null;
    if (entry) {
      const errored = historyError(entry, historyUrl);
      if (errored) fail(jobId, errored);
      if (entry.outputs && (entry.status?.completed || entry.status?.status_str === "success")) {
        break;
      }
      if (entry.outputs && !entry.status) break;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  if (!entry?.outputs) {
    fail(
      jobId,
      `ComfyUI at ${publicComfyUrl(historyUrl)} did not finish (last status: ${entry?.status?.status_str || "pending"}).`
    );
  }

  const files: ComfyFile[] = [];
  if (customGraph) {
    const outputs = entry.outputs;
    const nodeOut =
      outputs && typeof outputs === "object" && !Array.isArray(outputs)
        ? (outputs as Record<string, unknown>)[customGraph.map.output.node]
        : undefined;
    collectFiles(nodeOut, files);
  } else {
    collectFiles(entry.outputs, files);
  }
  const file =
    files.find((item) => item.filename && /\.(mp4|webm|webp|gif|mkv)$/i.test(item.filename)) ||
    files.find((item) => item.filename);
  if (!file?.filename) {
    if (customGraph) {
      fail(
        jobId,
        `Custom graph ${customGraph.id} finished, but output node ${customGraph.map.output.node} did not return a file. Star Dust does not take a file from another node.`
      );
    }
    fail(jobId, `ComfyUI at ${publicComfyUrl(historyUrl)} finished without an output file.`);
  }

  const view = new URL(`${base}/view`);
  view.searchParams.set("filename", file.filename);
  view.searchParams.set("subfolder", file.subfolder || "");
  view.searchParams.set("type", file.type || "output");
  let videoRes: Response;
  try {
    videoRes = await comfyFetch(view);
  } catch (err) {
    fail(jobId, netFailure(view.toString(), err));
  }
  if (!videoRes.ok) {
    const body = await readErrorBody(videoRes);
    fail(jobId, httpFailure(view.toString(), videoRes.status, body));
  }
  const buf = Buffer.from(await videoRes.arrayBuffer());
  const { abs, rel } = absoluteOutputPath(job.projectId, `${jobId}.mp4`);
  const ext = path.extname(file.filename).toLowerCase();
  if (ext === ".mp4") {
    fs.writeFileSync(abs, buf);
  } else {
    const temp = `${abs}.src${ext || ".bin"}`;
    fs.writeFileSync(temp, buf);
    try {
      await runFfmpeg([
        "-y",
        "-i",
        temp,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        abs,
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      fail(jobId, `Downloaded ${publicComfyUrl(view.toString())} but ffmpeg could not make an mp4: ${message}`);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  if (getJob(jobId)?.status === "cancelled") return;
  finishRenderedClip(jobId, rel.split(path.sep).join("/"));
  } finally {
    progressWatch?.stop();
    const status = getJob(jobId)?.status;
    if (status !== "queued" && status !== "running") clearJobActivity(jobId);
  }
}

const DEFAULT_OBJECT_INFO_MS = 15000;

export function objectInfoTimeoutMs(): number {
  const raw = Number(process.env.STAR_DUST_COMFY_OBJECT_INFO_MS);
  if (Number.isFinite(raw) && raw >= 200 && raw <= 120_000) return raw;
  return DEFAULT_OBJECT_INFO_MS;
}

export type ComfyObjectInfoFetch =
  | { ok: true; objectInfo: unknown; publicUrl: string }
  | {
      ok: false;
      publicUrl: string;
      status: number | null;
      timedOut: boolean;
      detail: string;
      timeoutMs: number;
    };

function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  if (name === "TimeoutError") return true;
  const message = err instanceof Error ? err.message : "";
  return /aborted due to timeout|TimeoutError/i.test(message);
}

function failureDetail(err: unknown, publicUrl: string): string {
  const cause =
    err instanceof Error ? (err as Error & { cause?: { code?: string; message?: string } }).cause : undefined;
  if (cause?.code) return cause.code;
  const message = (cause?.message || (err instanceof Error ? err.message : String(err))).split(publicUrl).join("the server");
  return message.replace(/\s+/g, " ").trim().slice(0, 180) || "request failed";
}

/** GET /object_info. Times out instead of waiting on a server that accepts and never answers. */
export async function fetchComfyObjectInfo(base: string): Promise<ComfyObjectInfoFetch> {
  const timeoutMs = objectInfoTimeoutMs();
  const root = base.replace(/\/$/, "");
  const publicUrl = publicComfyUrl(root);
  const url = `${root}/object_info`;
  try {
    const res = await comfyFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      return { ok: false, publicUrl, status: res.status, timedOut: false, detail: `HTTP ${res.status}`, timeoutMs };
    }
    try {
      const objectInfo = (await res.json()) as unknown;
      return { ok: true, objectInfo, publicUrl };
    } catch {
      return { ok: false, publicUrl, status: res.status, timedOut: false, detail: "body was not JSON", timeoutMs };
    }
  } catch (err) {
    const timedOut = isTimeoutError(err);
    const seconds = Math.max(1, Math.round(timeoutMs / 1000));
    return {
      ok: false,
      publicUrl,
      status: null,
      timedOut,
      detail: timedOut ? `${seconds}s` : failureDetail(err, publicUrl),
      timeoutMs,
    };
  }
}

function lorasForJob(job: { projectId: string; shotId?: string }): LoraRef[] {
  if (!job.shotId) return [];
  const shot = getShot(job.shotId);
  const project = getProject(job.projectId);
  if (!shot || !project) return [];
  return effectiveLoras(project, shot);
}

export async function checkComfyServer(
  ids: readonly ComfyGraphId[],
  override?: { base: string; source: ComfyCheckSource },
  loras: readonly LoraRef[] = []
): Promise<ReturnType<typeof serverCheck>> {
  const resolved = override
    ? { base: override.base.replace(/\/$/, ""), source: override.source }
    : resolveComfyBase(getSettings());
  const prepared = prepareGraphChecks(ids);
  if (ids.length > 0 && prepared.runnable.length === 0) {
    return serverCheck({
      reachable: true,
      url: publicComfyUrl(resolved.base),
      source: resolved.source,
      timedOut: false,
      httpStatus: null,
      detail: "",
      workflows: prepared.failed,
    });
  }
  const fetched = await fetchComfyObjectInfo(resolved.base);
  if (!fetched.ok) {
    return serverCheck({
      reachable: false,
      url: fetched.publicUrl,
      source: resolved.source,
      timedOut: fetched.timedOut,
      httpStatus: fetched.status,
      detail: fetched.detail,
      workflows: prepared.failed,
    });
  }
  const loraCheck = loras.length > 0 ? checkLoraFiles(fetched.objectInfo, loras) : null;
  const check = serverCheck({
    reachable: true,
    url: fetched.publicUrl,
    source: resolved.source,
    timedOut: false,
    httpStatus: null,
    detail: "",
    workflows: assessWorkflows(ids, fetched.objectInfo),
    ...(loraCheck
      ? { loraNames: loras.map((lora) => lora.name), loraIssues: loraCheck.missing }
      : {}),
  });
  check.objectInfo = fetched.objectInfo;
  return check;
}

/** Refuses a ComfyUI render before any job row is created. Empty means nothing to queue. */
export async function guardComfyWorkflows(
  ids: readonly ComfyGraphId[],
  loras: readonly LoraRef[] = []
): Promise<{ status: number; error: string } | null> {
  if (ids.length === 0 && loras.length === 0) return null;
  const report = toPublicCheck(await checkComfyServer(ids, undefined, loras));
  if (!report.blocksQueue) return null;
  return { status: 400, error: formatQueueRefusal(report) };
}

export async function probeComfyui(baseUrl: string): Promise<{
  ok: boolean;
  message: string;
  source: "env" | "settings";
  authConfigured: boolean;
}> {
  const resolved = resolveComfyBase({ comfyuiBaseUrl: baseUrl });
  const authConfigured = comfyAuthConfigured();
  const url = `${resolved.base}/system_stats`;
  const where = publicComfyUrl(url);
  const sourceLabel = resolved.source === "env" ? "COMFYUI_BASE_URL" : "the saved URL";
  try {
    const res = await comfyFetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      return {
        ok: true,
        source: resolved.source,
        authConfigured,
        message: `ComfyUI OK at ${where} (HTTP ${res.status}) via ${sourceLabel}.${
          authConfigured ? " Auth header is set." : " No auth header is set."
        }`,
      };
    }
    const body = await readErrorBody(res);
    return {
      ok: false,
      source: resolved.source,
      authConfigured,
      message: httpFailure(url, res.status, body),
    };
  } catch (err) {
    return {
      ok: false,
      source: resolved.source,
      authConfigured,
      message: netFailure(where, err),
    };
  }
}
