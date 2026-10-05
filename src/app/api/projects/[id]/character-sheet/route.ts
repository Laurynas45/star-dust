import { NextRequest, NextResponse } from "next/server";
import { getProject, updateProject } from "@/lib/storage";
import { storeImageIfAllowed } from "@/lib/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!getProject(params.id)) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  const form = await req.formData();
  const file = form.get("image");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "Reference image is required" }, { status: 400 });
  }
  const stored = storeImageIfAllowed({
    projectId: params.id,
    prompt: String(form.get("prompt") || ""),
    filename: file.name || "character.png",
    buffer: Buffer.from(await file.arrayBuffer()),
  });
  if (!stored.ok) {
    return NextResponse.json(
      { error: stored.error, refused: stored.refused },
      { status: stored.status }
    );
  }
  const project = updateProject(params.id, { characterSheetPath: stored.path });
  return NextResponse.json(project);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!getProject(params.id)) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  const project = updateProject(params.id, { characterSheetPath: null });
  return NextResponse.json(project);
}
