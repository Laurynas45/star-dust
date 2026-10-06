import { NextRequest, NextResponse } from "next/server";
import { paypalCreditsEnabled } from "@/lib/credits";
import { capturePayPalOrder } from "@/lib/paypal-billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function redirect(req: NextRequest, path: string) {
  return NextResponse.redirect(new URL(path, req.nextUrl.origin));
}

/** PayPal sends the buyer back with token set to the order id. Capture stays on the server. */
export async function GET(req: NextRequest) {
  if (!paypalCreditsEnabled()) return redirect(req, "/settings");
  const orderId = req.nextUrl.searchParams.get("token")?.trim() ?? "";
  if (!orderId) return redirect(req, "/settings?credits=cancel");
  try {
    await capturePayPalOrder(orderId);
    return redirect(req, "/settings?credits=paypal");
  } catch {
    return redirect(req, "/settings?credits=paypal-error");
  }
}
