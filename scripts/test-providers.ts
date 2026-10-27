import { spawnSync } from "child_process";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "star-dust-test-"));
process.env.STAR_DUST_DATA = dataDir;
delete process.env.FAL_KEY;
delete process.env.REPLICATE_API_TOKEN;
delete process.env.STAR_DUST_LICENSE_KEY;
delete process.env.STAR_DUST_CREDITS_PER_SECOND;
for (const key of Object.keys(process.env)) {
  if (key.startsWith("STRIPE_") || key.startsWith("PAYPAL_")) delete process.env[key];
}
delete process.env.COMFYUI_BASE_URL;
delete process.env.COMFYUI_AUTH_HEADER;
delete process.env.COMFYUI_AUTH_HEADER_NAME;

function assert(cond: unknown, message: string) {
  if (!cond) throw new Error(message);
}

function solidPng(dir: string, name: string, color: string): Buffer {
  const file = path.join(dir, name);
  const made = spawnSync(
    "ffmpeg",
    ["-y", "-f", "lavfi", "-i", `color=c=${color}:s=320x180`, "-frames:v", "1", file],
    { encoding: "utf8" }
  );
  if (made.status !== 0) throw new Error(made.stderr || `could not make ${color} still`);
  return fs.readFileSync(file);
}

function averageRgb(file: string): { r: number; g: number; b: number } {
  const probe = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-frames:v", "1", "-"]
  );
  const bytes = probe.stdout;
  if (probe.status !== 0 || !Buffer.isBuffer(bytes) || bytes.length < 3) {
    throw new Error(probe.stderr?.toString() || "color probe failed");
  }
  return { r: bytes[0], g: bytes[1], b: bytes[2] };
}

function isRed(color: { r: number; g: number; b: number }): boolean {
  return color.r > 180 && color.g < 80 && color.b < 80;
}

function isBlue(color: { r: number; g: number; b: number }): boolean {
  return color.b > 180 && color.r < 80 && color.g < 80;
}

function isGreen(color: { r: number; g: number; b: number }): boolean {
  return color.g > 180 && color.r < 80 && color.b < 80;
}

function mediaDuration(file: string): number {
  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ],
    { encoding: "utf8" }
  );
  const value = Number(String(probe.stdout).trim());
  if (probe.status !== 0 || !Number.isFinite(value)) {
    throw new Error(probe.stderr || "duration probe failed");
  }
  return value;
}

let probeSeq = 0;

function runFfmpegSync(args: string[]) {
  const made = spawnSync("ffmpeg", args, { encoding: "utf8" });
  if (made.status !== 0) throw new Error(made.stderr || "ffmpeg failed");
}

function hasAudioStream(file: string): boolean {
  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", file],
    { encoding: "utf8" }
  );
  return String(probe.stdout).includes("audio");
}

function videoRate(file: string): number {
  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=r_frame_rate",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ],
    { encoding: "utf8" }
  );
  const [num, den] = String(probe.stdout).trim().split("/").map(Number);
  if (!Number.isFinite(num) || num <= 0) throw new Error(probe.stderr || "fps probe failed");
  return den ? num / den : num;
}

function integratedLufs(file: string): number {
  const probe = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-i", file, "-af", "loudnorm=print_format=json", "-f", "null", "-"],
    { encoding: "utf8" }
  );
  const text = String(probe.stderr);
  const start = text.lastIndexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(text.slice(-400) || "loudness probe failed");
  const parsed = JSON.parse(text.slice(start, end + 1)) as { input_i?: string };
  const value = Number(parsed.input_i);
  if (!Number.isFinite(value)) throw new Error(`loudness ${parsed.input_i}`);
  return value;
}

function frameCountOf(file: string): number {
  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-count_frames",
      "-show_entries",
      "stream=nb_read_frames",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ],
    { encoding: "utf8" }
  );
  const value = Number(String(probe.stdout).trim());
  if (probe.status !== 0 || !Number.isFinite(value)) {
    throw new Error(probe.stderr || "frame count failed");
  }
  return value;
}

function frameRgbAt(file: string, index: number): { r: number; g: number; b: number } {
  const png = path.join(dataDir, `probe-${process.pid}-${probeSeq++}.png`);
  runFfmpegSync(["-y", "-i", file, "-vf", `select=eq(n\\,${index})`, "-frames:v", "1", png]);
  try {
    return averageRgb(png);
  } finally {
    fs.rmSync(png, { force: true });
  }
}

function concatColors(file: string, parts: { color: string; frames: number }[]) {
  const dir = fs.mkdtempSync(path.join(dataDir, "segs-"));
  const list = path.join(dir, "list.txt");
  const lines = parts.map((part, index) => {
    const seg = path.join(dir, `seg-${index}.mp4`);
    runFfmpegSync([
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${part.color}:s=160x90:r=24`,
      "-frames:v",
      String(part.frames),
      "-c:v",
      "libx264",
      "-qp",
      "0",
      "-pix_fmt",
      "yuv420p",
      seg,
    ]);
    return `file '${seg.replace(/'/g, "'\\''")}'`;
  });
  fs.writeFileSync(list, lines.join("\n"));
  runFfmpegSync([
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-c:v",
    "libx264",
    "-qp",
    "0",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "24",
    file,
  ]);
}

