import { NextRequest, NextResponse } from "next/server";
import { toPublicCheck } from "@/lib/comfy-readiness";
import { resolveComfyChoice } from "@/lib/comfy-choice";
import { COMFY_WORKFLOW_ORDER } from "@/lib/provider-info";
import { checkComfyServer } from "@/lib/providers/comfyui";
import { getProject, getSettings, listShots } from "@/lib/storage";
import { ComfyWorkflowId, isComfyWorkflowId } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function workflowsForProject(projectId: string): ComfyWorkflowId[] | null {
  const project = getProject(projectId);
  if (!project) return null;
  const settings = getSettings();
  const shots = listShots(projectId);
  const ids: ComfyWorkflowId[] = [];
  const add = (id: ComfyWorkflowId) => {
    if (!ids.includes(id)) ids.push(id);
  };
  if (shots.length === 0) add(resolveComfyChoice({ settings, project }).workflow);
  for (const shot of shots) add(resolveComfyChoice({ settings, project, shot }).workflow);
  ids.sort((a, b) => COMFY_WORKFLOW_ORDER.indexOf(a) - COMFY_WORKFLOW_ORDER.indexOf(b));
  return ids;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  let ids: ComfyWorkflowId[];
  if (typeof body.projectId === "string" && body.projectId) {
    const found = workflowsForProject(body.projectId);
    if (!found) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    ids = found;
  } else if (isComfyWorkflowId(body.workflow)) {
    ids = [body.workflow];
  } else {
    ids = [getSettings().comfyuiWorkflow];
  }
  const report = toPublicCheck(await checkComfyServer(ids));
  return NextResponse.json(report);
}
