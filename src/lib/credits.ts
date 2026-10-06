import { v4 as uuidv4 } from "uuid";
import { isPaidProvider } from "./provider-info";
import { getDb } from "./storage";
import { CreditEstimate, ProviderId, PublicCreditPack, PublicPayPalPack } from "./types";

export interface CreditPack extends PublicCreditPack {
  priceId: string;
}

export type PayPalPack = PublicPayPalPack;

const NAMED_PRICE = /^STRIPE_PRICE_CREDITS_([A-Z0-9]+)$/;
const NAMED_PAYPAL_AMOUNT = /^PAYPAL_PACK_AMOUNT_([A-Z0-9]+)$/;

function positiveInt(value: string | undefined): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function titleFromSuffix(suffix: string): string {
  const lower = suffix.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Packs declared in the environment. Price ids stay server-side. */
export function listPacks(env: NodeJS.ProcessEnv = process.env): CreditPack[] {
  const packs: CreditPack[] = [];
  const single = env.STRIPE_PRICE_CREDITS?.trim();
  if (single) {
    packs.push({
      id: "default",
      label: "Credit pack",
      credits: positiveInt(env.STRIPE_CREDITS_AMOUNT) ?? 100,
      priceId: single,
    });
  }
  for (const key of Object.keys(env)) {
    const match = NAMED_PRICE.exec(key);
    if (!match) continue;
    const priceId = env[key]?.trim();
    if (!priceId) continue;
    const credits = positiveInt(env[`STRIPE_CREDITS_${match[1]}`]);
    if (!credits) continue;
    packs.push({
      id: match[1].toLowerCase(),
      label: `${titleFromSuffix(match[1])} pack`,
      credits,
      priceId,
    });
  }
  return packs;
}

export function publicCreditPacks(env: NodeJS.ProcessEnv = process.env): PublicCreditPack[] {
  return listPacks(env).map(({ id, label, credits }) => ({ id, label, credits }));
}

export function packById(id: string, env: NodeJS.ProcessEnv = process.env): CreditPack | undefined {
  return listPacks(env).find((pack) => pack.id === id);
}

export function packByPriceId(
  priceId: string,
  env: NodeJS.ProcessEnv = process.env
): CreditPack | undefined {
  return listPacks(env).find((pack) => pack.priceId === priceId);
}

export function paypalCurrency(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PAYPAL_CURRENCY?.trim().toUpperCase() ?? "";
  return /^[A-Z]{3}$/.test(raw) ? raw : "USD";
}

/** Positive money with at most two decimal places, formatted for PayPal. */
export function paypalMoney(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed.toFixed(2);
}

/**
 * One-time PayPal packs. Credit counts follow PAYPAL_CREDITS_*, then the
 * Stripe pack with the same name, then 100 for the default pack only.
 */
export function listPayPalPacks(env: NodeJS.ProcessEnv = process.env): PayPalPack[] {
  const currency = paypalCurrency(env);
  const packs: PayPalPack[] = [];
  const single = paypalMoney(env.PAYPAL_PACK_AMOUNT);
  if (single) {
    packs.push({
      id: "default",
      label: "Credit pack",
      credits:
        positiveInt(env.PAYPAL_CREDITS_AMOUNT) ?? positiveInt(env.STRIPE_CREDITS_AMOUNT) ?? 100,
      amount: single,
      currency,
    });
  }
  for (const key of Object.keys(env)) {
    const match = NAMED_PAYPAL_AMOUNT.exec(key);
    if (!match) continue;
    const amount = paypalMoney(env[key]);
    if (!amount) continue;
    const credits =
      positiveInt(env[`PAYPAL_CREDITS_${match[1]}`]) ?? positiveInt(env[`STRIPE_CREDITS_${match[1]}`]);
    if (!credits) continue;
    packs.push({
      id: match[1].toLowerCase(),
      label: `${titleFromSuffix(match[1])} pack`,
      credits,
      amount,
      currency,
    });
  }
  return packs;
}

export function publicPayPalPacks(env: NodeJS.ProcessEnv = process.env): PublicPayPalPack[] {
  return listPayPalPacks(env).map(({ id, label, credits, amount, currency }) => ({
    id,
    label,
    credits,
    amount,
    currency,
  }));
}

export function paypalPackById(
  id: string,
  env: NodeJS.ProcessEnv = process.env
): PayPalPack | undefined {
  return listPayPalPacks(env).find((pack) => pack.id === id);
}

/** Stripe Checkout is on only when a secret key and at least one price are set. */
export function stripeCreditsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.STRIPE_SECRET_KEY?.trim()) && listPacks(env).length > 0;
}

/** PayPal Orders is on only when API credentials and at least one amount are set. */
export function paypalCreditsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    Boolean(env.PAYPAL_CLIENT_ID?.trim() && env.PAYPAL_CLIENT_SECRET?.trim()) &&
    listPayPalPacks(env).length > 0
  );
}

