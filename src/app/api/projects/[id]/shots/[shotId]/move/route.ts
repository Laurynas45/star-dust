import { NextRequest, NextResponse } from "next/server";
import { getShot, moveShot } from "@/lib/storage";

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
  const direction = body.direction === "down" ? "down" : "up";
  const updated = moveShot(shot.id, direction);
  return NextResponse.json(updated);
}
