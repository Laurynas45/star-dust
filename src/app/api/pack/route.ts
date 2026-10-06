import { NextResponse } from "next/server";
import { packHoldFileExists, packUnlocked, visiblePackWorkflows, PACK_WORKFLOW_FILE } from "@/lib/pack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const unlocked = packUnlocked();
  return NextResponse.json({
    unlocked,
    workflows: visiblePackWorkflows(),
    workflowFile: unlocked && packHoldFileExists() ? PACK_WORKFLOW_FILE : null,
  });
}
