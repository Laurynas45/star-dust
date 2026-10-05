import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import JSZip from "jszip";
import { completedJobsForGallery, getProject, resolveDataPath } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const project = getProject(params.id);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  const jobs = completedJobsForGallery(params.id).filter((job) => job.outputPath);
  if (jobs.length === 0) {
    return NextResponse.json({ error: "No completed clips to download" }, { status: 404 });
  }
  const zip = new JSZip();
  const ordered = [...jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  ordered.forEach((job, index) => {
    const abs = resolveDataPath(job.outputPath!);
    if (!fs.existsSync(abs)) return;
    const name = `${String(index + 1).padStart(2, "0")}-${job.id}.mp4`;
    zip.file(name, fs.readFileSync(abs));
  });
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const filename = `${project.name.replace(/[^a-z0-9-_]+/gi, "-").replace(/^-|-$/g, "") || "star-dust"}.zip`;
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(buf.length),
    },
  });
}
