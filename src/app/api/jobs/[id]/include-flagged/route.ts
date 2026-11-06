import { NextRequest, NextResponse } from "next/server";
import { setClipIncludeAnyway } from "@/lib/clip-check";
import { getJob } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const existing = getJob(params.id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!existing.clipCheck?.flagged) {
    return NextResponse.json({ error: "This clip is not flagged." }, { status: 400 });
  }
  const body = await req.json().catch(() => ({}));
  const include = body.include !== false;
  const job = setClipIncludeAnyway(params.id, include);
  if (!job) return NextResponse.json({ error: "This clip is not flagged." }, { status: 400 });
  return NextResponse.json(job);
}
