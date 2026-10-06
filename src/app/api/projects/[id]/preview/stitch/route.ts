import { NextRequest, NextResponse } from "next/server";
import { stitchPreview } from "@/lib/stitch";
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
  const jobIds = Array.isArray(body.jobIds)
    ? body.jobIds.filter((id: unknown): id is string => typeof id === "string")
    : [];
  try {
    const result = await stitchPreview(params.id, jobIds);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Preview stitch failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
