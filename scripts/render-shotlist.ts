import fs from "fs";
import os from "os";
import path from "path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "stardust-shotlist-"));
process.env.STAR_DUST_DATA = dataDir;

type ProviderId = "mock" | "fal" | "replicate" | "comfyui";

function isProvider(value: string | undefined): value is ProviderId {
  return value === "mock" || value === "fal" || value === "replicate" || value === "comfyui";
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function providerTitle(provider: ProviderId): string {
  if (provider === "fal") return "fal";
  if (provider === "replicate") return "Replicate";
  if (provider === "comfyui") return "ComfyUI";
  return "Mock";
}

/**
 * Mock unless --provider is set and the matching environment value is present.
 * The file's provider is never used on its own. The note is printed when this
 * run stays on Mock for that reason.
 */
function resolveRunProvider(named: ProviderId, flag: ProviderId | null): { provider: ProviderId; note: string | null } {
  const mockNote = (reason: string) =>
    `${reason} This run uses Mock (camera motion only, ffmpeg Ken Burns).`;

  if (flag == null) {
    if (named === "mock") return { provider: "mock", note: null };
    const need =
      named === "fal" ? "FAL_KEY" : named === "replicate" ? "REPLICATE_API_TOKEN" : "COMFYUI_BASE_URL";
    return {
      provider: "mock",
      note: mockNote(
        `This file names ${providerTitle(named)}. Pass --provider ${named} with ${need} set to use ${providerTitle(named)}.`
      ),
    };
  }
  if (flag === "mock") {
    if (named !== "mock") {
      return { provider: "mock", note: mockNote(`This file names ${providerTitle(named)}. --provider mock keeps Mock.`) };
    }
    return { provider: "mock", note: null };
  }
  const missing =
    flag === "fal"
      ? process.env.FAL_KEY
        ? null
        : "FAL_KEY"
      : flag === "replicate"
        ? process.env.REPLICATE_API_TOKEN
          ? null
          : "REPLICATE_API_TOKEN"
        : process.env.COMFYUI_BASE_URL
          ? null
          : "COMFYUI_BASE_URL";
  if (missing) {
    return {
      provider: "mock",
      note: mockNote(
        `This file names ${providerTitle(named)}. --provider ${flag} needs ${missing}, which is not set.`
      ),
    };
  }
  return { provider: flag, note: null };
}

function parseArgs(argv: string[]): {
  file: string;
  first: boolean;
  provider: ProviderId | null;
  includeFlagged: boolean;
  evenColour: boolean;
} {
  let first = false;
  let includeFlagged = false;
  let evenColour = false;
  let provider: ProviderId | null = null;
  const files: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--first") {
      first = true;
      continue;
    }
    if (arg === "--include-flagged") {
      includeFlagged = true;
      continue;
    }
    if (arg === "--even-colour") {
      evenColour = true;
      continue;
    }
    if (arg === "--provider") {
      const value = argv[index + 1];
      if (!isProvider(value)) {
        fail("--provider needs mock, fal, replicate, or comfyui.");
      }
      provider = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) fail(`Unknown flag ${arg}.`);
    files.push(arg);
  }
  if (files.length !== 1) {
    fail(
      "Usage: npm run render:shotlist -- <file> [--first] [--include-flagged] [--even-colour] [--provider mock|fal|replicate|comfyui]"
    );
  }
  return { file: files[0], first, provider, includeFlagged, evenColour };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const shotlist = await import("../src/lib/shotlist");
  const storage = await import("../src/lib/storage");
  const render = await import("../src/lib/render");
  const stitch = await import("../src/lib/stitch");
  const providers = await import("../src/lib/providers");
  const clipCheck = await import("../src/lib/clip-check");

  const loaded = await shotlist.loadShotListPath(path.resolve(args.file));
  if (!loaded.bundle || loaded.errors.length > 0) {
    for (const error of loaded.errors) console.error(error);
    process.exit(1);
  }
  const imported = shotlist.importShotList(loaded.bundle);
  if (!imported.ok) {
    for (const error of imported.errors) console.error(error);
    process.exit(1);
  }
  if (args.evenColour) {
    storage.updateProject(imported.project.id, { evenColour: true });
  }

  const named = imported.project.provider ?? "mock";
  const run = resolveRunProvider(named, args.provider);
  storage.saveSettings({ provider: run.provider });

  const shots = storage.listShots(imported.project.id);
  const preflightRun = await import("../src/lib/preflight-run");
  const preflight = await import("../src/lib/preflight");
  const project = storage.getProject(imported.project.id);
  if (project) {
    console.log(preflight.formatPreflight(preflightRun.preflightStoredProject(project, shots, storage.getSettings())));
  }
  const target = args.first ? shots.find((shot) => shot.enabled !== false) : undefined;
  if (args.first && !target) fail("No enabled shot to render.");

  const comfy = await import("../src/lib/providers/comfyui");
  const pendingWorkflows =
    args.first && target
      ? render.comfyWorkflowsBeforeRenderShot(target.id)
      : render.comfyWorkflowsBeforeRenderAll(imported.project.id);
  const block = await comfy.guardComfyWorkflows(pendingWorkflows);
  if (block) fail(block.error);

  const result = args.first && target ? render.renderShot(target.id) : render.renderAll(imported.project.id);
  if (!result.ok) fail(result.error);
  for (const job of result.jobs) providers.enqueueJob(job.id);
  await providers.waitForQueue();
  const finished = [];
  for (const job of result.jobs) {
    const done = storage.getJob(job.id);
    if (!done || done.status !== "completed" || !done.outputPath) {
      fail(done?.error || `Shot did not render (${done?.status ?? "missing"}).`);
    }
    finished.push(done!);
  }

  let held = false;
  for (const done of finished) {
    if (!done.clipCheck?.flagged) continue;
    const shot = shots.find((item) => item.id === done.shotId);
    const where = shot ? `Shot ${shot.position}` : "Clip";
    if (args.includeFlagged) clipCheck.setClipIncludeAnyway(done.id, true);
    const fresh = storage.getJob(done.id);
    console.log(`${where}: ${fresh?.clipCheck?.status || done.clipCheck.status}`);
    const hints = fresh?.clipCheck?.hints ?? done.clipCheck.hints;
    hints.forEach((hint, index) => console.log(`${index + 1}. ${hint}`));
    if (args.includeFlagged) {
      console.log(`${where}: included in the stitch because you passed --include-flagged.`);
    } else {
      held = true;
    }
  }

  const stitched = await stitch.stitchProject(imported.project.id);
  const abs = storage.resolveDataPath(stitched.outputPath);
  const size = fs.statSync(abs).size;
  if (size < 1000) fail(`mp4 too small (${size} bytes): ${abs}`);

  console.log("Star Dust shot list");
  console.log(`file: ${path.resolve(args.file)}`);
  console.log(`project: ${imported.project.name}`);
  console.log(
    run.provider === "mock"
      ? "provider: mock (camera motion only, ffmpeg Ken Burns)"
      : `provider: ${run.provider}`
  );
  if (args.first) console.log("--first: rendered and stitched the first enabled shot.");
  if (run.note) console.log(run.note);
  if (stitched.warning) console.log(stitched.warning);
  console.log(stitched.colour.summary);
  if (args.evenColour) console.log("--even-colour: project setting on. The reference is the first included shot.");
  console.log(`mp4: ${abs}`);
  console.log(`bytes: ${size}`);
  console.log(`duration: ${stitched.durationSec}`);
  if (held) {
    fail("A flagged clip was left out of the stitch. Pass --include-flagged to include it, or render it again.");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
