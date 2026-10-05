import { NextRequest, NextResponse } from "next/server";
import { getSettings, saveSettings } from "@/lib/storage";
import { ProviderId } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const settings = getSettings();
  return NextResponse.json({
    ...settings,
    env: {
      hasFalKey: Boolean(process.env.FAL_KEY),
      hasReplicateToken: Boolean(process.env.REPLICATE_API_TOKEN),
    },
  });
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const allowed: ProviderId[] = ["mock", "fal", "replicate", "comfyui"];
  const patch: {
    provider?: ProviderId;
    comfyuiBaseUrl?: string;
    falModel?: string;
    replicateModel?: string;
  } = {};
  if (typeof body.provider === "string" && allowed.includes(body.provider)) {
    patch.provider = body.provider;
  }
  if (typeof body.comfyuiBaseUrl === "string") patch.comfyuiBaseUrl = body.comfyuiBaseUrl.trim();
  if (typeof body.falModel === "string") patch.falModel = body.falModel.trim();
  if (typeof body.replicateModel === "string") patch.replicateModel = body.replicateModel.trim();
  return NextResponse.json(saveSettings(patch));
}
