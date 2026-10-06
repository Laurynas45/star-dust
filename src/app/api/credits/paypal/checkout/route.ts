import { NextRequest, NextResponse } from "next/server";
import { paypalCreditsEnabled } from "@/lib/credits";
import { createPayPalCheckout } from "@/lib/paypal-billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clientError(err: unknown): string {
  if (err instanceof Error && err.message === "Unknown credit pack.") return err.message;
  return "Could not start checkout.";
}

export async function POST(req: NextRequest) {
  if (!paypalCreditsEnabled()) {
    return NextResponse.json({ error: "PayPal credits are off." }, { status: 404 });
  }
  const body = await req.json().catch(() => ({}));
  const packId =
    typeof body.packId === "string" && body.packId.trim() ? body.packId.trim() : "default";
  try {
    const order = await createPayPalCheckout({ packId, origin: req.nextUrl.origin });
    return NextResponse.json({ url: order.url });
  } catch (err) {
    return NextResponse.json({ error: clientError(err) }, { status: 400 });
  }
}
