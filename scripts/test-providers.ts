import { spawnSync } from "child_process";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "star-dust-test-"));
process.env.STAR_DUST_DATA = dataDir;
delete process.env.FAL_KEY;
delete process.env.REPLICATE_API_TOKEN;

function assert(cond: unknown, message: string) {
  if (!cond) throw new Error(message);
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
  assert(done?.status === "completed" && done.outputPath, "comfy stand-in completed");
  const downloaded = storage.resolveDataPath(done!.outputPath!);
  assert(fs.statSync(downloaded).size === mp4.length, "downloaded mp4 bytes");
  await standin.close();

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

  console.log("provider checks ok");
  console.log(dataDir);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
