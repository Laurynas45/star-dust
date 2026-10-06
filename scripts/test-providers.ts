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

  console.log("provider checks ok");
  console.log(dataDir);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
