import { NextRequest, NextResponse } from "next/server";
import { enqueueJob } from "@/lib/providers";
import { retryFromJob } from "@/lib/render";
import { getJob } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const job = getJob(params.id);
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const acknowledgeModel =
    typeof body.acknowledgeModel === "string" ? body.acknowledgeModel : undefined;
  const result = retryFromJob(job, { acknowledgeModel });
  if (!result.ok) return NextResponse.json(result, { status: result.status });
  for (const next of result.jobs) enqueueJob(next.id);
  return NextResponse.json({ jobs: result.jobs }, { status: 201 });
}
