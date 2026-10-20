import { NextRequest, NextResponse } from "next/server";
import { enqueueJob } from "@/lib/providers";
import { quoteRetake, retakeShot } from "@/lib/render";
import { getShot } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function shotInProject(projectId: string, shotId: string) {
  const shot = getShot(shotId);
  if (!shot || shot.projectId !== projectId) return undefined;
  return shot;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string; shotId: string } }
) {
  if (!shotInProject(params.id, params.shotId)) {
    return NextResponse.json({ error: "Shot not found" }, { status: 404 });
  }
  const quote = quoteRetake(params.shotId);
  if (!quote.ok) return NextResponse.json(quote, { status: quote.status });
  return NextResponse.json(quote.cost);
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; shotId: string } }
) {
  if (!shotInProject(params.id, params.shotId)) {
    return NextResponse.json({ error: "Shot not found" }, { status: 404 });
  }
  const body = await req.json().catch(() => ({}));
  const acknowledgeModel =
    typeof body.acknowledgeModel === "string" ? body.acknowledgeModel : undefined;
  const result = retakeShot(params.shotId, { acknowledgeModel });
  if (!result.ok) return NextResponse.json(result, { status: result.status });
  for (const job of result.jobs) enqueueJob(job.id);
  return NextResponse.json(
    { jobs: result.jobs, skipped: result.skipped, cost: result.cost },
    { status: result.jobs.length > 0 ? 201 : 200 }
  );
}
