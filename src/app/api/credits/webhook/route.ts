import { NextRequest, NextResponse } from "next/server";
import { handleStripeWebhook } from "@/lib/stripe-billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const result = await handleStripeWebhook(raw, req.headers.get("stripe-signature"));
  return NextResponse.json(result.body, { status: result.status });
}
