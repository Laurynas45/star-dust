import { NextRequest, NextResponse } from "next/server";
import { handlePayPalWebhook } from "@/lib/paypal-billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const result = await handlePayPalWebhook(raw, req.headers);
  return NextResponse.json(result.body, { status: result.status });
}
