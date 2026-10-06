import {
  grantPayPalCredits,
  paypalCreditsEnabled,
  paypalMoney,
  paypalPackById,
  type PayPalPack,
} from "./credits";

export type PayPalOrderDraft = {
  intent: "CAPTURE";
  packId: string;
  amount: string;
  currency: string;
  credits: number;
  returnUrl: string;
  cancelUrl: string;
};

export type PayPalOrderCreated = { id: string; url: string };

export type PayPalCapture = {
  orderId: string;
  status: string;
  packId: string;
  amount: string;
  currency: string;
};

export type PayPalClient = {
  createOrder(draft: PayPalOrderDraft): Promise<PayPalOrderCreated>;
  captureOrder(orderId: string): Promise<PayPalCapture>;
};

export type PayPalHeaderSource = { get(name: string): string | null };

export type PayPalWebhookVerifier = (
  rawBody: string,
  headers: PayPalHeaderSource
) => Promise<Record<string, unknown> | null>;

export type PayPalWebhookBody = {
  granted?: number;
  balance?: number;
  duplicate?: boolean;
  ignored?: boolean;
  reason?: string;
  error?: string;
};

export class PayPalCreditsOffError extends Error {
  constructor() {
    super("PayPal credits are off.");
  }
}

let clientOverride: PayPalClient | null = null;
let webhookVerifier: PayPalWebhookVerifier | null = null;

/** Tests inject a client so CI never calls PayPal. */
export function setPayPalClientForTests(client: PayPalClient | null) {
  clientOverride = client;
}

/** Tests inject signature checks so CI never calls PayPal's verify endpoint. */
export function setPayPalWebhookVerifierForTests(verifier: PayPalWebhookVerifier | null) {
  webhookVerifier = verifier;
}

export function paypalApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return env.PAYPAL_MODE?.trim().toLowerCase() === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

function safeOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Checkout needs an http(s) origin.");
  }
  return url.origin;
}

/** Orders v2 body. One-time capture only — no subscription or plan. */
export function buildPayPalOrderBody(draft: PayPalOrderDraft): Record<string, unknown> {
  return {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: draft.packId,
        custom_id: draft.packId,
        description: "Star Dust credit pack",
        amount: {
          currency_code: draft.currency,
          value: draft.amount,
        },
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: "Star Dust",
          user_action: "PAY_NOW",
          shipping_preference: "NO_SHIPPING",
          return_url: draft.returnUrl,
          cancel_url: draft.cancelUrl,
        },
      },
    },
  };
}

function draftFor(pack: PayPalPack, origin: string): PayPalOrderDraft {
  return {
    intent: "CAPTURE",
    packId: pack.id,
    amount: pack.amount,
    currency: pack.currency,
    credits: pack.credits,
    returnUrl: `${origin}/api/credits/paypal/return`,
    cancelUrl: `${origin}/settings?credits=cancel`,
  };
}

export async function createPayPalCheckout(opts: {
  packId: string;
  origin: string;
}): Promise<PayPalOrderCreated> {
  if (!paypalCreditsEnabled()) throw new PayPalCreditsOffError();
  const pack = paypalPackById(opts.packId);
  if (!pack) throw new Error("Unknown credit pack.");
  const draft = draftFor(pack, safeOrigin(opts.origin));
  if (clientOverride) return clientOverride.createOrder(draft);
  return liveCreateOrder(draft);
}

const ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function settlePayPalPayment(
  capture: PayPalCapture
):
  | { ok: true; granted: number; balance: number; duplicate: boolean }
  | { ok: false; error: string } {
  if (capture.status !== "COMPLETED") {
    return { ok: false, error: "Payment is not completed." };
  }
  if (!ORDER_ID.test(capture.orderId)) {
    return { ok: false, error: "PayPal order is missing." };
  }
  const pack = paypalPackById(capture.packId);
  if (!pack) return { ok: false, error: "Pack is not a configured credit pack." };
  const amount = paypalMoney(capture.amount);
  const currency = capture.currency.trim().toUpperCase();
  if (!amount || amount !== pack.amount || currency !== pack.currency) {
    return { ok: false, error: "Amount does not match the credit pack." };
  }
  return grantPayPalCredits(capture.orderId, pack);
}

