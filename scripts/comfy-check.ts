/**
 * Headless ComfyUI readiness check.
 * npm run comfy:check -- --url http://127.0.0.1:8188 [--workflow wan22-14b-flf2v]
 * Prints a pass/fail table. Exits non-zero when a checked graph would not run.
 * A Wan VAE pairing note is printed and does not change the exit code.
 * A required input the graph omits is printed. When Star Dust can send a value for it, the exit code does not change.
 * COMFYUI_AUTH_HEADER is sent when set and is never printed.
 */

import { COMFY_CHECK_WORKFLOW_FLAGS, formatComfyCheckTable, workflowIdFromFlag } from "../src/lib/comfy-readiness";
import { COMFY_WORKFLOW_ORDER } from "../src/lib/provider-info";
import { checkComfyServer } from "../src/lib/providers/comfyui";
import { ComfyWorkflowId } from "../src/lib/types";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv: string[]): { url: string; workflows: ComfyWorkflowId[] } {
  let url = "";
  let workflow: ComfyWorkflowId | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--url") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail("Usage: npm run comfy:check -- --url http://127.0.0.1:8188 [--workflow wan22-14b-flf2v]");
      url = value;
      index += 1;
      continue;
    }
    if (arg === "--workflow") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        fail(`--workflow needs one of: ${COMFY_CHECK_WORKFLOW_FLAGS.join(", ")}`);
      }
      const id = workflowIdFromFlag(value);
      if (!id) fail(`Unknown workflow ${value}. Use one of: ${COMFY_CHECK_WORKFLOW_FLAGS.join(", ")}`);
      workflow = id;
      index += 1;
      continue;
    }
    fail(`Unknown argument ${arg}. Usage: npm run comfy:check -- --url http://127.0.0.1:8188 [--workflow wan22-14b-flf2v]`);
  }
  if (!url) fail("Usage: npm run comfy:check -- --url http://127.0.0.1:8188 [--workflow wan22-14b-flf2v]");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail(`--url is not a URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail("--url must be http or https.");
  }
  return { url, workflows: workflow ? [workflow] : [...COMFY_WORKFLOW_ORDER] };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await checkComfyServer(args.workflows, { base: args.url, source: "cli" });
  console.log(formatComfyCheckTable(report));
  if (report.blocksQueue) process.exit(1);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
