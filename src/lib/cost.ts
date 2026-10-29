import fs from "fs";
import { completedTakesFor } from "./chain-stale";
import { resolveComfyChoice } from "./comfy-choice";
import { creditEstimate } from "./credits";
import { probeImageSize } from "./ffmpeg";
import { isPaidProvider, modelNameFor } from "./provider-info";
import { projectRenderPlan } from "./takes";
import { getProject, getSettings, listJobs, listShots, resolveDataPath } from "./storage";
import {
  AppSettings,
  BillingUnit,
  CostEstimate,
  ESTIMATE_FPS,
  Job,
  ProviderId,
  Shot,
  ShotCostLine,
  StoredRate,
  billingAmountOf,
  billingUnitOf,
} from "./types";

export interface ShotBill {
  id: string;
  position: number;
  durationSec: number;
  width: number | null;
  height: number | null;
  hasClip: boolean;
  /** Render all would send this shot. */
  remaining: boolean;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function fmt(value: number): string {
  return String(round4(value));
}

function fmtQty(value: number): string {
  return String(Math.round(value * 1_000_000) / 1_000_000);
}

const OWN = "This is your own estimate, not a vendor quote.";
const NO_TABLE = "Star Dust has no vendor price table.";

export function readRate(
  settings: AppSettings,
  provider: ProviderId,
  modelName: string
): { amount: number; unit: BillingUnit } | null {
  if (provider !== "fal" && provider !== "replicate") return null;
  const raw: StoredRate | undefined = settings.rates[provider]?.[modelName];
  const amount = billingAmountOf(raw);
  if (amount == null) return null;
  return { amount, unit: billingUnitOf(raw) };
}

/** @deprecated Prefer readRate. Kept so a per-second lookup still returns the amount. */
export function rateFor(
  settings: AppSettings,
  provider: ProviderId,
  modelName: string
): number | null {
  const rate = readRate(settings, provider, modelName);
  if (!rate || rate.unit !== "second") return null;
  return rate.amount;
}

export function stillPathForEstimate(
  shot: Pick<Shot, "chainFromPrevious" | "chainedStartImagePath" | "startImagePath">
): string | undefined {
  if (shot.chainFromPrevious && shot.chainedStartImagePath) return shot.chainedStartImagePath;
  return shot.startImagePath;
}

export function measureStill(shot: Shot): { width: number | null; height: number | null } {
  const rel = stillPathForEstimate(shot);
  if (!rel) return { width: null, height: null };
  try {
    const abs = resolveDataPath(rel);
    if (!fs.existsSync(abs)) return { width: null, height: null };
    return probeImageSize(abs) ?? { width: null, height: null };
  } catch {
    return { width: null, height: null };
  }
}

/**
 * Billed quantity for one shot.
 * Per second uses the duration. Per clip is one clip.
 * Per megapixel of video is width × height × 24 × seconds ÷ 1,000,000.
 * Per 1M video tokens is width × height × 24 × seconds ÷ 1024 ÷ 1,000,000.
 * Size-based units return null when the still size is missing.
 */
export function shotQuantity(
  unit: BillingUnit,
  durationSec: number,
  width: number | null,
  height: number | null
): number | null {
  const seconds = Math.max(0, durationSec);
  if (unit === "second") return seconds;
  if (unit === "clip") return seconds > 0 ? 1 : 0;
  if (width == null || height == null || width < 1 || height < 1) return null;
  const samples = width * height * ESTIMATE_FPS * seconds;
  if (unit === "megapixel") return samples / 1_000_000;
  return samples / 1024 / 1_000_000;
}

function unitNeedsSize(unit: BillingUnit): boolean {
  return unit === "megapixel" || unit === "million-tokens";
}

function unitNoun(unit: BillingUnit): string {
  if (unit === "second") return "seconds";
  if (unit === "clip") return "clips";
  if (unit === "megapixel") return "megapixels of video";
  return "million video tokens";
}

function sumQuantity(unit: BillingUnit, shots: ShotBill[], repeat: number): number | null {
  let total = 0;
  for (const shot of shots) {
    const quantity = shotQuantity(unit, shot.durationSec, shot.width, shot.height);
    if (quantity == null) return null;
    total += quantity;
  }
  return total * repeat;
}

function moneyFor(unit: BillingUnit, amount: number, shot: ShotBill): number | null {
  const quantity = shotQuantity(unit, shot.durationSec, shot.width, shot.height);
  if (quantity == null) return null;
  return round4(quantity * amount);
}

export function shotBill(shot: Shot, jobs: readonly Job[], remaining: boolean): ShotBill {
  const size = measureStill(shot);
  return {
    id: shot.id,
    position: shot.position,
    durationSec: Number(shot.durationSec) || 0,
    width: size.width,
    height: size.height,
    hasClip: completedTakesFor(jobs, shot.id).length > 0,
    remaining,
  };
}

function emptyPaid(budgetCap: number | null, label: string, unknown: boolean): CostEstimate {
  return {
    paid: true,
    seconds: 0,
    ratePerSecond: null,
    total: unknown ? null : 0,
    unknown,
    budgetCap,
    overBudget: false,
    label,
    billingUnit: null,
    rate: null,
    quantity: 0,
    projectTotal: unknown ? null : 0,
    remainingTotal: unknown ? null : 0,
    retakeTotal: unknown ? null : 0,
    shots: [],
  };
}

export function buildEstimate(opts: {
  provider: ProviderId;
  modelName: string;
  settings: AppSettings;
  shots?: ShotBill[];
  /** Try seeds renders the same shot 2, 3, or 4 times. */
  repeat?: number;
  /** project is the shot list. run is one retake or try-seeds quote. */
  scope?: "project" | "run";
  /** Used when shots are omitted. Older per-second path. */
  seconds?: number;
}): CostEstimate {
  const budgetCap = opts.settings.budgetCap;
  const scope = opts.scope ?? "project";
  const repeat = opts.repeat && opts.repeat > 0 ? opts.repeat : 1;
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

  const shots = opts.shots ?? [];
  const billed = shots.filter((shot) => shot.remaining);
  const rawSeconds = billed.reduce((sum, shot) => sum + Math.max(0, shot.durationSec), 0) * repeat;
  const seconds = round4(rawSeconds);

  if (shots.length === 0 && opts.seconds != null && opts.seconds > 0) {
    return buildEstimate({
      ...opts,
      seconds: undefined,
      shots: [
        {
          id: "run",
          position: 0,
          durationSec: opts.seconds / repeat,
          width: null,
          height: null,
          hasClip: false,
          remaining: true,
        },
      ],
    });
  }

  if (billed.length === 0 && scope === "run") {
    return emptyPaid(budgetCap, "Nothing new would be sent. No charge is estimated.", false);
  }

  const rate = readRate(opts.settings, opts.provider, opts.modelName);
  const priced = (group: ShotBill[]): number | null => {
    if (!rate) return null;
    const quantity = sumQuantity(rate.unit, group, group === billed ? repeat : 1);
    if (quantity == null) return null;
    if (rate.unit === "second") return round4(round4(quantity) * rate.amount);
    return round4(quantity * rate.amount);
  };

  const lines: ShotCostLine[] = shots.map((shot) => {
    const amount = rate ? moneyFor(rate.unit, rate.amount, shot) : null;
    return {
      shotId: shot.id,
      position: shot.position,
      durationSec: shot.durationSec,
      width: shot.width,
      height: shot.height,
      amount,
      remaining: shot.remaining,
      hasClip: shot.hasClip,
      retakeAdd: shot.hasClip ? amount : null,
    };
  });

  const withClips = shots.filter((shot) => shot.hasClip);
  const projectTotal = priced(shots);
  const remainingTotal = priced(billed);
  const retakeTotal = withClips.length === 0 ? 0 : priced(withClips);

  if (!rate) {
    if (billed.length === 0) {
      return {
        ...emptyPaid(budgetCap, "Nothing new would be sent. No charge is estimated.", false),
        shots: lines,
        projectTotal: null,
        retakeTotal: null,
      };
    }
    return {
      paid: true,
      seconds,
      ratePerSecond: null,
      total: null,
      unknown: true,
      budgetCap,
      overBudget: false,
      label:
        "Cost unknown. No rate is set for this model. Star Dust is not showing a number. This is not a vendor quote.",
      billingUnit: null,
      rate: null,
      quantity: null,
      projectTotal: null,
      remainingTotal: null,
      retakeTotal: null,
      shots: lines,
    };
  }

  const sizeMissing =
    unitNeedsSize(rate.unit) && billed.some((shot) => shotQuantity(rate.unit, shot.durationSec, shot.width, shot.height) == null);
  if (sizeMissing) {
    return {
      paid: true,
      seconds,
      ratePerSecond: rate.unit === "second" ? rate.amount : null,
      total: null,
      unknown: true,
      budgetCap,
      overBudget: false,
      label:
        "Cost unknown. The still size could not be read, so this billing unit has no number. This is not a vendor quote.",
      billingUnit: rate.unit,
      rate: rate.amount,
      quantity: null,
      projectTotal,
      remainingTotal: null,
      retakeTotal,
      shots: lines,
    };
  }

  const total = remainingTotal ?? 0;
  const quantity = sumQuantity(rate.unit, billed, repeat) ?? 0;
  const overBudget = budgetCap != null && total > budgetCap;
  const formula =
    unitNeedsSize(rate.unit)
      ? " Counted at 24 fps from each still's width and height."
      : "";
  const math = `Your estimate: ${fmtQty(quantity)} ${unitNoun(rate.unit)} × ${fmt(rate.amount)} = ${fmt(total)}.${formula}`;
  const breakdown = `Remaining takes add ${fmt(remainingTotal ?? 0)}. A retake of existing clips would add ${retakeTotal == null ? "unknown" : fmt(retakeTotal)}. Total for every shot is ${projectTotal == null ? "unknown" : fmt(projectTotal)}.`;

  let label: string;
  if (scope === "run") {
    label = overBudget
      ? `Your estimate ${fmt(total)} is over your budget cap ${fmt(budgetCap!)}. This paid run is blocked. ${OWN} ${NO_TABLE}`
      : `${math} ${OWN} ${NO_TABLE}`;
  } else if (billed.length === 0) {
    const extra = retakeTotal != null && retakeTotal > 0 ? ` A retake of existing clips would add ${fmt(retakeTotal)}.` : "";
    const all = projectTotal != null && projectTotal > 0 ? ` Total for every shot is ${fmt(projectTotal)}.` : "";
    label = `Nothing new would be sent. No charge is estimated.${extra}${all} ${OWN} ${NO_TABLE}`;
  } else if (overBudget) {
    label = `Your estimate ${fmt(total)} is over your budget cap ${fmt(budgetCap!)}. Paid Render all is blocked. ${breakdown} ${OWN} ${NO_TABLE}`;
  } else {
    label = `${math} ${breakdown} ${OWN} ${NO_TABLE}`;
  }

  return {
    paid: true,
    seconds,
    ratePerSecond: rate.unit === "second" ? rate.amount : null,
    total,
    unknown: false,
    budgetCap,
    overBudget,
    label,
    billingUnit: rate.unit,
    rate: rate.amount,
    quantity,
    projectTotal,
    remainingTotal,
    retakeTotal,
    shots: lines,
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

/**
 * Estimate for one queued run.
 * Unpaid providers report the seconds and no charge. Paid providers use the
 * user's rate, in the billing unit they picked, and the budget cap.
 */
export function quoteRun(opts: {
  seconds: number;
  unpaidLabel: string;
  shots?: Shot[];
  jobs?: readonly Job[];
  repeat?: number;
}): CostEstimate {
  const settings = getSettings();
  const provider = settings.provider;
  const modelName = modelNameFor(provider, settings);
  const seconds = round4(Math.max(0, opts.seconds));
  if (!isPaidProvider(provider)) {
    return {
      paid: false,
      seconds,
      ratePerSecond: null,
      total: 0,
      unknown: false,
      budgetCap: settings.budgetCap,
      overBudget: false,
      label: opts.unpaidLabel,
    };
  }
  const jobs = opts.jobs ?? [];
  const shots = (opts.shots ?? []).map((shot) => shotBill(shot, jobs, true));
  return withCredits(
    buildEstimate({
      provider,
      modelName,
      settings,
      shots,
      seconds: shots.length === 0 ? seconds : undefined,
      repeat: opts.repeat,
      scope: "run",
    }),
    provider,
    seconds
  );
}

/** What a paid Render all would newly send, plus the shot-list totals. */
export function estimateRenderAll(projectId: string): CostEstimate {
  const settings = getSettings();
  const provider = settings.provider;
  const modelName = modelNameFor(provider, settings);
  const jobs = listJobs(projectId);
  const project = getProject(projectId);
  const shots = project ? listShots(projectId) : [];
  let bills: ShotBill[] = [];
  if (isPaidProvider(provider) && project) {
    const plan = projectRenderPlan(
      shots,
      jobs,
      provider,
      (shot) =>
        modelNameFor(
          provider,
          settings,
          provider === "comfyui" ? resolveComfyChoice({ settings, project, shot }) : undefined
        ),
      project.styleBase
    );
    const remaining = new Set(plan.filter((item) => item.action === "run").map((item) => item.shot.id));
    bills = shots.map((shot) => shotBill(shot, jobs, remaining.has(shot.id)));
  }
  const seconds = round4(bills.filter((shot) => shot.remaining).reduce((sum, shot) => sum + shot.durationSec, 0));
  return withCredits(
    buildEstimate({ provider, modelName, seconds, settings, shots: bills, scope: "project" }),
    provider,
    seconds
  );
}
