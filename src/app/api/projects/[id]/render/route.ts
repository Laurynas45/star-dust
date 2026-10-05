import { NextRequest, NextResponse } from "next/server";
import { enqueueJob } from "@/lib/providers";
import { renderAll } from "@/lib/render";
import { getProject } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!getProject(params.id)) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  const body = await req.json().catch(() => ({}));
  const acknowledgeModel =
    typeof body.acknowledgeModel === "string" ? body.acknowledgeModel : undefined;
  const result = renderAll(params.id, { acknowledgeModel });
  if (!result.ok) return NextResponse.json(result, { status: result.status });
  for (const job of result.jobs) enqueueJob(job.id);
  return NextResponse.json({ jobs: result.jobs }, { status: 201 });
}