function firstFrameRgb(file: string): { r: number; g: number; b: number } {
  const png = path.join(path.dirname(file), `frame-${process.pid}-${Date.now()}.png`);
  const made = spawnSync("ffmpeg", ["-y", "-i", file, "-frames:v", "1", png], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(made.stderr || "could not read the first frame");
  try {
    return averageRgb(png);
  } finally {
    fs.rmSync(png, { force: true });
  }
}

function tinyMp4(): string {
  const file = path.join(dataDir, "tiny.mp4");
  const probe = spawnSync(
    "ffmpeg",
    ["-y", "-f", "lavfi", "-i", "color=c=black:s=160x90:d=0.2", "-c:v", "libx264", "-pix_fmt", "yuv420p", file],
    { encoding: "utf8" }
  );
  if (probe.status !== 0) throw new Error(probe.stderr || "could not make tiny mp4");
  return file;
}

function listen(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function main() {
  const safety = await import("../src/lib/safety");
  const storage = await import("../src/lib/storage");
  const uploads = await import("../src/lib/uploads");
  const render = await import("../src/lib/render");
  const fal = await import("../src/lib/providers/fal");
  const replicate = await import("../src/lib/providers/replicate");
  const comfy = await import("../src/lib/providers/comfyui");
  const mock = await import("../src/lib/providers/mock");
  const stitch = await import("../src/lib/stitch");
  const providers = await import("../src/lib/providers");
  const { SAMPLE_PROJECT_ID } = await import("../src/lib/types");

  assert(!safety.isDisallowedMinorSexualContent("a child flying a kite at dusk"), "innocent child scene");
  assert(!safety.isDisallowedMinorSexualContent("Slow push toward the lanterns"), "sample prompt");
  assert(safety.isDisallowedMinorSexualContent("nude child on a beach"), "sexual minor");
  assert(safety.isDisallowedMinorSexualContent("loli"), "inherent term");
  assert(!safety.generationIsRefused("two adults dancing in the rain", ["harbor.png"]), "adult scene");

  storage.listProjects();
  const samplePng = fs.readFileSync(path.join(process.cwd(), "samples", "harbor-dusk.png"));
  const before = fs.readdirSync(path.join(dataDir, "uploads"), { recursive: true }).map(String);
  const refused = uploads.storeImageIfAllowed({
    projectId: SAMPLE_PROJECT_ID,
    prompt: "nude child",
    filename: "should-not-exist.png",
    buffer: samplePng,
  });
  assert(!refused.ok && refused.refused, "refusal flag");
  const after = fs.readdirSync(path.join(dataDir, "uploads"), { recursive: true }).map(String);
  assert(before.length === after.length, "refused image was stored");
  assert(!after.some((name) => name.includes("should-not-exist")), "refused filename landed on disk");

  storage.saveSettings({ provider: "fal" });
  const shot = storage.listShots(SAMPLE_PROJECT_ID)[0];
  const missingFal = render.renderShot(shot.id, { acknowledgeModel: storage.getSettings().falModel });
  assert(!missingFal.ok && missingFal.error.includes("FAL_KEY"), "fal key named before queue");
  assert(storage.listJobs(SAMPLE_PROJECT_ID).every((job) => job.status !== "running"), "fal not running");

  storage.saveSettings({ provider: "replicate" });
  const missingRep = render.renderShot(shot.id, {
    acknowledgeModel: storage.getSettings().replicateModel,
  });
  assert(!missingRep.ok && missingRep.error.includes("REPLICATE_API_TOKEN"), "replicate token named");

  storage.saveSettings({ provider: "fal" });
  const needsAck = render.renderShot(shot.id);
  assert(!needsAck.ok && needsAck.needsModelAck && needsAck.priceAvailable === false, "model ack");
  assert(typeof needsAck.modelName === "string" && needsAck.modelName.length > 0, "model name");
  assert(!needsAck.error.match(/\$\d/), "no invented price");

  const queuedFal = storage.createJob({
    projectId: SAMPLE_PROJECT_ID,
    shotId: shot.id,
    prompt: shot.prompt,
    presetId: shot.presetId,
    provider: "fal",
    imagePath: shot.startImagePath!,
    modelName: "fal-ai/minimax/video-01/image-to-video",
    durationSec: 2,
    status: "queued",
  });
  await fal.runFalGenerate(queuedFal.id).catch(() => undefined);
  const falJob = storage.getJob(queuedFal.id);
  assert(falJob?.status === "failed" && falJob.error?.includes("FAL_KEY"), "provider fails before running");
  assert((falJob?.progress ?? 0) === 0, "fal progress stayed 0");

  const queuedRep = storage.createJob({
    projectId: SAMPLE_PROJECT_ID,
    shotId: shot.id,
    prompt: shot.prompt,
    presetId: shot.presetId,
    provider: "replicate",
    imagePath: shot.startImagePath!,
    status: "queued",
  });
  await replicate.runReplicateGenerate(queuedRep.id).catch(() => undefined);
  const repJob = storage.getJob(queuedRep.id);
  assert(repJob?.status === "failed" && repJob.error?.includes("REPLICATE_API_TOKEN"), "replicate guard");

  const closed = http.createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", () => resolve()));
  const closedAddr = closed.address();
  const closedPort = typeof closedAddr === "object" && closedAddr ? closedAddr.port : 0;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  const closedUrl = `http://127.0.0.1:${closedPort}`;
  storage.saveSettings({ provider: "comfyui", comfyuiBaseUrl: closedUrl });
  const down = storage.createJob({
    projectId: SAMPLE_PROJECT_ID,
    shotId: shot.id,
    prompt: shot.prompt,
    presetId: shot.presetId,
    provider: "comfyui",
    imagePath: shot.startImagePath!,
    status: "queued",
  });
  await comfy.runComfyuiGenerate(down.id).catch(() => undefined);
  const downJob = storage.getJob(down.id);
  assert(downJob?.status === "failed", "comfy down fails");
  assert(downJob?.error?.includes(closedUrl), `comfy down URL: ${downJob?.error}`);
  assert(/ECONNREFUSED|fetch failed|connect/i.test(downJob?.error || ""), "comfy down status");
  assert(downJob?.status !== "running", "comfy down not running");

  const refusedServer = await listen((_req, res) => {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("unavailable");
  });
  storage.saveSettings({ comfyuiBaseUrl: refusedServer.url });
  const httpJob = storage.createJob({
    projectId: SAMPLE_PROJECT_ID,
    shotId: shot.id,
    prompt: shot.prompt,
    presetId: shot.presetId,
    provider: "comfyui",
    imagePath: shot.startImagePath!,
    status: "queued",
  });
  await comfy.runComfyuiGenerate(httpJob.id).catch(() => undefined);
  const httpFailed = storage.getJob(httpJob.id);
  assert(httpFailed?.error?.includes(refusedServer.url) && httpFailed.error.includes("503"), "HTTP status");
  await refusedServer.close();

  const mp4 = fs.readFileSync(tinyMp4());
  let sawPrompt = false;
  let postedWorkflow = "";
  const standin = await listen((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/system_stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/upload/image") {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ name: "start.png", subfolder: "", type: "input" }));
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/prompt") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        postedWorkflow = body;
        const parsed = JSON.parse(body) as { prompt?: Record<string, { class_type?: string; inputs?: { image?: string } }> };
        sawPrompt = Object.values(parsed.prompt || {}).some(
          (node) => node.class_type === "LoadImage" && node.inputs?.image === "start.png"
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ prompt_id: "standin-1", node_errors: {} }));
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/history/standin-1") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          "standin-1": {
            status: { status_str: "success", completed: true },
            outputs: {
              "7": { images: [{ filename: "star-dust.mp4", subfolder: "", type: "output" }] },
            },
          },
        })
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/view") {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      res.end(mp4);
      return;
    }
    res.writeHead(404);
    res.end("missing");
  });

  storage.saveSettings({ comfyuiBaseUrl: standin.url });
  const okJob = storage.createJob({
    projectId: SAMPLE_PROJECT_ID,
    shotId: shot.id,
    prompt: shot.prompt,
    presetId: shot.presetId,
    provider: "comfyui",
    imagePath: shot.startImagePath!,
    durationSec: 2,
    status: "queued",
  });
  await comfy.runComfyuiGenerate(okJob.id);
  const done = storage.getJob(okJob.id);
  assert(sawPrompt, "workflow posted with LoadImage");
  assert(postedWorkflow.includes("SVD_img2vid_Conditioning"), "svd graph posted");
  assert(!postedWorkflow.includes(shot.prompt), "svd graph does not include the prompt");
  assert(done?.status === "completed" && done.outputPath, "comfy stand-in completed");
  const downloaded = storage.resolveDataPath(done!.outputPath!);
  assert(fs.statSync(downloaded).size === mp4.length, "downloaded mp4 bytes");
  await standin.close();

  const wan = await import("../src/lib/wan");
  const info = await import("../src/lib/provider-info");
  const pixels = wan.imagePixelSize(fs.readFileSync(storage.resolveDataPath(shot.startImagePath!)));
  assert(pixels && pixels.width > 0 && pixels.height > 0, "start image size");
  const expectedSize = wan.wanFrameSize(pixels!.width, pixels!.height);
  const expectedFrames = wan.wanFrameCount(shot.durationSec || 4);
  let wanBody = "";
  const wanStandin = await listen((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/system_stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/upload/image") {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ name: "wan-start.png", subfolder: "", type: "input" }));
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/prompt") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        wanBody = body;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ prompt_id: "standin-wan", node_errors: {} }));
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/history/standin-wan") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          "standin-wan": {
            status: { status_str: "success", completed: true },
            outputs: {
              "11": { images: [{ filename: "wan.mp4", subfolder: "", type: "output" }] },
            },
          },
        })
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/view") {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      res.end(mp4);
      return;
    }
    res.writeHead(404);
    res.end("missing");
  });
  storage.saveSettings({ provider: "comfyui", comfyuiBaseUrl: wanStandin.url, comfyuiWorkflow: "wan" });
  const wanDescribed = info.describeProviderUse({
    provider: "comfyui",
    settings: storage.getSettings(),
    hasCharacterSheet: false,
    hasEndImage: false,
  });
  assert(!/does not read the text prompt|ignores the prompt/i.test(wanDescribed.providerNote), "wan note reads the prompt");
  assert(/reads the text prompt/i.test(wanDescribed.providerNote), "wan note says it reads the prompt");
  assert(!/character lock|lip-sync|long-form/i.test(wanDescribed.providerNote), "wan note makes no extra claims");
  const wanJob = storage.createJob({
    projectId: SAMPLE_PROJECT_ID,
    shotId: shot.id,
    prompt: shot.prompt,
    presetId: shot.presetId,
    provider: "comfyui",
    imagePath: shot.startImagePath!,
    durationSec: shot.durationSec,
    modelName: wanDescribed.modelName,
    providerNote: wanDescribed.providerNote,
    status: "queued",
  });
  await comfy.runComfyuiGenerate(wanJob.id);
  const wanDone = storage.getJob(wanJob.id);
  assert(wanDone?.status === "completed", `wan stand-in completed: ${wanDone?.error}`);
  const wanPosted = JSON.parse(wanBody) as {
    prompt?: Record<string, { class_type?: string; inputs?: Record<string, unknown>; _meta?: { title?: string } }>;
  };
  const wanNodes = Object.values(wanPosted.prompt || {});
  assert(
    wanNodes.some((node) => node.class_type === "LoadImage" && node.inputs?.image === "wan-start.png"),
    "wan injects the start image"
  );
  assert(
    wanNodes.some(
      (node) =>
        node.class_type === "CLIPTextEncode" &&
        node._meta?.title === "Positive prompt" &&
        node.inputs?.text === shot.prompt
    ),
    "wan injects the prompt"
  );
  const latent = wanNodes.find((node) => node.class_type === "Wan22ImageToVideoLatent");
  assert(latent?.inputs?.length === expectedFrames, `wan frame count ${latent?.inputs?.length} != ${expectedFrames}`);
  assert(latent?.inputs?.width === expectedSize.width, "wan width");
  assert(latent?.inputs?.height === expectedSize.height, "wan height");
  assert(
    wanNodes.some((node) => node.class_type === "UNETLoader" && node.inputs?.unet_name === "wan2.2_ti2v_5B_fp16.safetensors"),
    "wan diffusion file"
  );
  await wanStandin.close();

  const flfSize = wan.wanFlfFrameSize(pixels!.width, pixels!.height, false);
  const flfFrames = wan.wanFrameCount(shot.durationSec || 4);
  let flfUploads = 0;
  let flfPrompts = 0;
  let flfBody = "";
  const flfStandin = await listen((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/system_stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/upload/image") {
      req.resume();
      req.on("end", () => {
        flfUploads += 1;
        const name = flfUploads === 1 ? "flf-start.png" : "flf-end.png";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ name, subfolder: "", type: "input" }));
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/prompt") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        flfPrompts += 1;
        flfBody = body;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ prompt_id: "standin-flf", node_errors: {} }));
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/history/standin-flf") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          "standin-flf": {
            status: { status_str: "success", completed: true },
            outputs: {
              "16": { images: [{ filename: "flf.mp4", subfolder: "", type: "output" }] },
            },
          },
        })
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/view") {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      res.end(mp4);
      return;
    }
    res.writeHead(404);
    res.end("missing");
  });
  storage.saveSettings({
    provider: "comfyui",
    comfyuiBaseUrl: flfStandin.url,
    comfyuiWorkflow: "wan-flf",
  });
  const flfMissing = info.describeProviderUse({
    provider: "comfyui",
    settings: storage.getSettings(),
    hasCharacterSheet: false,
    hasEndImage: false,
    comfy: { workflow: "wan-flf", lowMemory: false },
  });
  assert(/does not switch this graph to TI2V-5B/.test(flfMissing.providerNote), "flf missing-end note");
  assert(!/character lock/i.test(flfMissing.providerNote), "flf missing-end note makes no lock claim");
  const flfRefused = render.renderShot(shot.id, { force: true });
  assert(!flfRefused.ok && flfRefused.status === 400, "flf render refuses a shot with no end still");
  assert(
    !flfRefused.ok && /does not switch this graph to TI2V-5B/.test(flfRefused.error),
    "flf render error names the missing end"
  );
  const missingJob = storage.createJob({
    projectId: SAMPLE_PROJECT_ID,
    shotId: shot.id,
    prompt: shot.prompt,
    presetId: shot.presetId,
    provider: "comfyui",
    imagePath: shot.startImagePath!,
    durationSec: shot.durationSec,
    modelName: info.WAN_FLF_MODEL_NAME,
    status: "queued",
  });
  let missingThrew = false;
  try {
    await comfy.runComfyuiGenerate(missingJob.id);
  } catch {
    missingThrew = true;
  }
  const flfMissingDone = storage.getJob(missingJob.id);
  assert(missingThrew, "flf missing end throws");
  assert(flfMissingDone?.status === "failed", "flf missing end fails the job");
  assert(/does not switch this graph to TI2V-5B/.test(flfMissingDone?.error || ""), "flf missing end error");
  assert(flfPrompts === 0 && flfUploads === 0, "flf missing end does not post a graph");
  const ti2vWithEnd = info.describeProviderUse({
    provider: "comfyui",
    settings: storage.getSettings(),
    hasCharacterSheet: false,
    hasEndImage: true,
    comfy: { workflow: "wan", lowMemory: false },
  });
  assert(/end image was not sent/i.test(ti2vWithEnd.providerNote), "ti2v still ignores the end image");
  const flfDescribed = info.describeProviderUse({
    provider: "comfyui",
    settings: storage.getSettings(),
    hasCharacterSheet: false,
    hasEndImage: true,
    comfy: { workflow: "wan-flf", lowMemory: false },
  });
  assert(/start image, the end image/.test(flfDescribed.providerNote), "flf note sends both stills");
  assert(/not a character lock/i.test(flfDescribed.providerNote), "flf note is not a character lock");
  assert(/identity can still drift/i.test(flfDescribed.providerNote), "flf note says identity can drift");
  assert(/one short clip/i.test(flfDescribed.providerNote), "flf note keeps one clip as the unit");
  assert(!/lip-sync|long film|face lock/i.test(flfDescribed.providerNote), "flf note makes no extra claims");
  const flfJob = storage.createJob({
    projectId: SAMPLE_PROJECT_ID,
    shotId: shot.id,
    prompt: shot.prompt,
    presetId: shot.presetId,
    provider: "comfyui",
    imagePath: shot.startImagePath!,
    endImagePath: shot.startImagePath,
    durationSec: shot.durationSec,
    modelName: flfDescribed.modelName,
    providerNote: flfDescribed.providerNote,
    status: "queued",
  });
  await comfy.runComfyuiGenerate(flfJob.id);
  const flfDone = storage.getJob(flfJob.id);
  assert(flfDone?.status === "completed", `flf stand-in completed: ${flfDone?.error}`);
  assert(flfPrompts === 1 && flfUploads === 2, "flf uploads both stills and posts once");
  const flfPosted = JSON.parse(flfBody) as {
    prompt?: Record<string, { class_type?: string; inputs?: Record<string, unknown>; _meta?: { title?: string } }>;
  };
  const flfNodes = Object.values(flfPosted.prompt || {});
  assert(
    flfNodes.some(
      (node) =>
        node.class_type === "LoadImage" &&
        node._meta?.title === "Start image" &&
        node.inputs?.image === "flf-start.png"
    ),
    "flf injects the start image"
  );
  assert(
    flfNodes.some(
      (node) =>
        node.class_type === "LoadImage" &&
        node._meta?.title === "End image" &&
        node.inputs?.image === "flf-end.png"
    ),
    "flf injects the end image"
  );
  const flfLatent = flfNodes.find((node) => node.class_type === "WanFirstLastFrameToVideo");
  assert(flfLatent?.inputs?.length === flfFrames, `flf frame count ${flfLatent?.inputs?.length} != ${flfFrames}`);
  assert(flfLatent?.inputs?.width === flfSize.width, "flf width");
  assert(flfLatent?.inputs?.height === flfSize.height, "flf height");
  assert(
    flfNodes.some(
      (node) =>
        node.class_type === "CLIPTextEncode" &&
        node._meta?.title === "Positive prompt" &&
        node.inputs?.text === shot.prompt
    ),
    "flf injects the prompt"
  );
  assert(
    flfNodes.some(
      (node) => node.class_type === "UNETLoader" && node.inputs?.unet_name === info.WAN_FLF_HIGH_NOISE
    ),
    "flf high-noise file"
  );
  assert(
    flfNodes.some(
      (node) => node.class_type === "UNETLoader" && node.inputs?.unet_name === info.WAN_FLF_LOW_NOISE
    ),
    "flf low-noise file"
  );
  assert(!flfNodes.some((node) => node.class_type === "Wan22ImageToVideoLatent"), "flf does not post the TI2V latent");
  assert(!flfNodes.some((node) => node.class_type === "LoraLoaderModelOnly"), "flf does not load the lightx2v lora");
  assert(!/gguf|svi2pro|minimax|freevideo/i.test(flfBody), "flf graph has no custom-node packs");
  assert(info.comfyWorkflowFromModelName(info.WAN_FLF_MODEL_NAME) === "wan-flf", "flf model name does not route to TI2V");
  assert(info.comfyWorkflowFromModelName(info.WAN_MODEL_NAME) === "wan", "ti2v model name stays on the 5B graph");
  await flfStandin.close();
  storage.saveSettings({ comfyuiWorkflow: "svd" });
  const svdDescribed = info.describeProviderUse({
    provider: "comfyui",
    settings: storage.getSettings(),
    hasCharacterSheet: false,
    hasEndImage: false,
  });
  assert(/does not read the text prompt/i.test(svdDescribed.providerNote), "svd note ignores the prompt");

  const choiceMod = await import("../src/lib/comfy-choice");
  const ltx = await import("../src/lib/ltx");
  storage.saveSettings({ provider: "comfyui", comfyuiWorkflow: "svd", comfyLowMemory: false });
  storage.updateProject(SAMPLE_PROJECT_ID, { comfyuiWorkflow: "ltx", comfyLowMemory: null });
  storage.updateShot(shot.id, { comfyuiWorkflow: null, comfyLowMemory: true });
  const inherited = choiceMod.resolveComfyChoice({
    settings: storage.getSettings(),
    project: storage.getProject(SAMPLE_PROJECT_ID),
    shot: storage.getShot(shot.id),
  });
  assert(inherited.workflow === "ltx" && inherited.lowMemory === true, "shot low-memory inherits project LTX");
  storage.updateShot(shot.id, { comfyuiWorkflow: "wan", comfyLowMemory: false });
  const overridden = choiceMod.resolveComfyChoice({
    settings: storage.getSettings(),
    project: storage.getProject(SAMPLE_PROJECT_ID),
    shot: storage.getShot(shot.id),
  });
  assert(overridden.workflow === "wan" && overridden.lowMemory === false, "shot workflow overrides the project");
  const rendered = render.renderShot(shot.id, { force: true });
  assert(rendered.ok && rendered.jobs.length === 1, "shot render queues the override");
  assert(rendered.ok && rendered.jobs[0]?.modelName?.includes("Wan 2.2"), "queued model follows the shot");
  assert(rendered.ok && !rendered.jobs[0]?.modelName?.includes("low-memory"), "override is not the low-memory preset");
  storage.updateJob(rendered.jobs[0]!.id, { status: "cancelled", error: "test cleanup" });

  storage.updateShot(shot.id, { comfyuiWorkflow: "ltx", comfyLowMemory: true });
  const lowDescribed = info.describeProviderUse({
    provider: "comfyui",
    settings: storage.getSettings(),
    hasCharacterSheet: false,
    hasEndImage: false,
    comfy: { workflow: "ltx", lowMemory: true },
  });
  assert(/reads the text prompt/i.test(lowDescribed.providerNote), "ltx note reads the prompt");
  assert(!/character lock|lip-sync|long-form|long film/i.test(lowDescribed.providerNote), "ltx note makes no extra claims");
  assert(/832×480/.test(lowDescribed.providerNote), "ltx low-memory note names 480p box");
  const lowSize = ltx.ltxFrameSize(pixels!.width, pixels!.height, true);
  const lowFrames = ltx.ltxFrameCount(10, true);
  assert(lowFrames === ltx.LTX_LOW_MAX_FRAMES, "ten seconds still caps the low-memory clip");
  let ltxBodies: string[] = [];
  const ltxStandin = await listen((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/system_stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/upload/image") {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ name: "ltx-start.png", subfolder: "", type: "input" }));
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/prompt") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        ltxBodies.push(body);
        const promptId = ltxBodies.length === 1 ? "standin-ltx-low" : "standin-ltx";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ prompt_id: promptId, node_errors: {} }));
      });
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/history/")) {
      const promptId = url.pathname.split("/").pop();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          [promptId || ""]: {
            status: { status_str: "success", completed: true },
            outputs: {
              "22": { images: [{ filename: "ltx.mp4", subfolder: "", type: "output" }] },
            },
          },
        })
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/view") {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      res.end(mp4);
      return;
    }
    res.writeHead(404);
    res.end("missing");
  });
  storage.saveSettings({ comfyuiBaseUrl: ltxStandin.url, comfyuiWorkflow: "svd" });
  const lowJob = storage.createJob({
    projectId: SAMPLE_PROJECT_ID,
    shotId: shot.id,
    prompt: shot.prompt,
    presetId: shot.presetId,
    provider: "comfyui",
    imagePath: shot.startImagePath!,
    durationSec: 10,
    modelName: lowDescribed.modelName,
    providerNote: lowDescribed.providerNote,
    status: "queued",
  });
  await comfy.runComfyuiGenerate(lowJob.id);
  assert(storage.getJob(lowJob.id)?.status === "completed", `ltx low-memory completed: ${storage.getJob(lowJob.id)?.error}`);
  const fullDescribed = info.describeProviderUse({
    provider: "comfyui",
    settings: storage.getSettings(),
    hasCharacterSheet: false,
    hasEndImage: false,
    comfy: { workflow: "ltx", lowMemory: false },
  });
  const fullFrames = ltx.ltxFrameCount(4, false);
  const fullSize = ltx.ltxFrameSize(pixels!.width, pixels!.height, false);
  const fullJob = storage.createJob({
    projectId: SAMPLE_PROJECT_ID,
    shotId: shot.id,
    prompt: shot.prompt,
    presetId: shot.presetId,
    provider: "comfyui",
    imagePath: shot.startImagePath!,
    durationSec: 4,
    modelName: fullDescribed.modelName,
    status: "queued",
  });
  await comfy.runComfyuiGenerate(fullJob.id);
  assert(storage.getJob(fullJob.id)?.status === "completed", `ltx completed: ${storage.getJob(fullJob.id)?.error}`);
  function ltxNodes(index: number) {
    const posted = JSON.parse(ltxBodies[index] || "{}") as {
      prompt?: Record<string, { class_type?: string; inputs?: Record<string, unknown>; _meta?: { title?: string } }>;
    };
    return Object.values(posted.prompt || {});
  }
  const lowNodes = ltxNodes(0);
  const fullNodes = ltxNodes(1);
  assert(
    lowNodes.some((node) => node.class_type === "LoadImage" && node.inputs?.image === "ltx-start.png"),
    "ltx injects the start image"
  );
  assert(
    fullNodes.some(
      (node) =>
        node.class_type === "CLIPTextEncode" &&
        node._meta?.title === "Positive prompt" &&
        node.inputs?.text === shot.prompt
    ),
    "ltx injects the prompt"
  );
  const lowLatent = lowNodes.find((node) => node.class_type === "EmptyLTXVLatentVideo");
  assert(lowLatent?.inputs?.length === lowFrames, `ltx low frames ${lowLatent?.inputs?.length} != ${lowFrames}`);
  assert(lowLatent?.inputs?.width === lowSize.width, "ltx low width");
  assert(lowLatent?.inputs?.height === lowSize.height, "ltx low height");
  assert(
    lowNodes.some((node) => node.class_type === "LTXVEmptyLatentAudio" && node.inputs?.frames_number === lowFrames),
    "ltx audio latent matches the frame count"
  );
  const fullLatent = fullNodes.find((node) => node.class_type === "EmptyLTXVLatentVideo");
  assert(fullLatent?.inputs?.length === fullFrames, `ltx frames ${fullLatent?.inputs?.length} != ${fullFrames}`);
  assert(fullLatent?.inputs?.width === fullSize.width && fullLatent?.inputs?.height === fullSize.height, "ltx size");
  assert(
    fullNodes.some(
      (node) => node.class_type === "RandomNoise" && typeof node.inputs?.noise_seed === "number"
    ),
    "ltx injects a seed"
  );
  assert(
    fullNodes.some(
      (node) =>
        node.class_type === "CheckpointLoaderSimple" &&
        node.inputs?.ckpt_name === "ltx-2.3-22b-distilled-fp8.safetensors"
    ),
    "ltx checkpoint file"
  );
  assert(
    fullNodes.some(
      (node) =>
        node.class_type === "LTXAVTextEncoderLoader" &&
        node.inputs?.text_encoder === "gemma_3_12B_it_fp4_mixed.safetensors"
    ),
    "ltx text encoder file"
  );
  assert(
    fullNodes.some((node) => node.class_type === "CreateVideo" && node.inputs?.fps === ltx.LTX_FPS),
    "ltx fps"
  );
  await ltxStandin.close();

  const secret = "Bearer secret-token-do-not-store";
  let sawAuth = false;
  const remote = await listen((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const authed = req.headers.authorization === secret;
    if (req.method === "GET" && url.pathname === "/system_stats") {
      if (!authed) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("unauthorized");
        return;
      }
      sawAuth = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/upload/image") {
      req.resume();
      req.on("end", () => {
        res.writeHead(authed ? 200 : 401, { "Content-Type": "application/json" });
        res.end(authed ? JSON.stringify({ name: "remote.png", subfolder: "", type: "input" }) : "unauthorized");
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/prompt") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        if (!authed) {
          res.writeHead(401);
          res.end("unauthorized");
          return;
        }
        const parsed = JSON.parse(body) as { prompt?: Record<string, { class_type?: string }> };
        const missing = Object.values(parsed.prompt || {}).some((node) => node.class_type === "LTXVImgToVideoInplace");
        if (missing && body.includes("MISSING_NODE")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              node_errors: { "9": { class_type: "LTXVImgToVideoInplace", errors: [{ message: "Node does not exist" }] } },
            })
          );
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ prompt_id: "standin-remote", node_errors: {} }));
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/history/standin-remote") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          "standin-remote": {
            status: { status_str: "success", completed: true },
            outputs: { "22": { images: [{ filename: "remote.mp4", subfolder: "", type: "output" }] } },
          },
        })
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/view") {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      res.end(mp4);
      return;
    }
    res.writeHead(404);
    res.end("missing");
  });
  process.env.COMFYUI_BASE_URL = remote.url;
  storage.saveSettings({ comfyuiBaseUrl: closedUrl, provider: "comfyui", comfyuiWorkflow: "svd" });
  const denied = storage.createJob({
    projectId: SAMPLE_PROJECT_ID,
    shotId: shot.id,
    prompt: shot.prompt,
    presetId: shot.presetId,
    provider: "comfyui",
    imagePath: shot.startImagePath!,
    modelName: "ComfyUI SVD image-to-video (svd_xt_1_1.safetensors)",
    status: "queued",
  });
  await comfy.runComfyuiGenerate(denied.id).catch(() => undefined);
  const deniedJob = storage.getJob(denied.id);
  assert(deniedJob?.status === "failed", "remote 401 fails");
  assert(deniedJob?.status !== "running", "remote 401 not left running");
  assert(/COMFYUI_AUTH_HEADER/.test(deniedJob?.error || ""), "remote 401 names the env header");
  assert(!deniedJob?.error?.includes("secret-token"), "auth header value is not stored on the job");
  assert(deniedJob?.error?.includes(remote.url), "remote 401 names the env host");
  assert(!deniedJob?.error?.includes(String(closedPort)), "env URL wins over the saved URL");

  process.env.COMFYUI_AUTH_HEADER = secret;
  const remoteJob = storage.createJob({
    projectId: SAMPLE_PROJECT_ID,
    shotId: shot.id,
    prompt: shot.prompt,
    presetId: shot.presetId,
    provider: "comfyui",
    imagePath: shot.startImagePath!,
    modelName: "ComfyUI SVD image-to-video (svd_xt_1_1.safetensors)",
    durationSec: 2,
    status: "queued",
  });
  await comfy.runComfyuiGenerate(remoteJob.id);
  assert(storage.getJob(remoteJob.id)?.status === "completed", `remote authed run: ${storage.getJob(remoteJob.id)?.error}`);
  assert(sawAuth, "auth header was sent");
  assert(!storage.getJob(remoteJob.id)?.error?.includes("secret-token"), "completed job does not store the header");

  const oomServer = await listen((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/system_stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/upload/image") {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ name: "oom.png", subfolder: "", type: "input" }));
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/prompt") {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ prompt_id: "standin-oom", node_errors: {} }));
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/history/standin-oom") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          "standin-oom": {
            status: {
              status_str: "error",
              messages: [["execution_error", { exception_message: "CUDA out of memory. Tried to allocate 20 GiB." }]],
            },
          },
        })
      );
      return;
    }
    res.writeHead(404);
    res.end("missing");
  });
  process.env.COMFYUI_BASE_URL = oomServer.url;
  const oomJob = storage.createJob({
    projectId: SAMPLE_PROJECT_ID,
    shotId: shot.id,
    prompt: shot.prompt,
    presetId: shot.presetId,
    provider: "comfyui",
    imagePath: shot.startImagePath!,
    modelName: lowDescribed.modelName,
    status: "queued",
  });
  await comfy.runComfyuiGenerate(oomJob.id).catch(() => undefined);
  const oomDone = storage.getJob(oomJob.id);
  assert(oomDone?.status === "failed", "oom fails the job");
  assert(oomDone?.status !== "running", "oom is not left running");
  assert(/out of memory/i.test(oomDone?.error || ""), "oom says memory");
  assert(/low-memory preset/i.test(oomDone?.error || ""), "oom points at the preset");
  assert(!oomDone?.error?.includes(secret), "oom error does not include the auth header");
  await oomServer.close();

  const missingServer = await listen((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/system_stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    if (req.method === "POST" && url.pathname === "/upload/image") {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ name: "miss.png", subfolder: "", type: "input" }));
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/prompt") {
      req.resume();
      req.on("end", () => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              type: "prompt_outputs_failed_validation",
              message: "Value not in list",
              details: "ckpt_name 'ltx-2.3-22b-distilled-fp8.safetensors' not in list",
            },
          })
        );
      });
      return;
    }
    res.writeHead(404);
    res.end("missing");
  });
  process.env.COMFYUI_BASE_URL = missingServer.url;
  const missingModel = storage.createJob({
    projectId: SAMPLE_PROJECT_ID,
    shotId: shot.id,
    prompt: shot.prompt,
    presetId: shot.presetId,
    provider: "comfyui",
    imagePath: shot.startImagePath!,
    modelName: fullDescribed.modelName,
    status: "queued",
  });
  await comfy.runComfyuiGenerate(missingModel.id).catch(() => undefined);
  const missingDone = storage.getJob(missingModel.id);
  assert(missingDone?.status === "failed" && missingDone.status !== "running", "missing model fails");
  assert(/model file/i.test(missingDone?.error || ""), `missing model guidance: ${missingDone?.error}`);
  await missingServer.close();

  const nodeServer = await listen((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/system_stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    if (req.method === "POST" && url.pathname === "/upload/image") {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ name: "node.png", subfolder: "", type: "input" }));
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/prompt") {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            node_errors: {
              "9": { class_type: "LTXVImgToVideoInplace", errors: [{ message: "Node does not exist" }] },
            },
          })
        );
      });
      return;
    }
    res.writeHead(404);
    res.end("missing");
  });
  process.env.COMFYUI_BASE_URL = nodeServer.url;
  const missingNode = storage.createJob({
    projectId: SAMPLE_PROJECT_ID,
    shotId: shot.id,
    prompt: shot.prompt,
    presetId: shot.presetId,
    provider: "comfyui",
    imagePath: shot.startImagePath!,
    modelName: fullDescribed.modelName,
    status: "queued",
  });
  await comfy.runComfyuiGenerate(missingNode.id).catch(() => undefined);
  const nodeDone = storage.getJob(missingNode.id);
  assert(nodeDone?.status === "failed" && nodeDone.status !== "running", "missing node fails");
  assert(/missing a node/i.test(nodeDone?.error || ""), `missing node guidance: ${nodeDone?.error}`);
  await nodeServer.close();
  await remote.close();
  delete process.env.COMFYUI_BASE_URL;
  delete process.env.COMFYUI_AUTH_HEADER;
  storage.updateProject(SAMPLE_PROJECT_ID, { comfyuiWorkflow: null, comfyLowMemory: null });
  storage.updateShot(shot.id, { comfyuiWorkflow: null, comfyLowMemory: null });
  storage.saveSettings({ provider: "mock", comfyuiWorkflow: "svd", comfyLowMemory: false });

  storage.saveSettings({ provider: "mock" });
  const endJob = storage.createJob({
    projectId: SAMPLE_PROJECT_ID,
    shotId: shot.id,
    prompt: "crossfade",
    presetId: "slow-zoom-in",
    provider: "mock",
    imagePath: shot.startImagePath!,
    endImagePath: shot.startImagePath,
    durationSec: 2,
    status: "queued",
  });
  await mock.runMockGenerate(endJob.id);
  assert(storage.getJob(endJob.id)?.status === "completed", "mock end image");

  const second = storage.listShots(SAMPLE_PROJECT_ID)[1];
  const secondJob = storage.createJob({
    projectId: SAMPLE_PROJECT_ID,
    shotId: second.id,
    prompt: second.prompt,
    presetId: second.presetId,
    provider: "mock",
    imagePath: second.startImagePath!,
    durationSec: 1,
    status: "queued",
  });
  await mock.runMockGenerate(secondJob.id);
  const stitched = await stitch.stitchProject(SAMPLE_PROJECT_ID);
  assert(fs.existsSync(storage.resolveDataPath(stitched.outputPath)), "stitch mp4");
  assert(stitched.includedShotIds.length >= 1, "stitch included shots");

  const cost = await import("../src/lib/cost");
  const spend = storage.createProject("Spend safety");
  const spendShot = storage.createShot({
    projectId: spend.id,
    prompt: "Lanterns drift over the water.",
    presetId: "slow-zoom-in",
    durationSec: 4,
    startImagePath: shot.startImagePath,
  });
  storage.saveSettings({ provider: "mock", comfyuiWorkflow: "svd" });
  const firstRender = render.renderShot(spendShot.id);
  assert(firstRender.ok && firstRender.jobs.length === 1 && firstRender.jobs[0].kind === "take", "first take queued");
  await mock.runMockGenerate(firstRender.jobs[0].id);
  const firstDone = storage.getJob(firstRender.jobs[0].id);
  assert(firstDone?.status === "completed" && firstDone.outputPath, "first take completed");
  const firstBytes = fs.readFileSync(storage.resolveDataPath(firstDone!.outputPath!));

  const skippedAll = render.renderAll(spend.id);
  assert(skippedAll.ok && skippedAll.jobs.length === 0, "render all skipped a matching take");
  assert(
    skippedAll.ok && skippedAll.skipped.some((item) => item.reason === "Reused an existing clip. No new spend."),
    "skip reason names the matching take"
  );
  const skippedShot = render.renderShot(spendShot.id);
  assert(skippedShot.ok && skippedShot.jobs.length === 0, "single render also skips a matching take");

  const forced = render.renderShot(spendShot.id, { force: true });
  assert(forced.ok && forced.jobs.length === 1, "re-render forces a new take");
  const blockedForce = render.renderShot(spendShot.id, { force: true });
  assert(!blockedForce.ok && blockedForce.status === 409, "in-flight re-render is refused");
  const blockedAll = render.renderAll(spend.id);
  assert(blockedAll.ok && blockedAll.jobs.length === 0, "render all skips a queued shot");
  assert(
    blockedAll.ok && blockedAll.skipped.some((item) => item.reason === "Already queued or running"),
    "skip reason names the in-flight shot"
  );
  await mock.runMockGenerate(forced.jobs[0].id);
  const secondDone = storage.getJob(forced.jobs[0].id);
  assert(secondDone?.status === "completed" && secondDone.outputPath, "second take completed");
  assert(secondDone!.outputPath !== firstDone!.outputPath, "new take did not overwrite the old file");
  assert(
    fs.readFileSync(storage.resolveDataPath(firstDone!.outputPath!)).equals(firstBytes),
    "old take bytes stayed on disk"
  );
  assert(fs.existsSync(storage.resolveDataPath(secondDone!.outputPath!)), "new take file exists");

  const newestStitch = await stitch.stitchProject(spend.id);
  assert(newestStitch.includedJobIds[0] === secondDone!.id, "stitch defaults to the newest take");
  const selected = storage.selectTake(spendShot.id, firstDone!.id);
  assert(selected?.selectedJobId === firstDone!.id, "user selected the older take");
  const chosenStitch = await stitch.stitchProject(spend.id);
  assert(chosenStitch.includedJobIds[0] === firstDone!.id, "stitch uses the selected take");
  assert(storage.selectTake(spendShot.id, "missing") === undefined, "unknown take is rejected");

  const beforePreview = storage.getShot(spendShot.id)?.selectedJobId;
  const preview = render.previewAll(spend.id);
  assert(preview.ok && preview.jobs.length === 1, "preview queued");
  assert(preview.jobs[0].kind === "preview" && preview.jobs[0].provider === "mock", "preview is mock");
  assert(storage.getShot(spendShot.id)?.selectedJobId === beforePreview, "preview did not replace the selected take");
  await mock.runMockGenerate(preview.jobs[0].id);
  const previewDone = storage.getJob(preview.jobs[0].id);
  assert(previewDone?.status === "completed" && previewDone.outputPath, "preview clip completed");
  assert(previewDone!.outputPath !== firstDone!.outputPath, "preview did not overwrite the take file");
  assert(
    fs.readFileSync(storage.resolveDataPath(firstDone!.outputPath!)).equals(firstBytes),
    "take bytes unchanged after preview"
  );
  const afterPreview = await stitch.stitchProject(spend.id);
  assert(afterPreview.includedJobIds[0] === firstDone!.id, "stitch still uses the selected take");
  assert(!afterPreview.includedJobIds.includes(previewDone!.id), "preview is not a stitch take");
  const previewStitch = await stitch.stitchPreview(spend.id, [previewDone!.id]);
  assert(previewStitch.kind === "preview" && previewStitch.includedJobIds[0] === previewDone!.id, "preview stitch");
  assert(fs.existsSync(storage.resolveDataPath(previewStitch.outputPath)), "preview mp4");

  const keptPrompt = spendShot.prompt;
  storage.updateShot(spendShot.id, { prompt: "nude child" });
  const jobsBeforeRefusal = storage.listJobs(spend.id).length;
  const refusedPreview = render.previewAll(spend.id);
  assert(!refusedPreview.ok && refusedPreview.refused, "preview refuses sexual content involving a minor");
  const refusedRender = render.renderAll(spend.id);
  assert(!refusedRender.ok && refusedRender.refused, "render all still refuses");
  assert(storage.listJobs(spend.id).length === jobsBeforeRefusal, "refused preview stored nothing");
  storage.updateShot(spendShot.id, { prompt: keptPrompt });

  const extra = storage.createShot({
    projectId: spend.id,
    prompt: "A second angle on the pier.",
    presetId: "pan-right",
    durationSec: 2,
    startImagePath: shot.startImagePath,
  });
  const queuedPreview = render.previewAll(spend.id);
  assert(queuedPreview.ok, "second preview queued");
  const whilePreview = render.renderAll(spend.id);
  assert(whilePreview.ok, "render all during preview");
  assert(
    whilePreview.ok && whilePreview.jobs.some((job) => job.shotId === extra.id && job.kind === "take"),
    "a queued preview does not block a real take"
  );
  assert(
    whilePreview.ok && whilePreview.skipped.some((item) => item.shotId === spendShot.id),
    "matching take still skipped while a preview exists"
  );

  storage.saveSettings({
    provider: "fal",
    falModel: "fal-ai/test-model",
    rates: { fal: {}, replicate: {} },
    budgetCap: null,
  });
  const unknown = render.renderAll(spend.id);
  assert(!unknown.ok && unknown.needsModelAck, "paid render all still asks for the model");
  assert(unknown.cost?.unknown === true && unknown.cost.total == null, "no rate means unknown cost");
  assert(unknown.cost?.label && !/\d/.test(unknown.cost.label), "unknown cost shows no number");
  assert(!unknown.error.match(/\$\d/), "ack text has no invented price");
  const unknownRun = render.renderAll(spend.id, { acknowledgeModel: "fal-ai/test-model" });
  assert(!unknownRun.ok && unknownRun.error.includes("FAL_KEY"), "unknown cost still refuses a missing key");
  assert(unknownRun.cost?.unknown === true && unknownRun.cost.total == null, "missing key response keeps cost unknown");
  assert(!unknownRun.error.match(/\$\d/), "missing key has no invented price");
  assert(
    storage.listJobs(spend.id).every((job) => job.provider !== "fal"),
    "unknown cost did not queue fal"
  );

  storage.saveSettings({
    provider: "fal",
    falModel: "fal-ai/test-model",
    rates: { fal: { "fal-ai/test-model": 0.25 }, replicate: {} },
    budgetCap: 0.2,
  });
  const estimate = cost.estimateRenderAll(spend.id);
  assert(estimate.unknown === false && estimate.total != null, "rate makes a user estimate");
  assert(estimate.total === Math.round(estimate.seconds * 0.25 * 10000) / 10000, "total is seconds times the user rate");
  assert(/your own estimate, not a vendor quote/i.test(estimate.label), "estimate is labelled as the user's");
  assert(estimate.overBudget, "estimate over the cap");
  const beforeCap = storage.listJobs(spend.id).length;
  const capped = render.renderAll(spend.id, { acknowledgeModel: "fal-ai/test-model" });
  assert(!capped.ok && capped.overBudget, "budget cap blocks paid render all");
  assert(capped.cost?.total === estimate.total, "block carries the same estimate");
  assert(storage.listJobs(spend.id).length === beforeCap, "budget cap created no job");
  assert(
    storage.listJobs(spend.id).every((job) => job.provider !== "fal"),
    "budget cap did not call fal"
  );

  storage.saveSettings({ budgetCap: 1000 });
  const underCap = render.renderAll(spend.id, { acknowledgeModel: "fal-ai/test-model" });
  assert(!underCap.ok && !underCap.overBudget && underCap.error.includes("FAL_KEY"), "under cap still needs the key");
  assert(underCap.cost?.overBudget === false && underCap.cost?.total != null, "under cap shows the user total");

  const saved = storage.getSettings();
  assert(saved.rates.fal["fal-ai/test-model"] === 0.25, "rate stored in settings");
  assert(!JSON.stringify(saved).includes("FAL_KEY"), "settings have no key");
  assert(saved.budgetCap === 1000, "budget cap stored");

  const credits = await import("../src/lib/credits");
  const billing = await import("../src/lib/stripe-billing");
  const paypal = await import("../src/lib/paypal-billing");
  const pack = await import("../src/lib/pack");
  const { NextRequest } = await import("next/server");
  const checkoutRoute = await import("../src/app/api/credits/checkout/route");
  const webhookRoute = await import("../src/app/api/credits/webhook/route");
  const paypalCheckoutRoute = await import("../src/app/api/credits/paypal/checkout/route");
  const paypalReturnRoute = await import("../src/app/api/credits/paypal/return/route");
  const paypalWebhookRoute = await import("../src/app/api/credits/paypal/webhook/route");
  const settingsRoute = await import("../src/app/api/settings/route");
  const packRoute = await import("../src/app/api/pack/route");
  const workerRoute = await import("../src/app/api/projects/[id]/pack-worker/route");

  const phase = storage.createProject("Phase 1");
  storage.createShot({
    projectId: phase.id,
    prompt: "A quiet harbor.",
    presetId: "slow-zoom-in",
    durationSec: 4,
    startImagePath: shot.startImagePath,
  });
  storage.saveSettings({
    provider: "fal",
    falModel: "fal-ai/test-model",
    rates: { fal: { "fal-ai/test-model": 0.25 }, replicate: {} },
    budgetCap: null,
  });
  assert(credits.hostedCreditsEnabled() === false, "stripe unset is not hosted mode");
  assert(credits.paypalCreditsEnabled() === false, "paypal unset is not a checkout");
  assert(paypal.paypalApiBase() === "https://api-m.sandbox.paypal.com", "paypal mode defaults to sandbox");
  const phase1 = render.renderAll(phase.id);
  assert(!phase1.ok && phase1.needsModelAck, "stripe unset still asks for the model");
  assert(!phase1.insufficientCredits, "stripe unset does not block on credits");
  assert(phase1.cost?.credits == null, "stripe unset leaves the Phase 1 cost shape");
  const offCheckout = await checkoutRoute.POST(
    new NextRequest("http://127.0.0.1:3000/api/credits/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ packId: "default" }),
    })
  );
  assert(offCheckout.status === 404, "checkout is hidden when Stripe is unset");
  const offHook = await webhookRoute.POST(
    new NextRequest("http://127.0.0.1:3000/api/credits/webhook", { method: "POST", body: "{}" })
  );
  assert(offHook.status === 404, "webhook is hidden when Stripe is unset");
  const offPayPal = await paypalCheckoutRoute.POST(
    new NextRequest("http://127.0.0.1:3000/api/credits/paypal/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ packId: "default" }),
    })
  );
  assert(offPayPal.status === 404, "paypal checkout is hidden when PayPal is unset");
  const offPayPalHook = await paypalWebhookRoute.POST(
    new NextRequest("http://127.0.0.1:3000/api/credits/paypal/webhook", { method: "POST", body: "{}" })
  );
  assert(offPayPalHook.status === 404, "paypal webhook is hidden when PayPal is unset");
  const phaseSettings = await (await settingsRoute.GET()).json();
  assert(phaseSettings.env.paypalCredits === false, "phase 1 settings hide PayPal");
  assert(phaseSettings.env.stripeCredits === false, "phase 1 settings hide Stripe");
  assert(phaseSettings.env.paypalPacks.length === 0, "phase 1 settings have no PayPal packs");
  const lockedPack = await packRoute.GET();
  const lockedBody = await lockedPack.json();
  assert(lockedPack.status === 200 && lockedBody.unlocked === false, "license unset keeps the pack locked");
  assert(lockedBody.workflowFile == null, "locked pack does not advertise the workflow");

  process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";
  process.env.STRIPE_PRICE_CREDITS = "price_test_pack";
  process.env.STRIPE_CREDITS_AMOUNT = "4";
  process.env.STRIPE_PRICE_CREDITS_STUDIO = "price_test_studio";
  process.env.STRIPE_CREDITS_STUDIO = "10";
  process.env.STAR_DUST_CREDITS_PER_SECOND = "1";
  assert(credits.hostedCreditsEnabled(), "secret plus a price turns hosted credits on");
  const publicPacks = credits.publicCreditPacks();
  assert(publicPacks.length === 2, "default pack and named pack");
  assert(!JSON.stringify(publicPacks).includes("price_"), "price ids stay off the public pack list");
  assert(credits.getCreditBalance() === 0, "balance starts at zero");

  const settingsOn = await (await settingsRoute.GET()).json();
  const settingsText = JSON.stringify(settingsOn);
  assert(settingsOn.env.hostedCredits === true, "settings report hosted credits");
  assert(settingsOn.env.stripeCredits === true, "settings report Stripe checkout");
  assert(settingsOn.env.paypalCredits === false, "Stripe alone does not show PayPal");
  assert(settingsOn.env.paypalPacks.length === 0, "Stripe alone has no PayPal packs");
  assert(settingsOn.env.creditBalance === 0, "settings report the balance");
  assert(settingsOn.env.packUnlocked === false, "settings do not unlock the pack");
  assert(!settingsText.includes("sk_test_placeholder"), "settings omit the Stripe secret");
  assert(!settingsText.includes("whsec_test_secret"), "settings omit the webhook secret");
  assert(!settingsText.includes("price_test_pack"), "settings omit price ids");

  const blocked = render.renderAll(phase.id, { acknowledgeModel: "fal-ai/test-model" });
  assert(!blocked.ok && blocked.insufficientCredits, "low balance blocks paid render all");
  assert(blocked.cost?.credits?.required === 4, "render all estimates one credit per second");
  assert(/not enough hosted credits/i.test(blocked.error), "block names the credit balance");
  assert(credits.getCreditBalance() === 0, "a blocked render does not spend credits");
  assert(storage.listJobs(phase.id).every((job) => job.provider !== "fal"), "blocked render queued nothing");

  const blockedShot = render.renderShot(storage.listShots(phase.id)[0].id, {
    acknowledgeModel: "fal-ai/test-model",
  });
  assert(!blockedShot.ok && blockedShot.insufficientCredits, "a single paid shot cannot bypass the balance");

  const Stripe = (await import("stripe")).default;
  function signedEvent(payload: string) {
    return Stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_test_secret" });
  }
  async function postWebhook(payload: string, signature: string) {
    return webhookRoute.POST(
      new NextRequest("http://127.0.0.1:3000/api/credits/webhook", {
        method: "POST",
        headers: { "stripe-signature": signature, "content-type": "application/json" },
        body: payload,
      })
    );
  }
  const grantPayload = JSON.stringify({
    id: "evt_test_grant",
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_grant",
        object: "checkout.session",
        mode: "payment",
        payment_status: "paid",
        metadata: { priceId: "price_test_pack", packId: "default", credits: "9999" },
      },
    },
  });
  const prevFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error("network disabled");
  }) as typeof fetch;
  try {
    const granted = await postWebhook(grantPayload, signedEvent(grantPayload));
    const grantedBody = await granted.json();
    assert(granted.status === 200 && grantedBody.granted === 4, "webhook grants the configured pack");
    assert(grantedBody.balance === 4, "webhook balance is the pack size, not metadata credits");
    assert(networkCalls === 0, "webhook grant does not call the network");
    const replay = await postWebhook(grantPayload, signedEvent(grantPayload));
    const replayBody = await replay.json();
    assert(replay.status === 200 && replayBody.duplicate === true && replayBody.granted === 0, "replay does not double-credit");
    assert(credits.getCreditBalance() === 4, "balance stays at one grant");

    const subscriptionPayload = JSON.stringify({
      id: "evt_test_sub",
      object: "event",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_sub",
          object: "checkout.session",
          mode: "subscription",
          payment_status: "paid",
          metadata: { priceId: "price_test_pack", packId: "default" },
        },
      },
    });
    const sub = await postWebhook(subscriptionPayload, signedEvent(subscriptionPayload));
    const subBody = await sub.json();
    assert(sub.status === 200 && subBody.ignored === true, "subscriptions are not credited");
    assert(credits.getCreditBalance() === 4, "subscription left the balance alone");

    const bad = await postWebhook(grantPayload, "t=1,v1=deadbeef");
    assert(bad.status === 400, "bad signature is rejected");
    assert(credits.getCreditBalance() === 4, "bad signature did not grant credits");

    let sawPayment = false;
    billing.setCheckoutCreatorForTests(async (params) => {
      sawPayment = params.mode === "payment";
      assert(!("subscription" in params) && params.mode === "payment", "checkout is a one-time payment");
      assert(params.line_items[0]?.price === "price_test_pack", "checkout uses the configured price");
      return { id: "cs_test_local", url: "https://checkout.stripe.test/c/pay/cs_test_local" };
    });
    const session = await billing.createCreditCheckout({
      packId: "default",
      origin: "http://127.0.0.1:3000",
    });
    assert(sawPayment && session.url.startsWith("https://checkout.stripe.test/"), "checkout stays on the test creator");
    assert(networkCalls === 0, "checkout test did not call Stripe");
  } finally {
    globalThis.fetch = prevFetch;
    billing.setCheckoutCreatorForTests(null);
  }

  storage.saveSettings({ budgetCap: 0.01 });
  const beforeCapCredits = credits.getCreditBalance();
  const cappedCredits = render.renderAll(phase.id, { acknowledgeModel: "fal-ai/test-model" });
  assert(!cappedCredits.ok && cappedCredits.overBudget && !cappedCredits.insufficientCredits, "budget cap still blocks first");
  assert(credits.getCreditBalance() === beforeCapCredits, "budget cap does not spend credits");
  storage.saveSettings({ budgetCap: null });

  process.env.FAL_KEY = "test-not-a-real-key";
  const spent = render.renderAll(phase.id, { acknowledgeModel: "fal-ai/test-model" });
  assert(spent.ok && spent.jobs.length === 1 && spent.jobs[0].provider === "fal", "funded render all queues");
  assert(credits.getCreditBalance() === 0, "render all spends the estimated credits");
  delete process.env.FAL_KEY;
  const skippedFunded = render.renderAll(phase.id, { acknowledgeModel: "fal-ai/test-model" });
  assert(skippedFunded.ok && skippedFunded.jobs.length === 0, "an in-flight shot is not charged again");
  assert(credits.getCreditBalance() === 0, "skip did not change the balance");

  const failed = storage.createJob({
    projectId: phase.id,
    shotId: storage.listShots(phase.id)[0].id,
    prompt: "A quiet harbor.",
    presetId: "slow-zoom-in",
    provider: "fal",
    imagePath: shot.startImagePath!,
    modelName: "fal-ai/test-model",
    durationSec: 4,
    status: "failed",
  });
  const retried = render.retryFromJob(failed, { acknowledgeModel: "fal-ai/test-model" });
  assert(!retried.ok && retried.insufficientCredits, "retry cannot bypass an empty balance");

  const savedStripe = {
    secret: process.env.STRIPE_SECRET_KEY,
    webhook: process.env.STRIPE_WEBHOOK_SECRET,
    price: process.env.STRIPE_PRICE_CREDITS,
    studioPrice: process.env.STRIPE_PRICE_CREDITS_STUDIO,
  };
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_PRICE_CREDITS;
  delete process.env.STRIPE_PRICE_CREDITS_STUDIO;
  process.env.PAYPAL_CLIENT_ID = "paypal_test_client";
  process.env.PAYPAL_CLIENT_SECRET = "paypal_test_secret";
  process.env.PAYPAL_MODE = "sandbox";
  process.env.PAYPAL_PACK_AMOUNT = "10.00";
  process.env.PAYPAL_CREDITS_AMOUNT = "4";
  process.env.PAYPAL_PACK_AMOUNT_STUDIO = "25";
  assert(credits.stripeCreditsEnabled() === false, "paypal-only leaves Stripe checkout off");
  assert(credits.paypalCreditsEnabled(), "client id, secret, and an amount turn PayPal on");
  assert(credits.hostedCreditsEnabled(), "paypal alone turns hosted credits on");
  assert(paypal.paypalApiBase() === "https://api-m.sandbox.paypal.com", "sandbox mode stays off the live API");
  const paypalPacks = credits.listPayPalPacks();
  assert(paypalPacks.length === 2, "default pack and named pack");
  assert(paypalPacks.find((item) => item.id === "default")?.credits === 4, "paypal default pack size");
  assert(
    paypalPacks.find((item) => item.id === "studio")?.credits === 10,
    "named paypal pack uses the Stripe credit size when PAYPAL_CREDITS_STUDIO is unset"
  );
  assert(!JSON.stringify(credits.publicPayPalPacks()).includes("paypal_test_secret"), "public packs omit the secret");
  const stripeOff = await checkoutRoute.POST(
    new NextRequest("http://127.0.0.1:3000/api/credits/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ packId: "default" }),
    })
  );
  assert(stripeOff.status === 404, "Stripe checkout stays hidden when only PayPal is set");
  const paypalHookOff = await paypalWebhookRoute.POST(
    new NextRequest("http://127.0.0.1:3000/api/credits/paypal/webhook", { method: "POST", body: "{}" })
  );
  assert(paypalHookOff.status === 404, "paypal webhook stays hidden without PAYPAL_WEBHOOK_ID");

  const paypalProject = storage.createProject("PayPal only");
  storage.createShot({
    projectId: paypalProject.id,
    prompt: "A quiet harbor.",
    presetId: "slow-zoom-in",
    durationSec: 4,
    startImagePath: shot.startImagePath,
  });
  storage.saveSettings({
    provider: "fal",
    falModel: "fal-ai/test-model",
    rates: { fal: { "fal-ai/test-model": 0.25 }, replicate: {} },
    budgetCap: null,
  });
  const blockedPayPal = render.renderAll(paypalProject.id, { acknowledgeModel: "fal-ai/test-model" });
  assert(!blockedPayPal.ok && blockedPayPal.insufficientCredits, "paypal-only low balance blocks fal render all");
  assert(credits.getCreditBalance() === 0, "blocked paypal-mode render spent nothing");
  storage.saveSettings({ provider: "replicate", replicateModel: "stability-ai/stable-video-diffusion" });
  const blockedReplicate = render.renderAll(paypalProject.id, {
    acknowledgeModel: "stability-ai/stable-video-diffusion",
  });
  assert(
    !blockedReplicate.ok && blockedReplicate.insufficientCredits,
    "paypal-only low balance blocks replicate render all"
  );
  storage.saveSettings({ provider: "fal", falModel: "fal-ai/test-model" });

  function completedCapture(orderId: string) {
    return {
      orderId,
      status: "COMPLETED",
      packId: "default",
      amount: "10.00",
      currency: "USD",
    };
  }
  const paypalFetch = globalThis.fetch;
  let paypalNetwork = 0;
  globalThis.fetch = (async () => {
    paypalNetwork += 1;
    throw new Error("network disabled");
  }) as typeof fetch;
  try {
    paypal.setPayPalClientForTests({
      async createOrder(draft) {
        assert(draft.intent === "CAPTURE", "paypal order is a one-time capture");
        const body = paypal.buildPayPalOrderBody(draft);
        const text = JSON.stringify(body).toLowerCase();
        assert(body.intent === "CAPTURE", "paypal payload intent is CAPTURE");
        assert(!text.includes("subscription") && !text.includes("plan_id"), "paypal payload is not a subscription");
        assert(draft.amount === "10.00" && draft.credits === 4, "paypal checkout uses the configured pack");
        assert(draft.returnUrl.endsWith("/api/credits/paypal/return"), "capture returns to the server");
        return { id: "PAYPALORDER1", url: "https://www.sandbox.paypal.com/checkoutnow?token=PAYPALORDER1" };
      },
      async captureOrder(orderId) {
        return completedCapture(orderId);
      },
    });
    paypal.setPayPalWebhookVerifierForTests(async (raw, headers) => {
      if (headers.get("paypal-transmission-sig") !== "signed-test") return null;
      return JSON.parse(raw) as Record<string, unknown>;
    });
    const started = await paypalCheckoutRoute.POST(
      new NextRequest("http://127.0.0.1:3000/api/credits/paypal/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packId: "default" }),
      })
    );
    const startedBody = await started.json();
    assert(started.status === 200 && startedBody.url.includes("sandbox.paypal.com"), "paypal checkout returns the approval url");
    assert(paypalNetwork === 0, "paypal checkout test did not call PayPal");

    const returned = await paypalReturnRoute.GET(
      new NextRequest("http://127.0.0.1:3000/api/credits/paypal/return?token=PAYPALORDER1")
    );
    assert(returned.status === 307 || returned.status === 302, "return route redirects after capture");
    assert(
      returned.headers.get("location")?.endsWith("/settings?credits=paypal"),
      "return route lands on the paypal balance note"
    );
    assert(credits.getCreditBalance() === 4, "mocked paypal capture grants the shared credit balance");
    const replay = await paypal.capturePayPalOrder("PAYPALORDER1");
    assert(replay.duplicate === true && replay.granted === 0, "paypal capture replay does not double-credit");
    assert(credits.getCreditBalance() === 4, "balance stays at one paypal grant");

    process.env.PAYPAL_WEBHOOK_ID = "WH-TEST";
    function captureEvent(orderId: string, amount = "10.00", eventType = "PAYMENT.CAPTURE.COMPLETED") {
      return JSON.stringify({
        event_type: eventType,
        resource: {
          id: `CAP-${orderId}`,
          status: "COMPLETED",
          custom_id: "default",
          amount: { currency_code: "USD", value: amount },
          supplementary_data: { related_ids: { order_id: orderId } },
        },
      });
    }
    async function postPayPalWebhook(payload: string, signature = "signed-test") {
      return paypalWebhookRoute.POST(
        new NextRequest("http://127.0.0.1:3000/api/credits/paypal/webhook", {
          method: "POST",
          headers: { "paypal-transmission-sig": signature, "content-type": "application/json" },
          body: payload,
        })
      );
    }
    const replayHook = await postPayPalWebhook(captureEvent("PAYPALORDER1"));
    const replayHookBody = await replayHook.json();
    assert(
      replayHook.status === 200 && replayHookBody.duplicate === true && replayHookBody.granted === 0,
      "paypal webhook replay does not double-credit"
    );
    const second = await postPayPalWebhook(captureEvent("PAYPALORDER2"));
    const secondBody = await second.json();
    assert(second.status === 200 && secondBody.granted === 4 && secondBody.balance === 8, "a second order grants once");
    const secondCapture = await paypal.capturePayPalOrder("PAYPALORDER2");
    assert(secondCapture.duplicate === true && credits.getCreditBalance() === 8, "capture after webhook does not double-credit");
    const mismatch = await postPayPalWebhook(captureEvent("PAYPALORDER3", "1.00"));
    const mismatchBody = await mismatch.json();
    assert(mismatch.status === 200 && mismatchBody.ignored === true, "amount mismatch is not credited");
    const subscription = await postPayPalWebhook(captureEvent("PAYPALORDER4", "10.00", "BILLING.SUBSCRIPTION.ACTIVATED"));
    const subscriptionBody = await subscription.json();
    assert(subscription.status === 200 && subscriptionBody.ignored === true, "paypal subscriptions are not credited");
    const badSig = await postPayPalWebhook(captureEvent("PAYPALORDER5"), "nope");
    assert(badSig.status === 400, "bad paypal signature is rejected");
    assert(credits.getCreditBalance() === 8, "rejected paypal events left the balance alone");
    assert(paypalNetwork === 0, "paypal webhook grant does not call the network");

    const paypalSettings = await (await settingsRoute.GET()).json();
    const paypalSettingsText = JSON.stringify(paypalSettings);
    assert(paypalSettings.env.paypalCredits === true, "settings show PayPal when it is configured");
    assert(paypalSettings.env.stripeCredits === false, "settings hide Stripe when it is unset");
    assert(paypalSettings.env.paypalPacks.length === 2, "settings list PayPal packs");
    assert(paypalSettings.env.creditPacks.length === 0, "settings list no Stripe packs");
    assert(!paypalSettingsText.includes("paypal_test_secret"), "settings omit the PayPal secret");
    assert(!paypalSettingsText.includes("paypal_test_client"), "settings omit the PayPal client id");

    process.env.PAYPAL_MODE = "live";
    assert(paypal.paypalApiBase() === "https://api-m.paypal.com", "live mode selects the live API host");
    process.env.PAYPAL_MODE = "sandbox";
    process.env.STRIPE_SECRET_KEY = savedStripe.secret;
    process.env.STRIPE_WEBHOOK_SECRET = savedStripe.webhook;
    process.env.STRIPE_PRICE_CREDITS = savedStripe.price;
    process.env.STRIPE_PRICE_CREDITS_STUDIO = savedStripe.studioPrice;
    assert(credits.stripeCreditsEnabled() && credits.paypalCreditsEnabled(), "stripe and paypal can both be on");
    const both = await (await settingsRoute.GET()).json();
    assert(both.env.stripeCredits === true && both.env.creditPacks.length === 2, "both-on settings keep Stripe packs");
    assert(both.env.paypalCredits === true && both.env.paypalPacks.length === 2, "both-on settings keep PayPal packs");
    assert(both.env.creditBalance === 8, "both providers share one balance");
    const spentBack = credits.deductCredits(8, "restore test balance");
    assert(spentBack.ok && credits.getCreditBalance() === 0, "test balance returns to zero");
  } finally {
    globalThis.fetch = paypalFetch;
    paypal.setPayPalClientForTests(null);
    paypal.setPayPalWebhookVerifierForTests(null);
    process.env.PAYPAL_MODE = "sandbox";
    delete process.env.PAYPAL_WEBHOOK_ID;
    if (savedStripe.secret) process.env.STRIPE_SECRET_KEY = savedStripe.secret;
    if (savedStripe.webhook) process.env.STRIPE_WEBHOOK_SECRET = savedStripe.webhook;
    if (savedStripe.price) process.env.STRIPE_PRICE_CREDITS = savedStripe.price;
    if (savedStripe.studioPrice) process.env.STRIPE_PRICE_CREDITS_STUDIO = savedStripe.studioPrice;
  }

  storage.saveSettings({ provider: "mock" });
  const offline = storage.createProject("Air gap");
  const offlineShot = storage.createShot({
    projectId: offline.id,
    prompt: "Lanterns along the pier.",
    presetId: "slow-zoom-in",
    durationSec: 2,
    startImagePath: shot.startImagePath,
  });
  const fetchDuringMock = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network disabled");
  }) as typeof fetch;
  try {
    const mocked = render.renderShot(offlineShot.id);
    assert(mocked.ok && mocked.jobs.length === 1 && mocked.jobs[0].provider === "mock", "license unset still renders Mock");
    await mock.runMockGenerate(mocked.jobs[0].id);
    assert(storage.getJob(mocked.jobs[0].id)?.status === "completed", "Mock finishes with no license and no Stripe call");
    const preview = render.previewAll(offline.id);
    assert(preview.ok && preview.jobs[0].provider === "mock", "preview stays free in hosted mode");
    assert(credits.getCreditBalance() === 0, "Mock did not spend credits");
    const lockedPlan = pack.workerPlan(offline.id);
    assert(!lockedPlan.ok && lockedPlan.unlocked === false, "unset license leaves the worker locked");
    const denied = await workerRoute.GET(new NextRequest("http://127.0.0.1:3000/"), { params: { id: offline.id } });
    assert(denied.status === 403, "pack worker route stays closed");
    process.env.STAR_DUST_LICENSE_KEY = "sd-pack-test";
    const opened = pack.workerPlan(offline.id);
    assert(opened.ok && opened.shots.length === 1 && opened.workflow === "pack-hold", "license unlocks the local plan");
    assert(pack.packHoldFileExists(), "pack workflow file is in the tree");
    assert(!JSON.stringify(opened).includes("sd-pack-test"), "worker plan does not echo the license key");
    const allowed = await workerRoute.GET(new NextRequest("http://127.0.0.1:3000/"), { params: { id: offline.id } });
    assert(allowed.status === 200, "pack worker route opens locally");
    delete process.env.STAR_DUST_LICENSE_KEY;
    const still = render.renderShot(offlineShot.id, { force: true });
    assert(still.ok && still.jobs[0].provider === "mock", "clearing the license leaves Mock working");
  } finally {
    globalThis.fetch = fetchDuringMock;
    delete process.env.STAR_DUST_LICENSE_KEY;
    delete process.env.FAL_KEY;
  }

  const { chainDepth, chainDepthLabel, chainDepthNote, CHAIN_DEPTH_SOFT, CHAIN_DEPTH_WARN } = await import(
    "../src/lib/chain-depth"
  );
  const link = (id: string, on: boolean) => ({ id, chainFromPrevious: on });
  assert(chainDepth([link("a", false)], "a") === 0, "depth 0 when the option is off");
  assert(chainDepth([link("a", false), link("b", true)], "b") === 1, "depth 1 when only this shot chains");
  assert(chainDepth([link("a", false), link("b", true)], "a") === 0, "an earlier shot with the option off stays 0");
  assert(chainDepth([link("a", true)], "a") === 1, "a first shot with the option on is depth 1 and still cannot chain");
  assert(chainDepth([link("a", false)], "missing") === 0, "a shot that is not in the list is depth 0");
  assert(chainDepth([], "a") === 0, "an empty list is depth 0");
  const broken = [
    link("a", true),
    link("b", false),
    link("c", true),
    link("d", true),
    link("e", true),
  ];
  assert(chainDepth(broken, "a") === 1, "an opening chain stops at the first shot");
  assert(chainDepth(broken, "b") === 0, "a shot with the option off is depth 0 even between chains");
  assert(chainDepth(broken, "c") === 1, "a chain restarts after a break");
  assert(chainDepth(broken, "d") === 2, "depth 2 counts this shot and one previous link");
  assert(chainDepth(broken, "e") === 3, "depth 3 is three unbroken links");
  const longChain = ["a", "b", "c", "d", "e", "f", "g"].map((id, index) => link(id, index > 0));
  assert(chainDepth(longChain, "a") === 0, "the unchained start of a long list is depth 0");
  assert(chainDepth(longChain, "b") === 1, "the first real link is depth 1");
  assert(chainDepth(longChain, "f") === 5, "depth 5");
  assert(chainDepth(longChain, "g") === 6, "depth keeps growing past 5");
  const allOn = ["a", "b", "c", "d", "e", "f"].map((id) => link(id, true));
  assert(chainDepth(allOn, "f") === 6, "a first shot with the option on still counts in the run");
  assert(chainDepthNote(0) === null && chainDepthNote(1) === null, "depth 0 and 1 have no extra note");
  assert(chainDepthNote(2) === CHAIN_DEPTH_SOFT && chainDepthNote(3) === CHAIN_DEPTH_SOFT, "depth 2–3 uses the short note");
  assert(chainDepthNote(4) === CHAIN_DEPTH_WARN && chainDepthNote(6) === CHAIN_DEPTH_WARN, "depth 4 and above warn");
  assert(chainDepthNote(Number.NaN) === null && chainDepthNote(Number.POSITIVE_INFINITY) === null, "a bad depth has no note");
  const notes = `${CHAIN_DEPTH_SOFT} ${CHAIN_DEPTH_WARN}`;
  assert(/drift/i.test(notes), "depth notes say identity and details drift");
  assert(/original still/i.test(CHAIN_DEPTH_WARN), "the warning points at the original still");
  assert(/Start from previous shot's last frame/i.test(CHAIN_DEPTH_WARN), "the warning names the checkbox");
  assert(
    !/character lock|face lock|locks the|will fix|fixes identity|lip-sync/i.test(notes),
    "depth notes do not claim a lock, a fix, or lip-sync"
  );
  assert(chainDepthLabel(4) === "Chain depth 4", "the depth label is plain");
  assert(CHAIN_DEPTH_SOFT.length < 180 && CHAIN_DEPTH_WARN.length < 280, "depth copy stays short");

  storage.saveSettings({ provider: "mock" });
  const continuity = storage.createProject("Continuity");
  const red = storage.saveUpload(continuity.id, "red.png", solidPng(dataDir, "red.png", "red"));
  const blue = storage.saveUpload(continuity.id, "blue.png", solidPng(dataDir, "blue.png", "blue"));
  const green = storage.saveUpload(continuity.id, "green.png", solidPng(dataDir, "green.png", "green"));
  const shotA = storage.createShot({
    projectId: continuity.id,
    prompt: "Red lanterns over the water.",
    presetId: "slow-zoom-in",
    durationSec: 2,
    startImagePath: red,
  });
  const shotB = storage.createShot({
    projectId: continuity.id,
    prompt: "Continue directly from the last frame.",
    presetId: "slow-zoom-in",
    durationSec: 2,
    startImagePath: blue,
    chainFromPrevious: true,
  });
  const shotC = storage.createShot({
    projectId: continuity.id,
    prompt: "Keep the same framing along the pier.",
    presetId: "slow-zoom-out",
    durationSec: 2,
    startImagePath: green,
    chainFromPrevious: true,
  });
  storage.updateProject(continuity.id, { seamMode: "crossfade", seamFadeSec: 0.5 });
  const listed = storage.listShots(continuity.id);
  assert(chainDepth(listed, shotA.id) === 0, "shot 1 of the mock chain is depth 0");
  assert(chainDepth(listed, shotB.id) === 1, "shot 2 of the mock chain is depth 1");
  assert(chainDepth(listed, shotC.id) === 2, "shot 3 of the mock chain is depth 2");
  assert(isRed(averageRgb(storage.resolveDataPath(red))), "red still is red");
  assert(isBlue(averageRgb(storage.resolveDataPath(blue))), "blue still is blue");

  const blockedChain = render.renderShot(shotB.id);
  assert(!blockedChain.ok, "chained shot does not render without the previous take");
  assert(
    blockedChain.ok === false &&
      blockedChain.error.includes("finished take") &&
      blockedChain.error.includes("Your still was not used"),
    `chain error names the missing take: ${blockedChain.ok ? "" : blockedChain.error}`
  );
  assert(storage.listJobs(continuity.id).length === 0, "missing previous take queued nothing");
  assert(storage.getShot(shotB.id)?.startImagePath === blue, "user still unchanged when chain cannot start");

  const chainedRun = render.renderAll(continuity.id);
  assert(chainedRun.ok && chainedRun.jobs.length === 3, "three chained shots queue together");
  const queuedB = chainedRun.ok ? chainedRun.jobs.find((job) => job.shotId === shotB.id) : undefined;
  const queuedC = chainedRun.ok ? chainedRun.jobs.find((job) => job.shotId === shotC.id) : undefined;
  assert(queuedB?.awaitPreviousFrame && queuedB.imagePath !== blue, "shot 2 waits and does not use its still");
  assert(queuedC?.awaitPreviousFrame && queuedC.imagePath !== green, "shot 3 waits and does not use its still");
  assert(/last frame/i.test(queuedB?.providerNote || ""), "job says it uses the last frame");
  assert(
    !/character lock|lip-sync|long-form/i.test(queuedB?.providerNote || ""),
    "chain note makes no character-lock, lip-sync, or long-form claim"
  );
  await providers.startJob(queuedC!.id);
  for (const id of [shotA.id, shotB.id, shotC.id]) {
    const done = storage
      .listJobs(continuity.id)
      .find((job) => job.shotId === id && job.kind !== "preview" && job.status === "completed" && job.outputPath);
    assert(done, `shot ${id} completed from the chained queue`);
  }
  const doneB = storage.listJobs(continuity.id).find((job) => job.shotId === shotB.id && job.status === "completed");
  const doneC = storage.listJobs(continuity.id).find((job) => job.shotId === shotC.id && job.status === "completed");
  assert(doneB?.imagePath && doneB.imagePath !== blue && doneB.imagePath.startsWith("uploads/"), "shot 2 start still is stored");
  assert(doneC?.imagePath && doneC.imagePath !== green, "shot 3 did not use the green still");
  const keptB = storage.getShot(shotB.id);
  const keptC = storage.getShot(shotC.id);
  assert(keptB?.startImagePath === blue && keptC?.startImagePath === green, "original stills stay on the shots");
  assert(keptB?.chainedStartImagePath === doneB?.imagePath, "chained frame is the shot's stored still");
  const chainedPng = storage.resolveDataPath(keptB!.chainedStartImagePath!);
  const header = fs.readFileSync(chainedPng).subarray(0, 4);
  assert(header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47, "chained still is a png");
  assert(isRed(averageRgb(chainedPng)), "extracted frame keeps the previous clip's colour");
  assert(isRed(firstFrameRgb(storage.resolveDataPath(doneB!.outputPath!))), "shot 2 clip starts from that frame");
  assert(isRed(firstFrameRgb(storage.resolveDataPath(doneC!.outputPath!))), "shot 3 continues from shot 2");

  const clipDurations = [shotA, shotB, shotC].map((item) => {
    const job = storage
      .listJobs(continuity.id)
      .find((entry) => entry.shotId === item.id && entry.status === "completed" && entry.outputPath);
    return mediaDuration(storage.resolveDataPath(job!.outputPath!));
  });
  const clipSum = clipDurations.reduce((sum, value) => sum + value, 0);
  const faded = await stitch.stitchProject(continuity.id);
  const fadedAbs = storage.resolveDataPath(faded.outputPath);
  assert(fs.statSync(fadedAbs).size > 1000, "crossfade stitch is a real mp4");
  assert(faded.seams.length === 2 && faded.seams.every((seam) => seam.mode === "crossfade" && seam.fadeSec === 0.5), "both joins crossfade 0.5s");
  assert(faded.seams.every((seam) => seam.droppedFrames === 0), "a crossfade does not drop a frame");
  const fadedDur = mediaDuration(fadedAbs);
  assert(Math.abs(faded.durationSec - fadedDur) < 0.05, "reported stitch duration matches ffprobe");
  assert(
    Math.abs(fadedDur - (clipSum - 1)) <= 0.4,
    `crossfade duration ${fadedDur} should be about ${clipSum - 1}`
  );

  storage.updateProject(continuity.id, { seamMode: "cut" });
  storage.updateShot(shotC.id, { seamMode: "crossfade", seamFadeSec: 0.5 });
  const oneJoin = await stitch.stitchProject(continuity.id);
  assert(oneJoin.seams[0]?.mode === "cut" && oneJoin.seams[1]?.mode === "crossfade", "per-join override");
  assert(oneJoin.seams[0]?.droppedFrames === 1 && oneJoin.seams[1]?.droppedFrames === 0, "only the chained hard cut drops a frame");
  assert(
    Math.abs(oneJoin.durationSec - (clipSum - 0.5)) <= 0.4,
    `one crossfade duration ${oneJoin.durationSec} should be about ${clipSum - 0.5}`
  );

  storage.updateShot(shotC.id, { seamMode: null, seamFadeSec: null });
  const hardCut = await stitch.stitchProject(continuity.id);
  assert(hardCut.seams.every((seam) => seam.mode === "cut" && seam.droppedFrames === 1), "chained hard cuts drop the repeated frame");
  assert(
    hardCut.durationSec < clipSum - 0.05 && hardCut.durationSec > clipSum - 0.2,
    `hard cut duration ${hardCut.durationSec} should be about two frames shorter than ${clipSum}`
  );
  assert(hardCut.durationSec > faded.durationSec + 0.6, "hard cut is longer than the two crossfades");

  const skippedChain = render.renderAll(continuity.id);
  const joinTrimIds = (skippedChain.ok ? skippedChain.jobs : []).map((job) => job.shotId).sort();
  assert(
    skippedChain.ok && JSON.stringify(joinTrimIds) === JSON.stringify([shotB.id, shotC.id].sort()),
    `a hard cut's start-frame trim is part of the key, so the chained shots render again, got ${joinTrimIds.join(",")}`
  );
  assert(
    skippedChain.ok && skippedChain.skipped.some((item) => item.shotId === shotA.id && item.reason === "Reused an existing clip. No new spend."),
    "the unchained shot is reused when the trim does not apply"
  );
  for (const job of skippedChain.ok ? skippedChain.jobs : []) await providers.startJob(job.id);

  storage.updateShot(shotB.id, { chainFromPrevious: false });
  const afterOff = storage.listShots(continuity.id);
  assert(chainDepth(afterOff, shotB.id) === 0, "turning chaining off sets that shot to depth 0");
  assert(chainDepth(afterOff, shotC.id) === 1, "the next shot's depth stops at the break");
  assert(storage.getShot(shotB.id)?.startImagePath === blue, "turning chaining off leaves the original still");
  assert(
    storage.getShot(shotB.id)?.chainedStartImagePath === keptB?.chainedStartImagePath,
    "turning chaining off leaves the extracted frame"
  );
  const unchained = render.renderShot(shotB.id, { force: true });
  assert(unchained.ok && unchained.jobs.length === 1, "turning chaining off queues the original still");
  assert(unchained.ok && unchained.jobs[0].imagePath === blue && !unchained.jobs[0].awaitPreviousFrame, "off uses the user's still");
  await providers.startJob(unchained.ok ? unchained.jobs[0].id : "");
  const blueTake = storage.getJob(unchained.ok ? unchained.jobs[0].id : "");
  assert(blueTake?.status === "completed" && blueTake.outputPath, "unchained take completed");
  assert(isBlue(firstFrameRgb(storage.resolveDataPath(blueTake!.outputPath!))), "unchained clip starts on the user's still");
  assert(storage.getShot(shotB.id)?.startImagePath === blue, "user still still present after turning chaining off");

  const chainUploadsBefore = fs.readdirSync(path.join(dataDir, "uploads", continuity.id)).length;
  const chainJobsBefore = storage.listJobs(continuity.id).length;
  const chainPrompt = storage.getShot(shotC.id)?.prompt;
  storage.updateShot(shotC.id, { prompt: "nude child" });
  const refusedChain = render.renderAll(continuity.id);
  assert(!refusedChain.ok && refusedChain.refused, "chaining still refuses sexual content involving a minor before queue");
  assert(storage.listJobs(continuity.id).length === chainJobsBefore, "refused chain stored no job");
  assert(
    fs.readdirSync(path.join(dataDir, "uploads", continuity.id)).length === chainUploadsBefore,
    "refused chain stored no image"
  );
  storage.updateShot(shotC.id, { prompt: chainPrompt });

  const { STYLE_BASE_HONESTY, effectivePrompt } = await import("../src/lib/types");
  assert(/text only — not a character lock/i.test(STYLE_BASE_HONESTY), "helper says this is text only, not a character lock");
  assert(/identity can still drift/i.test(STYLE_BASE_HONESTY), "helper says identity can still drift");
  assert(/does not lock a face/i.test(STYLE_BASE_HONESTY), "helper does not promise a face lock");
  assert(/lip-sync/i.test(STYLE_BASE_HONESTY) && /long film/i.test(STYLE_BASE_HONESTY), "helper names the limits on lip-sync and a long film");
  const actionA = "Slow push toward the lanterns.";
  const actionB = "Drift right along the pier.";
  assert(
    effectivePrompt("dusk harbor, ", "the tide slides.") === "dusk harbor, the tide slides.",
    "join trims a trailing comma"
  );
  assert(
    effectivePrompt("dusk harbor,", ", the tide slides.") === "dusk harbor, the tide slides.",
    "join drops a double comma"
  );
  assert(effectivePrompt("", actionA) === actionA, "empty style base keeps the shot prompt");
  assert(effectivePrompt("   ", actionA) === actionA, "blank style base keeps the shot prompt");
  assert(effectivePrompt(",,,", actionA) === actionA, "comma-only style base keeps the shot prompt");
  assert(effectivePrompt("warm light,", "") === "warm light", "dangling comma is dropped when the shot prompt is empty");
  assert(
    !safety.isDisallowedMinorSexualContent("soft nude lighting"),
    "style base alone is not a minor-sexual refusal"
  );
  assert(
    !safety.isDisallowedMinorSexualContent("a child walks the pier"),
    "shot action alone is not a minor-sexual refusal"
  );
  assert(
    safety.isDisallowedMinorSexualContent(effectivePrompt("soft nude lighting", "a child walks the pier")),
    "joined style base and shot action is refused"
  );

  const columns = storage.getDb().prepare("PRAGMA table_info(projects)").all() as { name: string }[];
  assert(columns.some((column) => column.name === "style_base"), "projects.style_base exists");
  assert(storage.getProject(SAMPLE_PROJECT_ID)?.styleBase === "", "harbor dusk leaves style base empty");

  const styled = storage.createProject("Style base");
  assert(storage.getProject(styled.id)?.styleBase === "", "new project style base is empty");
  const base = "Dusk harbor, warm lantern light, same wool coat";
  storage.updateProject(styled.id, { styleBase: `  ${base},  ` });
  assert(storage.getProject(styled.id)?.styleBase === `${base},`, "style base is stored trimmed");
  const styleA = storage.createShot({
    projectId: styled.id,
    prompt: actionA,
    presetId: "slow-zoom-in",
    durationSec: 2,
    startImagePath: red,
  });
  const styleB = storage.createShot({
    projectId: styled.id,
    prompt: actionB,
    presetId: "pan-right",
    durationSec: 2,
    startImagePath: blue,
  });
  assert(storage.getShot(styleA.id)?.prompt === actionA, "shot prompt is not rewritten into the base");
  const joinedA = `${base}, ${actionA}`;
  const joinedB = `${base}, ${actionB}`;
  const styledTake = render.renderShot(styleA.id);
  assert(styledTake.ok && styledTake.jobs.length === 1, "style base take queued");
  assert(styledTake.ok && styledTake.jobs[0].prompt === joinedA, "take job stores the joined prompt");
  assert(styledTake.ok && styledTake.jobs[0].provider === "mock", "style base take uses Mock");
  await mock.runMockGenerate(styledTake.ok ? styledTake.jobs[0].id : "");
  const styledDone = storage.getJob(styledTake.ok ? styledTake.jobs[0].id : "");
  assert(styledDone?.status === "completed" && styledDone.outputPath, "style base Mock take rendered an mp4");
  assert(
    fs.statSync(storage.resolveDataPath(styledDone!.outputPath!)).size > 1000,
    "style base mp4 is a real file"
  );
  assert(storage.getShot(styleA.id)?.prompt === actionA, "completed take left the shot prompt as the action");

  const styledPreview = render.previewAll(styled.id);
  assert(styledPreview.ok && styledPreview.jobs.length === 2, "preview queues every shot");
  assert(
    styledPreview.ok &&
      styledPreview.jobs.find((job) => job.shotId === styleA.id)?.prompt === joinedA &&
      styledPreview.jobs.find((job) => job.shotId === styleB.id)?.prompt === joinedB,
    "preview jobs store the joined prompt"
  );
  for (const job of styledPreview.ok ? styledPreview.jobs : []) {
    await mock.runMockGenerate(job.id);
    const done = storage.getJob(job.id);
    assert(done?.status === "completed" && done.prompt === effectivePrompt(base + ",", storage.getShot(job.shotId!)!.prompt), "preview clip kept the joined prompt");
    assert(done?.outputPath && fs.statSync(storage.resolveDataPath(done.outputPath)).size > 1000, "preview mp4 with style base");
  }

  const matched = render.renderAll(styled.id);
  assert(matched.ok && matched.jobs.length === 1 && matched.jobs[0].shotId === styleB.id, "matching joined take is skipped");
  assert(matched.ok && matched.jobs[0].prompt === joinedB, "the shot that still needs a take gets the joined prompt");

  storage.updateProject(styled.id, { styleBase: "" });
  assert(storage.getProject(styled.id)?.styleBase === "", "style base can be cleared");
  const plain = render.renderShot(styleA.id, { force: true });
  assert(plain.ok && plain.jobs[0].prompt === actionA, "empty style base leaves the shot prompt unchanged on the job");
  await mock.runMockGenerate(plain.ok ? plain.jobs[0].id : "");
  assert(storage.getJob(plain.ok ? plain.jobs[0].id : "")?.status === "completed", "empty style base still renders Mock");

  const jobsBeforeStyleRefusal = storage.listJobs(styled.id).length;
  storage.updateProject(styled.id, { styleBase: "soft nude lighting" });
  storage.updateShot(styleB.id, { prompt: "a child walks the pier" });
  const refusedStyle = render.renderAll(styled.id);
  assert(!refusedStyle.ok && refusedStyle.refused, "joined style base and shot prompt is refused before queue");
  const refusedStylePreview = render.previewAll(styled.id);
  assert(!refusedStylePreview.ok && refusedStylePreview.refused, "preview refuses the joined prompt before queue");
  assert(storage.listJobs(styled.id).length === jobsBeforeStyleRefusal, "refused style base stored no job");

  const {
    clampChainFrameBack,
    frameIndexFromEnd,
    chainFramePhrase,
    SEAM_FRAME_HONESTY,
    FRAME_BACK_HONESTY,
    DROPPED_FRAME_NOTE,
    FRAME_BACK_SEAM_NOTE,
    clampChainTrimStartFrames,
    chainTrimFromDropDuplicate,
    projectChainTrimFromStored,
    shotChainTrimFromStored,
    startFrameTrimNote,
  } = await import("../src/lib/types");
  assert(clampChainFrameBack(0) === 0, "0 stays the last frame");
  assert(clampChainFrameBack(-4) === 0, "negative frame back clamps to 0");
  assert(clampChainFrameBack(12) === 12, "12 is the far end of the range");
  assert(clampChainFrameBack(13) === 12 && clampChainFrameBack(40) === 12, "past 12 clamps to 12");
  assert(clampChainFrameBack(1.6) === 2, "frame back rounds to the nearest frame");
  assert(clampChainFrameBack(Number.NaN) === 0, "NaN frame back falls back to 0");
  assert(clampChainFrameBack(Number.POSITIVE_INFINITY) === 0, "infinite frame back falls back to 0");
  assert(
    frameIndexFromEnd(48, 0).index === 47 && frameIndexFromEnd(48, 0).appliedBack === 0,
    "0 selects the last index"
  );
  assert(
    frameIndexFromEnd(48, 12).index === 35 && frameIndexFromEnd(48, 12).appliedBack === 12,
    "12 steps back twelve frames"
  );
  assert(
    frameIndexFromEnd(5, 12).index === 0 && frameIndexFromEnd(5, 12).appliedBack === 4,
    "a short clip cannot step past its first frame"
  );
  assert(frameIndexFromEnd(1, 3).appliedBack === 0, "a one-frame clip is the exact last frame");
  assert(frameIndexFromEnd(0, 0).appliedBack === 0, "an empty count does not invent a frame");
  assert(chainFramePhrase(0) === "last frame" && chainFramePhrase(4) === "frame 4 before the end", "frame phrases");

  const exactJoin = {
    seamMode: "cut" as const,
    chainFromPrevious: true,
    dropEnabled: true,
    previousJobId: "prev",
    chainedFromJobId: "prev",
    chainedFrameBack: 0 as number | null,
    takeUsedChainedStill: true,
  };
  assert(stitch.dropStartFramesForJoin(exactJoin) === 1, "chained exact hard cut drops one frame");
  assert(stitch.dropStartFramesForJoin({ ...exactJoin, trimFrames: 1 }) === 1, "default trim 1 drops one start frame");
  assert(stitch.dropStartFramesForJoin({ ...exactJoin, trimFrames: 3 }) === 3, "trim 3 drops 3 start frames");
  assert(stitch.dropStartFramesForJoin({ ...exactJoin, trimFrames: 0 }) === 0, "trim 0 keeps every frame");
  assert(stitch.dropStartFramesForJoin({ ...exactJoin, trimFrames: 4 }) === 4, "trim 4 is the far end of the range");
  assert(stitch.dropStartFramesForJoin({ ...exactJoin, trimFrames: 9 }) === 4, "trim past 4 clamps to 4");
  assert(stitch.dropStartFramesForJoin({ ...exactJoin, seamMode: "crossfade" }) === 0, "crossfade does not drop");
  assert(
    stitch.dropStartFramesForJoin({ ...exactJoin, trimFrames: 3, seamMode: "crossfade" }) === 0,
    "crossfade ignores trim"
  );
  assert(stitch.dropStartFramesForJoin({ ...exactJoin, chainFromPrevious: false }) === 0, "unchained does not drop");
  assert(
    stitch.dropStartFramesForJoin({ ...exactJoin, trimFrames: 3, chainFromPrevious: false }) === 0,
    "unchained ignores trim"
  );
  assert(stitch.dropStartFramesForJoin({ ...exactJoin, dropEnabled: false }) === 0, "turning the drop off keeps both frames");
  assert(
    stitch.dropStartFramesForJoin({ ...exactJoin, trimFrames: 3, dropEnabled: false }) === 3,
    "a numeric trim wins over the old boolean"
  );
  assert(stitch.dropStartFramesForJoin({ ...exactJoin, chainedFrameBack: 4 }) === 0, "frame back 4 is not an exact duplicate");
  assert(
    stitch.dropStartFramesForJoin({ ...exactJoin, trimFrames: 3, chainedFrameBack: 2 }) === 0,
    "a stepped-back chain ignores trim"
  );
  assert(stitch.dropStartFramesForJoin({ ...exactJoin, chainedFrameBack: null }) === 1, "an older last-frame extract still drops");
  assert(stitch.dropStartFramesForJoin({ ...exactJoin, chainedFromJobId: "other" }) === 0, "a different previous take is not dropped");
  assert(
    stitch.dropStartFramesForJoin({ ...exactJoin, takeUsedChainedStill: false }) === 0,
    "a take that did not use the chained still is not dropped"
  );
  assert(stitch.applyDropLimit(1, 1) === 0, "a single frame is not dropped");
  assert(stitch.applyDropLimit(1, 2) === 1, "two frames can lose the first");
  assert(stitch.applyDropLimit(3, 3) === 0, "trim cannot empty a 3-frame clip");
  assert(stitch.applyDropLimit(3, 4) === 3, "a 4-frame clip can lose 3 start frames");
  assert(stitch.applyDropLimit(4, 12) === 4, "trim of 4 stays 4 when the clip is longer");
  assert(stitch.applyDropLimit(0, 12) === 0, "trim 0 keeps the clip");
  assert(
    stitch.duplicateFrameDropEnabled({ dropDuplicateFrame: true }, { dropDuplicateFrame: null }) === true,
    "a shot with no override inherits the project drop"
  );
  assert(
    stitch.duplicateFrameDropEnabled({ dropDuplicateFrame: true }, { dropDuplicateFrame: false }) === false,
    "a shot can turn the drop off"
  );
  assert(
    stitch.duplicateFrameDropEnabled({ dropDuplicateFrame: false }, { dropDuplicateFrame: true }) === true,
    "a shot can turn the drop on"
  );
  assert(
    stitch.duplicateFrameDropEnabled({ dropDuplicateFrame: false }, {}) === false,
    "a shot inherits the project when the drop is off"
  );
  assert(
    stitch.resolveChainTrimStartFrames({ dropDuplicateFrame: true }, {}) === 1,
    "old project true migrates to trim 1"
  );
  assert(
    stitch.resolveChainTrimStartFrames({ dropDuplicateFrame: false }, {}) === 0,
    "old project false migrates to trim 0"
  );
  assert(
    stitch.resolveChainTrimStartFrames({ chainTrimStartFrames: 3 }, { chainTrimStartFrames: null }) === 3,
    "a shot with no override inherits trim 3"
  );
  assert(
    stitch.resolveChainTrimStartFrames({ chainTrimStartFrames: 3 }, { chainTrimStartFrames: 0 }) === 0,
    "a shot can keep every frame"
  );
  assert(
    stitch.resolveChainTrimStartFrames({ chainTrimStartFrames: 0 }, { dropDuplicateFrame: true }) === 1,
    "an old shot boolean true still means trim 1"
  );
  assert(
    stitch.resolveChainTrimStartFrames({ chainTrimStartFrames: 1 }, { dropDuplicateFrame: false }) === 0,
    "an old shot boolean false still means trim 0"
  );
  assert(
    stitch.resolveChainTrimStartFrames({ dropDuplicateFrame: false, chainTrimStartFrames: 4 }, {}) === 4,
    "numeric project trim wins over the old boolean"
  );
  assert(chainTrimFromDropDuplicate(true) === 1 && chainTrimFromDropDuplicate(false) === 0, "boolean migration is 1 or 0");
  assert(projectChainTrimFromStored(null, 0) === 0, "a project row with only drop false reads as trim 0");
  assert(projectChainTrimFromStored(null, 1) === 1, "a project row with only drop true reads as trim 1");
  assert(projectChainTrimFromStored(undefined, false) === 0, "a false boolean still reads when the trim column is missing");
  assert(projectChainTrimFromStored(3, 0) === 3, "a stored trim of 3 wins over the old boolean");
  assert(shotChainTrimFromStored(null, null) == null, "a shot row with both empty inherits");
  assert(
    shotChainTrimFromStored(null, 0) === 0 && shotChainTrimFromStored(null, 1) === 1,
    "a shot row still reads the old boolean"
  );
  assert(shotChainTrimFromStored(2, 0) === 2, "a stored shot trim wins over the old boolean");
  assert(clampChainTrimStartFrames(5) === 4 && clampChainTrimStartFrames(-2) === 0, "trim clamps to 0–4");
  assert(clampChainTrimStartFrames(Number.NaN) === 1, "a bad trim falls back to 1");

  const plainFilter = stitch.hardCutFilterComplex([0, 0]);
  assert(!plainFilter.includes("trim="), "unchained hard cut filter has no trim");
  assert(plainFilter.includes("concat=n=2:v=1:a=0[v]"), "unchained concat stays a plain concat");
  const dropFilter = stitch.hardCutFilterComplex([0, 1, 0]);
  assert(!dropFilter.split("[v0]")[0].includes("trim="), "the leading clip stays whole");
  assert(dropFilter.split("[v1]")[0].includes("trim=start_frame=1"), "the chained clip drops its first frame");
  assert(!dropFilter.split("[v2]")[0].split("[v1]")[1]?.includes("trim="), "an unchained later clip is not trimmed");
  const ffmpegArgs = stitch.hardCutArgs(["a.mp4", "b.mp4"], "out.mp4", [0, 1]);
  assert(ffmpegArgs[0] === "-y" && ffmpegArgs.includes("a.mp4") && ffmpegArgs.includes("b.mp4"), "ffmpeg args name the clips");
  assert(ffmpegArgs[ffmpegArgs.indexOf("-filter_complex") + 1] === stitch.hardCutFilterComplex([0, 1]), "ffmpeg args carry the drop filter");
  assert(stitch.hardCutFilterComplex([0, 3]).includes("trim=start_frame=3"), "a trim of 3 names start_frame=3");
  assert(stitch.pairCutFilter(3).includes("trim=start_frame=3"), "a pair cut can trim three start frames");
  assert(stitch.pairCutFilter(0) === "[0:v][1:v]concat=n=2:v=1:a=0[v]", "a cut with the drop off matches the old concat");
  assert(
    stitch.pairCutFilter(1) === "[1:v]trim=start_frame=1,setpts=PTS-STARTPTS[b];[0:v][b]concat=n=2:v=1:a=0[v]",
    "a mixed stitch trims only the incoming clip"
  );
  const fadeArgs = stitch.crossfadeFilter(0.5, 1.5);
  assert(
    fadeArgs === "[0:v][1:v]xfade=transition=fade:duration=0.500:offset=1.500,format=yuv420p[v]",
    "crossfade args are unchanged"
  );
  assert(!fadeArgs.includes("trim="), "crossfade filter does not drop a frame");

  assert(/repeated frame/i.test(SEAM_FRAME_HONESTY), "copy says this removes a repeated frame");
  assert(/does not fix identity or detail drift/i.test(SEAM_FRAME_HONESTY), "copy says drift is not fixed");
  assert(/crossfade/i.test(SEAM_FRAME_HONESTY), "copy says a crossfade is left as-is");
  assert(/not chained/i.test(SEAM_FRAME_HONESTY), "copy says an unchained shot is left as-is");
  assert(/lip-sync/i.test(SEAM_FRAME_HONESTY) && /long film/i.test(SEAM_FRAME_HONESTY), "copy names lip-sync and a long film as out of scope");
  assert(
    !/character lock|will fix|fixes identity/i.test(`${SEAM_FRAME_HONESTY} ${FRAME_BACK_HONESTY} ${DROPPED_FRAME_NOTE}`),
    "copy does not claim a lock or a fix"
  );
  assert(/exact last frame/i.test(FRAME_BACK_HONESTY), "frame-back copy says the drop is only for the exact last frame");
  assert(/leaves the previous take whole/i.test(FRAME_BACK_HONESTY), "frame-back copy says the previous take is not trimmed");
  assert(/nothing was dropped/i.test(FRAME_BACK_SEAM_NOTE), "the seam note says a stepped-back join drops nothing");
  assert(/trim 0.4 frames/i.test(SEAM_FRAME_HONESTY), "copy names the 0–4 trim");
  assert(/default is 1/i.test(SEAM_FRAME_HONESTY), "copy says the default trim is 1");
  assert(/re-enact/i.test(SEAM_FRAME_HONESTY), "copy says the trim softens a re-enacted freeze");
  assert(/identity continuous/i.test(SEAM_FRAME_HONESTY), "copy says identity is not kept continuous");
  assert(/stepping back/i.test(SEAM_FRAME_HONESTY), "copy says a stepped-back start is left as-is");
  assert(startFrameTrimNote(1) === DROPPED_FRAME_NOTE, "a one-frame trim keeps the repeated-frame note");
  assert(/Trimmed 3 start frames/i.test(startFrameTrimNote(3)), "a trim of 3 is named in the seam note");
  assert(
    !/character lock|will fix|fixes identity/i.test(startFrameTrimNote(3)),
    "the longer trim note does not claim a lock or a fix"
  );

  const seamProject = storage.createProject("Seam frames");
  assert(storage.getProject(seamProject.id)?.dropDuplicateFrame === true, "a new project drops the repeated frame");
  assert(storage.getProject(seamProject.id)?.chainTrimStartFrames === 1, "a new project trims 1 start frame");
  const still = storage.saveUpload(seamProject.id, "still.png", solidPng(dataDir, "seam-still.png", "gray"));
  const shotPrev = storage.createShot({
    projectId: seamProject.id,
    prompt: "Opening shot.",
    presetId: "slow-zoom-in",
    durationSec: 1,
    startImagePath: still,
  });
  const shotNext = storage.createShot({
    projectId: seamProject.id,
    prompt: "Chained shot.",
    presetId: "slow-zoom-in",
    durationSec: 1,
    startImagePath: still,
    chainFromPrevious: true,
  });
  assert(storage.getShot(shotNext.id)?.chainFrameBack === 0, "frame back defaults to 0");
  storage.updateShot(shotNext.id, { chainFrameBack: 99 });
  assert(storage.getShot(shotNext.id)?.chainFrameBack === 12, "stored frame back clamps to 12");
  storage.updateShot(shotNext.id, { chainFrameBack: -3 });
  assert(storage.getShot(shotNext.id)?.chainFrameBack === 0, "stored negative frame back clamps to 0");
  storage.updateProject(seamProject.id, { dropDuplicateFrame: false });
  assert(storage.getProject(seamProject.id)?.dropDuplicateFrame === false, "the project can keep both frames");
  assert(storage.getProject(seamProject.id)?.chainTrimStartFrames === 0, "writing the old false boolean stores trim 0");
  storage.updateShot(shotNext.id, { dropDuplicateFrame: false });
  assert(storage.getShot(shotNext.id)?.dropDuplicateFrame === false, "a shot can keep both frames");
  assert(storage.getShot(shotNext.id)?.chainTrimStartFrames === 0, "writing the old shot false boolean stores trim 0");
  storage.updateShot(shotNext.id, { dropDuplicateFrame: null });
  assert(storage.getShot(shotNext.id)?.dropDuplicateFrame == null, "a shot can inherit the project again");
  assert(storage.getShot(shotNext.id)?.chainTrimStartFrames == null, "clearing the old shot boolean inherits again");
  storage.updateProject(seamProject.id, { chainTrimStartFrames: 3 });
  assert(storage.getProject(seamProject.id)?.chainTrimStartFrames === 3, "the project can trim 3 start frames");
  assert(storage.getProject(seamProject.id)?.dropDuplicateFrame === true, "trim above 0 still reads as the old drop-on flag");
  storage.updateProject(seamProject.id, { chainTrimStartFrames: 9 });
  assert(storage.getProject(seamProject.id)?.chainTrimStartFrames === 4, "stored project trim clamps to 4");
  storage.updateShot(shotNext.id, { chainTrimStartFrames: 2 });
  assert(storage.getShot(shotNext.id)?.chainTrimStartFrames === 2, "a shot can trim 2 start frames");
  storage.updateShot(shotNext.id, { chainTrimStartFrames: null });
  assert(storage.getShot(shotNext.id)?.chainTrimStartFrames == null, "a shot can inherit the project trim again");
  storage.updateProject(seamProject.id, { dropDuplicateFrame: true, seamMode: "cut" });
  assert(storage.getProject(seamProject.id)?.chainTrimStartFrames === 1, "writing the old true boolean stores trim 1");

  const clipA = storage.absoluteOutputPath(seamProject.id, "clip-a.mp4");
  concatColors(clipA.abs, [
    { color: "black", frames: 8 },
    { color: "blue", frames: 1 },
    { color: "black", frames: 2 },
    { color: "red", frames: 1 },
  ]);
  assert(frameCountOf(clipA.abs) === 12, `clip A should be 12 frames, got ${frameCountOf(clipA.abs)}`);
  assert(isRed(frameRgbAt(clipA.abs, 11)), "the last frame of clip A is red");
  assert(isBlue(frameRgbAt(clipA.abs, 8)), "the frame three back from the end of clip A is blue");
  const jobA = storage.createJob({
    projectId: seamProject.id,
    shotId: shotPrev.id,
    prompt: "Opening shot.",
    presetId: "slow-zoom-in",
    provider: "mock",
    status: "completed",
    imagePath: still,
    durationSec: 1,
  });
  storage.updateJob(jobA.id, { status: "completed", outputPath: clipA.rel, progress: 100 });

  const continuityLib = await import("../src/lib/continuity");
  const queueExtract = () =>
    storage.createJob({
      projectId: seamProject.id,
      shotId: shotNext.id,
      prompt: "Chained shot.",
      presetId: "slow-zoom-in",
      provider: "mock",
      status: "queued",
      imagePath: continuityLib.CHAIN_PENDING_IMAGE,
      awaitPreviousFrame: true,
      durationSec: 1,
    });
  storage.updateShot(shotNext.id, { chainFrameBack: 0, chainFromPrevious: true });
  const exactJob = queueExtract();
  assert(await continuityLib.resolveJobChain(exactJob.id), "extract of the last frame succeeded with no API key");
  const exactShot = storage.getShot(shotNext.id);
  const exactStill = exactShot?.chainedStartImagePath;
  assert(exactShot?.chainedFrameBack === 0 && exactShot.chainedFrameRequest === 0, "exact extract records 0 frames back");
  assert(exactStill && isRed(averageRgb(storage.resolveDataPath(exactStill))), "the stored still is the red last frame");
  assert(!process.env.FAL_KEY && !process.env.REPLICATE_API_TOKEN, "frame extract did not need a provider key");
  storage.updateJob(exactJob.id, { status: "cancelled" });

  storage.updateShot(shotNext.id, { chainFrameBack: 3 });
  assert(continuityLib.startImageForMatch(storage.getShot(shotNext.id)!) === "", "a new frame-back does not reuse the old still");
  const noted = render.renderShot(shotNext.id);
  assert(noted.ok && noted.jobs.length === 1 && noted.jobs[0].provider === "mock", "frame back still renders on Mock with no API key");
  assert(noted.ok && noted.jobs[0].awaitPreviousFrame, "the new frame is extracted before the provider runs");
  assert(
    noted.ok && /frame 3 before the end/i.test(noted.jobs[0].providerNote || ""),
    "the note names the earlier frame"
  );
  assert(
    noted.ok && /drift/i.test(noted.jobs[0].providerNote || "") && !/start still is the last frame/i.test(noted.jobs[0].providerNote || ""),
    "the note does not pretend an earlier frame is the last frame"
  );
  const backJob = noted.ok ? noted.jobs[0] : queueExtract();
  assert(await continuityLib.resolveJobChain(backJob.id), "extract three frames back succeeded");
  const backShot = storage.getShot(shotNext.id);
  const blueStill = backShot?.chainedStartImagePath;
  assert(backShot?.chainedFrameBack === 3 && backShot.chainedFrameRequest === 3, "three frames back is what was stored");
  assert(blueStill && isBlue(averageRgb(storage.resolveDataPath(blueStill))), "the still is the blue frame, not the red last frame");
  assert(blueStill !== exactStill, "a different frame is a different still");
  storage.updateJob(backJob.id, { status: "cancelled" });

  storage.updateShot(shotNext.id, { chainFrameBack: 12 });
  const farJob = queueExtract();
  assert(await continuityLib.resolveJobChain(farJob.id), "extract twelve frames back succeeded");
  const farShot = storage.getShot(shotNext.id);
  assert(
    farShot?.chainedFrameRequest === 12 && farShot.chainedFrameBack === 11,
    `twelve frames back on a 12-frame clip lands on the first frame, got request ${farShot?.chainedFrameRequest} applied ${farShot?.chainedFrameBack}`
  );
  assert(
    stitch.dropStartFramesForJoin({
      seamMode: "cut",
      chainFromPrevious: true,
      trimFrames: 4,
      previousJobId: jobA.id,
      chainedFromJobId: farShot?.chainedFromJobId,
      chainedFrameBack: farShot?.chainedFrameBack,
      takeUsedChainedStill: true,
    }) === 0,
    "stepping back means the seam frames are not the same, so nothing is dropped"
  );

  const clipRed = storage.absoluteOutputPath(seamProject.id, "clip-b-red.mp4");
  const clipBlue = storage.absoluteOutputPath(seamProject.id, "clip-b-blue.mp4");
  concatColors(clipRed.abs, [
    { color: "red", frames: 1 },
    { color: "green", frames: 11 },
  ]);
  concatColors(clipBlue.abs, [
    { color: "blue", frames: 1 },
    { color: "green", frames: 11 },
  ]);
  const jobB = storage.createJob({
    projectId: seamProject.id,
    shotId: shotNext.id,
    prompt: "Chained shot.",
    presetId: "slow-zoom-in",
    provider: "mock",
    status: "completed",
    imagePath: exactStill!,
    durationSec: 1,
  });
  storage.updateJob(jobB.id, { status: "completed", outputPath: clipRed.rel, progress: 100, imagePath: exactStill });
  storage.selectTake(shotNext.id, jobB.id);
  storage.updateShot(shotNext.id, {
    chainFromPrevious: true,
    chainFrameBack: 0,
    chainedStartImagePath: exactStill,
    chainedFromJobId: jobA.id,
    chainedFrameBack: 0,
    chainedFrameRequest: 0,
    dropDuplicateFrame: null,
    seamMode: null,
  });

  const droppedCut = await stitch.stitchProject(seamProject.id);
  assert(fs.statSync(storage.resolveDataPath(droppedCut.outputPath)).size > 1000, "chained hard cut stitch is an mp4");
  assert(droppedCut.seams.length === 1 && droppedCut.seams[0].mode === "cut" && droppedCut.seams[0].droppedFrames === 1, "the chained cut drops one frame");
  assert(droppedCut.seams[0].note === DROPPED_FRAME_NOTE, "the seam note says the repeated frame was dropped and drift is not fixed");
  const droppedAbs = storage.resolveDataPath(droppedCut.outputPath);
  assert(frameCountOf(droppedAbs) === 23, `dropped stitch should be 23 frames, got ${frameCountOf(droppedAbs)}`);
  const around = [10, 11, 12, 13].map((index) => ({ index, ...frameRgbAt(droppedAbs, index) }));
  const greenish = (color: { r: number; g: number; b: number }) => color.g > 100 && color.r < 40 && color.b < 40;
  assert(
    isRed(around[1]),
    `the shared frame still plays once, as the end of the first clip; nearby ${JSON.stringify(around)}`
  );
  assert(
    greenish(around[2]) && !isRed(around[2]),
    `the next frame is the second frame of the next clip, not a second red; nearby ${JSON.stringify(around)}`
  );

  storage.updateProject(seamProject.id, { chainTrimStartFrames: 3 });
  const trim3Cut = await stitch.stitchProject(seamProject.id);
  assert(trim3Cut.seams[0]?.mode === "cut" && trim3Cut.seams[0]?.droppedFrames === 3, "trim 3 drops 3 start frames");
  assert(trim3Cut.seams[0]?.note === startFrameTrimNote(3), "the seam note names the three-frame trim");
  const trim3Abs = storage.resolveDataPath(trim3Cut.outputPath);
  assert(frameCountOf(trim3Abs) === 21, `trim 3 should leave 21 frames, got ${frameCountOf(trim3Abs)}`);
  assert(isRed(frameRgbAt(trim3Abs, 11)), "trim 3 still keeps the previous take's last frame");
  assert(
    greenish(frameRgbAt(trim3Abs, 12)) && !isRed(frameRgbAt(trim3Abs, 12)),
    "trim 3 removes the re-enacted red frame and the next two frames"
  );

  storage.updateProject(seamProject.id, { chainTrimStartFrames: 0 });
  const trim0Cut = await stitch.stitchProject(seamProject.id);
  assert(trim0Cut.seams[0]?.droppedFrames === 0 && trim0Cut.seams[0]?.mode === "cut", "trim 0 keeps every frame");
  assert(frameCountOf(storage.resolveDataPath(trim0Cut.outputPath)) === 24, "trim 0 stitch keeps 24 frames");

  storage.updateProject(seamProject.id, { dropDuplicateFrame: false });
  const keptCut = await stitch.stitchProject(seamProject.id);
  assert(keptCut.seams[0]?.droppedFrames === 0 && keptCut.seams[0]?.mode === "cut", "the project can keep the repeated frame");
  const keptAbs = storage.resolveDataPath(keptCut.outputPath);
  assert(frameCountOf(keptAbs) === 24, `keeping both frames should be 24 frames, got ${frameCountOf(keptAbs)}`);
  assert(isRed(frameRgbAt(keptAbs, 11)) && isRed(frameRgbAt(keptAbs, 12)), "with the drop off the red frame plays twice");

  storage.updateProject(seamProject.id, { chainTrimStartFrames: 0 });
  storage.updateShot(shotNext.id, { chainTrimStartFrames: 3 });
  const shotOverride = await stitch.stitchProject(seamProject.id);
  assert(shotOverride.seams[0]?.droppedFrames === 3, "a shot can override the project and trim 3");
  assert(
    frameCountOf(storage.resolveDataPath(shotOverride.outputPath)) === 21,
    "a shot trim of 3 leaves 21 frames"
  );

  storage.updateProject(seamProject.id, { chainTrimStartFrames: 3, seamMode: "cut" });
  storage.updateShot(shotNext.id, {
    dropDuplicateFrame: null,
    chainFrameBack: 3,
    chainedFrameBack: 3,
    chainedFrameRequest: 3,
    chainedStartImagePath: blueStill,
    chainedFromJobId: jobA.id,
    chainFromPrevious: true,
  });
  storage.updateJob(jobB.id, { imagePath: blueStill, outputPath: clipBlue.rel });
  const offsetCut = await stitch.stitchProject(seamProject.id);
  assert(offsetCut.seams[0]?.mode === "cut" && offsetCut.seams[0]?.droppedFrames === 0, "frame back does not drop a frame");
  assert(offsetCut.seams[0]?.note === FRAME_BACK_SEAM_NOTE, "the seam says the frames differ so nothing was dropped");
  const offsetAbs = storage.resolveDataPath(offsetCut.outputPath);
  assert(frameCountOf(offsetAbs) === 24, `a stepped-back cut should keep 24 frames, got ${frameCountOf(offsetAbs)}`);
  assert(isRed(frameRgbAt(offsetAbs, 11)), "the previous take still ends on its last frame");
  assert(isBlue(frameRgbAt(offsetAbs, 12)), "the next take starts on the earlier frame, which is not a copy of that last frame");

  storage.updateProject(seamProject.id, { seamMode: "crossfade", seamFadeSec: 0.25 });
  const offsetFade = await stitch.stitchProject(seamProject.id);
  assert(
    offsetFade.seams[0]?.mode === "crossfade" &&
      offsetFade.seams[0]?.droppedFrames === 0 &&
      offsetFade.seams[0]?.fadeSec === 0.25,
    `a crossfade of a chained shot is unchanged, got ${offsetFade.seams[0]?.mode} drop ${offsetFade.seams[0]?.droppedFrames} fade ${offsetFade.seams[0]?.fadeSec} note ${offsetFade.seams[0]?.note ?? ""}`
  );

  storage.updateProject(seamProject.id, { seamMode: "cut", chainTrimStartFrames: 4 });
  storage.updateShot(shotNext.id, { chainFromPrevious: false, seamMode: null, chainTrimStartFrames: null });
  storage.updateJob(jobB.id, { imagePath: exactStill, outputPath: clipRed.rel });
  const unchainedCut = await stitch.stitchProject(seamProject.id);
  assert(unchainedCut.seams[0]?.mode === "cut" && unchainedCut.seams[0]?.droppedFrames === 0, "an unchained hard cut does not drop a frame");
  const unchainedAbs = storage.resolveDataPath(unchainedCut.outputPath);
  assert(frameCountOf(unchainedAbs) === 24, `an unchained cut should keep 24 frames, got ${frameCountOf(unchainedAbs)}`);
  assert(
    isRed(frameRgbAt(unchainedAbs, 11)) && isRed(frameRgbAt(unchainedAbs, 12)),
    "matching pixels are not enough; an unchained join keeps both frames"
  );

  storage.updateProject(seamProject.id, { seamMode: "crossfade", seamFadeSec: 0.25, chainTrimStartFrames: 4 });
  storage.updateShot(shotNext.id, {
    chainFromPrevious: true,
    seamMode: null,
    chainFrameBack: 0,
    chainedFrameBack: 0,
    chainedFrameRequest: 0,
    chainedStartImagePath: exactStill,
    chainedFromJobId: jobA.id,
    chainTrimStartFrames: null,
  });
  storage.updateJob(jobB.id, { imagePath: exactStill, outputPath: clipRed.rel });
  const fadeIgnoresTrim = await stitch.stitchProject(seamProject.id);
  assert(
    fadeIgnoresTrim.seams[0]?.mode === "crossfade" && fadeIgnoresTrim.seams[0]?.droppedFrames === 0,
    `a crossfade ignores a trim of 4, got ${fadeIgnoresTrim.seams[0]?.mode} drop ${fadeIgnoresTrim.seams[0]?.droppedFrames}`
  );

  const clipShort = storage.absoluteOutputPath(seamProject.id, "clip-short.mp4");
  concatColors(clipShort.abs, [
    { color: "red", frames: 1 },
    { color: "green", frames: 1 },
  ]);
  storage.updateProject(seamProject.id, { seamMode: "cut", chainTrimStartFrames: 4 });
  storage.updateJob(jobB.id, { imagePath: exactStill, outputPath: clipShort.rel });
  const cappedTrim = await stitch.stitchProject(seamProject.id);
  assert(cappedTrim.seams[0]?.mode === "cut" && cappedTrim.seams[0]?.droppedFrames === 0, "trim is capped so a short clip is not emptied");
  assert(/too short/i.test(cappedTrim.seams[0]?.note || ""), "the seam says the clip was too short to trim");
  const cappedAbs = storage.resolveDataPath(cappedTrim.outputPath);
  assert(frameCountOf(cappedAbs) === 14, `a capped trim should keep 14 frames, got ${frameCountOf(cappedAbs)}`);

  const liveDb = storage.getDb();
  liveDb.prepare("UPDATE shots SET chain_trim_start_frames = NULL, drop_duplicate_frame = 0 WHERE id = ?").run(shotNext.id);
  assert(storage.getShot(shotNext.id)?.chainTrimStartFrames === 0, "a null trim column still reads drop false as 0");
  liveDb.prepare("UPDATE shots SET chain_trim_start_frames = NULL, drop_duplicate_frame = 1 WHERE id = ?").run(shotNext.id);
  assert(storage.getShot(shotNext.id)?.chainTrimStartFrames === 1, "a null trim column still reads drop true as 1");
  liveDb.prepare("UPDATE shots SET chain_trim_start_frames = NULL, drop_duplicate_frame = NULL WHERE id = ?").run(shotNext.id);
  assert(storage.getShot(shotNext.id)?.chainTrimStartFrames == null, "both empty columns still inherit");

  const savedData = process.env.STAR_DUST_DATA;
  const holder = globalThis as typeof globalThis & { starDustDb?: { close: () => void } };
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "star-dust-legacy-"));
  try {
    holder.starDustDb?.close();
    delete holder.starDustDb;
    const Database = (await import("better-sqlite3")).default;
    const legacy = new Database(path.join(legacyDir, "star-dust.sqlite"));
    legacy.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        character_sheet_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        seam_mode TEXT NOT NULL DEFAULT 'cut',
        seam_fade_sec REAL NOT NULL DEFAULT 0.5,
        style_base TEXT NOT NULL DEFAULT '',
        drop_duplicate_frame INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE shots (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        prompt TEXT NOT NULL,
        preset_id TEXT NOT NULL,
        duration_sec REAL NOT NULL,
        start_image_path TEXT,
        end_image_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        chain_from_previous INTEGER NOT NULL DEFAULT 0,
        drop_duplicate_frame INTEGER
      );
    `);
    const stamp = "2020-01-01T00:00:00.000Z";
    legacy.prepare(
      `INSERT INTO projects (id, name, description, created_at, updated_at, drop_duplicate_frame)
       VALUES (?, ?, '', ?, ?, ?)`
    ).run("legacy-off", "Legacy off", stamp, stamp, 0);
    legacy.prepare(
      `INSERT INTO projects (id, name, description, created_at, updated_at, drop_duplicate_frame)
       VALUES (?, ?, '', ?, ?, ?)`
    ).run("legacy-on", "Legacy on", stamp, stamp, 1);
    const insertShot = legacy.prepare(
      `INSERT INTO shots (
         id, project_id, position, prompt, preset_id, duration_sec, created_at, updated_at, drop_duplicate_frame
       ) VALUES (?, 'legacy-off', ?, ?, 'slow-zoom-in', 1, ?, ?, ?)`
    );
    insertShot.run("shot-off", 1, "Keep.", stamp, stamp, 0);
    insertShot.run("shot-on", 2, "Drop.", stamp, stamp, 1);
    insertShot.run("shot-inherit", 3, "Inherit.", stamp, stamp, null);
    legacy.close();
    process.env.STAR_DUST_DATA = legacyDir;
    const off = storage.getProject("legacy-off");
    const on = storage.getProject("legacy-on");
    assert(off?.chainTrimStartFrames === 0 && off.dropDuplicateFrame === false, "migrating drop false stores trim 0");
    assert(on?.chainTrimStartFrames === 1 && on.dropDuplicateFrame === true, "migrating drop true stores trim 1");
    assert(storage.getShot("shot-off")?.chainTrimStartFrames === 0, "migrating a shot drop false stores trim 0");
    assert(storage.getShot("shot-on")?.chainTrimStartFrames === 1, "migrating a shot drop true stores trim 1");
    assert(storage.getShot("shot-inherit")?.chainTrimStartFrames == null, "migrating a null shot flag still inherits");
  } finally {
    holder.starDustDb?.close();
    delete holder.starDustDb;
    process.env.STAR_DUST_DATA = savedData;
  }
  const { CHAIN_STALE_NOTE, SEAM_PREVIEW_HONESTY, SEAM_PREVIEW_SEC } = await import("../src/lib/types");
  const chainStale = await import("../src/lib/chain-stale");
  assert(SEAM_PREVIEW_SEC === 1.5, "a seam preview is about 1.5 seconds on each side");
  assert(/previous shot's take changed since this one was rendered/i.test(CHAIN_STALE_NOTE), "the out-of-date line names the previous take");
  assert(/spot the seam/i.test(SEAM_PREVIEW_HONESTY), "seam preview says it helps you spot the seam");
  assert(/does not fix drift/i.test(SEAM_PREVIEW_HONESTY), "seam preview does not claim to fix drift");
  assert(/lock a character/i.test(SEAM_PREVIEW_HONESTY), "seam preview does not claim a character lock");
  assert(/guarantee continuity/i.test(SEAM_PREVIEW_HONESTY), "seam preview does not guarantee continuity");
  assert(/does not replace any take/i.test(SEAM_PREVIEW_HONESTY), "seam preview does not replace a take");
  assert(
    stitch.seamPreviewSpan(72, "tail").start === 36 && stitch.seamPreviewSpan(72, "tail").frames === 36,
    "1.5s at 24fps keeps 36 frames from the tail"
  );
  assert(
    stitch.seamPreviewSpan(72, "head").start === 0 && stitch.seamPreviewSpan(72, "head").frames === 36,
    "the head window starts at the first frame"
  );
  assert(
    stitch.seamPreviewSpan(10, "tail").start === 0 && stitch.seamPreviewSpan(10, "tail").frames === 10,
    "a clip shorter than 1.5s is kept whole"
  );

  const mockModel = "ffmpeg Ken Burns (mock)";
  const staleOf = (projectId: string) => {
    const project = storage.getProject(projectId);
    return chainStale.chainStaleShotIds({
      shots: storage.listShots(projectId),
      jobs: storage.listJobs(projectId),
      provider: "mock",
      styleBase: project?.styleBase ?? "",
      modelNameForShot: () => mockModel,
    });
  };

  storage.saveSettings({ provider: "mock" });
  const staleProject = storage.createProject("Stale chain");
  const shotP = storage.createShot({
    projectId: staleProject.id,
    prompt: "Pier before the edit.",
    presetId: "slow-zoom-in",
    durationSec: 2,
    startImagePath: red,
  });
  const shotUp = storage.createShot({
    projectId: staleProject.id,
    prompt: "Opening lanterns.",
    presetId: "slow-zoom-in",
    durationSec: 2,
    startImagePath: blue,
  });
  const shotChild = storage.createShot({
    projectId: staleProject.id,
    prompt: "Continue from the previous frame.",
    presetId: "slow-zoom-in",
    durationSec: 2,
    startImagePath: green,
    chainFromPrevious: true,
  });
  const shotGrand = storage.createShot({
    projectId: staleProject.id,
    prompt: "Continue again along the pier.",
    presetId: "slow-zoom-in",
    durationSec: 2,
    startImagePath: red,
    chainFromPrevious: true,
  });
  const shotFree = storage.createShot({
    projectId: staleProject.id,
    prompt: "A separate unchained shot.",
    presetId: "slow-zoom-in",
    durationSec: 2,
    startImagePath: blue,
  });
  const staleFirst = render.renderAll(staleProject.id);
  assert(staleFirst.ok && staleFirst.jobs.length === 5, "the stale-chain project queues five shots");
  for (const job of staleFirst.ok ? staleFirst.jobs : []) await providers.startJob(job.id);
  const completedTake = (shotId: string) =>
    storage
      .listJobs(staleProject.id)
      .filter((job) => job.shotId === shotId && job.kind !== "preview" && job.status === "completed" && job.outputPath)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const upFirst = completedTake(shotUp.id)[0];
  const childFirst = completedTake(shotChild.id)[0];
  assert(upFirst?.outputPath && childFirst?.outputPath, "upstream and child takes rendered on Mock");
  assert(storage.getShot(shotGrand.id)?.chainedFromJobId === childFirst?.id, "the grandchild was rendered from the child take");
  assert(staleOf(staleProject.id).length === 0, "a fresh chain is not out of date");
  const keptPaths = {
    before: completedTake(shotP.id)[0]?.outputPath,
    free: completedTake(shotFree.id)[0]?.outputPath,
    up: upFirst?.outputPath,
  };

  const upAgain = render.renderShot(shotUp.id, { force: true });
  assert(upAgain.ok && upAgain.jobs.length === 1 && upAgain.jobs[0].provider === "mock", "re-render stays on Mock");
  await providers.startJob(upAgain.ok ? upAgain.jobs[0].id : "");
  const upSecond = storage.getJob(upAgain.ok ? upAgain.jobs[0].id : "");
  assert(upSecond?.status === "completed" && upSecond.outputPath, "the new upstream take is an mp4");
  assert(
    fs.statSync(storage.resolveDataPath(upSecond!.outputPath!)).size > 1000,
    "the new Mock take is a real file"
  );
  let staleIds = staleOf(staleProject.id);
  assert(staleIds.includes(shotChild.id) && staleIds.includes(shotGrand.id), "the child and the grandchild are out of date");
  assert(
    !staleIds.includes(shotP.id) && !staleIds.includes(shotUp.id) && !staleIds.includes(shotFree.id),
    "the shot before the edit, the edited shot, and the unchained shot are not out of date"
  );
  assert(
    storage.getShot(shotGrand.id)?.chainedFromJobId === childFirst?.id,
    "the grandchild still points at the child take that is currently in the cut"
  );

  storage.selectTake(shotUp.id, upFirst!.id);
  assert(staleOf(staleProject.id).length === 0, "choosing the original upstream take clears the chain");
  const restored = render.renderAll(staleProject.id);
  assert(restored.ok && restored.jobs.length === 0, "a restored take is reused, including the chain");

  storage.selectTake(shotUp.id, upSecond!.id);
  staleIds = staleOf(staleProject.id);
  assert(
    staleIds.includes(shotChild.id) && staleIds.includes(shotGrand.id) && staleIds.length === 2,
    "swapping to the newer upstream take marks only the chained descendants"
  );
  const refresh = render.renderAll(staleProject.id);
  assert(refresh.ok, "render all accepts the stale chain");
  const refreshIds = (refresh.ok ? refresh.jobs : []).map((job) => job.shotId).sort();
  assert(
    JSON.stringify(refreshIds) === JSON.stringify([shotChild.id, shotGrand.id].sort()),
    `render all re-renders the chain and skips the rest, got ${refreshIds.join(",")}`
  );
  assert(
    refresh.ok && refresh.jobs.every((job) => job.provider === "mock" && job.awaitPreviousFrame),
    "the chain waits for the new frame instead of reusing the old still"
  );
  assert(
    refresh.ok &&
      refresh.skipped.some((item) => item.shotId === shotP.id) &&
      refresh.skipped.some((item) => item.shotId === shotFree.id) &&
      refresh.skipped.some((item) => item.shotId === shotUp.id),
    "the shot before, the unchained shot, and the upstream shot are skipped"
  );
  const grandJob = refresh.ok ? refresh.jobs.find((job) => job.shotId === shotGrand.id) : undefined;
  await providers.startJob(grandJob?.id ?? "");
  assert(storage.getJob(grandJob?.id ?? "")?.status === "completed", "the grandchild re-rendered from the new chain");
  const childJob = refresh.ok ? refresh.jobs.find((job) => job.shotId === shotChild.id) : undefined;
  assert(storage.getJob(childJob?.id ?? "")?.status === "completed" && storage.getJob(childJob?.id ?? "")?.outputPath, "the child re-rendered");
  assert(storage.getShot(shotGrand.id)?.chainedFromJobId === childJob?.id, "the grandchild now points at the new child take");
  assert(staleOf(staleProject.id).length === 0, "the refreshed chain is current");
  assert(completedTake(shotP.id)[0]?.outputPath === keptPaths.before, "the shot before the edit kept its take");
  assert(completedTake(shotFree.id)[0]?.outputPath === keptPaths.free, "the unchained shot kept its take");
  assert(storage.getShot(shotUp.id)?.selectedJobId === upSecond?.id, "the upstream pin stayed on the take that changed");
  const reused = render.renderAll(staleProject.id);
  assert(reused.ok && reused.jobs.length === 0, "the next render all reuses the refreshed chain");

  const seamOnMock = await stitch.previewSeam(staleProject.id, shotChild.id);
  const seamOnMockAbs = storage.resolveDataPath(seamOnMock.outputPath);
  assert(fs.statSync(seamOnMockAbs).size > 1000, "Mock seam preview is an mp4 with no API key");
  assert(!process.env.FAL_KEY && !process.env.REPLICATE_API_TOKEN, "seam preview did not need a provider key");
  assert(
    seamOnMock.seams[0]?.mode === "cut" && seamOnMock.seams[0]?.droppedFrames === 1,
    "the Mock seam preview uses the default start-frame trim of 1"
  );
  assert(
    seamOnMock.durationSec > 2.5 && seamOnMock.durationSec < 3.3,
    `seam preview should be about 3s of a 4s join, got ${seamOnMock.durationSec}`
  );
  const jobsAfterSeam = storage.listJobs(staleProject.id).length;
  const seamAgain = await stitch.previewSeam(staleProject.id, shotChild.id);
  assert(storage.listJobs(staleProject.id).length === jobsAfterSeam, "seam preview does not add a take");
  assert(seamAgain.outputPath !== childJob?.outputPath, "seam preview is not the take file");
  assert(completedTake(shotFree.id)[0]?.outputPath === keptPaths.free, "seam preview left the unchained take in place");

  storage.clearTakeSelection(shotUp.id);
  storage.updateShot(shotUp.id, { prompt: "Opening lanterns, a little later." });
  staleIds = staleOf(staleProject.id);
  assert(
    staleIds.includes(shotChild.id) && staleIds.includes(shotGrand.id) && !staleIds.includes(shotFree.id) && !staleIds.includes(shotP.id),
    "editing the upstream shot marks the chain before the new take exists"
  );
  const edited = render.renderAll(staleProject.id);
  const editedIds = (edited.ok ? edited.jobs : []).map((job) => job.shotId);
  assert(edited.ok && editedIds.includes(shotUp.id) && editedIds.includes(shotChild.id) && editedIds.includes(shotGrand.id), "render all reruns the edited shot and its chain");
  assert(edited.ok && !editedIds.includes(shotP.id) && !editedIds.includes(shotFree.id), "shots outside the chain stay reused");
  assert(
    edited.ok && edited.jobs.filter((job) => job.shotId !== shotUp.id).every((job) => job.awaitPreviousFrame),
    "descendants wait for the edited shot's new take"
  );
  const editedGrand = edited.ok ? edited.jobs.find((job) => job.shotId === shotGrand.id) : undefined;
  await providers.startJob(editedGrand?.id ?? "");
  assert(storage.getJob(editedGrand?.id ?? "")?.status === "completed", "the edited chain finished on Mock");
  assert(staleOf(staleProject.id).length === 0, "the edited chain is current after render all");
  const editedDone = render.renderAll(staleProject.id);
  assert(editedDone.ok && editedDone.jobs.length === 0, "a current chain is skipped again");

  const seamProjectColors = storage.createProject("Seam preview");
  const colorStill = storage.saveUpload(seamProjectColors.id, "still.png", solidPng(dataDir, "seam-preview-still.png", "gray"));
  const colorPrev = storage.createShot({
    projectId: seamProjectColors.id,
    prompt: "Previous color.",
    presetId: "slow-zoom-in",
    durationSec: 3,
    startImagePath: colorStill,
  });
  const colorNext = storage.createShot({
    projectId: seamProjectColors.id,
    prompt: "Next color.",
    presetId: "slow-zoom-in",
    durationSec: 3,
    startImagePath: colorStill,
    chainFromPrevious: true,
  });
  const prevClip = storage.absoluteOutputPath(seamProjectColors.id, "preview-prev.mp4");
  const nextClip = storage.absoluteOutputPath(seamProjectColors.id, "preview-next.mp4");
  concatColors(prevClip.abs, [{ color: "red", frames: 72 }]);
  concatColors(nextClip.abs, [
    { color: "red", frames: 1 },
    { color: "green", frames: 71 },
  ]);
  assert(frameCountOf(prevClip.abs) === 72 && frameCountOf(nextClip.abs) === 72, "seam preview sources are 72 frames");
  const colorJobPrev = storage.createJob({
    projectId: seamProjectColors.id,
    shotId: colorPrev.id,
    prompt: "Previous color.",
    presetId: "slow-zoom-in",
    provider: "mock",
    status: "completed",
    imagePath: colorStill,
    durationSec: 3,
    modelName: mockModel,
  });
  storage.updateJob(colorJobPrev.id, { status: "completed", outputPath: prevClip.rel, progress: 100 });
  const colorJobNext = storage.createJob({
    projectId: seamProjectColors.id,
    shotId: colorNext.id,
    prompt: "Next color.",
    presetId: "slow-zoom-in",
    provider: "mock",
    status: "completed",
    imagePath: colorStill,
    durationSec: 3,
    modelName: mockModel,
  });
  storage.updateJob(colorJobNext.id, { status: "completed", outputPath: nextClip.rel, progress: 100, imagePath: colorStill });
  storage.updateShot(colorNext.id, {
    chainFromPrevious: true,
    chainFrameBack: 0,
    chainedStartImagePath: colorStill,
    chainedFromJobId: colorJobPrev.id,
    chainedFrameBack: 0,
    chainedFrameRequest: 0,
  });
  storage.updateProject(seamProjectColors.id, { seamMode: "cut", dropDuplicateFrame: true });
  const colorJobsBefore = storage.listJobs(seamProjectColors.id).length;
  const hardPreview = await stitch.previewSeam(seamProjectColors.id, colorNext.id);
  const hardAbs = storage.resolveDataPath(hardPreview.outputPath);
  assert(fs.statSync(hardAbs).size > 1000, "hard-cut seam preview is an mp4");
  assert(hardPreview.seams[0]?.mode === "cut" && hardPreview.seams[0]?.droppedFrames === 1, "hard-cut preview drops the repeated frame");
  assert(frameCountOf(hardAbs) === 71, `hard-cut preview should be 36+36-1 frames, got ${frameCountOf(hardAbs)}`);
  assert(isRed(frameRgbAt(hardAbs, 35)), "the preview still ends the previous clip on its last frame");
  const afterDrop = frameRgbAt(hardAbs, 36);
  assert(
    afterDrop.g > 100 && afterDrop.r < 40 && afterDrop.b < 40 && !isRed(afterDrop),
    `the repeated first frame of the next clip is gone, got ${JSON.stringify(afterDrop)}`
  );
  assert(storage.listJobs(seamProjectColors.id).length === colorJobsBefore, "the color preview added no take");
  assert(storage.getJob(colorJobNext.id)?.outputPath === nextClip.rel, "the next take file was not replaced");

  storage.updateProject(seamProjectColors.id, { seamMode: "cut", chainTrimStartFrames: 3 });
  const trim3Seam = await stitch.previewSeam(seamProjectColors.id, colorNext.id);
  const trim3SeamAbs = storage.resolveDataPath(trim3Seam.outputPath);
  assert(
    trim3Seam.seams[0]?.mode === "cut" && trim3Seam.seams[0]?.droppedFrames === 3,
    `seam preview trims 3 start frames, got drop ${trim3Seam.seams[0]?.droppedFrames}`
  );
  assert(frameCountOf(trim3SeamAbs) === 69, `a trim of 3 should leave 36+36-3 frames, got ${frameCountOf(trim3SeamAbs)}`);
  assert(isRed(frameRgbAt(trim3SeamAbs, 35)), "the preview still ends the previous clip on its last frame");
  const afterTrim3 = frameRgbAt(trim3SeamAbs, 36);
  assert(
    afterTrim3.g > 100 && afterTrim3.r < 40 && afterTrim3.b < 40 && !isRed(afterTrim3),
    `trim 3 skips the repeated frame and the next two, got ${JSON.stringify(afterTrim3)}`
  );

  storage.updateProject(seamProjectColors.id, { dropDuplicateFrame: false });
  const keptPreview = await stitch.previewSeam(seamProjectColors.id, colorNext.id);
  const keptPreviewAbs = storage.resolveDataPath(keptPreview.outputPath);
  assert(keptPreview.seams[0]?.mode === "cut" && keptPreview.seams[0]?.droppedFrames === 0, "turning the drop off keeps both frames in the preview");
  assert(frameCountOf(keptPreviewAbs) === 72, `keeping the repeated frame should be 72 frames, got ${frameCountOf(keptPreviewAbs)}`);
  assert(isRed(frameRgbAt(keptPreviewAbs, 35)) && isRed(frameRgbAt(keptPreviewAbs, 36)), "with the drop off the red frame plays twice");

  storage.updateProject(seamProjectColors.id, { seamMode: "crossfade", seamFadeSec: 0.5, dropDuplicateFrame: true });
  const fadePreview = await stitch.previewSeam(seamProjectColors.id, colorNext.id);
  assert(
    fadePreview.seams[0]?.mode === "crossfade" &&
      fadePreview.seams[0]?.droppedFrames === 0 &&
      fadePreview.seams[0]?.fadeSec === 0.5,
    `crossfade preview keeps the fade and does not drop, got ${fadePreview.seams[0]?.mode} ${fadePreview.seams[0]?.fadeSec} drop ${fadePreview.seams[0]?.droppedFrames}`
  );
  assert(
    fadePreview.durationSec > 2.3 && fadePreview.durationSec < 2.7,
    `crossfade preview should be about 2.5s, got ${fadePreview.durationSec}`
  );
  assert(fadePreview.durationSec < hardPreview.durationSec - 0.2, "the crossfade preview is shorter than the hard cut");

  storage.updateProject(seamProjectColors.id, { seamMode: "cut", dropDuplicateFrame: true });
  storage.updateShot(colorNext.id, { chainFromPrevious: false });
  const freePreview = await stitch.previewSeam(seamProjectColors.id, colorNext.id);
  const freeAbs = storage.resolveDataPath(freePreview.outputPath);
  assert(freePreview.seams[0]?.mode === "cut" && freePreview.seams[0]?.droppedFrames === 0, "an unchained preview does not drop a frame");
  assert(frameCountOf(freeAbs) === 72, `an unchained preview should keep 72 frames, got ${frameCountOf(freeAbs)}`);
  assert(isRed(frameRgbAt(freeAbs, 35)) && isRed(frameRgbAt(freeAbs, 36)), "an unchained preview keeps both frames at the join");
  let missingPrev = false;
  try {
    await stitch.previewSeam(seamProjectColors.id, colorPrev.id);
  } catch (err) {
    missingPrev = err instanceof Error && /no join/i.test(err.message);
  }
  assert(missingPrev, "the first shot has no seam to preview");
  assert(!process.env.FAL_KEY && !process.env.REPLICATE_API_TOKEN, "color seam previews stayed on ffmpeg");

  const inputKey = await import("../src/lib/input-key");
  const keyTypes = await import("../src/lib/types");
  assert(/paying again/i.test(keyTypes.REUSE_HONESTY), "reuse says it avoids paying again");
  assert(/another backend/i.test(keyTypes.REUSE_HONESTY), "reuse does not promise identical output across backends");
  assert(/does not lock a character/i.test(keyTypes.REUSE_HONESTY), "reuse makes no character-lock claim");
  const keyBase = {
    image: "img-a",
    endImage: "",
    prompt: "lanterns",
    seed: 7,
    provider: "mock",
    model: "ffmpeg Ken Burns (mock)",
    workflow: "",
    lowMemory: false,
    preset: "slow-zoom-in",
    durationSec: 2,
    startFrameTrim: 1 as number | null,
    upstreamKey: "",
  };
  const keyOf = (patch: Partial<typeof keyBase>) => inputKey.buildInputKey({ ...keyBase, ...patch });
  const sameKey = keyOf({});
  assert(sameKey === keyOf({}), "the content key is deterministic");
  assert(sameKey !== keyOf({ image: "img-b" }), "the source image is in the key");
  assert(sameKey !== keyOf({ prompt: "other" }), "the prompt is in the key");
  assert(sameKey !== keyOf({ seed: 8 }), "the seed is in the key");
  assert(sameKey !== keyOf({ startFrameTrim: 0 }), "start-frame trim is in the key");
  assert(sameKey !== keyOf({ startFrameTrim: null }), "a trim that does not apply is a different key");
  assert(sameKey !== keyOf({ upstreamKey: "upstream" }), "the upstream clip is in the key");
  assert(sameKey !== keyOf({ model: "other-model" }), "the model is in the key");
  assert(sameKey !== keyOf({ provider: "fal" }), "the backend is in the key");
  assert(comfy.providerSeed(424242) === 424242, "ComfyUI sends the stored seed");
  const seededLtx = comfy.patchLtxWorkflow(comfy.loadLtxWorkflow(), {
    imageName: "a.png",
    prompt: "p",
    seed: 424242,
    frames: 25,
    width: 832,
    height: 480,
    fps: 24,
  });
  const seededNoise = Object.values(seededLtx).find((node) => node.class_type === "RandomNoise");
  assert(seededNoise?.inputs?.noise_seed === 424242, "the LTX graph receives the clip seed");

  storage.saveSettings({ provider: "mock", budgetCap: null, rates: { fal: {}, replicate: {} } });
  const reuseProject = storage.createProject("Reuse and retake");
  const stillA = storage.saveUpload(reuseProject.id, "a.png", solidPng(dataDir, "reuse-a.png", "red"));
  const stillB = storage.saveUpload(reuseProject.id, "b.png", solidPng(dataDir, "reuse-b.png", "blue"));
  const stillC = storage.saveUpload(reuseProject.id, "c.png", solidPng(dataDir, "reuse-c.png", "green"));
  const stillD = storage.saveUpload(reuseProject.id, "d.png", solidPng(dataDir, "reuse-d.png", "gray"));
  const reuseA = storage.createShot({
    projectId: reuseProject.id,
    prompt: "Opening still.",
    presetId: "slow-zoom-in",
    durationSec: 2,
    startImagePath: stillA,
  });
  const reuseB = storage.createShot({
    projectId: reuseProject.id,
    prompt: "Continue from the previous frame.",
    presetId: "slow-zoom-in",
    durationSec: 2,
    startImagePath: stillB,
    chainFromPrevious: true,
  });
  const reuseC = storage.createShot({
    projectId: reuseProject.id,
    prompt: "Continue again.",
    presetId: "slow-zoom-in",
    durationSec: 2,
    startImagePath: stillC,
    chainFromPrevious: true,
  });
  const reuseD = storage.createShot({
    projectId: reuseProject.id,
    prompt: "A separate shot.",
    presetId: "slow-zoom-in",
    durationSec: 2,
    startImagePath: stillD,
  });
  const takesOf = (shotId: string) =>
    storage
      .listJobs(reuseProject.id)
      .filter((job) => job.shotId === shotId && job.kind !== "preview" && job.status === "completed" && job.outputPath)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const finishJobs = async (jobs: { id: string }[]) => {
    for (const job of jobs) await providers.startJob(job.id);
  };
  const firstPass = render.renderAll(reuseProject.id);
  assert(firstPass.ok && firstPass.jobs.length === 4, "the reuse project queues four shots");
  await finishJobs(firstPass.ok ? firstPass.jobs : []);
  for (const shot of [reuseA, reuseB, reuseC, reuseD]) {
    const take = takesOf(shot.id).at(-1);
    const fresh = storage.getShot(shot.id);
    assert(take?.status === "completed" && take.outputPath, `${shot.prompt} rendered on Mock`);
    assert(take?.inputKey && take.seed != null, "the take stores a seed and a content key");
    assert(take?.inputKey === inputKey.desiredClipKey(fresh!), "the stored key matches the current inputs");
    assert(fs.statSync(storage.resolveDataPath(take!.outputPath!)).size > 1000, "Mock wrote an mp4 with no API key");
  }
  assert(takesOf(reuseC.id).at(-1)?.inputKey !== takesOf(reuseB.id).at(-1)?.inputKey, "a chained clip is not the upstream clip");
  const jobCount = storage.listJobs(reuseProject.id).length;
  const reusedPass = render.renderAll(reuseProject.id);
  assert(reusedPass.ok && reusedPass.jobs.length === 0, "an unchanged sequence loads existing clips");
  assert(
    reusedPass.ok && reusedPass.skipped.every((item) => item.reason === keyTypes.REUSE_SKIP_REASON),
    "reuse is labelled as no new spend"
  );
  assert(storage.listJobs(reuseProject.id).length === jobCount, "reuse did not queue a job");
  assert(!process.env.FAL_KEY && !process.env.REPLICATE_API_TOKEN, "reuse did not need a provider key");

  const styleBefore = inputKey.desiredClipKey(storage.getShot(reuseD.id)!);
  storage.updateProject(reuseProject.id, { styleBase: "warm dusk" });
  assert(inputKey.desiredClipKey(storage.getShot(reuseD.id)!) !== styleBefore, "shared style is part of the key");
  storage.updateProject(reuseProject.id, { styleBase: "" });
  assert(inputKey.desiredClipKey(storage.getShot(reuseD.id)!) === styleBefore, "clearing shared style restores the key");
  const afterStyle = render.renderAll(reuseProject.id);
  assert(afterStyle.ok && afterStyle.jobs.length === 0, "restoring the style reuses the clips");

  const aKey = inputKey.desiredClipKey(storage.getShot(reuseA.id)!);
  const dKey = inputKey.desiredClipKey(storage.getShot(reuseD.id)!);
  const bKey = inputKey.desiredClipKey(storage.getShot(reuseB.id)!);
  fs.writeFileSync(storage.resolveDataPath(stillA), solidPng(dataDir, "reuse-a-white.png", "white"));
  assert(inputKey.desiredClipKey(storage.getShot(reuseA.id)!) !== aKey, "new image bytes change the key");
  assert(inputKey.desiredClipKey(storage.getShot(reuseD.id)!) === dKey, "another shot's image is unchanged");
  assert(inputKey.desiredClipKey(storage.getShot(reuseB.id)!) === bKey, "the chained key stays on the current upstream clip");
  const imagePass = render.renderAll(reuseProject.id);
  const imageIds = (imagePass.ok ? imagePass.jobs : []).map((job) => job.shotId).sort();
  assert(
    imagePass.ok && JSON.stringify(imageIds) === JSON.stringify([reuseA.id, reuseB.id, reuseC.id].sort()),
    `a new still re-renders that shot and the chain after it, got ${imageIds.join(",")}`
  );
  await finishJobs(imagePass.ok ? imagePass.jobs : []);
  assert(
    takesOf(reuseA.id).at(-1)?.inputKey === inputKey.desiredClipKey(storage.getShot(reuseA.id)!),
    "the new still's take matches its key"
  );

  const trimA = inputKey.desiredClipKey(storage.getShot(reuseA.id)!);
  const trimB = inputKey.desiredClipKey(storage.getShot(reuseB.id)!);
  storage.updateProject(reuseProject.id, { chainTrimStartFrames: 0 });
  assert(inputKey.desiredClipKey(storage.getShot(reuseA.id)!) === trimA, "trim does not change an unchained key");
  assert(inputKey.desiredClipKey(storage.getShot(reuseB.id)!) !== trimB, "trim changes a chained hard-cut key");
  const trimPass = render.renderAll(reuseProject.id);
  const trimIds = (trimPass.ok ? trimPass.jobs : []).map((job) => job.shotId).sort();
  assert(
    trimPass.ok && JSON.stringify(trimIds) === JSON.stringify([reuseB.id, reuseC.id].sort()),
    `trim re-renders only the chain, got ${trimIds.join(",")}`
  );
  await finishJobs(trimPass.ok ? trimPass.jobs : []);
  storage.updateProject(reuseProject.id, { chainTrimStartFrames: 1 });
  const trimBack = render.renderAll(reuseProject.id);
  assert(trimBack.ok && trimBack.jobs.length === 0, "restoring the trim reuses the earlier clips");

  const beforeRefusal = storage.listJobs(reuseProject.id).length;
  const seedBeforeRefusal = storage.getShot(reuseB.id)?.seed;
  storage.updateShot(reuseB.id, { prompt: "nude child" });
  const refusedRetake = render.retakeShot(reuseB.id);
  assert(!refusedRetake.ok && refusedRetake.refused, "retake refuses sexual content involving a minor");
  assert(storage.listJobs(reuseProject.id).length === beforeRefusal, "the refusal queued nothing");
  assert(storage.getShot(reuseB.id)?.seed === seedBeforeRefusal, "the refusal did not change the seed");
  storage.updateShot(reuseB.id, { prompt: "Continue from the previous frame." });

  const keptA = takesOf(reuseA.id).at(-1)?.outputPath;
  const keptD = takesOf(reuseD.id).at(-1)?.outputPath;
  const oldB = takesOf(reuseB.id).at(-1)!;
  const quote = render.quoteRetake(reuseB.id);
  assert(quote.ok && quote.cost.total === 0 && /No charge/i.test(quote.cost.label), "Mock retake estimates no charge");
  const retaken = render.retakeShot(reuseB.id);
  assert(retaken.ok, "retake queues");
  const retakeIds = (retaken.ok ? retaken.jobs : []).map((job) => job.shotId);
  assert(JSON.stringify(retakeIds) === JSON.stringify([reuseB.id, reuseC.id]), "retake renders this shot and the chain after it");
  const newBJob = retaken.ok ? retaken.jobs[0] : undefined;
  assert(newBJob?.seed != null && newBJob.seed !== oldB.seed, "retake changes only this shot's seed");
  assert(newBJob?.inputKey && newBJob.inputKey !== oldB.inputKey, "the new seed is a new key");
  assert(retaken.ok && retaken.jobs[1]?.inputKey !== takesOf(reuseC.id).at(-1)?.inputKey, "the downstream key follows the new upstream clip");
  const staleNow = staleOf(reuseProject.id);
  assert(staleNow.includes(reuseC.id), "the chained shot after a retake is out of date");
  assert(
    !staleNow.includes(reuseA.id) && !staleNow.includes(reuseD.id) && !staleNow.includes(reuseB.id),
    "retake does not mark the shot itself, earlier shots, or an unchained shot"
  );
  await providers.startJob(retaken.ok ? retaken.jobs[1].id : "");
  assert(storage.getJob(newBJob?.id ?? "")?.status === "completed", "the retaken shot rendered on Mock");
  assert(storage.getJob(retaken.ok ? retaken.jobs[1].id : "")?.status === "completed", "the downstream shot rendered on Mock");
  assert(storage.getShot(reuseC.id)?.chainedFromJobId === newBJob?.id, "the chain uses the retaken take");
  assert(takesOf(reuseB.id).length >= 2, "the earlier take is kept");
  assert(fs.existsSync(storage.resolveDataPath(oldB.outputPath!)), "the earlier take file stays on disk");
  assert(takesOf(reuseA.id).at(-1)?.outputPath === keptA, "the shot before the retake was not rendered");
  assert(takesOf(reuseD.id).at(-1)?.outputPath === keptD, "the unchained shot was not rendered");
  assert(staleOf(reuseProject.id).length === 0, "the retaken chain is current");
  storage.selectTake(reuseB.id, oldB.id);
  assert(staleOf(reuseProject.id).includes(reuseC.id), "picking the earlier take marks the chain out of date");
  storage.selectTake(reuseB.id, newBJob!.id);
  assert(staleOf(reuseProject.id).length === 0, "picking the retaken take clears the chain");
  const afterRetake = render.renderAll(reuseProject.id);
  assert(afterRetake.ok && afterRetake.jobs.length === 0, "the retaken sequence is reused");

  const cCount = takesOf(reuseC.id).length;
  const cutA = storage.getShot(reuseA.id)?.selectedJobId ?? takesOf(reuseA.id).at(-1)?.id;
  const huntQuote = render.quoteHunt(reuseA.id, 3);
  assert(
    huntQuote.ok && huntQuote.cost.total === 0 && /No charge/i.test(huntQuote.cost.label) && /3 seeds/i.test(huntQuote.cost.label),
    "Mock try-seeds shows no charge before running"
  );
  const badHunt = render.huntShot(reuseA.id, 5);
  assert(!badHunt.ok && badHunt.status === 400, "try seeds only accepts 2, 3, or 4");
  const hunted = render.huntShot(reuseA.id, 3);
  assert(hunted.ok && hunted.jobs.length === 3, "try seeds queues one take per seed");
  const huntSeeds = (hunted.ok ? hunted.jobs : []).map((job) => job.seed);
  assert(new Set(huntSeeds).size === 3, "each candidate has its own seed");
  assert(huntSeeds.every((seed) => seed !== takesOf(reuseA.id).at(-1)?.seed), "candidates are not the current seed");
  assert(storage.getShot(reuseA.id)?.selectedJobId === cutA, "try seeds leaves the stitch on the current take");
  assert(takesOf(reuseC.id).length === cCount, "try seeds does not render the chain");
  await finishJobs(hunted.ok ? hunted.jobs : []);
  for (const job of hunted.ok ? hunted.jobs : []) {
    const done = storage.getJob(job.id);
    assert(done?.status === "completed" && done.outputPath, "each seed rendered on Mock");
    assert(fs.statSync(storage.resolveDataPath(done!.outputPath!)).size > 1000, "each candidate is an mp4");
  }
  const huntStitch = await stitch.stitchProject(reuseProject.id);
  assert(huntStitch.includedJobIds[0] === cutA, "the stitch still uses the take from before try seeds");
  const winner = hunted.ok ? hunted.jobs[1] : undefined;
  storage.selectTake(reuseA.id, winner!.id);
  const winnerStitch = await stitch.stitchProject(reuseProject.id);
  assert(winnerStitch.includedJobIds[0] === winner?.id, "the user can pick a candidate");
  assert(takesOf(reuseA.id).length >= 4, "every candidate stays a take");
  assert(!process.env.FAL_KEY && !process.env.REPLICATE_API_TOKEN, "try seeds did not need a provider key");

  storage.saveSettings({
    provider: "fal",
    falModel: "fal-ai/test-model",
    rates: { fal: { "fal-ai/test-model": 0.5 }, replicate: {} },
    budgetCap: 0.2,
  });
  const beforePaid = storage.listJobs(reuseProject.id).length;
  const blockedHunt = render.huntShot(reuseA.id, 3, { acknowledgeModel: "fal-ai/test-model" });
  assert(!blockedHunt.ok && blockedHunt.overBudget, "try seeds blocks a paid run above the typed rate");
  assert(blockedHunt.cost?.total != null && blockedHunt.cost.total > 0.2, "the block shows the estimate");
  assert(storage.listJobs(reuseProject.id).length === beforePaid, "the blocked run queued nothing");
  assert(
    storage.listJobs(reuseProject.id).every((job) => job.provider !== "fal"),
    "the blocked run did not call fal"
  );
  storage.saveSettings({ provider: "mock", budgetCap: null, rates: { fal: {}, replicate: {} } });

  const approve = await import("../src/lib/approve");
  const { APPROVED_HOLD_REASON, APPROVED_MISMATCH_NOTE, APPROVE_HONESTY } = await import("../src/lib/types");
  assert(/approved take no longer matches this shot/i.test(APPROVED_MISMATCH_NOTE), "mismatch uses the plain sentence");
  assert(/does not lock a character/i.test(APPROVE_HONESTY), "approve makes no character-lock claim");
  assert(/lip-sync/i.test(APPROVE_HONESTY), "approve makes no lip-sync claim");
  assert(/long film/i.test(APPROVE_HONESTY), "approve makes no long-film claim");
  assert(!/api[_ ]?key/i.test(APPROVE_HONESTY), "approve copy does not mention an API key");

  const anchor = (
    id: string,
    extra: Record<string, unknown> = {}
  ) =>
    ({
      id,
      chainFromPrevious: false,
      chainFrameBack: 0,
      prompt: id,
      presetId: "slow-zoom-in",
      durationSec: 1,
      startImagePath: "uploads/x.png",
      ...extra,
    }) as const;
  const clip = (id: string, shotId: string, imagePath: string) =>
    ({
      id,
      shotId,
      createdAt: `2020-01-01T00:00:0${id.length}.000Z`,
      imagePath,
      status: "completed",
      outputPath: `outputs/${id}.mp4`,
      kind: "take",
      provider: "mock",
      modelName: mockModel,
      prompt: shotId,
      presetId: "slow-zoom-in",
      durationSec: 1,
    }) as const;
  const marksOf = (
    shots: ReturnType<typeof anchor>[],
    jobs: ReturnType<typeof clip>[]
  ) =>
    chainStale.chainStaleMarks({
      shots,
      jobs,
      provider: "mock",
      styleBase: "",
      modelNameForShot: () => mockModel,
    });
  const anchorA = anchor("A");
  const anchorB = anchor("B", { chainFromPrevious: true, chainedFromJobId: "a1", chainedStartImagePath: "uploads/a.png" });
  const anchorC = anchor("C", { chainFromPrevious: true, chainedFromJobId: "b1", chainedStartImagePath: "uploads/b.png" });
  const anchorD = anchor("D", {
    chainFromPrevious: true,
    chainedFromJobId: "c1",
    chainedStartImagePath: "uploads/c.png",
    approvedJobId: "d1",
  });
  const anchorE = anchor("E", { chainFromPrevious: true, chainedFromJobId: "d1", chainedStartImagePath: "uploads/d.png" });
  const anchorJobs = [
    clip("a1", "A", "uploads/x.png"),
    clip("b1", "B", "uploads/a.png"),
    clip("b2", "B", "uploads/a.png"),
    clip("c1", "C", "uploads/b.png"),
    clip("d1", "D", "uploads/c.png"),
    clip("e1", "E", "uploads/d.png"),
  ];
  const pickedB = marksOf(
    [anchorA, { ...anchorB, selectedJobId: "b2" }, anchorC, anchorD, anchorE],
    anchorJobs
  );
  const anchorStale = pickedB.filter((mark) => mark.stale).map((mark) => mark.id);
  assert(JSON.stringify(anchorStale) === JSON.stringify(["C"]), `only the unapproved shot between approved takes is out of date, got ${anchorStale.join(",")}`);
  assert(!pickedB.find((mark) => mark.id === "D")?.stale, "an approved shot is not out of date");
  assert(!pickedB.find((mark) => mark.id === "E")?.stale, "a shot after an approved take is not out of date");
  const openChain = marksOf(
    [anchorA, { ...anchorB, selectedJobId: "b2" }, anchorC, { ...anchorD, approvedJobId: undefined }, anchorE],
    anchorJobs
  );
  const openIds = openChain.filter((mark) => mark.stale).map((mark) => mark.id);
  assert(
    JSON.stringify(openIds) === JSON.stringify(["C", "D", "E"]),
    `without approval the rest of the chain is out of date, got ${openIds.join(",")}`
  );

  storage.saveSettings({ provider: "mock", budgetCap: null, rates: { fal: {}, replicate: {} } });
  const approveProject = storage.createProject("Approve take");
  const stills = ["red", "blue", "green", "gray", "white"].map((color) =>
    storage.saveUpload(approveProject.id, `${color}.png`, solidPng(dataDir, `approve-${color}.png`, color))
  );
  const approveShots = stills.map((still, index) =>
    storage.createShot({
      projectId: approveProject.id,
      prompt: `Approve shot ${index + 1}.`,
      presetId: "slow-zoom-in",
      durationSec: 1,
      startImagePath: still,
      chainFromPrevious: index > 0,
    })
  );
  const [appA, appB, appC, appD, appE] = approveShots;
  const queued = render.renderAll(approveProject.id);
  assert(queued.ok && queued.jobs.length === 5, "the approve project queues five shots");
  for (const job of queued.ok ? queued.jobs : []) await providers.startJob(job.id);
  const takeId = (shotId: string) =>
    storage
      .listJobs(approveProject.id)
      .filter((job) => job.shotId === shotId && job.kind !== "preview" && job.status === "completed")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .at(-1);
  const approvedA = storage.approveTake(appA.id, takeId(appA.id)!.id);
  const approvedD = storage.approveTake(appD.id, takeId(appD.id)!.id);
  assert(approvedA?.approvedJobId === takeId(appA.id)!.id, "approval is stored on the shot");
  assert(approvedD?.approvedStartStamp && approvedD.approvedStartStamp.length > 10, "approval stores an image stamp, not a key");
  assert(!/sk-|fal_|r8_|whsec_|secret/i.test(JSON.stringify(approvedD)), "approval does not store an API key");
  const held = render.renderAll(approveProject.id);
  assert(held.ok && held.jobs.length === 0, "approving unchanged shots does not render them");
  const between = render.retakeShot(appB.id);
  assert(between.ok, "retake of an unapproved shot is allowed");
  const blockedIds = (between.ok ? between.jobs : []).map((job) => job.shotId);
  assert(
    JSON.stringify(blockedIds) === JSON.stringify([appB.id, appC.id]),
    `retake stops at the next approved take, got ${blockedIds.join(",")}`
  );
  const midStale = staleOf(approveProject.id);
  assert(midStale.includes(appC.id), "the unapproved shot after the retake is out of date");
  assert(!midStale.includes(appD.id) && !midStale.includes(appE.id), "approved D and the shot after it stay current");
  assert(!midStale.includes(appA.id), "the approved opening shot is not out of date");
  for (const job of between.ok ? between.jobs : []) await providers.startJob(job.id);
  assert(staleOf(approveProject.id).length === 0, "finishing the in-between shots clears the mark");
  const stitchBefore = await stitch.stitchProject(approveProject.id);
  assert(stitchBefore.includedJobIds.includes(approvedD!.approvedJobId!), "the stitch uses the approved take");
  const dBefore = approvedD!.approvedJobId!;
  storage.updateShot(appD.id, { prompt: "A different action for the approved shot." });
  const mismatched = storage.getShot(appD.id)!;
  const mismatchJob = storage.getJob(dBefore);
  assert(
    approve.approvedTakeMismatch(mismatched, mismatchJob, ""),
    "editing the prompt marks the approved take as a mismatch"
  );
  fs.writeFileSync(storage.resolveDataPath(stills[0]), solidPng(dataDir, "approve-red-next.png", "white"));
  const imageMismatch = storage.getShot(appA.id)!;
  assert(
    approve.approvedTakeMismatch(imageMismatch, storage.getJob(imageMismatch.approvedJobId!), ""),
    "replacing the image bytes marks the approved take as a mismatch"
  );
  const quiet = render.renderAll(approveProject.id);
  const quietIds = (quiet.ok ? quiet.jobs : []).map((job) => job.shotId);
  assert(quiet.ok && quietIds.length === 0, `render all does not re-render a mismatched approved shot, got ${quietIds.join(",")}`);
  assert(
    quiet.ok && quiet.skipped.some((item) => item.shotId === appA.id && item.reason === APPROVED_HOLD_REASON),
    "render all says the approved take was kept"
  );
  const asked = render.renderShot(appD.id, { force: true });
  assert(!asked.ok && asked.needsApprovalConfirm, "re-render asks before replacing an approved take");
  assert(!asked.ok && /approved take no longer matches this shot/i.test(asked.error), "the ask uses the mismatch sentence");
  assert(storage.getShot(appD.id)?.approvedJobId === dBefore, "the ask did not clear approval");
  const replaced = render.renderShot(appD.id, { force: true, confirmApproved: true });
  assert(replaced.ok && replaced.jobs.length === 1 && replaced.jobs[0]?.shotId === appD.id, "confirming re-renders only that shot");
  assert(!storage.getShot(appD.id)?.approvedJobId, "confirming clears approval");
  await providers.startJob(replaced.ok ? replaced.jobs[0].id : "");
  storage.approveTake(appD.id, takeId(appD.id)!.id);
  const refusedA = render.retakeShot(appA.id);
  assert(!refusedA.ok && refusedA.needsApprovalConfirm, "retake asks before replacing an approved shot");
  const retakeA = render.retakeShot(appA.id, { confirmApproved: true });
  const retakeAIds = (retakeA.ok ? retakeA.jobs : []).map((job) => job.shotId);
  assert(
    retakeA.ok && JSON.stringify(retakeAIds) === JSON.stringify([appA.id, appB.id, appC.id]),
    `a confirmed retake stops at the next approved take, got ${retakeAIds.join(",")}`
  );
  assert(storage.getShot(appD.id)?.approvedJobId, "the downstream approved take stays approved");
  for (const job of retakeA.ok ? retakeA.jobs : []) await providers.startJob(job.id);
  const huntBlocked = render.huntShot(appD.id, 2);
  assert(!huntBlocked.ok && huntBlocked.needsApprovalConfirm, "try seeds asks when the shot is approved");
  const huntedApproved = render.huntShot(appD.id, 2, { confirmApproved: true });
  assert(huntedApproved.ok && huntedApproved.jobs.length === 2, "confirmed try seeds keeps extra takes");
  assert(storage.getShot(appD.id)?.approvedJobId, "try seeds does not clear approval");
  for (const job of huntedApproved.ok ? huntedApproved.jobs : []) await providers.startJob(job.id);
  const finalStitch = await stitch.stitchProject(approveProject.id);
  assert(
    finalStitch.includedJobIds.includes(storage.getShot(appD.id)?.approvedJobId ?? ""),
    "the stitch still uses the approved take after try seeds"
  );
  assert(
    fs.statSync(storage.resolveDataPath(finalStitch.outputPath)).size > 1000,
    "the approved stitch is an mp4 with no API key"
  );
  assert(!process.env.FAL_KEY && !process.env.REPLICATE_API_TOKEN, "approval tests did not need a provider key");

  const edit = await import("../src/lib/edit-export");
  const { createHash } = await import("crypto");
  const JSZip = (await import("jszip")).default;
  storage.saveSettings({ provider: "mock", budgetCap: null, rates: { fal: {}, replicate: {} } });
  const editProject = storage.createProject("Edit export");
  storage.updateProject(editProject.id, {
    styleBase: "cool dusk grade",
    seamMode: "cut",
    chainTrimStartFrames: 1,
  });
  const editStills = ["red", "blue", "green"].map((color) =>
    storage.saveUpload(editProject.id, `edit-${color}.png`, solidPng(dataDir, `edit-${color}.png`, color))
  );
  const editPrompts = ["Lanterns over the water", "Boat crosses the frame", "Dock lights fade"];
  const editShots = editPrompts.map((prompt, index) =>
    storage.createShot({
      projectId: editProject.id,
      prompt,
      presetId: "slow-zoom-in",
      durationSec: 2,
      startImagePath: editStills[index],
      chainFromPrevious: index === 1,
    })
  );
  storage.updateShot(editShots[2].id, { seamMode: "crossfade", seamFadeSec: 0.5 });
  async function renderEditShot(shotId: string, force = false) {
    const result = render.renderShot(shotId, force ? { force: true } : undefined);
    assert(result.ok && result.jobs.length === 1, `edit render failed: ${result.ok ? "no job" : result.error}`);
    if (!result.ok) throw new Error("unreachable");
    await providers.startJob(result.jobs[0].id);
    return result.jobs[0].id;
  }
  const editV1 = await renderEditShot(editShots[0].id);
  const editV2 = await renderEditShot(editShots[0].id, true);
  const editV3 = await renderEditShot(editShots[0].id, true);
  assert(edit.takeFilename(1, 1) === "SH010_v01.mp4", "shot 1 version 1 is SH010_v01");
  assert(edit.takeFilename(1, 3) === "SH010_v03.mp4", "shot 1 version 3 is SH010_v03");
  assert(edit.takeFilename(1, 1) !== edit.takeFilename(1, 3), "versions do not share a filename");
  const approvedEdit = storage.approveTake(editShots[0].id, editV3);
  assert(approvedEdit?.approvedJobId === editV3, "the third take is the approved one");
  const editShot2Job = await renderEditShot(editShots[1].id);
  const editShot3Job = await renderEditShot(editShots[2].id);
  const chainedShot = storage.getShot(editShots[1].id);
  assert(chainedShot?.chainedFromJobId === editV3, "the chained shot started from the approved take");
  const huntedEdit = render.huntShot(editShots[0].id, 2, { confirmApproved: true });
  assert(huntedEdit.ok && huntedEdit.jobs.length === 2, "two later seeds stay as takes");
  for (const job of huntedEdit.ok ? huntedEdit.jobs : []) await providers.startJob(job.id);
  assert(storage.getShot(editShots[0].id)?.approvedJobId === editV3, "later seeds do not replace the approved take");
  const shot1Takes = edit.orderedTakes(
    storage.listJobs(editProject.id).filter(
      (job) =>
        job.shotId === editShots[0].id &&
        job.kind !== "preview" &&
        job.status === "completed" &&
        job.outputPath
    )
  );
  assert(shot1Takes.length === 5, `shot 1 keeps five takes, got ${shot1Takes.length}`);
  assert(edit.takeVersion(shot1Takes, editV1) === 1, "oldest take stays v01");
  assert(edit.takeVersion(shot1Takes, editV2) === 2, "middle take stays v02");
  assert(edit.takeVersion(shot1Takes, editV3) === 3, "approved take stays v03");
  assert(edit.takeVersion(shot1Takes, shot1Takes[4].id) === 5, "newest take is v05 and is not the export");

  const falSecret = "fal-secret-SHOULD-NOT-LEAK-9f3a";
  const headerSecret = "Bearer header-SHOULD-NOT-LEAK-77";
  const urlSecret = "https://gpu.example.test/should-not-leak";
  const replicateSecret = "r8_should-not-leak-token-value";
  process.env.FAL_KEY = falSecret;
  process.env.COMFYUI_AUTH_HEADER = headerSecret;
  process.env.COMFYUI_BASE_URL = urlSecret;
  process.env.REPLICATE_API_TOKEN = replicateSecret;
  try {
    for (const id of [editV3, editShot2Job, editShot3Job]) {
      storage.updateJob(id, {
        error: falSecret,
        remoteId: headerSecret,
        providerNote: urlSecret,
        characterNote: replicateSecret,
      });
    }
    storage.updateJob(editShot3Job, {
      provider: "comfyui",
      modelName: "ComfyUI Wan 2.2 TI2V-5B",
    });
    storage.createJob({
      projectId: editProject.id,
      shotId: editShots[0].id,
      prompt: `PREVIEW_SHOULD_NOT_EXPORT ${falSecret}`,
      presetId: "slow-zoom-in",
      provider: "mock",
      kind: "preview",
      status: "completed",
      imagePath: editStills[0],
      error: headerSecret,
      providerNote: urlSecret,
    });

    const packed = await edit.buildEditExport(editProject.id);
    const again = await edit.buildEditExport(editProject.id);
    const zip = await JSZip.loadAsync(packed.bytes);
    const againZip = await JSZip.loadAsync(again.bytes);
    const entryNames = (archive: JSZip) =>
      Object.keys(archive.files)
        .filter((name) => !archive.files[name].dir)
        .sort();
    const names = entryNames(zip);
    const againNames = entryNames(againZip);
    assert(
      JSON.stringify(names) === JSON.stringify(["SH010_v03.json", "SH010_v03.mp4", "SH020_v01.json", "SH020_v01.mp4", "SH030_v01.json", "SH030_v01.mp4", "contact-sheet.png", "cut.edl"]),
      `edit zip names: ${names.join(", ")}`
    );
    assert(JSON.stringify(againNames) === JSON.stringify(names), "a second export keeps the same names");
    assert(!names.includes("SH010_v01.mp4") && !names.includes("SH010_v05.mp4"), "earlier and later versions are not overwritten or substituted");

    const edl = packed.edl;
    assert(edl.includes("FCM: NON-DROP FRAME"), "EDL declares non-drop");
    assert(edl.includes("* FROM CLIP NAME: SH010_v03.mp4"), "EDL points at SH010_v03");
    assert(edl.includes("* FROM CLIP NAME: SH020_v01.mp4"), "EDL points at SH020_v01");
    assert(edl.includes("* FROM CLIP NAME: SH030_v01.mp4"), "EDL points at SH030_v01");
    assert(/not a Premiere or Resolve project/i.test(edl), "EDL says it is not an NLE project");
    assert(/review codec, not a mastering codec/i.test(edl), "EDL says mp4 is a review codec");
    assert(!/character lock|lip-sync a performance|long film ready/i.test(edl), "EDL makes no lock or long-film promise");

    function tc(frame: number): string {
      const fps = 24;
      const ff = frame % fps;
      const total = Math.floor(frame / fps);
      const ss = total % 60;
      const mm = Math.floor(total / 60) % 60;
      const hh = Math.floor(total / 3600);
      const pad = (value: number) => String(value).padStart(2, "0");
      return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
    }
    function framesOf(value: string): number {
      const [hh, mm, ss, ff] = value.split(":").map(Number);
      return ((hh * 60 + mm) * 60 + ss) * 24 + ff;
    }
    const eventRe =
      /^(\d+)\s+(\S+)\s+V\s+([CD])\s+(?:(\d+)\s+)?(\d\d:\d\d:\d\d:\d\d)\s+(\d\d:\d\d:\d\d:\d\d)\s+(\d\d:\d\d:\d\d:\d\d)\s+(\d\d:\d\d:\d\d:\d\d)\s*$/;
    const events = edl
      .split("\n")
      .map((line) => eventRe.exec(line.trim()))
      .filter((match): match is RegExpExecArray => Boolean(match));
    assert(events.length === 3, `EDL has three events, got ${events.length}`);
    const frameOfJob = (id: string) => frameCountOf(storage.resolveDataPath(storage.getJob(id)!.outputPath!));
    const frames1 = frameOfJob(editV3);
    const frames2 = frameOfJob(editShot2Job);
    const frames3 = frameOfJob(editShot3Job);
    assert(events[0][2] === "SH010_v03" && events[0][3] === "C", "first event is a cut of SH010_v03");
    assert(events[0][5] === tc(0) && events[0][6] === tc(frames1), "first source in/out");
    assert(events[0][7] === tc(0) && events[0][8] === tc(frames1), "first record in/out");
    assert(events[1][2] === "SH020_v01" && events[1][3] === "C", "second event is a hard cut");
    assert(events[1][5] === "00:00:00:01", `chained hard cut trims one frame, source in ${events[1][5]}`);
    assert(framesOf(events[1][6]) - framesOf(events[1][5]) === frames2 - 1, "trim keeps the rest of the clip");
    assert(framesOf(events[1][7]) === frames1, "hard cut starts where the previous shot ends");
    assert(framesOf(events[1][8]) - framesOf(events[1][7]) === frames2 - 1, "record duration matches the trimmed clip");
    assert(events[2][2] === "SH030_v01" && events[2][3] === "D", "third event is a dissolve");
    assert(Number(events[2][4]) === 12, `0.5s crossfade is 12 frames at 24 fps, got ${events[2][4]}`);
    assert(events[2][5] === tc(0) && framesOf(events[2][6]) === frames3, "dissolve uses the whole next clip");
    const overlap = framesOf(events[1][8]) - framesOf(events[2][7]);
    assert(overlap === 12, `dissolve overlaps the previous shot by 12 frames, got ${overlap}`);
    assert(framesOf(events[2][8]) - framesOf(events[2][7]) === frames3, "dissolve record duration is the clip");

    const manifest1 = packed.manifests.find((item) => item.filename === "SH010_v03.mp4");
    const manifest2 = packed.manifests.find((item) => item.shot === "SH020");
    const manifest3 = packed.manifests.find((item) => item.shot === "SH030");
    assert(manifest1 && manifest2 && manifest3, "one manifest per exported take");
    assert(manifest1.provider === "mock" && manifest1.comfyuiWorkflowName === null, "mock has no workflow name");
    assert(manifest1.sharedStyleText === "cool dusk grade", "shared style text is in the manifest");
    assert(
      manifest1.prompt.includes("cool dusk grade") && manifest1.prompt.includes("Lanterns over the water"),
      "manifest prompt is the take prompt"
    );
    assert(manifest1.chainSource === null, "an unchained shot has no chain source");
    assert(typeof manifest1.seed === "number", "seed is recorded");
    assert(manifest1.frames === frames1 && manifest1.fps === 24, "frames and fps come from the file");
    assert(manifest1.width > 0 && manifest1.height > 0 && manifest1.size === `${manifest1.width}x${manifest1.height}`, "size is recorded");
    const stillHash = createHash("sha256")
      .update(fs.readFileSync(storage.resolveDataPath(storage.getJob(editV3)!.imagePath)))
      .digest("hex");
    assert(manifest1.sourceStillSha256 === stillHash, "source still hash");
    assert(manifest2.chainSource?.fromFilename === "SH010_v03.mp4", "chain source names the approved take");
    assert(manifest2.chainSource?.fromShot === "SH010" && manifest2.chainSource.framesBack === 0, "chain source is the last frame of SH010");
    assert(/last frame/.test(manifest2.chainSource?.frame || ""), "chain source says last frame");
    const chainedHash = createHash("sha256")
      .update(fs.readFileSync(storage.resolveDataPath(storage.getJob(editShot2Job)!.imagePath)))
      .digest("hex");
    assert(manifest2.sourceStillSha256 === chainedHash, "chained take hashes the still it used");
    assert(manifest3.provider === "comfyui", "provider is the take's provider");
    assert(
      manifest3.comfyuiWorkflowName === "Wan 2.2 TI2V-5B (workflows/comfyui-wan22-ti2v-5b.api.json)",
      `workflow name: ${manifest3.comfyuiWorkflowName}`
    );
    assert(manifest3.chainSource === null, "the crossfade shot was not chained");

    const exportedText = [
      edl,
      ...packed.manifests.map((item) => JSON.stringify(item)),
      names.join("\n"),
    ].join("\n");
    for (const secret of [falSecret, headerSecret, urlSecret, replicateSecret]) {
      assert(!exportedText.includes(secret), "export included a secret");
    }
    assert(!exportedText.includes("PREVIEW_SHOULD_NOT_EXPORT"), "preview clips stay out of the edit export");
    assert(!/FAL_KEY|REPLICATE_API_TOKEN|COMFYUI_AUTH_HEADER|COMFYUI_BASE_URL|Authorization/i.test(exportedText), "export names no key or header");
    assert(!process.env.FAL_KEY || !exportedText.includes(process.env.FAL_KEY), "FAL_KEY value is absent");

    const editStitch = await stitch.stitchProject(editProject.id);
    assert(editStitch.includedJobIds[0] === editV3, "the stitch uses the same approved take as the export");
    assert(editStitch.seams[0]?.mode === "cut" && editStitch.seams[0].droppedFrames === 1, "stitch trims one frame on the hard cut");
    assert(
      editStitch.seams[1]?.mode === "crossfade" && editStitch.seams[1].fadeSec === 0.5,
      "stitch crossfade is 0.5s"
    );
    assert(fs.statSync(storage.resolveDataPath(editStitch.outputPath)).size > 1000, "mock stitch still writes an mp4");
  } finally {
    delete process.env.FAL_KEY;
    delete process.env.COMFYUI_AUTH_HEADER;
    delete process.env.COMFYUI_BASE_URL;
    delete process.env.REPLICATE_API_TOKEN;
  }
  assert(!process.env.FAL_KEY && !process.env.REPLICATE_API_TOKEN && !process.env.COMFYUI_AUTH_HEADER, "edit export did not need a provider key");

  const conform = await import("../src/lib/conform");
  const { CONFORM_HONESTY } = await import("../src/lib/types");
  assert(conform.majorityFps([16, 16, 24]) === 16, "majority fps is 16 when 16 leads");
  assert(conform.majorityFps([16, 24]) === 24, "an fps tie uses the higher rate");
  assert(conform.majorityFps([25, 25, 16, 16]) === 25, "an fps tie of 25 and 16 uses 25");
  assert(conform.majorityFps([24, 30, 30, 24]) === 30, "30 wins a tie with 24");
  assert(conform.majorityFps([23.976, 24.2, 16]) === 24, "rates near 24 count as 24");
  const larger = conform.majoritySize([
    { width: 1280, height: 720 },
    { width: 1920, height: 1080 },
  ]);
  assert(larger.width === 1920 && larger.height === 1080, "a size tie uses the larger frame");
  const common = conform.majoritySize([
    { width: 1280, height: 720 },
    { width: 1280, height: 720 },
    { width: 640, height: 480 },
  ]);
  assert(common.width === 1280 && common.height === 720, "majority size is 1280x720");
  const wide = conform.letterboxFit(1920, 800, 1280, 720);
  assert(wide.letterboxed && !wide.pillarboxed, "a wide frame is letterboxed");
  assert(wide.width === 1280 && wide.height === 533 && wide.padX === 0 && wide.padY === 93, "letterbox math");
  assert(Math.abs(wide.width / wide.height - 1920 / 800) < 0.01, "letterbox keeps the aspect ratio");
  const square = conform.letterboxFit(640, 640, 1280, 720);
  assert(square.pillarboxed && !square.letterboxed && square.padX === 280 && square.padY === 0, "a square frame is pillarboxed");
  const sameFit = conform.letterboxFit(1280, 720, 1280, 720);
  assert(!sameFit.letterboxed && !sameFit.pillarboxed && sameFit.padX === 0 && sameFit.padY === 0, "a matching frame is not padded");
  assert(conform.conformVideoFilter(1280, 720, 24) === conform.HISTORIC_NORMALIZE, "24 fps 1280x720 keeps the old filter");
  const rateFilter = conform.conformVideoFilter(1920, 1080, 25);
  assert(rateFilter.includes("fps=25") && rateFilter.includes("force_original_aspect_ratio=decrease"), "conform filter sets fps and pads");
  assert(!rateFilter.includes("setpts"), "conform filter does not speed the clip with setpts");
  assert(conform.silenceForClip(false, true) && !conform.silenceForClip(true, true) && !conform.silenceForClip(false, false), "silence is added only for a silent clip in a mixed cut");
  assert(conform.loudnessOn(null, true) && !conform.loudnessOn(null, false), "loudness defaults on only when a clip has audio");
  assert(conform.loudnessOn(false, true) === false && conform.loudnessOn(true, false) === false, "loudness can be turned off, and stays off with no audio");
  const labelPlan = conform.planTakeConform(
    { outputFps: null, outputWidth: null, outputHeight: null, loudnessNormalize: null },
    [
      { shotId: "wide", fps: 16, width: 1920, height: 800, hasAudio: true },
      { shotId: "a", fps: 24, width: 1280, height: 720, hasAudio: true },
      { shotId: "b", fps: 24, width: 1280, height: 720, hasAudio: true },
    ]
  );
  assert(labelPlan.fps === 24 && labelPlan.width === 1280 && labelPlan.height === 720, "plan uses majority 24 fps and 1280x720");
  assert(labelPlan.shots[0].label === "16 fps → 24 fps, letterboxed", `conform label: ${labelPlan.shots[0].label}`);
  assert(labelPlan.shots[1].label === null, "a matching clip has no conform label");
  assert(/duplicating or dropping frames/.test(labelPlan.summary), "the summary says frames are duplicated or dropped");
  assert(!/character lock|lip-sync|long film/i.test(labelPlan.summary), "the summary does not claim a lock");
  assert(/duplicating or dropping frames/.test(CONFORM_HONESTY) && /not by speeding/i.test(CONFORM_HONESTY), "copy says the rate change is not a speed change");
  assert(/does not lock a character/i.test(CONFORM_HONESTY) && /lip-sync/i.test(CONFORM_HONESTY) && /long film/i.test(CONFORM_HONESTY), "conform copy keeps the lock out of scope");
  const tied = conform.planTakeConform(
    { outputFps: null, outputWidth: null, outputHeight: null, loudnessNormalize: null },
    [
      { shotId: "slow", fps: 16, width: 640, height: 480, hasAudio: false },
      { shotId: "fast", fps: 24, width: 1280, height: 720, hasAudio: true },
    ]
  );
  assert(tied.fps === 24, "one 16 and one 24 conform to 24");
  assert(tied.shots[0].label === "16 fps → 24 fps, pillarboxed, silence added", `mixed label: ${tied.shots[0].label}`);
  assert(tied.loudness, "mixed audio turns loudness on");
  const projectTarget = conform.resolveConformTarget(
    { outputFps: 25, outputWidth: 1920, outputHeight: 1080 },
    [{ fps: 16, width: 640, height: 480 }]
  );
  assert(projectTarget.fps === 25 && projectTarget.fpsSource === "project", "a project fps override wins");
  assert(projectTarget.width === 1920 && projectTarget.height === 1080 && projectTarget.sizeSource === "project", "a project size override wins");
  const silentArgs = stitch.conformClipArgs({
    src: "silent.mp4",
    dest: "out.mp4",
    videoFilter: conform.HISTORIC_NORMALIZE,
    withAudio: true,
    hasAudio: false,
  });
  assert(silentArgs.some((arg) => arg.includes("anullsrc")), "a silent clip in a mixed cut gets a silent audio source");
  assert(silentArgs.includes("-shortest"), "silence is trimmed to the video");
  const quietArgs = stitch.conformClipArgs({
    src: "silent.mp4",
    dest: "out.mp4",
    videoFilter: conform.HISTORIC_NORMALIZE,
    withAudio: false,
    hasAudio: false,
  });
  assert(quietArgs.includes("-an") && !quietArgs.some((arg) => arg.includes("anullsrc")), "an all-silent cut stays video only");
  const at25 = edit.timelineEvents(
    [
      { filename: "a.mp4", frames: 25 },
      { filename: "b.mp4", frames: 25 },
    ],
    [{ mode: "crossfade", fadeSec: 0.5, droppedFrames: 0 }],
    25
  );
  assert(at25[1].dissolveFrames === 13, "a 0.5s dissolve is 13 frames at 25 fps");
  assert(edit.dissolveFrames(0.5, 24) === 12, "the same dissolve is 12 frames at 24 fps");
  assert(edit.framesToTimecode(25, 25) === "00:00:01:00", "25 frames at 25 fps is one second");
  assert(edit.framesToTimecode(25, 24) === "00:00:01:01", "25 frames at 24 fps is not the same timecode");
  assert(edit.formatCmx3600("Rate", at25, 25).includes("Timecode is 25 fps non-drop"), "EDL names the conformed rate");

  function conformStill(projectId: string): string {
    const rel = `uploads/${projectId}/conform-still.png`;
    const abs = path.join(dataDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, solidPng(dataDir, `conform-still-${projectId}.png`, "red"));
    return rel;
  }

  function attachClip(
    projectId: string,
    shotId: string,
    imagePath: string,
    filename: string,
    args: string[]
  ): string {
    const { abs, rel } = storage.absoluteOutputPath(projectId, filename);
    runFfmpegSync(["-y", ...args, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", abs]);
    const job = storage.createJob({
      projectId,
      shotId,
      prompt: "conform clip",
      presetId: "slow-zoom-in",
      provider: "mock",
      status: "completed",
      imagePath,
    });
    storage.updateJob(job.id, { status: "completed", outputPath: rel });
    return rel;
  }

  const rateProject = storage.createProject("Conform rate", "");
  const rateStill = conformStill(rateProject.id);
  const rateShots = [0, 1, 2].map((index) =>
    storage.createShot({
      projectId: rateProject.id,
      prompt: `rate ${index}`,
      presetId: "slow-zoom-in",
      durationSec: 1,
      startImagePath: rateStill,
    })
  );
  attachClip(rateProject.id, rateShots[0].id, rateStill, "rate-a.mp4", [
    "-f",
    "lavfi",
    "-i",
    "color=c=green:s=320x180:r=16:d=0.5",
    "-frames:v",
    "8",
    "-an",
  ]);
  attachClip(rateProject.id, rateShots[1].id, rateStill, "rate-b.mp4", [
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x180:r=16:d=0.5",
    "-frames:v",
    "8",
    "-an",
  ]);
  attachClip(rateProject.id, rateShots[2].id, rateStill, "rate-c.mp4", [
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=640x360:r=24:d=0.5",
    "-frames:v",
    "12",
    "-an",
  ]);
  const rateExport = await edit.buildEditExport(rateProject.id);
  assert(rateExport.edl.includes("Timecode is 16 fps non-drop"), "EDL timecode uses the majority 16 fps");
  assert(!rateExport.edl.includes("Timecode is 24 fps"), "EDL does not stay on 24 fps when the cut is 16");
  const rateInfo = (await import("../src/lib/ffmpeg")).probeVideoStream(
    storage.resolveDataPath(storage.getJob(storage.listJobs(rateProject.id).find((job) => job.shotId === rateShots[2].id)!.id)!.outputPath!)
  );
  const framesAt16 = edit.reviewFrames(rateInfo, 16);
  const framesAt24 = edit.reviewFrames(rateInfo, 24);
  assert(framesAt16 !== framesAt24, "the 24 fps clip has a different length at 16 fps");
  assert(rateExport.edl.includes(edit.framesToTimecode(framesAt16, 16)), "the 24 fps clip is timed at the conformed 16 fps");
  assert(!rateExport.edl.includes(edit.framesToTimecode(framesAt24, 24)) || edit.framesToTimecode(framesAt16, 16) !== edit.framesToTimecode(framesAt24, 24), "24 fps timecode is not the record");

  const overrideProject = storage.createProject("Conform override", "");
  storage.updateProject(overrideProject.id, { outputFps: 25 });
  assert(storage.getProject(overrideProject.id)?.outputFps === 25, "project fps is stored");
  const overrideStill = conformStill(overrideProject.id);
  const overrideShots = [0, 1].map((index) =>
    storage.createShot({
      projectId: overrideProject.id,
      prompt: `override ${index}`,
      presetId: "slow-zoom-in",
      durationSec: 1,
      startImagePath: overrideStill,
    })
  );
  storage.updateShot(overrideShots[1].id, { seamMode: "crossfade", seamFadeSec: 0.5 });
  for (const [index, shot] of overrideShots.entries()) {
    attachClip(overrideProject.id, shot.id, overrideStill, `over-${index}.mp4`, [
      "-f",
      "lavfi",
      "-i",
      `color=c=${index === 0 ? "green" : "blue"}:s=320x180:r=24:d=1`,
      "-an",
    ]);
  }
  const overrideExport = await edit.buildEditExport(overrideProject.id);
  assert(overrideExport.edl.includes("Timecode is 25 fps non-drop"), "EDL uses the project fps override");
  const overrideEvents = overrideExport.edl
    .split("\n")
    .map((line) =>
      /^(\d+)\s+(\S+)\s+V\s+([CD])\s+(?:(\d+)\s+)?(\d\d:\d\d:\d\d:\d\d)\s+/.exec(line.trim())
    )
    .filter((match): match is RegExpExecArray => Boolean(match));
  assert(overrideEvents.length === 2, "override EDL has two events");
  assert(Number(overrideEvents[1][4]) === 13, `0.5s at 25 fps is 13 frames, got ${overrideEvents[1][4]}`);
  storage.updateProject(overrideProject.id, { outputFps: null });
  assert(storage.getProject(overrideProject.id)?.outputFps == null, "clearing the fps override returns to the majority");

  const mixProject = storage.createProject("Conform mix", "");
  const mixStill = conformStill(mixProject.id);
  const mixShots = [0, 1].map((index) =>
    storage.createShot({
      projectId: mixProject.id,
      prompt: `mix ${index}`,
      presetId: "slow-zoom-in",
      durationSec: 1,
      startImagePath: mixStill,
    })
  );
  const silentRel = attachClip(mixProject.id, mixShots[0].id, mixStill, "mix-silent.mp4", [
    "-f",
    "lavfi",
    "-i",
    "color=c=0x00ff00:s=640x480:r=16:d=1",
    "-an",
  ]);
  const loudRel = attachClip(mixProject.id, mixShots[1].id, mixStill, "mix-loud.mp4", [
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=1280x720:r=24:d=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=1",
    "-c:a",
    "aac",
    "-shortest",
  ]);
  assert(!hasAudioStream(storage.resolveDataPath(silentRel)), "the first clip has no audio");
  assert(hasAudioStream(storage.resolveDataPath(loudRel)), "the second clip has audio");
  const mixed = await stitch.stitchProject(mixProject.id);
  const mixedAbs = storage.resolveDataPath(mixed.outputPath);
  const mixedDur = mediaDuration(mixedAbs);
  assert(mixedDur > 1.85 && mixedDur < 2.3, `mixed stitch keeps duration ${mixedDur}, it does not speed 16 fps up to 24`);
  assert(Math.abs(videoRate(mixedAbs) - 24) < 0.05, "the mixed stitch plays at the higher tie rate");
  assert(hasAudioStream(mixedAbs), "silence was added so the mixed cut has audio");
  const edge = (() => {
    const png = path.join(dataDir, `edge-${probeSeq++}.png`);
    runFfmpegSync(["-y", "-i", mixedAbs, "-vf", "crop=16:16:0:240", "-frames:v", "1", png]);
    try {
      return averageRgb(png);
    } finally {
      fs.rmSync(png, { force: true });
    }
  })();
  const middle = (() => {
    const png = path.join(dataDir, `mid-${probeSeq++}.png`);
    runFfmpegSync(["-y", "-i", mixedAbs, "-vf", "crop=16:16:632:352", "-frames:v", "1", png]);
    try {
      return averageRgb(png);
    } finally {
      fs.rmSync(png, { force: true });
    }
  })();
  assert(edge.r < 30 && edge.g < 30 && edge.b < 30, "pillarbox pad is black instead of a stretched frame");
  assert(isGreen(middle), "the picture sits inside the pillarbox");
  const mixedLufs = integratedLufs(mixedAbs);
  assert(mixedLufs < -16, `EBU R128 brought the mixed cut down, measured ${mixedLufs}`);

  const fadeProject = storage.createProject("Conform fade", "");
  const fadeStill = conformStill(fadeProject.id);
  const fadeShots = [0, 1].map((index) =>
    storage.createShot({
      projectId: fadeProject.id,
      prompt: `fade ${index}`,
      presetId: "slow-zoom-in",
      durationSec: 1,
      startImagePath: fadeStill,
    })
  );
  storage.updateShot(fadeShots[1].id, { seamMode: "crossfade", seamFadeSec: 0.5 });
  attachClip(fadeProject.id, fadeShots[0].id, fadeStill, "fade-silent.mp4", [
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=320x180:r=24:d=1",
    "-an",
  ]);
  attachClip(fadeProject.id, fadeShots[1].id, fadeStill, "fade-audio.mp4", [
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x180:r=24:d=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=330:sample_rate=48000:duration=1",
    "-c:a",
    "aac",
    "-shortest",
  ]);
  const fadedMix = await stitch.stitchProject(fadeProject.id);
  const fadedMixAbs = storage.resolveDataPath(fadedMix.outputPath);
  assert(hasAudioStream(fadedMixAbs), "a crossfade between a silent clip and an audio clip keeps audio");
  const fadedMixDur = mediaDuration(fadedMixAbs);
  assert(fadedMixDur > 1.2 && fadedMixDur < 1.9, `crossfade duration ${fadedMixDur} stays near 1.5s`);

  const loudProject = storage.createProject("Conform loudness", "");
  const loudStill = conformStill(loudProject.id);
  const loudShot = storage.createShot({
    projectId: loudProject.id,
    prompt: "loud",
    presetId: "slow-zoom-in",
    durationSec: 2,
    startImagePath: loudStill,
  });
  attachClip(loudProject.id, loudShot.id, loudStill, "loud.mp4", [
    "-f",
    "lavfi",
    "-i",
    "color=c=gray:s=320x180:r=24:d=2",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=2",
    "-c:a",
    "aac",
    "-shortest",
  ]);
  storage.updateProject(loudProject.id, { loudnessNormalize: false });
  const rawStitch = await stitch.stitchProject(loudProject.id);
  const rawLufs = integratedLufs(storage.resolveDataPath(rawStitch.outputPath));
  storage.updateProject(loudProject.id, { loudnessNormalize: null });
  const normStitch = await stitch.stitchProject(loudProject.id);
  const normLufs = integratedLufs(storage.resolveDataPath(normStitch.outputPath));
  assert(normLufs < -20 && normLufs > -26, `EBU R128 lands near -23 LUFS, measured ${normLufs}`);
  assert(rawLufs > normLufs + 0.5, `loudness off stays louder (${rawLufs}) than EBU R128 (${normLufs})`);
  assert(!process.env.FAL_KEY && !process.env.REPLICATE_API_TOKEN, "conform checks did not need a provider key");

  const captions = await import("../src/lib/captions");
  const musicBed = await import("../src/lib/music-bed");
  const { FINISH_HONESTY } = await import("../src/lib/types");
  const { runMockGenerate } = await import("../src/lib/providers/mock");
  const badSrt = captions.parseSrt(
    "1\n00:00:02,000 --> 00:00:01,000\nBackwards\n\n2\n1:2:3 --> 4:5:6\nMissing\n"
  );
  assert(badSrt.cues.length === 0, "a bad SRT does not import cues");
  assert(badSrt.errors.some((line) => /not after the start time/.test(line)), `end-before-start error: ${badSrt.errors.join(" | ")}`);
  assert(badSrt.errors.some((line) => /HH:MM:SS/.test(line)), `timestamp error: ${badSrt.errors.join(" | ")}`);
  assert(captions.parseSrt("hello").errors[0].includes("not an SRT"), "a plain text file is rejected as SRT");
  const twoCues = captions.parseSrt(
    "1\n00:00:00,500 --> 00:00:01,500\nHarbor dusk\n\n2\n00:00:02,500 --> 00:00:03,500\nLanterns\n"
  );
  assert(twoCues.errors.length === 0 && twoCues.cues.length === 2, "a 2-cue SRT parses");
  const snapped = captions.cuesOnTimeline([{ index: 1, startSec: 0.03, endSec: 0.2, text: "Frame" }], 25, 1);
  assert(Math.abs(snapped[0].startSec - 0.04) < 0.0001, "0.03s snaps to one frame at 25 fps");
  assert(captions.formatSrt(snapped).includes("00:00:00,040"), "the snapped cue is written at the conformed rate");
  assert(
    musicBed.finishLine({ hasMusic: true, anyClipAudio: true, captionCount: 14, captionMode: "burn" }) ===
      "music bed, ducked; 14 captions burned in",
    "the stitch line names a ducked bed and burned-in captions"
  );
  assert(
    musicBed.finishLine({ hasMusic: true, anyClipAudio: false, captionCount: 2, captionMode: "sidecar" }) ===
      "music bed, at its level; 2 captions as a sidecar",
    "a silent cut does not claim ducking"
  );
  const ducked = musicBed.musicFilter({ durationSec: 4, levelDb: -18, fadeInSec: 0.25, fadeOutSec: 1, duck: true });
  const levelOnly = musicBed.musicFilter({ durationSec: 4, levelDb: -18, fadeInSec: 0, fadeOutSec: 1, duck: false });
  assert(ducked.includes("sidechaincompress") && ducked.includes("volume=-18.0dB"), "clip audio sidechains the bed");
  assert(!levelOnly.includes("sidechaincompress") && levelOnly.includes("[1:a]"), "a silent cut plays the bed at its level");
  assert(
    captions.burnInProblemFrom("drawtext", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")?.includes("libass"),
    "burn-in names libass when the subtitles filter is missing"
  );
  assert(
    captions.burnInProblemFrom("subtitles", null)?.includes("DejaVu Sans"),
    "burn-in names the font when DejaVu Sans is missing"
  );
  assert(captions.burnInProblemFrom(" ... subtitles V->V", captions.findBurnFont()) == null, "this ffmpeg can burn captions");
  assert(conform.masterLoudnormFilter(true).includes("I=-14"), "a music bed masters to -14 LUFS");
  assert(conform.masterLoudnormFilter(false) === conform.LOUDNORM_FILTER, "clips alone stay on EBU R128");
  assert(conform.masterLoudnessOn(null, false, true) && !conform.masterLoudnessOn(false, true, true), "music loudness defaults on and can be turned off");
  assert(!/transcrib/i.test(FINISH_HONESTY) || /does not transcribe/i.test(FINISH_HONESTY), "copy does not promise transcription");
  assert(/does not transcribe/i.test(FINISH_HONESTY) && /lip-sync/i.test(FINISH_HONESTY) && /does not lock a character/i.test(FINISH_HONESTY), "music and caption copy stays inside the product");

  const bedProject = storage.createProject("Music bed", "");
  const bedStill = storage.saveUpload(bedProject.id, "bed.png", solidPng(dataDir, "bed-still.png", "red"));
  const bedShots = [0, 1].map((index) =>
    storage.createShot({
      projectId: bedProject.id,
      prompt: `bed ${index}`,
      presetId: "slow-zoom-in",
      durationSec: 2,
      startImagePath: bedStill,
    })
  );
  for (const [index, shot] of bedShots.entries()) {
    const job = storage.createJob({
      projectId: bedProject.id,
      shotId: shot.id,
      prompt: shot.prompt,
      presetId: "slow-zoom-in",
      provider: "mock",
      status: "queued",
      imagePath: bedStill,
      durationSec: 2,
    });
    await runMockGenerate(job.id);
    assert(storage.getJob(job.id)?.status === "completed", `mock clip ${index} rendered`);
  }
  const voiced = storage.listJobs(bedProject.id).find((job) => job.shotId === bedShots[0].id);
  assert(voiced?.outputPath, "the first mock clip has a file");
  const voicedAbs = storage.resolveDataPath(voiced!.outputPath!);
  const voicedWithTone = `${voicedAbs}.tone.mp4`;
  runFfmpegSync([
    "-y",
    "-i",
    voicedAbs,
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-shortest",
    voicedWithTone,
  ]);
  fs.renameSync(voicedWithTone, voicedAbs);
  assert(hasAudioStream(voicedAbs), "one mock clip now has sound so the bed can duck");
  const toneRel = `uploads/${bedProject.id}/bed-tone.wav`;
  const toneAbs = path.join(dataDir, toneRel);
  fs.mkdirSync(path.dirname(toneAbs), { recursive: true });
  runFfmpegSync([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:sample_rate=48000:duration=0.4",
    toneAbs,
  ]);
  const tonePath = storage.saveUpload(bedProject.id, "bed-tone.wav", fs.readFileSync(toneAbs));
  assert(tonePath.startsWith("uploads/"), "the music bed is stored with other local media");
  const srtBody =
    "1\n00:00:00,500 --> 00:00:01,500\nHarbor dusk\n\n2\n00:00:02,500 --> 00:00:03,500\nLanterns\n";
  const srtPath = storage.saveUpload(bedProject.id, "captions.srt", Buffer.from(srtBody));
  storage.updateProject(bedProject.id, {
    musicBedPath: tonePath,
    musicLevelDb: -18,
    musicFadeInSec: 0.25,
    musicFadeOutSec: 0.5,
    captionsPath: srtPath,
    captionMode: "burn",
  });
  const bedStitch = await stitch.stitchProject(bedProject.id);
  const bedAbs = storage.resolveDataPath(bedStitch.outputPath);
  const bedDur = mediaDuration(bedAbs);
  assert(bedDur > 3.6 && bedDur < 4.5, `music-bed stitch duration ${bedDur} stays near 4s`);
  assert(hasAudioStream(bedAbs), "the stitched mp4 has an audio stream");
  assert(
    bedStitch.finish?.line === "music bed, ducked; 2 captions burned in",
    `finish line: ${bedStitch.finish?.line}`
  );
  assert(bedStitch.finish?.fitNote?.includes("loops"), "a short bed loops to the cut");
  const bedLufs = integratedLufs(bedAbs);
  assert(bedLufs < -10 && bedLufs > -18, `music bed masters near -14 LUFS, measured ${bedLufs}`);
  function nearWhiteCount(file: string, atSec: number): number {
    const png = path.join(dataDir, `cap-${probeSeq++}.png`);
    runFfmpegSync([
      "-y",
      "-ss",
      String(atSec),
      "-i",
      file,
      "-vf",
      "crop=in_w:in_h/5:0:in_h*4/5",
      "-frames:v",
      "1",
      png,
    ]);
    const raw = spawnSync("ffmpeg", ["-v", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], {
      maxBuffer: 8 * 1024 * 1024,
    });
    fs.rmSync(png, { force: true });
    const bytes = raw.stdout;
    if (raw.status !== 0 || !Buffer.isBuffer(bytes)) throw new Error(raw.stderr?.toString() || "caption frame failed");
    let count = 0;
    for (let i = 0; i + 2 < bytes.length; i += 3) {
      if (bytes[i] > 220 && bytes[i + 1] > 220 && bytes[i + 2] > 220) count += 1;
    }
    return count;
  }
  const onCue = nearWhiteCount(bedAbs, 1);
  const offCue = nearWhiteCount(bedAbs, 2);
  assert(onCue > 8, `burned caption pixels at 1s: ${onCue}`);
  assert(onCue > offCue * 3, `caption gap at 2s (${offCue}) should be quieter than the cue (${onCue})`);
  storage.updateProject(bedProject.id, { captionMode: "sidecar" });
  const sideStitch = await stitch.stitchProject(bedProject.id);
  assert(sideStitch.finish?.line === "music bed, ducked; 2 captions as a sidecar", `sidecar line: ${sideStitch.finish?.line}`);
  assert(sideStitch.finish?.sidecarPath, "sidecar path is returned");
  const sideSrt = fs.readFileSync(storage.resolveDataPath(sideStitch.finish!.sidecarPath!), "utf8");
  assert(sideSrt.includes("Harbor dusk") && sideSrt.includes("Lanterns"), "the sidecar has both cues");
  assert((sideSrt.match(/-->/g) ?? []).length === 2, "the sidecar has 2 cues");
  const sideWhite = nearWhiteCount(storage.resolveDataPath(sideStitch.outputPath), 1);
  assert(sideWhite * 3 < onCue, `sidecar did not burn the cue (${sideWhite} vs ${onCue})`);
  const bedExport = await edit.buildEditExport(bedProject.id);
  assert(bedExport.srt?.includes("00:00:00,500") && bedExport.srt.includes("00:00:02,500"), "export SRT keeps the conformed 24 fps times");
  const bedZip = await JSZip.loadAsync(bedExport.bytes);
  assert(bedZip.file("captions.srt"), "the edit zip contains captions.srt");
  assert(!process.env.FAL_KEY && !process.env.REPLICATE_API_TOKEN, "music bed and captions did not need a provider key");

  const mixedPass = await import("../src/lib/mixed-pass");
  const sheet = await import("../src/lib/contact-sheet");
  assert(mixedPass.providerContactName("mock") === "mock", "mock label");
  assert(mixedPass.providerContactName("fal") === "fal", "fal label");
  assert(mixedPass.providerContactName("replicate") === "Replicate", "Replicate label");
  assert(mixedPass.providerContactName("comfyui") === "ComfyUI", "ComfyUI label");
  const labelled = sheet.contactLabelLines({
    shotId: "shot-label",
    version: 3,
    preview: false,
    provider: "comfyui",
    seed: 99,
    durationSec: 4,
  });
  assert(labelled.join("\n") === "shot-label\ntake v03\nComfyUI\nseed 99\n4.00s", `contact label lines: ${labelled.join(" | ")}`);
  const previewLines = sheet.contactLabelLines({
    shotId: "shot-preview",
    version: 1,
    preview: true,
    provider: "mock",
    seed: null,
    durationSec: 1.5,
  });
  assert(previewLines[1] === "preview v01" && previewLines[3] === "seed unset", "a preview cell says preview and leaves the seed unset");
  const twoGrid = sheet.contactGrid(2);
  assert(twoGrid.cols === 2 && twoGrid.rows === 1 && twoGrid.width === 960 && twoGrid.height === 390, "two shots sit on one row");
  const fourGrid = sheet.contactGrid(4);
  assert(fourGrid.cols === 3 && fourGrid.rows === 2 && fourGrid.width === 1440 && fourGrid.height === 780, "four shots wrap to two rows");
  assert(sheet.contactSheetProblem("drawtext", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf") === null, "drawtext and DejaVu can label a sheet");
  assert(sheet.contactSheetProblem("scale", "/font") === sheet.CONTACT_DRAWTEXT_MISSING, "a missing drawtext filter is named");
  assert(sheet.contactSheetProblem("drawtext", null) === sheet.CONTACT_FONT_MISSING, "a missing font is named");

  const uniform = mixedPass.describeMixedPass([
    { shotId: "only-mock", position: 1, jobId: "m", provider: "mock", kind: "take", stale: false },
    { shotId: "also-mock", position: 2, jobId: "m2", provider: "mock", kind: "take", stale: false },
  ]);
  assert(!uniform.warn && uniform.text === "", "a mock-only cut does not warn");
  const realOnly = mixedPass.describeMixedPass([
    { shotId: "only-fal", position: 1, jobId: "f", provider: "fal", kind: "take", stale: false },
  ]);
  assert(!realOnly.warn, "one real provider does not warn");
  const staleOnly = mixedPass.describeMixedPass([
    { shotId: "stale-shot", position: 3, jobId: "c", provider: "comfyui", kind: "take", stale: true },
  ]);
  assert(staleOnly.warn && !staleOnly.mixed, "an out-of-date shot warns without calling it mixed");
  assert(!staleOnly.text.includes("MIXED PASSES"), "an out-of-date-only cut is not labelled MIXED PASSES");
  assert(staleOnly.text.includes("stale-shot") && staleOnly.text.includes("Out of date"), "the out-of-date shot is named");
  assert(staleOnly.text.includes("does not promise quality"), "the out-of-date note does not promise quality");
  const previewMix = mixedPass.describeMixedPass([
    { shotId: "prev-shot", position: 1, jobId: "p", provider: "mock", kind: "preview", stale: false },
    { shotId: "rep-shot", position: 2, jobId: "r", provider: "replicate", kind: "take", stale: false },
  ]);
  assert(previewMix.warn && previewMix.mixed, "a preview clip beside a real take is mixed");
  assert(previewMix.text.includes("MIXED PASSES"), "the mixed cut is labelled MIXED PASSES");
  assert(previewMix.text.includes("prev-shot") && previewMix.text.includes("preview clip"), "the preview shot is named");
  assert(previewMix.text.includes("rep-shot") && previewMix.text.includes("Replicate"), "the Replicate shot is named");
  assert(previewMix.fallback.some((pass) => pass.shotId === "prev-shot"), "the free clip is the fallback");
  assert(previewMix.text.includes("does not promise quality"), "the mixed note does not promise quality");
  assert(previewMix.text.includes("does not lock a character"), "the mixed note does not claim a character lock");
  assert(!/\bguarantee\b|broadcast quality|will look the same|perfect match/i.test(previewMix.text), "the mixed note makes no quality promise");
  assert(!/FAL_KEY|REPLICATE_API_TOKEN|COMFYUI_AUTH/.test(previewMix.text), "the mixed note does not print a key");
  const chosenPass = mixedPass.reviewStitchPasses({
    shots: [
      { id: "s-mix", position: 1, approvedJobId: "j-mock", selectedJobId: "j-newer" },
      { id: "s-real", position: 2 },
    ],
    jobs: [
      {
        id: "j-mock",
        createdAt: "2026-01-01T00:00:00.000Z",
        imagePath: "uploads/a.png",
        shotId: "s-mix",
        kind: "take",
        status: "completed",
        outputPath: "outputs/a.mp4",
        provider: "mock",
      },
      {
        id: "j-newer",
        createdAt: "2026-01-02T00:00:00.000Z",
        imagePath: "uploads/a.png",
        shotId: "s-mix",
        kind: "take",
        status: "completed",
        outputPath: "outputs/b.mp4",
        provider: "fal",
      },
      {
        id: "j-real",
        createdAt: "2026-01-01T00:00:01.000Z",
        imagePath: "uploads/a.png",
        shotId: "s-real",
        kind: "take",
        status: "completed",
        outputPath: "outputs/c.mp4",
        provider: "comfyui",
      },
    ],
    staleShotIds: new Set(["s-real"]),
  });
  assert(chosenPass.mixed && chosenPass.fallback.some((pass) => pass.jobId === "j-mock"), "the approved mock take is the free clip");
  assert(!chosenPass.fallback.some((pass) => pass.jobId === "j-newer"), "a newer take is not the cut when an approved take is set");
  assert(chosenPass.text.includes("s-mix") && chosenPass.text.includes("s-real"), "both shots in the mixed cut are named");
  assert(chosenPass.stale.some((pass) => pass.shotId === "s-real"), "the out-of-date shot in the cut is named");
  assert(chosenPass.text.includes("ComfyUI"), "the ComfyUI take is named with that provider");
  const noTake = mixedPass.reviewStitchPasses({
    shots: [{ id: "missing-take", position: 1 }],
    jobs: [],
    staleShotIds: new Set(["missing-take"]),
  });
  assert(!noTake.warn, "a shot with no completed take is not in the cut");

  function imageSize(file: string): { width: number; height: number } {
    const probe = spawnSync(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file],
      { encoding: "utf8" }
    );
    if (probe.status !== 0) throw new Error(probe.stderr || "image probe failed");
    const [width, height] = String(probe.stdout).trim().split(",").map(Number);
    return { width, height };
  }
  function isPng(file: string): boolean {
    const buf = fs.readFileSync(file);
    return buf.length > 8 && buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG";
  }
  function labelWhites(file: string): number {
    const raw = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        file,
        "-vf",
        `crop=iw:${sheet.CONTACT_LABEL_H}:0:ih-${sheet.CONTACT_LABEL_H}`,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
      ],
      { maxBuffer: 32 * 1024 * 1024 }
    );
    const bytes = raw.stdout;
    if (raw.status !== 0 || !Buffer.isBuffer(bytes)) throw new Error(raw.stderr?.toString() || "label crop failed");
    let count = 0;
    for (let i = 0; i + 2 < bytes.length; i += 3) {
      if (bytes[i] > 220 && bytes[i + 1] > 220 && bytes[i + 2] > 220) count += 1;
    }
    return count;
  }

  const quadDir = path.join(dataDir, "quad");
  fs.mkdirSync(quadDir, { recursive: true });
  const quadClips = ["red", "green", "blue", "yellow"].map((color, index) => {
    const file = path.join(quadDir, `${color}.mp4`);
    runFfmpegSync([
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=320x180:r=24:d=0.2`,
      "-frames:v",
      "4",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-an",
      file,
    ]);
    return {
      abs: file,
      shotId: `quad-${color}`,
      version: index + 1,
      preview: false,
      provider: (["mock", "fal", "replicate", "comfyui"] as const)[index],
      seed: 10 + index,
      durationSec: 0.2,
    };
  });
  const quadPng = path.join(quadDir, "contact.png");
  await sheet.writeContactSheet(quadClips, quadPng);
  assert(isPng(quadPng), "the four-shot contact sheet is a PNG");
  const quadSize = imageSize(quadPng);
  assert(quadSize.width === fourGrid.width && quadSize.height === fourGrid.height, `four-shot sheet is ${quadSize.width}x${quadSize.height}`);
  assert(labelWhites(quadPng) > 20, "the contact sheet draws light label text");

  const sheetProject = storage.createProject("Contact sheet", "");
  const sheetStill = storage.saveUpload(sheetProject.id, "still.png", solidPng(dataDir, "contact-still.png", "navy"));
  const sheetShots = [0, 1].map((index) =>
    storage.createShot({
      projectId: sheetProject.id,
      prompt: `contact ${index}`,
      presetId: "slow-zoom-in",
      durationSec: 1,
      startImagePath: sheetStill,
    })
  );
  const sheetJobs = sheetShots.map((shot, index) => {
    const made = storage.createJob({
      projectId: sheetProject.id,
      shotId: shot.id,
      prompt: shot.prompt,
      presetId: shot.presetId,
      provider: "mock",
      status: "completed",
      imagePath: sheetStill,
      durationSec: 1,
      seed: 100 + index,
    });
    const { abs, rel } = storage.absoluteOutputPath(sheetProject.id, `contact-${index}.mp4`);
    runFfmpegSync([
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${index === 0 ? "teal" : "orange"}:s=640x360:r=24:d=1`,
      "-frames:v",
      "24",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-an",
      abs,
    ]);
    storage.updateJob(made.id, { status: "completed", outputPath: rel });
    return made.id;
  });
  const mockReview = mixedPass.reviewStitchPasses({
    shots: storage.listShots(sheetProject.id),
    jobs: storage.listJobs(sheetProject.id),
    staleShotIds: new Set(),
  });
  assert(!mockReview.warn, "two mock takes do not warn");
  const mockStitch = await stitch.stitchProject(sheetProject.id);
  const mockMp4 = storage.resolveDataPath(mockStitch.outputPath);
  const mockSheet = storage.resolveDataPath(mockStitch.contactSheetPath);
  assert(fs.existsSync(mockMp4), "the mock stitch still writes an mp4");
  assert(mockStitch.contactSheetPath.endsWith(".png") && isPng(mockSheet), "the mock stitch writes a PNG contact sheet");
  const mockSheetSize = imageSize(mockSheet);
  assert(
    mockSheetSize.width === twoGrid.width && mockSheetSize.height === twoGrid.height,
    `mock contact sheet is ${mockSheetSize.width}x${mockSheetSize.height}`
  );
  assert(labelWhites(mockSheet) > 20, "the mock contact sheet has label text");
  assert(mockStitch.includedShotIds[0] === sheetShots[0].id && mockStitch.includedShotIds[1] === sheetShots[1].id, "sheet order follows the shot list");
  storage.updateJob(sheetJobs[1], { provider: "fal" });
  const falReview = mixedPass.reviewStitchPasses({
    shots: storage.listShots(sheetProject.id),
    jobs: storage.listJobs(sheetProject.id),
    staleShotIds: new Set([sheetShots[0].id]),
  });
  assert(falReview.warn && falReview.mixed, "mock beside fal warns");
  assert(falReview.text.includes("MIXED PASSES"), "the studio warning says MIXED PASSES");
  assert(falReview.text.includes(sheetShots[0].id) && falReview.text.includes(sheetShots[1].id), "the warning names both shot ids");
  assert(falReview.text.includes("mock") && falReview.text.includes("fal"), "the warning names mock and fal");
  assert(falReview.stale.some((pass) => pass.shotId === sheetShots[0].id), "the out-of-date shot is included");
  assert(falReview.text.includes("does not promise quality"), "the stitch warning does not promise quality");
  const mixedStitch = await stitch.stitchProject(sheetProject.id);
  assert(fs.existsSync(storage.resolveDataPath(mixedStitch.outputPath)), "stitch anyway still writes the mp4");
  assert(isPng(storage.resolveDataPath(mixedStitch.contactSheetPath)), "stitch anyway still writes the contact sheet");
  const previewJob = storage.createJob({
    projectId: sheetProject.id,
    shotId: sheetShots[0].id,
    prompt: "preview",
    presetId: "slow-zoom-in",
    provider: "mock",
    kind: "preview",
    status: "completed",
    imagePath: sheetStill,
    durationSec: 1,
    seed: 7,
  });
  storage.updateJob(previewJob.id, {
    status: "completed",
    outputPath: storage.getJob(sheetJobs[0])?.outputPath,
  });
  const previewCut = await stitch.stitchPreview(sheetProject.id, [previewJob.id]);
  assert(previewCut.kind === "preview" && previewCut.includedJobIds.length === 1, "preview stitch stays one clip");
  assert(isPng(storage.resolveDataPath(previewCut.contactSheetPath)), "a preview stitch writes a contact sheet");
  const previewSize = imageSize(storage.resolveDataPath(previewCut.contactSheetPath));
  assert(previewSize.width === sheet.contactGrid(1).width && previewSize.height === sheet.contactGrid(1).height, "one preview cell is one column");
  const packedSheet = await edit.buildEditExport(sheetProject.id);
  const packedZip = await JSZip.loadAsync(packedSheet.bytes);
  const packedPng = await packedZip.file("contact-sheet.png")?.async("nodebuffer");
  assert(packedPng && packedPng[0] === 0x89 && packedPng.toString("ascii", 1, 4) === "PNG", "the edit zip contains a PNG contact sheet");
  assert(!process.env.FAL_KEY && !process.env.REPLICATE_API_TOKEN, "the contact sheet did not need a provider key");

  console.log("provider checks ok");
  console.log(dataDir);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
