import fs from "fs";
import path from "path";
import { runFfmpeg } from "../ffmpeg";
import { LTX_FPS, ltxFrameCount, ltxFrameSize } from "../ltx";
import {
  COMFY_CHECKPOINT,
  LOW_MEMORY_MARK,
  LTX_CHECKPOINT,
  LTX_TEXT_ENCODER,
  WAN_DIFFUSION,
  WAN_TEXT_ENCODER,
  WAN_VAE,
  comfyWorkflowFromModelName,
} from "../provider-info";
import {
  absoluteOutputPath,
  getJob,
  getSettings,
  resolveDataPath,
  updateJob,
} from "../storage";
import { ComfyWorkflowId } from "../types";
import {
  WAN_FPS,
  WAN_LOW_MAX_FRAMES,
  WAN_MAX_FRAMES,
  WAN_MAX_HEIGHT,
  WAN_MAX_WIDTH,
  imagePixelSize,
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
    return `ComfyUI could not find a model file for this workflow at ${where}. The README lists the filenames for SVD, Wan 2.2 TI2V-5B, and LTX-2.3. Star Dust does not download weights. The job was not left running. Server said: ${text}`;
  }
  if (/does not exist|missing node|unknown node|node type|class_type|custom node/.test(lower)) {
    return `ComfyUI is missing a node for this workflow at ${where}. SVD, Wan 2.2, and the shipped LTX-2.3 graph use core nodes from a current ComfyUI. Optional GGUF loading needs the ComfyUI-GGUF custom node, which the shipped graph does not use. The job was not left running. Server said: ${text}`;
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

export function loadLtxWorkflow(): Workflow {
  const file = path.join(process.cwd(), "workflows", "comfyui-ltx23-i2v.api.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as Workflow;
}

export function comfyPlanForJob(
  job: { modelName?: string },
  settings: { comfyuiWorkflow: ComfyWorkflowId; comfyLowMemory?: boolean }
): { workflow: ComfyWorkflowId; lowMemory: boolean } {
  const named = comfyWorkflowFromModelName(job.modelName);
  const workflow = named ?? settings.comfyuiWorkflow;
  const lowMemory = job.modelName
    ? job.modelName.includes(LOW_MEMORY_MARK)
    : Boolean(settings.comfyLowMemory);
  return { workflow, lowMemory };
}

export function comfyWorkflowForJob(
  job: { modelName?: string },
  settings: { comfyuiWorkflow: ComfyWorkflowId; comfyLowMemory?: boolean }
): ComfyWorkflowId {
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
  return next;
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
 * Queues the selected shipped workflow (SVD, Wan 2.2 TI2V-5B, or LTX-2.3), polls /history, downloads the file.
 * Not a node editor. If the server is down, or it reports OOM or a missing node or model, the job fails.
 */
export async function runComfyuiGenerate(jobId: string): Promise<void> {
  const initial = getJob(jobId);
  if (!initial || (initial.status !== "queued" && initial.status !== "running")) return;

  const settings = getSettings();
  const { base } = resolveComfyBase(settings);
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

  const inputAbs = resolveDataPath(job.imagePath);
  if (!fs.existsSync(inputAbs)) fail(jobId, `Image not found: ${job.imagePath}`);

  const uploadUrl = `${base}/upload/image`;
  const bytes = fs.readFileSync(inputAbs);
  const form = new FormData();
  form.append("image", new Blob([bytes]), path.basename(inputAbs));
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
  const imageName = uploaded.subfolder
    ? `${uploaded.subfolder}/${uploaded.name}`
    : uploaded.name;
  if (!imageName) fail(jobId, `ComfyUI at ${publicComfyUrl(uploadUrl)} returned HTTP 200 without a filename.`);

  const duration = job.durationSec && job.durationSec > 0 ? job.durationSec : 4;
  const plan = comfyPlanForJob(job, settings);
  const seed = Math.floor(Math.random() * 1_000_000_000);
  let workflow: Workflow;
  if (plan.workflow === "ltx") {
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
  } else {
    const fps = 6;
    const frames = plan.lowMemory ? 14 : Math.max(14, Math.min(25, Math.round(duration * fps)));
    workflow = patchWorkflow(loadWorkflow(), {
      imageName,
      seed,
      frames,
      fps,
      width: plan.lowMemory ? 768 : undefined,
      height: plan.lowMemory ? 448 : undefined,
    });
  }

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

  const historyUrl = `${base}/history/${queued.prompt_id}`;
  type HistoryEntry = {
    outputs?: unknown;
    status?: { status_str?: string; completed?: boolean; messages?: unknown };
  };
  let entry: HistoryEntry | null = null;

  for (let i = 0; i < MAX_POLLS; i++) {
    if (getJob(jobId)?.status === "cancelled") return;
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
    updateJob(jobId, { progress: Math.min(85, 30 + Math.floor(i / 2)) });
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  if (!entry?.outputs) {
    fail(
      jobId,
      `ComfyUI at ${publicComfyUrl(historyUrl)} did not finish (last status: ${entry?.status?.status_str || "pending"}).`
    );
  }

  const files: ComfyFile[] = [];
  collectFiles(entry.outputs, files);
  const file =
    files.find((item) => item.filename && /\.(mp4|webm|webp|gif|mkv)$/i.test(item.filename)) ||
    files.find((item) => item.filename);
  if (!file?.filename) {
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
  updateJob(jobId, {
    status: "completed",
    progress: 100,
    outputPath: rel.split(path.sep).join("/"),
    error: undefined,
  });
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
