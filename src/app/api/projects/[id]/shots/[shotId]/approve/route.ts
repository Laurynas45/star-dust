import { NextRequest, NextResponse } from "next/server";
import { finishedTake } from "@/lib/continuity";
import { approveTake, clearApproval, getShot } from "@/lib/storage";

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
  if (body.clear === true) {
    const cleared = clearApproval(shot.id);
    return NextResponse.json(cleared);
  }
  const jobId =
    typeof body.jobId === "string" && body.jobId
      ? body.jobId
      : finishedTake(shot)?.id;
  if (!jobId) {
    return NextResponse.json(
      { error: "Render a take before approving it." },
      { status: 400 }
    );
  }
  const updated = approveTake(shot.id, jobId);
  if (!updated) {
    return NextResponse.json(
      { error: "Choose a completed take from this shot. Preview clips are not takes." },
      { status: 400 }
    );
  }
  return NextResponse.json(updated);
}
