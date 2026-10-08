import { NextRequest, NextResponse } from "next/server";
import { ensureJobWorker } from "@/lib/providers";
import {
  deleteProject,
  getProject,
  listJobs,
  listShots,
  updateProject,
} from "@/lib/storage";
import { ComfyWorkflowId, SeamMode, clampSeamFade } from "@/lib/types";

function workflowField(value: unknown): ComfyWorkflowId | null | undefined {
  if (value === null) return null;
  if (value === "svd" || value === "wan" || value === "ltx") return value;
  return undefined;
}

function flagField(value: unknown): boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  return undefined;
}

function seamModeField(value: unknown): SeamMode | undefined {
  if (value === "cut" || value === "crossfade") return value;
  return undefined;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  ensureJobWorker();
  const project = getProject(params.id);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({
    project,
    shots: listShots(params.id),
    jobs: listJobs(params.id),
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const body = await req.json().catch(() => ({}));
  const updated = updateProject(params.id, {
    name: typeof body.name === "string" ? body.name : undefined,
    description: typeof body.description === "string" ? body.description : undefined,
    comfyuiWorkflow: workflowField(body.comfyuiWorkflow),
    comfyLowMemory: flagField(body.comfyLowMemory),
    seamMode: seamModeField(body.seamMode),
    seamFadeSec: typeof body.seamFadeSec === "number" ? clampSeamFade(body.seamFadeSec) : undefined,
  });
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(updated);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!getProject(params.id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  deleteProject(params.id);
  return NextResponse.json({ ok: true });
}