/** Hosted mode is on when either one-time checkout is configured. */
export function hostedCreditsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return stripeCreditsEnabled(env) || paypalCreditsEnabled(env);
}

export function creditsPerSecond(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.STAR_DUST_CREDITS_PER_SECOND;
  if (raw == null || raw.trim() === "") return 1;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return value;
}

export function getCreditBalance(): number {
  const row = getDb()
    .prepare("SELECT COALESCE(SUM(delta), 0) AS balance FROM credit_ledger")
    .get() as { balance: number } | undefined;
  const balance = Number(row?.balance ?? 0);
  return Number.isFinite(balance) ? balance : 0;
}

function isUniqueConstraint(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === "object" &&
      "code" in err &&
      String((err as { code: unknown }).code).includes("SQLITE_CONSTRAINT")
  );
}

export function grantPackCredits(
  sessionId: string,
  priceId: string
):
  | { ok: true; granted: number; balance: number; duplicate: boolean }
  | { ok: false; error: string } {
  const pack = packByPriceId(priceId);
  if (!pack) return { ok: false, error: "Price is not a configured credit pack." };
  const db = getDb();
  const now = new Date().toISOString();
  try {
    const balance = db
      .transaction(() => {
        db.prepare(
          `INSERT INTO credit_ledger (id, delta, reason, stripe_session_id, paypal_order_id, detail, created_at)
           VALUES (?, ?, 'purchase', ?, NULL, ?, ?)`
        ).run(uuidv4(), pack.credits, sessionId, pack.id, now);
        return getCreditBalance();
      })
      .immediate();
    return { ok: true, granted: pack.credits, balance, duplicate: false };
  } catch (err) {
    if (isUniqueConstraint(err)) {
      return { ok: true, granted: 0, balance: getCreditBalance(), duplicate: true };
    }
    throw err;
  }
}

/** Same ledger as Stripe. A PayPal order id can be granted only once. */
export function grantPayPalCredits(
  orderId: string,
  pack: PayPalPack
):
  | { ok: true; granted: number; balance: number; duplicate: boolean }
  | { ok: false; error: string } {
  const id = orderId.trim();
  if (!id) return { ok: false, error: "PayPal order is missing." };
  const db = getDb();
  const now = new Date().toISOString();
  try {
    const balance = db
      .transaction(() => {
        db.prepare(
          `INSERT INTO credit_ledger (id, delta, reason, stripe_session_id, paypal_order_id, detail, created_at)
           VALUES (?, ?, 'purchase', NULL, ?, ?, ?)`
        ).run(uuidv4(), pack.credits, id, pack.id, now);
        return getCreditBalance();
      })
      .immediate();
    return { ok: true, granted: pack.credits, balance, duplicate: false };
  } catch (err) {
    if (isUniqueConstraint(err)) {
      return { ok: true, granted: 0, balance: getCreditBalance(), duplicate: true };
    }
    throw err;
  }
}

export function deductCredits(amount: number, detail: string): { ok: boolean; balance: number } {
  const credits = Math.trunc(amount);
  if (!Number.isFinite(credits) || credits <= 0) {
    return { ok: true, balance: getCreditBalance() };
  }
  const db = getDb();
  const now = new Date().toISOString();
  return db
    .transaction(() => {
      const balance = getCreditBalance();
      if (balance < credits) return { ok: false, balance };
      db.prepare(
        `INSERT INTO credit_ledger (id, delta, reason, stripe_session_id, detail, created_at)
         VALUES (?, ?, 'render', NULL, ?, ?)`
      ).run(uuidv4(), -credits, detail.slice(0, 200), now);
      return { ok: true, balance: balance - credits };
    })
    .immediate();
}

/**
 * Credit meter for a paid fal/Replicate run.
 * Returns undefined when neither Stripe nor PayPal packs are configured (Phase 1).
 */
export function creditEstimate(
  seconds: number,
  provider: ProviderId,
  env: NodeJS.ProcessEnv = process.env
): CreditEstimate | undefined {
  if (!hostedCreditsEnabled(env) || !isPaidProvider(provider)) return undefined;
  const perSecond = creditsPerSecond(env);
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const required = safeSeconds === 0 ? 0 : Math.ceil(safeSeconds * perSecond);
  const balance = getCreditBalance();
  const insufficient = required > 0 && balance < required;
  const label =
    required === 0
      ? "Hosted credits are on. This run does not spend credits."
      : insufficient
        ? `Not enough hosted credits. This run needs ${required} and the balance is ${balance}.`
        : `Hosted credits: this run spends ${required} (${balance} available). Credits are spent when the jobs are queued.`;
  return { hosted: true, required, balance, insufficient, perSecond, label };
}
