import { NextRequest, NextResponse } from "next/server";
import { parseLoraList } from "@/lib/loras";
import { parseCfgValue, parseStepsValue } from "@/lib/sampler";
import { generationIsRefused, MINOR_SEXUAL_REFUSAL } from "@/lib/safety";
import { createShot, getProject, listShots } from "@/lib/storage";
import { ComfyGraphId, LoraRef, clampChainFrameBack, clampDuration, effectivePrompt, isComfyGraphId, presetById } from "@/lib/types";

function formWorkflow(value: FormDataEntryValue | null): ComfyGraphId | null {
  if (isComfyGraphId(value)) return value;
  return null;
}

function readFormSampler(
  value: FormDataEntryValue | null,
  kind: "steps" | "cfg"
): { ok: true; value: number | null } | { ok: false; error: string } {
  if (value == null || value === "") return { ok: true, value: null };
  if (typeof value !== "string") {
    return {
      ok: false,
      error: kind === "steps" ? "steps must be a whole number from 1 to 100." : "cfg must be a number from 0 to 30.",
    };
  }
  if (kind === "steps") {
    const parsed = parseStepsValue(value, "steps", { allowString: true });
    if (!parsed.ok) return parsed;
    return { ok: true, value: parsed.steps };
  }
  const parsed = parseCfgValue(value, "cfg", { allowString: true });
  if (!parsed.ok) return parsed;
  return { ok: true, value: parsed.cfg };
}

function formFlag(value: FormDataEntryValue | null): boolean | null {
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return null;
}
import { storeImageIfAllowed } from "@/lib/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function fileBuffer(
  entry: FormDataEntryValue | null
): Promise<{ name: string; buf: Buffer } | null> {
  if (!(entry instanceof File) || entry.size === 0) return null;
  return { name: entry.name || "image.png", buf: Buffer.from(await entry.arrayBuffer()) };
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const project = getProject(params.id);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  const form = await req.formData();
  const prompt = String(form.get("prompt") || "");
  if (!prompt.trim()) {
    return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
  }
  let loras: LoraRef[] | null | undefined;
  const loraField = form.get("loras");
  if (typeof loraField === "string" && loraField.trim()) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(loraField);
    } catch {
      return NextResponse.json({ error: "loras must be a JSON list of { name, strength }." }, { status: 400 });
    }
    const parsed = parseLoraList(parsedJson, "loras");
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    loras = parsed.loras;
  }
  const stepsField = readFormSampler(form.get("steps"), "steps");
  if (!stepsField.ok) return NextResponse.json({ error: stepsField.error }, { status: 400 });
  const cfgField = readFormSampler(form.get("cfg"), "cfg");
  if (!cfgField.ok) return NextResponse.json({ error: cfgField.error }, { status: 400 });
  const preset = presetById(String(form.get("presetId") || ""));
  const durationSec = clampDuration(Number(form.get("durationSec")), preset.durationSec);
  const start = await fileBuffer(form.get("startImage"));
  const end = await fileBuffer(form.get("endImage"));
  if (!start) {
    return NextResponse.json({ error: "Start image is required" }, { status: 400 });
  }
  if (generationIsRefused(effectivePrompt(project.styleBase, prompt), [start.name, end?.name || ""])) {
    return NextResponse.json({ error: MINOR_SEXUAL_REFUSAL, refused: true }, { status: 400 });
  }
  const seen = effectivePrompt(project.styleBase, prompt);
  const storedStart = storeImageIfAllowed({
    projectId: params.id,
    prompt: seen,
    filename: start.name,
    buffer: start.buf,
    extraFilenames: end ? [end.name] : [],
  });
  if (!storedStart.ok) {
    return NextResponse.json(
      { error: storedStart.error, refused: storedStart.refused },
      { status: storedStart.status }
    );
  }
  let endPath: string | undefined;
  if (end) {
    const storedEnd = storeImageIfAllowed({
      projectId: params.id,
      prompt: seen,
      filename: end.name,
      buffer: end.buf,
    });
    if (!storedEnd.ok) {
      return NextResponse.json(
        { error: storedEnd.error, refused: storedEnd.refused },
        { status: storedEnd.status }
      );
    }
    endPath = storedEnd.path;
  }
  const hasPrevious = listShots(params.id).length > 0;
  const shot = createShot({
    projectId: params.id,
    prompt,
    presetId: preset.id,
    durationSec,
    startImagePath: storedStart.path,
    endImagePath: endPath,
    comfyuiWorkflow: formWorkflow(form.get("comfyuiWorkflow")),
    comfyLowMemory: formFlag(form.get("comfyLowMemory")),
    generatedAudio: formFlag(form.get("generatedAudio")),
    chainFromPrevious: hasPrevious && form.get("chainFromPrevious") === "1",
    chainFrameBack: clampChainFrameBack(Number(form.get("chainFrameBack") || 0)),
    loras,
    steps: stepsField.value,
    cfg: cfgField.value,
  });
  return NextResponse.json(shot, { status: 201 });
}
