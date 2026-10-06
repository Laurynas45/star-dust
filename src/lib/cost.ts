import { creditEstimate } from "./credits";
import { isPaidProvider, modelNameFor } from "./provider-info";
import { classifyShot } from "./takes";
import { getSettings, listJobs, listShots } from "./storage";
import { AppSettings, CostEstimate, ProviderId } from "./types";

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function fmt(value: number): string {
  return String(round4(value));
}

export function rateFor(
  settings: AppSettings,
  provider: ProviderId,
  modelName: string
): number | null {
  if (provider !== "fal" && provider !== "replicate") return null;
  const value = settings.rates[provider]?.[modelName];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

export function buildEstimate(opts: {
  provider: ProviderId;
  modelName: string;
  seconds: number;
  settings: AppSettings;
}): CostEstimate {
  const budgetCap = opts.settings.budgetCap;
  if (!isPaidProvider(opts.provider)) {
    return {
      paid: false,
      seconds: 0,
      ratePerSecond: null,
      total: null,
      unknown: false,
      budgetCap,
      overBudget: false,
      label: "This provider is not billed through Star Dust.",
    };
  }

  const seconds = round4(Math.max(0, opts.seconds));
  if (seconds === 0) {
    return {
      paid: true,
      seconds: 0,
      ratePerSecond: null,
      total: 0,
      unknown: false,
      budgetCap,
      overBudget: false,
      label: "Nothing new would be sent. No charge is estimated.",
    };
  }

  const rate = rateFor(opts.settings, opts.provider, opts.modelName);
  if (rate == null) {
    return {
      paid: true,
      seconds,
      ratePerSecond: null,
      total: null,
      unknown: true,
      budgetCap,
      overBudget: false,
      label:
        "Cost unknown. No per-second rate is set for this model. Star Dust is not showing a number. This is not a vendor quote.",
    };
  }

  const total = round4(seconds * rate);
  const overBudget = budgetCap != null && total > budgetCap;
  const own = "This is your own estimate, not a vendor quote.";
  const label = overBudget
    ? `Your estimate ${fmt(total)} is over your budget cap ${fmt(budgetCap!)}. Paid Render all is blocked. ${own}`
    : `Your estimate: ${fmt(seconds)} seconds × ${fmt(rate)} = ${fmt(total)}. ${own}`;
  return {
    paid: true,
    seconds,
    ratePerSecond: rate,
    total,
    unknown: false,
    budgetCap,
    overBudget,
    label,
  };
}

/** Attaches the hosted credit meter. Omitted entirely when Stripe and PayPal are unset. */
export function withCredits(
  estimate: CostEstimate,
  provider: ProviderId,
  seconds: number
): CostEstimate {
  if (!isPaidProvider(provider)) return estimate;
  const credits = creditEstimate(seconds, provider);
  return credits ? { ...estimate, credits } : estimate;
}

/** Seconds that a paid Render all would newly send. Skipped shots are not included. */
export function estimateRenderAll(projectId: string): CostEstimate {
  const settings = getSettings();
  const provider = settings.provider;
  const modelName = modelNameFor(provider, settings);
  const jobs = listJobs(projectId);
  let seconds = 0;
  if (isPaidProvider(provider)) {
    for (const shot of listShots(projectId)) {
      const decision = classifyShot(shot, jobs, provider, modelName);
      if (decision.action === "run") seconds += Number(shot.durationSec) || 0;
    }
  }
  return withCredits(buildEstimate({ provider, modelName, seconds, settings }), provider, seconds);
}
