import fs from "fs";
import { NextRequest, NextResponse } from "next/server";
import { approvedTakeMismatch } from "@/lib/approve";
import { planTakeConform } from "@/lib/conform";
import { planProjectFinish } from "@/lib/finish-plan";
import { finishedTake } from "@/lib/continuity";
import { probeClipShape } from "@/lib/ffmpeg";
import { desiredClipKey, effectiveSeed } from "@/lib/input-key";
import { ensureJobWorker } from "@/lib/providers";
import {
  deleteProject,
  getProject,
  listJobs,
  listShots,
  resolveDataPath,
  updateProject,
} from "@/lib/storage";
import { generationIsRefused, MINOR_SEXUAL_REFUSAL } from "@/lib/safety";
import {
  CaptionMode,
  ComfyWorkflowId,
  SeamMode,
  clampChainTrimStartFrames,
  clampMusicFadeSec,
  clampMusicLevelDb,
  clampSeamFade,
  effectivePrompt,
  isComfyWorkflowId,
} from "@/lib/types";

function workflowField(value: unknown): ComfyWorkflowId | null | undefined {
  if (value === null) return null;
  if (isComfyWorkflowId(value)) return value;
  return undefined;
}

function flagField(value: unknown): boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  return undefined;
}

function seamModeField(value: unknown): SeamMode | undefined {
  if (value === "cut" || value === "crossfade") return value;
  return undefined;
}

function nullableNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function nullableFlag(value: unknown): boolean | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  return undefined;
}

function captionModeField(value: unknown): CaptionMode | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value === "burn" || value === "sidecar") return value;
  return undefined;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  ensureJobWorker();
  const project = getProject(params.id);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const shots = listShots(params.id);
  const jobs = listJobs(params.id);
  const conformClips = [];
  for (const shot of shots) {
    const job = finishedTake(shot);
    if (!job?.outputPath) continue;
    const abs = resolveDataPath(job.outputPath);
    if (!fs.existsSync(abs)) continue;
    try {
      const shape = probeClipShape(abs);
      conformClips.push({ shotId: shot.id, ...shape });
    } catch {
      continue;
    }
  }
  const cutSec = conformClips.reduce((sum, clip) => sum + (clip.durationSec > 0 ? clip.durationSec : 0), 0);
  const previewSec = shots.reduce((sum, shot) => sum + (shot.durationSec > 0 ? shot.durationSec : 0), 0);
  return NextResponse.json({
    project,
    conform: planTakeConform(project, conformClips),
    finish: planProjectFinish(project, {
      anyClipAudio: conformClips.some((clip) => clip.hasAudio),
      cutSec: cutSec > 0 ? cutSec : null,
    }),
    previewFinish: planProjectFinish(project, {
      anyClipAudio: false,
      cutSec: previewSec > 0 ? previewSec : null,
    }),
    shots: shots.map((shot) => ({
      ...shot,
      currentInputKey: desiredClipKey(shot),
      effectiveSeed: effectiveSeed(shot),
      approvedMismatch: approvedTakeMismatch(
        shot,
        jobs.find((job) => job.id === shot.approvedJobId),
        project.styleBase
      ),
    })),
    jobs,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const body = await req.json().catch(() => ({}));
  const styleBase = typeof body.styleBase === "string" ? body.styleBase : undefined;
  if (styleBase !== undefined) {
    const project = getProject(params.id);
    if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const shots = listShots(params.id);
    const refused =
      generationIsRefused(styleBase, []) ||
      shots.some((shot) => generationIsRefused(effectivePrompt(styleBase, shot.prompt), []));
    if (refused) {
      return NextResponse.json({ error: MINOR_SEXUAL_REFUSAL, refused: true }, { status: 400 });
    }
  }
  const updated = updateProject(params.id, {
    name: typeof body.name === "string" ? body.name : undefined,
    description: typeof body.description === "string" ? body.description : undefined,
    comfyuiWorkflow: workflowField(body.comfyuiWorkflow),
    comfyLowMemory: flagField(body.comfyLowMemory),
    seamMode: seamModeField(body.seamMode),
    seamFadeSec: typeof body.seamFadeSec === "number" ? clampSeamFade(body.seamFadeSec) : undefined,
    styleBase,
    chainTrimStartFrames:
      typeof body.chainTrimStartFrames === "number" && Number.isFinite(body.chainTrimStartFrames)
        ? clampChainTrimStartFrames(body.chainTrimStartFrames)
        : undefined,
    dropDuplicateFrame: typeof body.dropDuplicateFrame === "boolean" ? body.dropDuplicateFrame : undefined,
    outputFps: nullableNumber(body.outputFps),
    outputWidth: nullableNumber(body.outputWidth),
    outputHeight: nullableNumber(body.outputHeight),
    loudnessNormalize: nullableFlag(body.loudnessNormalize),
    musicLevelDb: typeof body.musicLevelDb === "number" ? clampMusicLevelDb(body.musicLevelDb) : undefined,
    musicFadeInSec: typeof body.musicFadeInSec === "number" ? clampMusicFadeSec(body.musicFadeInSec) : undefined,
    musicFadeOutSec:
      typeof body.musicFadeOutSec === "number" ? clampMusicFadeSec(body.musicFadeOutSec) : undefined,
    captionMode: captionModeField(body.captionMode),
  });
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(updated);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!getProject(params.id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  deleteProject(params.id);
  return NextResponse.json({ ok: true });
}
