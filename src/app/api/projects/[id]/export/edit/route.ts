import { NextRequest, NextResponse } from "next/server";
import { buildEditExport } from "@/lib/edit-export";
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
  try {
    const result = await buildEditExport(params.id);
    return new NextResponse(new Uint8Array(result.bytes), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "Content-Length": String(result.bytes.length),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Export failed";
    const status = message === "Project not found" ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
