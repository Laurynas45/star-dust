import { NextRequest, NextResponse } from "next/server";
import { effectiveSeed, normalizeSeed } from "@/lib/input-key";
import { generationIsRefused, MINOR_SEXUAL_REFUSAL } from "@/lib/safety";
import { deleteShot, getJob, getProject, getShot, updateShot } from "@/lib/storage";
import { ComfyWorkflowId, SeamMode, clampChainFrameBack, clampChainTrimStartFrames, clampDuration, clampSeamFade, effectivePrompt, isComfyWorkflowId, presetById } from "@/lib/types";

function workflowField(value: unknown): ComfyWorkflowId | null | undefined {
  if (value === null) return null;
  if (isComfyWorkflowId(value)) return value;
  return undefined;
}

function flagField(value: unknown): boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  return undefined;
}

function seamField(value: unknown): SeamMode | null | undefined {
  if (value === null) return null;
  if (value === "cut" || value === "crossfade") return value;
  return undefined;
}

function fadeField(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number") return clampSeamFade(value);
  return undefined;
}

function optionalBool(value: unknown): boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  return undefined;
}

function optionalTrim(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return clampChainTrimStartFrames(value);
  return undefined;
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

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; shotId: string } }
) {
  const shot = getShot(params.shotId);
  if (!shot || shot.projectId !== params.id) {
    return NextResponse.json({ error: "Shot not found" }, { status: 404 });
  }
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const body = await req.json().catch(() => ({}));
    const prompt = typeof body.prompt === "string" ? body.prompt : shot.prompt;
    const styleBase = getProject(shot.projectId)?.styleBase ?? "";
    if (generationIsRefused(effectivePrompt(styleBase, prompt), [])) {
      return NextResponse.json({ error: MINOR_SEXUAL_REFUSAL, refused: true }, { status: 400 });
    }
    const preset = presetById(typeof body.presetId === "string" ? body.presetId : shot.presetId);
    let seed: number | null | undefined;
    if (body.seed === null) seed = null;
    else if (typeof body.seed === "number" && Number.isFinite(body.seed)) seed = normalizeSeed(body.seed);
    let seedPinned: boolean | undefined;
    if (typeof body.seedPinned === "boolean") seedPinned = body.seedPinned;
    if (seedPinned === true && seed === undefined) seed = effectiveSeed(shot);
    let lockedJobId: string | null | undefined;
    if (body.lockedJobId === null) lockedJobId = null;
    else if (typeof body.lockedJobId === "string" && body.lockedJobId) {
      const job = getJob(body.lockedJobId);
      if (!job || job.shotId !== shot.id || job.kind === "preview" || job.status !== "completed" || !job.outputPath) {
        return NextResponse.json({ error: "Lock a completed take of this shot." }, { status: 400 });
      }
      lockedJobId = job.id;
    }
    const updated = updateShot(shot.id, {
      prompt,
      presetId: preset.id,
      durationSec: clampDuration(
        typeof body.durationSec === "number" ? body.durationSec : shot.durationSec,
        preset.durationSec
      ),
      seed,
      seedPinned,
      lockedJobId,
      endImagePath: body.clearEndImage ? "" : undefined,
      comfyuiWorkflow: workflowField(body.comfyuiWorkflow),
      comfyLowMemory: flagField(body.comfyLowMemory),
      chainFromPrevious:
        typeof body.chainFromPrevious === "boolean" ? body.chainFromPrevious : undefined,
      chainFrameBack: typeof body.chainFrameBack === "number" ? clampChainFrameBack(body.chainFrameBack) : undefined,
      chainTrimStartFrames: optionalTrim(body.chainTrimStartFrames),
      dropDuplicateFrame: optionalBool(body.dropDuplicateFrame),
      seamMode: seamField(body.seamMode),
      seamFadeSec: fadeField(body.seamFadeSec),
    });
    return NextResponse.json(updated);
  }

  const form = await req.formData();
  const prompt = String(form.get("prompt") || shot.prompt);
  const preset = presetById(String(form.get("presetId") || shot.presetId));
  const durationSec = clampDuration(Number(form.get("durationSec")), shot.durationSec);
  const start = await fileBuffer(form.get("startImage"));
  const end = await fileBuffer(form.get("endImage"));
  const seen = effectivePrompt(getProject(shot.projectId)?.styleBase, prompt);
  if (generationIsRefused(seen, [start?.name || "", end?.name || ""])) {
    return NextResponse.json({ error: MINOR_SEXUAL_REFUSAL, refused: true }, { status: 400 });
  }
  let startImagePath = shot.startImagePath;
  let endImagePath = shot.endImagePath;
  if (start) {
    const stored = storeImageIfAllowed({
      projectId: shot.projectId,
      prompt: seen,
      filename: start.name,
      buffer: start.buf,
    });
    if (!stored.ok) {
      return NextResponse.json(
        { error: stored.error, refused: stored.refused },
        { status: stored.status }
      );
    }
    startImagePath = stored.path;
  }
  if (end) {
    const stored = storeImageIfAllowed({
      projectId: shot.projectId,
      prompt: seen,
      filename: end.name,
      buffer: end.buf,
    });
    if (!stored.ok) {
      return NextResponse.json(
        { error: stored.error, refused: stored.refused },
        { status: stored.status }
      );
    }
    endImagePath = stored.path;
  }
  if (form.get("clearEndImage") === "1") endImagePath = "";
  const updated = updateShot(shot.id, {
    prompt,
    presetId: preset.id,
    durationSec,
    startImagePath,
    endImagePath,
  });
  return NextResponse.json(updated);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; shotId: string } }
) {
  const shot = getShot(params.shotId);
  if (!shot || shot.projectId !== params.id) {
    return NextResponse.json({ error: "Shot not found" }, { status: 404 });
  }
  deleteShot(shot.id);
  return NextResponse.json({ ok: true });
}
