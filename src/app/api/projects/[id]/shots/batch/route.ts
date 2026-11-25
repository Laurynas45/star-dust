import { NextRequest, NextResponse } from "next/server";
import { parseLoraList } from "@/lib/loras";
import { parseCfgValue, parseStepsValue } from "@/lib/sampler";
import { generationIsRefused, MINOR_SEXUAL_REFUSAL } from "@/lib/safety";
import {
  BATCH_IMAGE_FIELD,
  MAX_BATCH_SHOTS,
  batchFailureText,
  promptFromStillName,
  sortByFileName,
  stillFileName,
  tooManyStillsError,
  type RejectedStill,
} from "@/lib/shot-batch";
import { createShot, getProject, listShots } from "@/lib/storage";
import {
  ComfyGraphId,
  LoraRef,
  clampDuration,
  effectivePrompt,
  isComfyGraphId,
  presetById,
} from "@/lib/types";
import { storeImageIfAllowed } from "@/lib/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

function isUpload(entry: FormDataEntryValue): entry is File {
  return typeof entry !== "string" && typeof entry.arrayBuffer === "function";
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

  const uploads = form.getAll(BATCH_IMAGE_FIELD).filter(isUpload);
  if (uploads.length === 0) {
    return NextResponse.json({ error: "Add at least one still." }, { status: 400 });
  }
  if (uploads.length > MAX_BATCH_SHOTS) {
    return NextResponse.json({ error: tooManyStillsError(uploads.length) }, { status: 400 });
  }

  const sharedPrompt = String(form.get("prompt") || "").trim();
  if (sharedPrompt && generationIsRefused(effectivePrompt(project.styleBase, sharedPrompt), [])) {
    return NextResponse.json({ error: MINOR_SEXUAL_REFUSAL, refused: true }, { status: 400 });
  }

  const preset = presetById(String(form.get("presetId") || ""));
  const durationField = form.get("durationSec");
  const durationSec =
    durationField == null || durationField === ""
      ? preset.durationSec
      : clampDuration(Number(durationField), preset.durationSec);
  const workflow = formWorkflow(form.get("comfyuiWorkflow"));
  const lowMemory = formFlag(form.get("comfyLowMemory"));
  const generatedAudio = formFlag(form.get("generatedAudio"));

  const before = listShots(params.id).length;
  const rejected: RejectedStill[] = [];
  const shots = [];
  for (const file of sortByFileName(uploads.map((upload) => ({ upload, name: upload.name || "image" })))) {
    const name = stillFileName(file.name);
    const shotPrompt = sharedPrompt || promptFromStillName(name);
    const seen = effectivePrompt(project.styleBase, shotPrompt);
    const buffer = Buffer.from(await file.upload.arrayBuffer());
    const stored = storeImageIfAllowed({
      projectId: params.id,
      prompt: seen,
      filename: name,
      buffer,
    });
    if (!stored.ok) {
      rejected.push({ name, error: stored.error });
      continue;
    }
    shots.push(
      createShot({
        projectId: params.id,
        prompt: shotPrompt,
        presetId: preset.id,
        durationSec,
        startImagePath: stored.path,
        comfyuiWorkflow: workflow,
        comfyLowMemory: lowMemory,
        generatedAudio,
        loras,
        steps: stepsField.value,
        cfg: cfgField.value,
      })
    );
  }

  if (shots.length === 0) {
    return NextResponse.json(
      { error: batchFailureText(rejected), added: 0, shots: [], rejected },
      { status: 400 }
    );
  }

  return NextResponse.json(
    {
      added: shots.length,
      shots,
      rejected,
      appendedAfter: before,
    },
    { status: 201 }
  );
}
