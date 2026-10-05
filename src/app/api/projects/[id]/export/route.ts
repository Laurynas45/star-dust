import { NextRequest, NextResponse } from "next/server";
import { stitchProject } from "@/lib/stitch";
import { getProject } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!getProject(params.id)) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  try {
    const result = await stitchProject(params.id);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Stitch failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
