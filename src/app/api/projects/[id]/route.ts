import { NextRequest, NextResponse } from "next/server";
import { ensureJobWorker } from "@/lib/providers";
import {
  deleteProject,
  getProject,
  listJobs,
  listShots,
  updateProject,
} from "@/lib/storage";

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
