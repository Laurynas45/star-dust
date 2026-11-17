import { NextRequest, NextResponse } from "next/server";
import { toPublicCheck } from "@/lib/comfy-readiness";
import { resolveComfyChoice } from "@/lib/comfy-choice";
import { compareGraphIds } from "@/lib/provider-info";
import { checkComfyServer } from "@/lib/providers/comfyui";
import { getProject, getSettings, listShots } from "@/lib/storage";
import { ComfyGraphId, isComfyGraphId } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function workflowsForProject(projectId: string): ComfyGraphId[] | null {
  const project = getProject(projectId);
  if (!project) return null;
  const settings = getSettings();
  const shots = listShots(projectId);
  const ids: ComfyGraphId[] = [];
  const add = (id: ComfyGraphId) => {
    if (!ids.includes(id)) ids.push(id);
  };
  if (shots.length === 0) add(resolveComfyChoice({ settings, project }).workflow);
  for (const shot of shots) add(resolveComfyChoice({ settings, project, shot }).workflow);
  ids.sort(compareGraphIds);
  return ids;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  let ids: ComfyGraphId[];
  if (typeof body.projectId === "string" && body.projectId) {
    const found = workflowsForProject(body.projectId);
    if (!found) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    ids = found;
  } else if (isComfyGraphId(body.workflow)) {
    ids = [body.workflow];
  } else {
    ids = [getSettings().comfyuiWorkflow];
  }
  const report = toPublicCheck(await checkComfyServer(ids));
  return NextResponse.json(report);
}
