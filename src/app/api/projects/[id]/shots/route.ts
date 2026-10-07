import { NextRequest, NextResponse } from "next/server";
import { generationIsRefused, MINOR_SEXUAL_REFUSAL } from "@/lib/safety";
import { createShot, getProject } from "@/lib/storage";
import { ComfyWorkflowId, clampDuration, presetById } from "@/lib/types";

function formWorkflow(value: FormDataEntryValue | null): ComfyWorkflowId | null {
  if (value === "svd" || value === "wan" || value === "ltx") return value;
  return null;
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
  if (!getProject(params.id)) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  const form = await req.formData();
  const prompt = String(form.get("prompt") || "");
  if (!prompt.trim()) {
    return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
  }
  const preset = presetById(String(form.get("presetId") || ""));
  const durationSec = clampDuration(Number(form.get("durationSec")), preset.durationSec);
  const start = await fileBuffer(form.get("startImage"));
  const end = await fileBuffer(form.get("endImage"));
  if (!start) {
    return NextResponse.json({ error: "Start image is required" }, { status: 400 });
  }
  if (generationIsRefused(prompt, [start.name, end?.name || ""])) {
    return NextResponse.json({ error: MINOR_SEXUAL_REFUSAL, refused: true }, { status: 400 });
  }
  const storedStart = storeImageIfAllowed({
    projectId: params.id,
    prompt,
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
      prompt,
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
  const shot = createShot({
    projectId: params.id,
    prompt,
    presetId: preset.id,
    durationSec,
    startImagePath: storedStart.path,
    endImagePath: endPath,
    comfyuiWorkflow: formWorkflow(form.get("comfyuiWorkflow")),
    comfyLowMemory: formFlag(form.get("comfyLowMemory")),
  });
  return NextResponse.json(shot, { status: 201 });
}
