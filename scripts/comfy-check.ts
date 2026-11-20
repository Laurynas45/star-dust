/**
 * Headless ComfyUI readiness check.
 * npm run comfy:check -- --url http://127.0.0.1:8188 [--workflow wan22-14b-flf2v] [--lora file.safetensors]
 * Prints a pass/fail table. Exits non-zero when a checked graph would not run.
 * A Wan VAE pairing note is printed and does not change the exit code.
 * A required input the graph omits is printed. When Star Dust can send a value for it, the exit code does not change.
 * COMFYUI_AUTH_HEADER is sent when set and is never printed.
 */

import { COMFY_CHECK_WORKFLOW_FLAGS, formatComfyCheckTable, workflowIdFromFlag } from "../src/lib/comfy-readiness";
import { MAX_LORAS, parseLoraList } from "../src/lib/loras";
import { COMFY_WORKFLOW_ORDER } from "../src/lib/provider-info";
import { checkComfyServer } from "../src/lib/providers/comfyui";
import { ComfyGraphId, LoraRef } from "../src/lib/types";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const USAGE =
  "Usage: npm run comfy:check -- --url http://127.0.0.1:8188 [--workflow wan22-14b-flf2v] [--lora file.safetensors]";

function parseArgs(argv: string[]): { url: string; workflows: ComfyGraphId[]; loras: LoraRef[] } {
  let url = "";
  let workflow: ComfyGraphId | null = null;
  const loraNames: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--url") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail(USAGE);
      url = value;
      index += 1;
      continue;
    }
    if (arg === "--workflow") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        fail(`--workflow needs one of: ${COMFY_CHECK_WORKFLOW_FLAGS.join(", ")}, or custom:<slug>`);
      }
      const id = workflowIdFromFlag(value);
      if (!id) fail(`Unknown workflow ${value}. Use one of: ${COMFY_CHECK_WORKFLOW_FLAGS.join(", ")}, or custom:<slug>`);
      workflow = id;
      index += 1;
      continue;
    }
    if (arg === "--lora") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail("--lora needs the file name ComfyUI lists.");
      loraNames.push(value);
      index += 1;
      continue;
    }
    fail(`Unknown argument ${arg}. ${USAGE}`);
  }
  if (!url) fail(USAGE);
  if (loraNames.length > MAX_LORAS) fail(`--lora was given ${loraNames.length} times. The limit is ${MAX_LORAS}.`);
  const parsedLoras = parseLoraList(
    loraNames.map((name) => ({ name })),
    "loras"
  );
  if (!parsedLoras.ok) fail(parsedLoras.error);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail(`--url is not a URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail("--url must be http or https.");
  }
  return { url, workflows: workflow ? [workflow] : [...COMFY_WORKFLOW_ORDER], loras: parsedLoras.loras };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await checkComfyServer(args.workflows, { base: args.url, source: "cli" }, args.loras);
  console.log(formatComfyCheckTable(report));
  if (report.blocksQueue) process.exit(1);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