export async function capturePayPalOrder(orderId: string): Promise<{
  granted: number;
  balance: number;
  duplicate: boolean;
}> {
  if (!paypalCreditsEnabled()) throw new PayPalCreditsOffError();
  if (!ORDER_ID.test(orderId)) throw new Error("Unknown PayPal order.");
  const capture = clientOverride
    ? await clientOverride.captureOrder(orderId)
    : await liveCaptureOrder(orderId);
  const settled = settlePayPalPayment(capture);
  if (!settled.ok) throw new Error(settled.error);
  return { granted: settled.granted, balance: settled.balance, duplicate: settled.duplicate };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function applyPayPalEvent(event: Record<string, unknown>): PayPalWebhookBody {
  const type = asString(event.event_type);
  if (type.startsWith("BILLING.SUBSCRIPTION") || type === "PAYMENT.SALE.COMPLETED") {
    return { ignored: true, reason: "Subscriptions are not credited." };
  }
  if (type !== "PAYMENT.CAPTURE.COMPLETED") {
    return { ignored: true, reason: "Event is not a completed one-time capture." };
  }
  const resource = asRecord(event.resource) ?? {};
  const related = asRecord(asRecord(resource.supplementary_data)?.related_ids);
  const amount = asRecord(resource.amount);
  const settled = settlePayPalPayment({
    orderId: asString(related?.order_id),
    status: asString(resource.status),
    packId: asString(resource.custom_id),
    amount: asString(amount?.value),
    currency: asString(amount?.currency_code),
  });
  if (!settled.ok) return { ignored: true, reason: settled.error };
  return { granted: settled.granted, balance: settled.balance, duplicate: settled.duplicate };
}

export async function handlePayPalWebhook(
  rawBody: string,
  headers: PayPalHeaderSource
): Promise<{ status: number; body: PayPalWebhookBody }> {
  if (!paypalCreditsEnabled()) {
    return { status: 404, body: { error: "PayPal credits are off." } };
  }
  if (!process.env.PAYPAL_WEBHOOK_ID?.trim()) {
    return { status: 404, body: { error: "PayPal webhook is off." } };
  }
  try {
    const event = webhookVerifier
      ? await webhookVerifier(rawBody, headers)
      : await verifyWithPayPal(rawBody, headers);
    if (!event) return { status: 400, body: { error: "Invalid PayPal signature." } };
    return { status: 200, body: applyPayPalEvent(event) };
  } catch {
    return { status: 400, body: { error: "Invalid PayPal signature." } };
  }
}

async function paypalFetch(path: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    return await fetch(`${paypalApiBase()}${path}`, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function accessToken(): Promise<string> {
  const id = process.env.PAYPAL_CLIENT_ID?.trim() ?? "";
  const secret = process.env.PAYPAL_CLIENT_SECRET?.trim() ?? "";
  const auth = Buffer.from(`${id}:${secret}`).toString("base64");
  const res = await paypalFetch("/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error("PayPal authentication failed.");
  const data = (await res.json()) as { access_token?: unknown };
  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new Error("PayPal authentication failed.");
  }
  return data.access_token;
}

function approveLink(links: unknown): string {
  if (!Array.isArray(links)) throw new Error("PayPal did not return a checkout URL.");
  const typed = links.filter(
    (item): item is { rel?: string; href?: string } => Boolean(item && typeof item === "object")
  );
  const link =
    typed.find((item) => item.rel === "payer-action") ?? typed.find((item) => item.rel === "approve");
  if (!link?.href) throw new Error("PayPal did not return a checkout URL.");
  const url = new URL(link.href);
  const host = url.hostname.toLowerCase();
  const paypalHost = host === "paypal.com" || host.endsWith(".paypal.com");
  if (url.protocol !== "https:" || !paypalHost) {
    throw new Error("PayPal did not return a checkout URL.");
  }
  return url.href;
}

async function liveCreateOrder(draft: PayPalOrderDraft): Promise<PayPalOrderCreated> {
  const token = await accessToken();
  const res = await paypalFetch("/v2/checkout/orders", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildPayPalOrderBody(draft)),
  });
  if (!res.ok) throw new Error("PayPal could not start checkout.");
  const data = (await res.json()) as { id?: unknown; links?: unknown };
  if (typeof data.id !== "string" || !data.id) throw new Error("PayPal could not start checkout.");
  return { id: data.id, url: approveLink(data.links) };
}

function parseCapturedOrder(order: Record<string, unknown>, fallbackOrderId: string): PayPalCapture {
  const units = Array.isArray(order.purchase_units) ? order.purchase_units : [];
  const unit = asRecord(units[0]) ?? {};
  const payments = asRecord(unit.payments);
  const captures = Array.isArray(payments?.captures) ? payments.captures : [];
  const capture = asRecord(captures[0]) ?? {};
  const amount = asRecord(capture.amount) ?? asRecord(unit.amount);
  return {
    orderId: asString(order.id) || fallbackOrderId,
    status: asString(capture.status) || asString(order.status),
    packId: asString(capture.custom_id) || asString(unit.custom_id) || asString(unit.reference_id),
    amount: asString(amount?.value),
    currency: asString(amount?.currency_code),
  };
}

async function liveCaptureOrder(orderId: string): Promise<PayPalCapture> {
  const token = await accessToken();
  const encoded = encodeURIComponent(orderId);
  const res = await paypalFetch(`/v2/checkout/orders/${encoded}/capture`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
  });
  if (res.ok) {
    return parseCapturedOrder((await res.json()) as Record<string, unknown>, orderId);
  }
  const failure = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 422 && JSON.stringify(failure).includes("ORDER_ALREADY_CAPTURED")) {
    const got = await paypalFetch(`/v2/checkout/orders/${encoded}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!got.ok) throw new Error("PayPal could not capture the order.");
    return parseCapturedOrder((await got.json()) as Record<string, unknown>, orderId);
  }
  throw new Error("PayPal could not capture the order.");
}

async function verifyWithPayPal(
  rawBody: string,
  headers: PayPalHeaderSource
): Promise<Record<string, unknown>> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID?.trim() ?? "";
  let webhookEvent: unknown;
  try {
    webhookEvent = JSON.parse(rawBody);
  } catch {
    throw new Error("Invalid PayPal signature.");
  }
  const token = await accessToken();
  const res = await paypalFetch("/v1/notifications/verify-webhook-signature", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      auth_algo: headers.get("paypal-auth-algo"),
      cert_url: headers.get("paypal-cert-url"),
      transmission_id: headers.get("paypal-transmission-id"),
      transmission_sig: headers.get("paypal-transmission-sig"),
      transmission_time: headers.get("paypal-transmission-time"),
      webhook_id: webhookId,
      webhook_event: webhookEvent,
    }),
  });
  if (!res.ok) throw new Error("Invalid PayPal signature.");
  const data = (await res.json()) as { verification_status?: unknown };
  if (data.verification_status !== "SUCCESS") throw new Error("Invalid PayPal signature.");
  const event = asRecord(webhookEvent);
  if (!event) throw new Error("Invalid PayPal signature.");
  return event;
}
