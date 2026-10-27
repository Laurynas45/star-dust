import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { parseSrt } from "@/lib/captions";
import { getProject, saveUpload, updateProject } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SRT_BYTES = 512 * 1024;

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const project = getProject(params.id);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  const form = await req.formData();
  const file = form.get("srt");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "An SRT file is required" }, { status: 400 });
  }
  if (file.size > MAX_SRT_BYTES) {
    return NextResponse.json({ error: "SRT file is larger than 512 KB" }, { status: 400 });
  }
  const ext = path.extname(file.name || "").toLowerCase();
  if (ext && ext !== ".srt") {
    return NextResponse.json({ error: "Captions must be an .srt file." }, { status: 400 });
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  const parsed = parseSrt(buffer.toString("utf8"));
  if (parsed.errors.length > 0) {
    return NextResponse.json(
      { error: parsed.errors[0], errors: parsed.errors },
      { status: 400 }
    );
  }
  const stored = saveUpload(params.id, file.name || "captions.srt", buffer);
  const updated = updateProject(params.id, {
    captionsPath: stored,
    captionMode: project.captionMode ?? "burn",
  });
  return NextResponse.json({ ...updated, cueCount: parsed.cues.length });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!getProject(params.id)) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  const project = updateProject(params.id, { captionsPath: null, captionMode: null });
  return NextResponse.json(project);
}
