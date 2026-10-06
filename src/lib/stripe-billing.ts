import { stripeCreditsEnabled, packById, packByPriceId, grantPackCredits } from "./credits";

export type CheckoutRequest = {
  mode: "payment";
  line_items: { price: string; quantity: number }[];
  success_url: string;
  cancel_url: string;
  metadata: { priceId: string; packId: string; credits: string };
};

export type CheckoutResult = { id: string; url: string };

type CheckoutCreator = (params: CheckoutRequest) => Promise<CheckoutResult>;

let checkoutOverride: CheckoutCreator | null = null;

/** Tests inject a creator so CI never calls Stripe. */
export function setCheckoutCreatorForTests(fn: CheckoutCreator | null) {
  checkoutOverride = fn;
}

export class HostedCreditsOffError extends Error {
  constructor() {
    super("Hosted credits are off.");
  }
}

function safeOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Checkout needs an http(s) origin.");
  }
  return url.origin;
}

export async function createCreditCheckout(opts: {
  packId: string;
  origin: string;
}): Promise<CheckoutResult> {
  if (!stripeCreditsEnabled()) throw new HostedCreditsOffError();
  const pack = packById(opts.packId);
  if (!pack) throw new Error("Unknown credit pack.");
  const origin = safeOrigin(opts.origin);
  const params: CheckoutRequest = {
    mode: "payment",
    line_items: [{ price: pack.priceId, quantity: 1 }],
    success_url: `${origin}/settings?credits=success`,
    cancel_url: `${origin}/settings?credits=cancel`,
    metadata: {
      priceId: pack.priceId,
      packId: pack.id,
      credits: String(pack.credits),
    },
  };
  if (checkoutOverride) return checkoutOverride(params);

  const secret = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secret) throw new HostedCreditsOffError();
  const { default: Stripe } = await import("stripe");
  const stripe = new Stripe(secret, {
    maxNetworkRetries: 0,
    timeout: 10000,
    telemetry: false,
  });
  const session = await stripe.checkout.sessions.create(params);
  if (!session.url) throw new Error("Stripe did not return a checkout URL.");
  return { id: session.id, url: session.url };
}

export type WebhookBody = {
  granted?: number;
  balance?: number;
  duplicate?: boolean;
  ignored?: boolean;
  reason?: string;
  error?: string;
};

const CREDIT_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);

export function applyStripeEvent(event: {
  type: string;
  data: { object: Record<string, unknown> };
}): WebhookBody {
  if (!CREDIT_EVENTS.has(event.type)) {
    return { ignored: true, reason: "Event is not a one-time checkout payment." };
  }
  const session = event.data.object;
  const mode = typeof session.mode === "string" ? session.mode : "";
  if (mode === "subscription") {
    return { ignored: true, reason: "Subscriptions are not credited." };
  }
  if (mode !== "payment") {
    return { ignored: true, reason: "Only one-time payments add credits." };
  }
  const paymentStatus = typeof session.payment_status === "string" ? session.payment_status : "";
  if (paymentStatus !== "paid") {
    return { ignored: true, reason: "Payment is not paid yet." };
  }
  const metadata =
    session.metadata && typeof session.metadata === "object"
      ? (session.metadata as Record<string, unknown>)
      : {};
  const priceId = typeof metadata.priceId === "string" ? metadata.priceId : "";
  const sessionId = typeof session.id === "string" ? session.id : "";
  if (!sessionId || !priceId) {
    return { ignored: true, reason: "Checkout session is missing a price." };
  }
  if (!packByPriceId(priceId)) {
    return { ignored: true, reason: "Price is not a configured credit pack." };
  }
  const granted = grantPackCredits(sessionId, priceId);
  if (!granted.ok) return { ignored: true, reason: granted.error };
  return { granted: granted.granted, balance: granted.balance, duplicate: granted.duplicate };
}

export async function handleStripeWebhook(
  rawBody: string,
  signature: string | null
): Promise<{ status: number; body: WebhookBody }> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) return { status: 404, body: { error: "Hosted credits are off." } };
  try {
    const event = await verifyStripeEvent(rawBody, signature ?? "", secret);
    return { status: 200, body: applyStripeEvent(event) };
  } catch {
    return { status: 400, body: { error: "Invalid Stripe signature." } };
  }
}

async function verifyStripeEvent(rawBody: string, signature: string, secret: string) {
  // Signature checks are local HMAC. The API key is not sent.
  const { default: Stripe } = await import("stripe");
  const key = process.env.STRIPE_SECRET_KEY?.trim() || "sk_test_unused";
  const stripe = new Stripe(key, { maxNetworkRetries: 0, timeout: 1000, telemetry: false });
  const event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  return {
    type: event.type,
    data: { object: event.data.object as unknown as Record<string, unknown> },
  };
}
