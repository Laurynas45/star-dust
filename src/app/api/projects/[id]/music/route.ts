import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { probeHasAudio } from "@/lib/ffmpeg";
import { AUDIO_EXTENSIONS } from "@/lib/music-bed";
import { getProject, resolveDataPath, saveUpload, updateProject } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_AUDIO_BYTES = 32 * 1024 * 1024;

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!getProject(params.id)) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  const form = await req.formData();
  const file = form.get("audio");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "Music file is required" }, { status: 400 });
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: "Music file is larger than 32 MB" }, { status: 400 });
  }
  const ext = path.extname(file.name || "").toLowerCase();
  if (!AUDIO_EXTENSIONS.includes(ext)) {
    return NextResponse.json(
      { error: "Music bed must be WAV, MP3, M4A, AAC, OGG, FLAC, or AIFF." },
      { status: 400 }
    );
  }
  const stored = saveUpload(params.id, file.name || `bed${ext}`, Buffer.from(await file.arrayBuffer()));
  const abs = resolveDataPath(stored);
  let audio = false;
  try {
    audio = probeHasAudio(abs);
  } catch (error) {
    fs.rmSync(abs, { force: true });
    const message = error instanceof Error ? error.message : "Could not read the music file.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
  if (!audio) {
    fs.rmSync(abs, { force: true });
    return NextResponse.json({ error: "That file has no audio stream." }, { status: 400 });
  }
  const project = updateProject(params.id, { musicBedPath: stored });
  return NextResponse.json(project);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!getProject(params.id)) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  const project = updateProject(params.id, { musicBedPath: null });
  return NextResponse.json(project);
}
