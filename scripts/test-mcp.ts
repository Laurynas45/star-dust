/**
 * MCP tool tests against a fake Star Dust HTTP API.
 * No network, no GPU, no payment routes.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fs from "fs";
import os from "os";
import path from "path";
import { MINOR_SEXUAL_REFUSAL } from "../src/lib/safety";
import {
  STAR_DUST_TOOLS,
  StarDustClient,
  createStarDustMcpServer,
  studioBaseUrl,
  type FetchLike,
} from "./star-dust-mcp";

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function blobBytes(value: FormDataEntryValue | null | undefined): Promise<Buffer> {
  assert(value instanceof Blob, "expected a file");
  return Buffer.from(await value.arrayBuffer());
}

type Call = {
  method: string;
  url: string;
  path: string;
  json: unknown;
  form: FormData | null;
};

type Parsed = { text: string; isError: boolean; json: Record<string, unknown> | null };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function mockFetch(handler: (call: Call) => Response | Promise<Response>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    let json: unknown;
    let form: FormData | null = null;
    if (init?.body instanceof FormData) form = init.body;
    else if (typeof init?.body === "string") {
      try {
        json = JSON.parse(init.body);
      } catch {
        json = init.body;
      }
    }
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      path: new URL(url).pathname,
      json,
      form,
    };
    calls.push(call);
    if (call.path.startsWith("/api/credits") || call.path.includes("paypal") || call.path.includes("stripe")) {
      throw new Error(`payment route was called: ${call.method} ${call.path}`);
    }
    return handler(call);
  };
  return { fetch: fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function bytesResponse(bytes: Buffer, contentType: string, headers?: Record<string, string>): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": contentType, ...headers },
  });
}

function parseTool(result: unknown): Parsed {
  const record = asRecord(result);
  const content = Array.isArray(record?.content) ? record.content : [];
  const block = content.map(asRecord).find((item) => item?.type === "text");
  const text = typeof block?.text === "string" ? block.text : "";
  const split = text.indexOf("\n\n");
  let json: Record<string, unknown> | null = null;
  if (split >= 0) {
    try {
      const parsed = JSON.parse(text.slice(split + 2));
      json = asRecord(parsed);
    } catch {
      json = null;
    }
  }
  return { text, isError: record?.isError === true, json };
}

async function withTools(fetchImpl: FetchLike, run: (call: (name: string, args?: Record<string, unknown>) => Promise<Parsed>, list: () => Promise<string[]>) => Promise<void>) {
  const server = createStarDustMcpServer(new StarDustClient("http://studio.test", fetchImpl));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: "star-dust-test", version: "0.0.0" });
  await mcp.connect(clientTransport);
  try {
    await run(
      async (name, args) => parseTool(await mcp.callTool({ name, arguments: args ?? {} })),
      async () => {
        const listed = await mcp.listTools();
        return listed.tools.map((tool) => tool.name);
      }
    );
  } finally {
    await mcp.close();
    await server.close();
  }
}

function settings(over: Record<string, unknown> = {}) {
  const env = {
    hasFalKey: false,
    hasReplicateToken: false,
    comfyuiUrlFromEnv: false,
    comfyuiAuthConfigured: false,
    hostedCredits: false,
    stripeCredits: false,
    paypalCredits: false,
    creditBalance: null,
    creditPacks: [{ id: "price_secret_test", label: "Secret pack", credits: 100 }],
    paypalPacks: [],
    packUnlocked: false,
    packWorkflows: [],
    ...(asRecord(over.env) ?? {}),
  };
  return {
    provider: "mock",
    comfyuiBaseUrl: "http://127.0.0.1:8188",
    falModel: "fal-ai/minimax/video-01/image-to-video",
    replicateModel: "stability-ai/stable-video-diffusion",
    comfyuiWorkflow: "svd",
    comfyLowMemory: false,
    rates: { fal: { "secret-model": 9 }, replicate: {} },
    budgetCap: null,
    customWorkflows: [],
    ...over,
    env,
  };
}

function readiness(id: string, opts?: { reachable?: boolean; blocks?: boolean }) {
  const reachable = opts?.reachable !== false;
  const blocks = Boolean(opts?.blocks);
  return {
    reachable,
    url: reachable ? "http://127.0.0.1:8188" : "",
    source: "settings",
    message: reachable ? `${id} checked.` : "ComfyUI did not answer.",
    honesty: "This check does not measure memory.",
    blocksQueue: !reachable || blocks,
    timedOut: !reachable,
    httpStatus: null,
    detail: reachable ? "" : "15s",
    workflows: [
      {
        id,
        title: id,
        file: `workflows/${id}.api.json`,
        ok: reachable && !blocks,
        blocksQueue: blocks,
        missingNodes: [],
        missingModels: blocks
          ? [
              {
                filename: "svd_xt_1_1.safetensors",
                folder: "models/checkpoints",
                nextStep: "Put svd_xt_1_1.safetensors in models/checkpoints.",
              },
            ]
          : [],
        vaeWarnings: [],
        audioNotes: [],
        inputNotes: [],
        inputBlocks: [],
      },
    ],
  };
}

function offlineError(): Error {
  return new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3000"), { code: "ECONNREFUSED" }) });
}

async function testBaseUrl() {
  assert(studioBaseUrl({}) === "http://localhost:3000", "default studio URL");
  assert(studioBaseUrl({ STAR_DUST_URL: "http://localhost:3000/" }) === "http://localhost:3000", "trim slash");
  assert(studioBaseUrl({ STAR_DUST_URL: "127.0.0.1:3000" }) === "http://127.0.0.1:3000", "add protocol");
}

async function testPaymentRoutesAreNotCalled() {
  const mocked = mockFetch(() => {
    throw new Error("fetch should not run");
  });
  const client = new StarDustClient("http://studio.test", mocked.fetch);
  for (const path of ["/api/credits/checkout", "/api/credits/paypal/checkout"]) {
    let message = "";
    try {
      await client.postJson(path, { pack: "studio" });
    } catch (err) {
      message = err instanceof Error ? err.message : "";
    }
    assert(message.includes("does not add credits"), `payment guard for ${path}: ${message}`);
  }
  assert(mocked.calls.length === 0, "payment guard called fetch");
}

async function testListTools() {
  const mocked = mockFetch(() => jsonResponse({ error: "unused" }, 500));
  await withTools(mocked.fetch, async (_call, list) => {
    const names = await list();
    for (const name of STAR_DUST_TOOLS) {
      assert(names.includes(name), `missing tool ${name}`);
    }
    assert(names.length === STAR_DUST_TOOLS.length, `tool count ${names.length}`);
  });
}

async function testListBackends() {
  const mocked = mockFetch((call) => {
    if (call.path === "/api/settings") return jsonResponse(settings({
      customWorkflows: [
        { id: "custom:harbor", title: "Harbor graph", ok: true, errors: [] },
        { id: "custom:broken", title: "Broken", ok: false, errors: ["Mapping is missing the start image."] },
      ],
    }));
    if (call.path === "/api/comfyui/readiness") {
      const id = text(asRecord(call.json)?.workflow) || "svd";
      return jsonResponse(readiness(id, { blocks: id === "svd" }));
    }
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });
  await withTools(mocked.fetch, async (call) => {
    const result = await call("list_backends");
    assert(!result.isError, result.text);
    assert(result.text.includes("Selected provider is mock."), result.text);
    assert(result.text.includes("Mock is ready."), result.text);
    assert(result.text.includes("fal is not ready."), result.text);
    assert(result.text.includes("no FAL_KEY"), result.text);
    assert(result.text.includes("no REPLICATE_API_TOKEN"), result.text);
    assert(result.text.includes("ComfyUI (svd) is not ready."), result.text);
    assert(result.text.includes("Put svd_xt_1_1.safetensors in models/checkpoints."), result.text);
    assert(result.text.includes("custom:harbor"), result.text);
    assert(result.text.includes("Mapping is missing the start image."), result.text);
    assert(result.text.includes("Self-hosted pack is locked."), result.text);
    assert(result.text.includes("This check does not measure memory."), result.text);
    assert(!result.text.includes("secret-model"), "rates leaked");
    assert(!result.text.includes("price_secret_test"), "credit pack leaked");
    const providers = Array.isArray(result.json?.providers) ? result.json.providers : [];
    const comfy = asRecord(providers.map(asRecord).find((item) => item?.id === "comfyui"));
    const graphs = Array.isArray(comfy?.graphs) ? comfy.graphs : [];
    const wan = asRecord(graphs.map(asRecord).find((item) => item?.id === "wan"));
    assert(wan?.ready === true, "wan should be ready");
    const svd = asRecord(graphs.map(asRecord).find((item) => item?.id === "svd"));
    assert(svd?.ready === false && svd?.selected === true, "svd selected and blocked");
    const broken = asRecord(graphs.map(asRecord).find((item) => item?.id === "custom:broken"));
    assert(broken?.ready === false, "a graph that failed to load is not ready");
  });
  const readinessCalls = mocked.calls.filter((call) => call.path === "/api/comfyui/readiness");
  assert(readinessCalls.length === 8, `readiness calls ${readinessCalls.length}`);
  const ltx25Call = readinessCalls.find((call) => text(asRecord(call.json)?.workflow) === "ltx25");
  assert(ltx25Call, "list_backends asks about ltx25");
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function testListBackendsUnreachableAndCredits() {
  const mocked = mockFetch((call) => {
    if (call.path === "/api/settings") {
      return jsonResponse(settings({
        provider: "fal",
        env: { hasFalKey: true, hasReplicateToken: false, hostedCredits: true, creditBalance: 0, packUnlocked: false },
      }));
    }
    if (call.path === "/api/comfyui/readiness") return jsonResponse(readiness("svd", { reachable: false }));
    throw new Error(`unexpected ${call.path}`);
  });
  await withTools(mocked.fetch, async (call) => {
    const result = await call("list_backends");
    assert(!result.isError, result.text);
    assert(result.text.includes("ComfyUI did not answer."), result.text);
    assert(result.text.includes("balance is 0"), result.text);
    assert(result.text.includes("does not add credits"), result.text);
    assert(result.text.includes("fal is not ready."), result.text);
    const providers = result.json?.providers;
    const fal = asRecord((providers as unknown[])?.map(asRecord).find((item) => item?.id === "fal"));
    assert(fal?.ready === false, "fal with zero balance is not ready");
  });
  const readinessCalls = mocked.calls.filter((call) => call.path === "/api/comfyui/readiness");
  assert(readinessCalls.length === 1, `stopped after unreachable, got ${readinessCalls.length}`);
}

async function testServerDown() {
  const mocked = mockFetch(() => {
    throw offlineError();
  });
  await withTools(mocked.fetch, async (call) => {
    const result = await call("list_backends");
    assert(result.isError, "expected an error");
    assert(result.text.includes("Star Dust is not running at http://studio.test"), result.text);
    assert(result.text.includes("npm run dev"), result.text);
    assert(result.text.includes("ECONNREFUSED"), result.text);
  });
}

async function testCreateProject() {
  const mocked = mockFetch((call) => {
    assert(call.method === "POST" && call.path === "/api/projects", call.path);
    const body = asRecord(call.json);
    assert(body?.name === "Harbor", "name");
    assert(body?.description === "dusk", "description");
    return jsonResponse({ id: "proj-1", name: "Harbor", description: "dusk" }, 201);
  });
  await withTools(mocked.fetch, async (call) => {
    const result = await call("create_project", { name: "Harbor", description: "dusk" });
    assert(!result.isError, result.text);
    assert(result.json?.id === "proj-1", result.text);
    const blank = await call("create_project", { name: "  " });
    assert(blank.isError && blank.text.includes("Project name is required."), blank.text);
  });
  assert(mocked.calls.length === 1, "blank name must not call the API");
}

async function testAddShot() {
  const png = Buffer.from("png-bytes");
  const end = Buffer.from("end-bytes");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "star-dust-mcp-"));
  const still = path.join(dir, "still.png");
  const endStill = path.join(dir, "end.png");
  fs.writeFileSync(still, png);
  fs.writeFileSync(endStill, end);
  const mocked = mockFetch(async (call) => {
    if (call.url === "https://images.example/lantern.png") return bytesResponse(png, "image/png");
    if (call.method === "PUT" && call.path === "/api/settings") {
      assert(asRecord(call.json)?.provider === "comfyui", "provider update");
      return jsonResponse(settings({ provider: "comfyui", comfyuiWorkflow: "wan" }));
    }
    if (call.method === "POST" && call.path === "/api/projects/proj-1/shots") {
      assert(call.form, "form");
      const prompt = call.form?.get("prompt");
      if (prompt === "from a url") {
        assert(call.form?.get("comfyuiWorkflow") === "custom:harbor", "custom graph");
        assert((await blobBytes(call.form?.get("startImage"))).equals(png), "url bytes");
        return jsonResponse({ id: "shot-2", projectId: "proj-1", prompt: "from a url", comfyuiWorkflow: "custom:harbor" }, 201);
      }
      assert(prompt === "a lantern swings", "prompt");
      assert(call.form?.get("durationSec") === "5", "duration");
      assert(call.form?.get("presetId") === "slow-zoom-in", "preset");
      assert(call.form?.get("comfyuiWorkflow") === "wan", "workflow");
      assert(call.form?.get("comfyLowMemory") === "true", "low memory");
      assert(call.form?.get("generatedAudio") === "false", "generated audio");
      assert(call.form?.get("chainFromPrevious") === null, "chain is omitted unless asked");
      const start = call.form?.get("startImage");
      assert((await blobBytes(start)).equals(png), "start bytes");
      if (typeof File !== "undefined" && start instanceof File) assert(start.name === "still.png", start.name);
      assert((await blobBytes(call.form?.get("endImage"))).equals(end), "end bytes");
      return jsonResponse(
        {
          id: "shot-1",
          projectId: "proj-1",
          prompt: "a lantern swings",
          durationSec: 5,
          presetId: "slow-zoom-in",
          comfyuiWorkflow: "wan",
          comfyLowMemory: true,
          startImagePath: "uploads/still.png",
          endImagePath: "uploads/end.png",
        },
        201
      );
    }
    throw new Error(`unexpected ${call.method} ${call.url}`);
  });
  try {
    await withTools(mocked.fetch, async (call) => {
      const badDuration = await call("add_shot", {
        projectId: "proj-1",
        prompt: "a lantern swings",
        imagePath: still,
        durationSec: 30,
      });
      assert(badDuration.isError && badDuration.text.includes("durationSec must be from 1 to 10"), badDuration.text);

      const badGraph = await call("add_shot", {
        projectId: "proj-1",
        prompt: "a lantern swings",
        imagePath: still,
        comfyWorkflow: "custom:Wan",
      });
      assert(badGraph.isError && badGraph.text.includes("comfyWorkflow must be"), badGraph.text);

      const missing = await call("add_shot", { projectId: "proj-1", prompt: "a lantern swings" });
      assert(missing.isError && missing.text.includes("imagePath"), missing.text);

      const result = await call("add_shot", {
        projectId: "proj-1",
        prompt: "a lantern swings",
        imagePath: still,
        endImagePath: endStill,
        durationSec: 5,
        presetId: "slow-zoom-in",
        provider: "comfyui",
        comfyWorkflow: "wan",
        comfyLowMemory: true,
        generatedAudio: false,
      });
      assert(!result.isError, result.text);
      assert(result.json?.id === "shot-1", result.text);
      assert(result.text.includes("Studio provider is comfyui."), result.text);

      const fromUrl = await call("add_shot", {
        projectId: "proj-1",
        prompt: "from a url",
        imageUrl: "https://images.example/lantern.png",
        comfyWorkflow: "custom:harbor",
      });
      assert(!fromUrl.isError, fromUrl.text);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const posts = mocked.calls.filter((call) => call.path === "/api/projects/proj-1/shots");
  assert(posts.length === 2, `shot posts ${posts.length}`);
  const puts = mocked.calls.filter((call) => call.method === "PUT");
  assert(puts.length === 1, "provider is set once");
  assert(mocked.calls.findIndex((call) => call.method === "PUT") < mocked.calls.findIndex((call) => call.path.endsWith("/shots")), "settings before shot");
}

async function testAddShotRefusal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "star-dust-mcp-"));
  const still = path.join(dir, "still.png");
  fs.writeFileSync(still, "png");
  const mocked = mockFetch((call) => {
    if (call.path.endsWith("/shots")) {
      return jsonResponse({ error: MINOR_SEXUAL_REFUSAL, refused: true }, 400);
    }
    throw new Error(`unexpected ${call.path}`);
  });
  try {
    await withTools(mocked.fetch, async (call) => {
      const result = await call("add_shot", {
        projectId: "proj-1",
        prompt: "refused by the server",
        imagePath: still,
      });
      assert(result.isError, "refusal should be an error");
      assert(result.text.includes(MINOR_SEXUAL_REFUSAL), result.text);
      assert(result.json?.refused === true, "refused flag");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testAddShots() {
  const png = Buffer.from("png-bytes");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "star-dust-mcp-batch-"));
  const shot10 = path.join(dir, "shot10.png");
  const shot2 = path.join(dir, "shot2.png");
  const notes = path.join(dir, "notes.txt");
  fs.writeFileSync(shot10, png);
  fs.writeFileSync(shot2, png);
  fs.writeFileSync(notes, "hello");
  const mocked = mockFetch(async (call) => {
    if (call.url === "https://images.example/lantern.png") return bytesResponse(png, "image/png");
    if (call.method === "PUT" && call.path === "/api/settings") {
      assert(asRecord(call.json)?.provider === "mock", "provider update");
      return jsonResponse({ provider: "mock", ok: true });
    }
    if (call.method === "POST" && call.path === "/api/projects/proj-1/shots/batch") {
      const images = call.form?.getAll("images") ?? [];
      const prompt = call.form?.get("prompt");
      if (prompt === "from a url") {
        assert(images.length === 1, "one url still");
        assert((await blobBytes(images[0])).equals(png), "url bytes");
        return jsonResponse({ added: 1, shots: [{ id: "url-shot", prompt: "lantern" }], rejected: [] }, 201);
      }
      assert(images.length === 2, "two stills");
      assert(images[0] instanceof File && images[0].name === "shot2.png", "shot2 is first");
      assert(images[1] instanceof File && images[1].name === "shot10.png", "shot10 is second");
      assert(prompt === "a lantern", "shared prompt");
      assert(call.form?.get("durationSec") === "4", "duration");
      assert(call.form?.get("presetId") === "slow-zoom-out", "preset");
      assert(call.form?.get("comfyuiWorkflow") === "ltx", "workflow");
      return jsonResponse(
        {
          added: 2,
          shots: [
            { id: "shot-2", prompt: "a lantern" },
            { id: "shot-10", prompt: "a lantern" },
          ],
          rejected: [],
        },
        201
      );
    }
    if (call.method === "POST" && call.path === "/api/projects/proj-reject/shots/batch") {
      return jsonResponse(
        {
          added: 1,
          shots: [{ id: "shot-ok" }],
          rejected: [{ name: "notes.txt", error: "Start and end images must be PNG, JPEG, WebP, or GIF" }],
        },
        201
      );
    }
    if (call.method === "POST" && call.path === "/api/projects/proj-none/shots/batch") {
      return jsonResponse(
        {
          error: "No shots were added. notes.txt: Start and end images must be PNG, JPEG, WebP, or GIF",
          added: 0,
          rejected: [{ name: "notes.txt", error: "Start and end images must be PNG, JPEG, WebP, or GIF" }],
        },
        400
      );
    }
    throw new Error(`unexpected ${call.method} ${call.url}`);
  });
  try {
    await withTools(mocked.fetch, async (call) => {
      const callsBefore = mocked.calls.length;
      const empty = await call("add_shots", { projectId: "proj-1", images: [] });
      assert(empty.isError && empty.text.includes("imagePath"), empty.text);
      const tooMany = await call("add_shots", {
        projectId: "proj-1",
        images: Array.from({ length: 41 }, () => ({ imagePath: shot2 })),
      });
      assert(tooMany.isError && tooMany.text.includes("At most 40"), tooMany.text);
      const badDuration = await call("add_shots", {
        projectId: "proj-1",
        images: [{ imagePath: shot2 }],
        durationSec: 30,
      });
      assert(badDuration.isError && badDuration.text.includes("durationSec must be from 1 to 10"), badDuration.text);
      const blankStill = await call("add_shots", { projectId: "proj-1", images: [{}] });
      assert(blankStill.isError && blankStill.text.includes("imagePath"), blankStill.text);
      const both = await call("add_shots", {
        projectId: "proj-1",
        images: [{ imagePath: shot2, imageUrl: "https://images.example/lantern.png" }],
      });
      assert(both.isError && both.text.includes("not both"), both.text);
      const missingFile = await call("add_shots", {
        projectId: "proj-1",
        images: [{ imagePath: path.join(dir, "missing.png") }],
      });
      assert(missingFile.isError && missingFile.text.includes("No a start image"), missingFile.text);
      assert(mocked.calls.length === callsBefore, "a bad list must not call the API");

      const added = await call("add_shots", {
        projectId: "proj-1",
        prompt: "a lantern",
        images: [{ imagePath: shot10 }, { imagePath: shot2 }],
        durationSec: 4,
        presetId: "slow-zoom-out",
        provider: "mock",
        comfyWorkflow: "ltx",
      });
      assert(!added.isError, added.text);
      assert(added.json?.added === 2, added.text);
      assert(Array.isArray(added.json?.shotIds) && (added.json?.shotIds as unknown[])[0] === "shot-2", added.text);
      assert(added.text.includes("Added 2 shots."), added.text);
      assert(added.text.includes("Studio provider is mock."), added.text);
      assert(added.text.includes("Nothing was rendered."), added.text);

      const fromUrl = await call("add_shots", {
        projectId: "proj-1",
        prompt: "from a url",
        images: [{ imageUrl: "https://images.example/lantern.png" }],
      });
      assert(!fromUrl.isError, fromUrl.text);
      assert(fromUrl.json?.added === 1, fromUrl.text);

      const partial = await call("add_shots", {
        projectId: "proj-reject",
        images: [{ imagePath: shot2 }, { imagePath: notes }],
      });
      assert(!partial.isError, partial.text);
      assert(partial.text.includes("Added 1 shot."), partial.text);
      assert(partial.text.includes("notes.txt"), partial.text);

      const rejected = await call("add_shots", {
        projectId: "proj-none",
        images: [{ imagePath: notes }],
      });
      assert(rejected.isError && rejected.text.includes("notes.txt"), rejected.text);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert(!mocked.calls.some((item) => item.path.includes("/render")), "add_shots does not render");
  assert(!mocked.calls.some((item) => item.path.includes("credits")), "add_shots does not call credits");
  const puts = mocked.calls.filter((item) => item.method === "PUT");
  assert(puts.length === 1, "provider is set once");
  const firstPost = mocked.calls.findIndex((item) => item.path.endsWith("/shots/batch"));
  assert(mocked.calls.findIndex((item) => item.method === "PUT") < firstPost, "settings before the batch");
}

async function testStartRender() {
  const mocked = mockFetch((call) => {
    if (call.path === "/api/projects/proj-1/render") {
      return jsonResponse(
        {
          jobs: [
            {
              id: "job-1",
              projectId: "proj-1",
              shotId: "shot-1",
              status: "queued",
              provider: "mock",
              modelName: "ffmpeg Ken Burns (mock)",
            },
          ],
          skipped: [],
        },
        201
      );
    }
    if (call.path === "/api/projects/proj-1/shots/shot-9/render") {
      const body = asRecord(call.json);
      assert(body?.acknowledgeModel === "fal-ai/minimax/video-01/image-to-video", "ack");
      assert(body?.force === true, "force");
      return jsonResponse({ jobs: [{ id: "job-9", status: "queued", shotId: "shot-9", provider: "fal" }], skipped: [] }, 201);
    }
    throw new Error(`unexpected ${call.path}`);
  });
  await withTools(mocked.fetch, async (call) => {
    const all = await call("start_render", { projectId: "proj-1" });
    assert(!all.isError, all.text);
    assert(all.text.includes("Queued 1 job."), all.text);
    const jobs = all.json?.jobs as unknown[];
    assert(asRecord(jobs?.[0])?.id === "job-1", all.text);

    const one = await call("start_render", {
      projectId: "proj-1",
      shotId: "shot-9",
      acknowledgeModel: "fal-ai/minimax/video-01/image-to-video",
      force: true,
    });
    assert(!one.isError, one.text);
    assert(one.text.includes("job-9") || (one.json?.jobs as unknown[])?.length === 1, one.text);

    const needsShot = await call("start_render", { projectId: "proj-1", force: true });
    assert(needsShot.isError && needsShot.text.includes("Pass shotId"), needsShot.text);
  });
}

async function testStartRenderErrors() {
  const mocked = mockFetch((call) => {
    const body = asRecord(call.json);
    if (body?.acknowledgeModel === "low") {
      return jsonResponse(
        {
          ok: false,
          error: "Not enough hosted credits. This run needs 5 and the balance is 0.",
          insufficientCredits: true,
        },
        409
      );
    }
    if (body?.acknowledgeModel === "comfy") {
      return jsonResponse(
        {
          ok: false,
          status: 400,
          error: "ComfyUI did not answer.\nThis render was not queued.",
        },
        400
      );
    }
    if (body?.acknowledgeModel === "ack") {
      return jsonResponse(
        {
          ok: false,
          error: "Confirm the model before this run: fal-ai/minimax/video-01/image-to-video.",
          needsModelAck: true,
          modelName: "fal-ai/minimax/video-01/image-to-video",
          priceAvailable: false,
          riskNote: "Star Dust does not fetch a vendor price.",
        },
        409
      );
    }
    if (body?.acknowledgeModel === "key") {
      return jsonResponse(
        {
          ok: false,
          error: "Missing FAL_KEY. Add it to .env.local (see .env.example). The job was not started.",
        },
        400
      );
    }
    return jsonResponse(
      {
        jobs: [],
        skipped: [{ shotId: "shot-1", position: 1, reason: "A matching take is already finished.", jobId: "job-done" }],
      },
      200
    );
  });
  await withTools(mocked.fetch, async (call) => {
    const low = await call("start_render", { projectId: "proj-1", acknowledgeModel: "low" });
    assert(low.isError, low.text);
    assert(low.text.includes("balance is 0"), low.text);
    assert(low.text.includes("does not add credits"), low.text);
    assert(low.json?.insufficientCredits === true, "flag");

    const comfy = await call("start_render", { projectId: "proj-1", acknowledgeModel: "comfy" });
    assert(comfy.isError && comfy.text.includes("This render was not queued."), comfy.text);

    const ack = await call("start_render", { projectId: "proj-1", acknowledgeModel: "ack" });
    assert(ack.isError && ack.text.includes("fal-ai/minimax/video-01/image-to-video"), ack.text);
    assert(ack.text.includes("acknowledgeModel"), ack.text);
    assert(ack.json?.needsModelAck === true, "ack flag");

    const key = await call("start_render", { projectId: "proj-1", acknowledgeModel: "key" });
    assert(key.isError && key.text.includes("Missing FAL_KEY"), key.text);

    const skipped = await call("start_render", { projectId: "proj-1", acknowledgeModel: "skip" });
    assert(!skipped.isError, skipped.text);
    assert(skipped.text.includes("No new job."), skipped.text);
    assert(skipped.text.includes("job-done"), skipped.text);
  });
}

async function testGetJob() {
  const mocked = mockFetch((call) => {
    if (call.path === "/api/jobs/job-run") {
      return jsonResponse({
        id: "job-run",
        projectId: "proj-1",
        shotId: "shot-1",
        status: "running",
        provider: "comfyui",
        modelName: "ComfyUI Wan 2.2 TI2V-5B",
        activity: { label: "Sampling 12/20 · 0:42", percent: 60 },
      });
    }
    if (call.path === "/api/jobs/job-done") {
      return jsonResponse({
        id: "job-done",
        status: "completed",
        provider: "mock",
        outputPath: "outputs/clip.mp4",
      });
    }
    if (call.path === "/api/jobs/missing") return jsonResponse({ error: "Not found" }, 404);
    throw new Error(call.path);
  });
  await withTools(mocked.fetch, async (call) => {
    const running = await call("get_job", { jobId: "job-run" });
    assert(!running.isError, running.text);
    assert(running.text.includes("Sampling 12/20"), running.text);
    assert(asRecord(running.json?.progress)?.percent === 60, running.text);
    assert(running.text.includes("Call get_job again"), running.text);

    const done = await call("get_job", { jobId: "job-done" });
    assert(!done.isError && done.text.includes("completed"), done.text);
    assert(done.json?.mediaUrl === "http://studio.test/api/media/outputs/clip.mp4", String(done.json?.mediaUrl));

    const missing = await call("get_job", { jobId: "missing" });
    assert(missing.isError && missing.text.includes("Not found"), missing.text);
  });
}

async function testFetchClip() {
  const mp4 = Buffer.from("fake-mp4-bytes");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "star-dust-mcp-out-"));
  const mocked = mockFetch((call) => {
    if (call.path === "/api/jobs/job-done") {
      return jsonResponse({ id: "job-done", status: "completed", outputPath: "outputs/clip.mp4" });
    }
    if (call.path === "/api/media/outputs/clip.mp4") return bytesResponse(mp4, "video/mp4");
    if (call.path === "/api/jobs/job-run") {
      return jsonResponse({
        id: "job-run",
        status: "running",
        provider: "comfyui",
        activity: { label: "Decoding · 1:05", percent: 90 },
      });
    }
    throw new Error(call.path);
  });
  try {
    await withTools(mocked.fetch, async (call) => {
      const folder = path.join(dir, "assets");
      const copied = await call("fetch_clip", { jobId: "job-done", outputPath: folder });
      assert(!copied.isError, copied.text);
      const local = String(copied.json?.localPath);
      assert(local === path.join(folder, "clip.mp4"), local);
      assert(fs.readFileSync(local).equals(mp4), "copied bytes");
      assert(copied.json?.mediaUrl === "http://studio.test/api/media/outputs/clip.mp4", copied.text);

      const filePath = path.join(dir, "named.mp4");
      const named = await call("fetch_clip", { jobId: "job-done", outputPath: filePath });
      assert(named.json?.localPath === filePath, String(named.json?.localPath));
      assert(fs.readFileSync(filePath).equals(mp4), "named bytes");

      const waiting = await call("fetch_clip", { jobId: "job-run", outputPath: folder });
      assert(waiting.isError, waiting.text);
      assert(waiting.text.includes("Decoding · 1:05"), waiting.text);
      assert(waiting.text.includes("running"), waiting.text);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testExportShotList() {
  const zip = Buffer.from("PK fake zip");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "star-dust-mcp-zip-"));
  const mocked = mockFetch((call) => {
    if (call.path === "/api/projects/proj-1/export/shotlist") {
      return bytesResponse(zip, "application/zip", {
        "content-disposition": 'attachment; filename="harbor-shotlist.zip"',
      });
    }
    if (call.path === "/api/projects/missing/export/shotlist") {
      return jsonResponse({ error: "Project not found" }, 404);
    }
    throw new Error(call.path);
  });
  const previous = process.cwd();
  try {
    await withTools(mocked.fetch, async (call) => {
      const folder = path.join(dir, "exports");
      const saved = await call("export_shotlist", { projectId: "proj-1", outputPath: folder });
      assert(!saved.isError, saved.text);
      const local = String(saved.json?.localPath);
      assert(local === path.join(folder, "harbor-shotlist.zip"), local);
      assert(fs.readFileSync(local).equals(zip), "zip bytes");
      assert(saved.json?.schema === "stardust.shotlist/1", "schema");
      assert(saved.text.includes("stardust.shotlist/1") || saved.json?.schema === "stardust.shotlist/1", saved.text);

      process.chdir(dir);
      const implicit = await call("export_shotlist", { projectId: "proj-1" });
      assert(implicit.json?.localPath === path.join(dir, "harbor-shotlist.zip"), String(implicit.json?.localPath));

      const missing = await call("export_shotlist", { projectId: "missing", outputPath: folder });
      assert(missing.isError && missing.text.includes("Project not found"), missing.text);
    });
  } finally {
    process.chdir(previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testLoras() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "star-dust-mcp-lora-"));
  const still = path.join(dir, "still.png");
  fs.writeFileSync(still, "png");
  let posts = 0;
  const mocked = mockFetch(async (call) => {
    if (call.method === "POST" && call.path === "/api/projects") {
      posts += 1;
      const body = asRecord(call.json);
      assert(Array.isArray(body?.loras) && (body.loras as { name: string }[])[0]?.name === "style.safetensors", "project loras");
      return jsonResponse({ id: "proj-lora", name: "LoRA", description: "", loras: body?.loras }, 201);
    }
    if (call.method === "POST" && call.path === "/api/projects/proj-lora/shots") {
      posts += 1;
      assert(call.form?.get("loras") === JSON.stringify([{ name: "shot.safetensors", strength: 0.5 }]), "shot loras");
      return jsonResponse({ id: "shot-lora", projectId: "proj-lora", loras: [{ name: "shot.safetensors", strength: 0.5 }] }, 201);
    }
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });
  try {
    await withTools(mocked.fetch, async (call) => {
      const bad = await call("create_project", {
        name: "LoRA",
        loras: [{ name: "../no.safetensors", strength: 1 }],
      });
      assert(bad.isError && bad.text.includes("LoRA folder"), bad.text);
      const high = await call("add_shot", {
        projectId: "proj-lora",
        prompt: "A lantern",
        imagePath: still,
        loras: [{ name: "shot.safetensors", strength: 4 }],
      });
      assert(high.isError && high.text.includes("range is -2 to 2"), high.text);
      const created = await call("create_project", {
        name: "LoRA",
        loras: [{ name: "style.safetensors" }],
      });
      assert(!created.isError, created.text);
      assert((created.json?.loras as { strength?: number }[])?.[0]?.strength === 1, "default strength is 1");
      const added = await call("add_shot", {
        projectId: "proj-lora",
        prompt: "A lantern",
        imagePath: still,
        loras: [{ name: "shot.safetensors", strength: 0.5 }],
      });
      assert(!added.isError, added.text);
      assert((added.json?.loras as { name?: string }[])?.[0]?.name === "shot.safetensors", added.text);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert(posts === 2, `invalid LoRAs must not call the API, posts=${posts}`);
}

async function testSampler() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "star-dust-mcp-sampler-"));
  const still = path.join(dir, "still.png");
  fs.writeFileSync(still, "png");
  let posts = 0;
  const mocked = mockFetch(async (call) => {
    if (call.method === "POST" && call.path === "/api/projects") {
      posts += 1;
      const body = asRecord(call.json);
      assert(body?.steps === 8 && body.cfg === 1, "project sampler");
      return jsonResponse({ id: "proj-sampler", name: "Sampler", description: "", steps: 8, cfg: 1 }, 201);
    }
    if (call.method === "POST" && call.path === "/api/projects/proj-sampler/shots") {
      posts += 1;
      assert(call.form?.get("steps") === "4", "shot steps");
      assert(call.form?.get("cfg") === "1.5", "shot cfg");
      return jsonResponse({ id: "shot-sampler", projectId: "proj-sampler", steps: 4, cfg: 1.5 }, 201);
    }
    return jsonResponse({ error: `unexpected ${call.method} ${call.path}` }, 500);
  });
  try {
    await withTools(mocked.fetch, async (call) => {
      const badSteps = await call("create_project", { name: "Bad", steps: 0 });
      assert(badSteps.isError && /1 to 100/.test(badSteps.text), badSteps.text);
      const badCfg = await call("create_project", { name: "Bad", cfg: 31 });
      assert(badCfg.isError && /0 to 30/.test(badCfg.text), badCfg.text);
      const created = await call("create_project", { name: "Sampler", steps: 8, cfg: 1 });
      assert(!created.isError, created.text);
      assert(created.json?.steps === 8 && created.json?.cfg === 1, created.text);
      const fraction = await call("add_shot", {
        projectId: "proj-sampler",
        prompt: "A lantern",
        imagePath: still,
        steps: 1.5,
      });
      assert(fraction.isError && /whole number/.test(fraction.text), fraction.text);
      const added = await call("add_shot", {
        projectId: "proj-sampler",
        prompt: "A lantern",
        imagePath: still,
        steps: 4,
        cfg: 1.5,
      });
      assert(!added.isError, added.text);
      assert(added.json?.steps === 4 && added.json?.cfg === 1.5, added.text);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert(posts === 2, `invalid sampler values must not call the API, posts=${posts}`);
}

async function main() {
  await testBaseUrl();
  await testPaymentRoutesAreNotCalled();
  await testListTools();
  await testListBackends();
  await testListBackendsUnreachableAndCredits();
  await testServerDown();
  await testCreateProject();
  await testLoras();
  await testSampler();
  await testAddShot();
  await testAddShotRefusal();
  await testAddShots();
  await testStartRender();
  await testStartRenderErrors();
  await testGetJob();
  await testFetchClip();
  await testExportShotList();
  console.log("mcp tests ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
