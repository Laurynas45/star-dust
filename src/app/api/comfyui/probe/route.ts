import { NextRequest, NextResponse } from "next/server";
import { probeComfyui } from "@/lib/providers/comfyui";
import { getSettings } from "@/lib/storage";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const base =
    typeof body.baseUrl === "string" && body.baseUrl
      ? body.baseUrl
      : getSettings().comfyuiBaseUrl;
  const result = await probeComfyui(base);
  return NextResponse.json(result);
}
