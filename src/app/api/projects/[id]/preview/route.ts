import { NextResponse } from "next/server";
import { enqueueJob } from "@/lib/providers";
import { previewAll } from "@/lib/render";
import { getProject } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  if (!getProject(params.id)) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  const result = previewAll(params.id);
  if (!result.ok) return NextResponse.json(result, { status: result.status });
  for (const job of result.jobs) enqueueJob(job.id);
  return NextResponse.json({ jobs: result.jobs, skipped: result.skipped }, { status: 201 });
}
