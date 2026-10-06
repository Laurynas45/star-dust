import fs from "fs";
import path from "path";
import { runFfmpeg } from "../ffmpeg";
import {
  COMFY_CHECKPOINT,
  WAN_DIFFUSION,
  WAN_TEXT_ENCODER,
  WAN_VAE,
} from "../provider-info";
import {
  absoluteOutputPath,
  getJob,
  getSettings,
  resolveDataPath,
  updateJob,
} from "../storage";
import { ComfyWorkflowId } from "../types";
import { WAN_FPS, WAN_MAX_HEIGHT, WAN_MAX_WIDTH, imagePixelSize, wanFrameCount, wanFrameSize } from "../wan";

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

function netFailure(url: string, err: unknown): string {
  const cause = err instanceof Error ? (err as Error & { cause?: { code?: string; message?: string } }).cause : undefined;
  const code = cause?.code || "";
  const detail = cause?.message || (err instanceof Error ? err.message : String(err));
  const status = code || detail;
  return `ComfyUI unreachable at ${url} (${status}).`;
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 800);
  } catch {
    return "";
  }
}

export function loadWorkflow(): Workflow {
  const file = path.join(process.cwd(), "workflows", "comfyui-svd-i2v.api.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as Workflow;
}

export function loadWanWorkflow(): Workflow {
  const file = path.join(process.cwd(), "workflows", "comfyui-wan22-ti2v-5b.api.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as Workflow;
}

export function comfyWorkflowForJob(
  job: { modelName?: string },
  settings: { comfyuiWorkflow: ComfyWorkflowId }
): ComfyWorkflowId {
  if (job.modelName?.includes("Wan 2.2")) return "wan";
  if (job.modelName?.includes("SVD")) return "svd";
  return settings.comfyuiWorkflow === "wan" ? "wan" : "svd";
}

export function patchWorkflow(
  workflow: Workflow,
  opts: { imageName: string; seed: number; frames: number; fps: number }
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

function historyError(entry: { status?: { status_str?: string; messages?: unknown } }): string | null {
  const status = entry.status?.status_str;
  if (status !== "error") return null;
  const messages = entry.status?.messages;
  return `ComfyUI history status error: ${JSON.stringify(messages).slice(0, 800)}`;
}

/**
 * Queues the selected shipped workflow (SVD or Wan 2.2 TI2V-5B), polls /history, downloads the file.
 * Not a node editor. If the server is down, the job fails with the URL and status.
 */
export async function runComfyuiGenerate(jobId: string): Promise<void> {
  const initial = getJob(jobId);
  if (!initial || (initial.status !== "queued" && initial.status !== "running")) return;

  const settings = getSettings();
  const base = (settings.comfyuiBaseUrl || "http://127.0.0.1:8188").replace(/\/$/, "");
  const healthUrl = `${base}/system_stats`;

  let health: Response;
  try {
    health = await fetch(healthUrl, { signal: AbortSignal.timeout(8000) });
  } catch (err) {
    fail(jobId, netFailure(healthUrl, err));
  }
  if (!health.ok) {
    const body = await readErrorBody(health);
    fail(
      jobId,
      `ComfyUI at ${healthUrl} returned HTTP ${health.status}.${body ? ` ${body}` : ""}`
    );
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
    upload = await fetch(uploadUrl, { method: "POST", body: form });
  } catch (err) {
    fail(jobId, netFailure(uploadUrl, err));
  }
  if (!upload.ok) {
    const body = await readErrorBody(upload);
    fail(jobId, `ComfyUI at ${uploadUrl} returned HTTP ${upload.status}. ${body}`);
  }
  const uploaded = (await upload.json()) as { name?: string; subfolder?: string };
  const imageName = uploaded.subfolder
    ? `${uploaded.subfolder}/${uploaded.name}`
    : uploaded.name;
  if (!imageName) fail(jobId, `ComfyUI at ${uploadUrl} returned HTTP 200 without a filename.`);

  const duration = job.durationSec && job.durationSec > 0 ? job.durationSec : 4;
  const workflowId = comfyWorkflowForJob(job, settings);
  let workflow: Workflow;
  if (workflowId === "wan") {
    const pixels = imagePixelSize(bytes);
    const size = pixels
      ? wanFrameSize(pixels.width, pixels.height)
      : { width: WAN_MAX_WIDTH, height: WAN_MAX_HEIGHT };
    workflow = patchWanWorkflow(loadWanWorkflow(), {
      imageName,
      prompt: job.prompt,
      seed: Math.floor(Math.random() * 1_000_000_000),
      frames: wanFrameCount(duration),
      width: size.width,
      height: size.height,
      fps: WAN_FPS,
    });
  } else {
    const fps = 6;
    const frames = Math.max(14, Math.min(25, Math.round(duration * fps)));
    workflow = patchWorkflow(loadWorkflow(), {
      imageName,
      seed: Math.floor(Math.random() * 1_000_000_000),
      frames,
      fps,
    });
  }

  const promptUrl = `${base}/prompt`;
  let promptRes: Response;
  try {
    promptRes = await fetch(promptUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: jobId }),
    });
  } catch (err) {
    fail(jobId, netFailure(promptUrl, err));
  }
  if (!promptRes.ok) {
    const body = await readErrorBody(promptRes);
    fail(jobId, `ComfyUI at ${promptUrl} returned HTTP ${promptRes.status}. ${body}`);
  }
  const queued = (await promptRes.json()) as {
    prompt_id?: string;
    node_errors?: Record<string, unknown>;
  };
  if (queued.node_errors && Object.keys(queued.node_errors).length > 0) {
    fail(
      jobId,
      `ComfyUI at ${promptUrl} returned HTTP 200 with node errors: ${JSON.stringify(queued.node_errors).slice(0, 800)}`
    );
  }
  if (!queued.prompt_id) {
    fail(jobId, `ComfyUI at ${promptUrl} returned HTTP 200 without a prompt_id.`);
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
      hist = await fetch(historyUrl, { signal: AbortSignal.timeout(8000) });
    } catch (err) {
      fail(jobId, netFailure(historyUrl, err));
    }
    if (!hist.ok) {
      const body = await readErrorBody(hist);
      fail(jobId, `ComfyUI at ${historyUrl} returned HTTP ${hist.status}. ${body}`);
    }
    const data = (await hist.json()) as Record<string, HistoryEntry>;
    entry = data[queued.prompt_id] ?? null;
    if (entry) {
      const errored = historyError(entry);
      if (errored) fail(jobId, `${errored} URL ${historyUrl}.`);
      if (entry.outputs && (entry.status?.completed || entry.status?.status_str === "success")) {
        break;
      }
      if (entry.outputs && !entry.status) break;
    }
    updateJob(jobId, { progress: Math.min(85, 30 + Math.floor(i / 2)) });
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  if (!entry?.outputs) {
    fail(jobId, `ComfyUI at ${historyUrl} did not finish (last status: ${entry?.status?.status_str || "pending"}).`);
  }

  const files: ComfyFile[] = [];
  collectFiles(entry.outputs, files);
  const file =
    files.find((item) => item.filename && /\.(mp4|webm|webp|gif|mkv)$/i.test(item.filename)) ||
    files.find((item) => item.filename);
  if (!file?.filename) {
    fail(jobId, `ComfyUI at ${historyUrl} finished without an output file.`);
  }

  const view = new URL(`${base}/view`);
  view.searchParams.set("filename", file.filename);
  view.searchParams.set("subfolder", file.subfolder || "");
  view.searchParams.set("type", file.type || "output");
  let videoRes: Response;
  try {
    videoRes = await fetch(view);
  } catch (err) {
    fail(jobId, netFailure(view.toString(), err));
  }
  if (!videoRes.ok) {
    const body = await readErrorBody(videoRes);
    fail(jobId, `ComfyUI at ${view.toString()} returned HTTP ${videoRes.status}. ${body}`);
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
      fail(jobId, `Downloaded ${view.toString()} but ffmpeg could not make an mp4: ${message}`);
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

export async function probeComfyui(baseUrl: string): Promise<{ ok: boolean; message: string }> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/system_stats`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) return { ok: true, message: `ComfyUI OK at ${url} (HTTP ${res.status})` };
    return { ok: false, message: `ComfyUI at ${url} returned HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, message: netFailure(url, err) };
  }
}
