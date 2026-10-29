import { NextRequest, NextResponse } from "next/server";
import { enqueueJob } from "@/lib/providers";
import { quoteRetakeAll, retakeAll } from "@/lib/render";
import { getProject } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!getProject(params.id)) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  const quote = quoteRetakeAll(params.id);
  if (!quote.ok) return NextResponse.json(quote, { status: quote.status });
  return NextResponse.json(quote.cost);
}

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
  const result = retakeAll(params.id, { acknowledgeModel });
  if (!result.ok) return NextResponse.json(result, { status: result.status });
  for (const job of result.jobs) enqueueJob(job.id);
  return NextResponse.json(
    { jobs: result.jobs, skipped: result.skipped, cost: result.cost ?? null },
    { status: result.jobs.length > 0 ? 201 : 200 }
  );
}
