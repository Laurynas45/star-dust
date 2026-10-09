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
    skippedAll.ok && skippedAll.skipped.some((item) => item.reason === "Completed take already matches these inputs"),
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
  assert(
    Math.abs(oneJoin.durationSec - (clipSum - 0.5)) <= 0.4,
    `one crossfade duration ${oneJoin.durationSec} should be about ${clipSum - 0.5}`
  );

  storage.updateShot(shotC.id, { seamMode: null, seamFadeSec: null });
  const hardCut = await stitch.stitchProject(continuity.id);
  assert(hardCut.seams.every((seam) => seam.mode === "cut"), "project hard cut");
  assert(Math.abs(hardCut.durationSec - clipSum) <= 0.4, `hard cut duration ${hardCut.durationSec} should be about ${clipSum}`);
  assert(hardCut.durationSec > faded.durationSec + 0.6, "hard cut is longer than the two crossfades");

  const skippedChain = render.renderAll(continuity.id);
  assert(skippedChain.ok && skippedChain.jobs.length === 0, "a current chained take is skipped like any other match");

  storage.updateShot(shotB.id, { chainFromPrevious: false });
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

  console.log("provider checks ok");
  console.log(dataDir);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
