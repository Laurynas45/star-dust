import { NextRequest, NextResponse } from "next/server";
import { previewSeam } from "@/lib/stitch";
import { getShot } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string; shotId: string } }
) {
  const shot = getShot(params.shotId);
  if (!shot || shot.projectId !== params.id) {
    return NextResponse.json({ error: "Shot not found" }, { status: 404 });
  }
  try {
    const result = await previewSeam(params.id, params.shotId);
    return NextResponse.json({
      outputPath: result.outputPath,
      durationSec: result.durationSec,
      seam: result.seams[0] ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Seam preview failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
