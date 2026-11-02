import { NextRequest, NextResponse } from "next/server";
import { bundleFromUpload, importShotList } from "@/lib/shotlist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function fileBuffer(entry: FormDataEntryValue | null): Promise<{ name: string; buf: Buffer } | null> {
  if (!(entry instanceof File) || entry.size === 0) return null;
  return { name: entry.name || "shotlist", buf: Buffer.from(await entry.arrayBuffer()) };
}

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "Upload a shot list zip or JSON file.", errors: ["Upload a shot list zip or JSON file."] }, { status: 400 });
  }
  const file = await fileBuffer(form.get("file"));
  if (!file) {
    return NextResponse.json(
      { error: "Choose a shot list zip or JSON file.", errors: ["Choose a shot list zip or JSON file."] },
      { status: 400 }
    );
  }
  const images = await fileBuffer(form.get("images"));
  const loaded = await bundleFromUpload({
    fileName: file.name,
    file: file.buf,
    imagesZip: images?.buf ?? null,
  });
  if (!loaded.bundle || loaded.errors.length > 0) {
    const errors = loaded.errors.length > 0 ? loaded.errors : ["The shot list could not be read."];
    return NextResponse.json({ error: errors[0], errors }, { status: 400 });
  }
  const result = importShotList(loaded.bundle);
  if (!result.ok) {
    const errors = result.errors.length > 0 ? result.errors : ["The shot list was not imported."];
    return NextResponse.json(
      { error: errors[0], errors, refused: result.refused },
      { status: 400 }
    );
  }
  return NextResponse.json({ project: result.project }, { status: 201 });
}
