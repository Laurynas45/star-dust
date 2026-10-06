import { NextRequest, NextResponse } from "next/server";
import { workerPlan } from "@/lib/pack";
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
  const plan = workerPlan(params.id);
  if (!plan.ok && !plan.unlocked) {
    return NextResponse.json(plan, { status: 403 });
  }
  if (!plan.ok) return NextResponse.json(plan, { status: 404 });
  return NextResponse.json(plan);
}
