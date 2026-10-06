import { NextResponse } from "next/server";
import { estimateRenderAll } from "@/lib/cost";
import { getProject } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  if (!getProject(params.id)) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  return NextResponse.json(estimateRenderAll(params.id));
}
