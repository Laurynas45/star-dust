import { NextRequest, NextResponse } from "next/server";
import { requestCancel } from "@/lib/providers";
import { getJob } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!getJob(params.id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const job = requestCancel(params.id);
  return NextResponse.json(job);
}
