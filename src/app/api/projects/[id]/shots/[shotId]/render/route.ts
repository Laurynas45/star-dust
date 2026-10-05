import { NextRequest, NextResponse } from "next/server";
import { enqueueJob } from "@/lib/providers";
import { renderShot } from "@/lib/render";
import { getShot } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; shotId: string } }
) {
  const shot = getShot(params.shotId);
  if (!shot || shot.projectId !== params.id) {
    return NextResponse.json({ error: "Shot not found" }, { status: 404 });
  }
  const body = await req.json().catch(() => ({}));
  const acknowledgeModel =
    typeof body.acknowledgeModel === "string" ? body.acknowledgeModel : undefined;
  const result = renderShot(shot.id, { acknowledgeModel });
  if (!result.ok) return NextResponse.json(result, { status: result.status });
  for (const job of result.jobs) enqueueJob(job.id);
  return NextResponse.json({ jobs: result.jobs }, { status: 201 });
}
