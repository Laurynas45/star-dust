import { NextRequest, NextResponse } from "next/server";
import { ensureJobWorker } from "@/lib/providers";
import { listJobs } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  ensureJobWorker();
  const projectId = req.nextUrl.searchParams.get("projectId") || undefined;
  return NextResponse.json(listJobs(projectId));
}
