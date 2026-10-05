import { NextRequest, NextResponse } from "next/server";
import { createProject, listProjects } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(listProjects());
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name : "Untitled Project";
  const description = typeof body.description === "string" ? body.description : "";
  const project = createProject(name, description);
  return NextResponse.json(project, { status: 201 });
}
