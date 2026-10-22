import { NextRequest, NextResponse } from "next/server";
import { enqueueJob } from "@/lib/providers";
import { huntShot, quoteHunt } from "@/lib/render";
import { getShot } from "@/lib/storage";
import { huntSeedCount } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function shotInProject(projectId: string, shotId: string) {
  const shot = getShot(shotId);
  if (!shot || shot.projectId !== projectId) return undefined;
  return shot;
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string; shotId: string } }
) {
  if (!shotInProject(params.id, params.shotId)) {
    return NextResponse.json({ error: "Shot not found" }, { status: 404 });
  }
  const count = huntSeedCount(new URL(req.url).searchParams.get("count"));
  if (!count) {
    return NextResponse.json({ error: "Choose 2, 3, or 4 seeds." }, { status: 400 });
  }
  const quote = quoteHunt(params.shotId, count);
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
  const confirmApproved = body.confirmApproved === true;
  const result = huntShot(params.shotId, body.count, { acknowledgeModel, confirmApproved });
  if (!result.ok) return NextResponse.json(result, { status: result.status });
  for (const job of result.jobs) enqueueJob(job.id);
  return NextResponse.json(
    { jobs: result.jobs, skipped: result.skipped, cost: result.cost },
    { status: result.jobs.length > 0 ? 201 : 200 }
  );
}
