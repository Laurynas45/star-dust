import { NextRequest, NextResponse } from "next/server";
import { parseLoraList } from "@/lib/loras";
import { createProject, listProjects } from "@/lib/storage";
import { LoraRef } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(listProjects());
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name : "Untitled Project";
  const description = typeof body.description === "string" ? body.description : "";
  let loras: LoraRef[] | undefined;
  if ("loras" in body && body.loras !== undefined) {
    const parsed = parseLoraList(body.loras, "loras");
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    loras = parsed.loras;
  }
  const project = createProject(name, description, loras);
  return NextResponse.json(project, { status: 201 });
}
