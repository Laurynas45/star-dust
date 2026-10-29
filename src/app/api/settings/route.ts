import { NextRequest, NextResponse } from "next/server";
import { studioEnv } from "@/lib/studio-env";
import { getSettings, saveSettings } from "@/lib/storage";
import { AppSettings, BillingUnit, ProviderId, RateTable, StoredRate, isBillingUnit, isComfyWorkflowId } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function withEnv(settings: AppSettings) {
  return { ...settings, env: studioEnv() };
}

export async function GET() {
  return NextResponse.json(withEnv(getSettings()));
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const allowed: ProviderId[] = ["mock", "fal", "replicate", "comfyui"];
  const current = getSettings();
  const patch: Partial<AppSettings> = {};
  if (typeof body.provider === "string" && allowed.includes(body.provider)) {
    patch.provider = body.provider;
  }
  if (typeof body.comfyuiBaseUrl === "string") patch.comfyuiBaseUrl = body.comfyuiBaseUrl.trim();
  if (typeof body.falModel === "string") patch.falModel = body.falModel.trim();
  if (typeof body.replicateModel === "string") patch.replicateModel = body.replicateModel.trim();
  if (isComfyWorkflowId(body.comfyuiWorkflow)) {
    patch.comfyuiWorkflow = body.comfyuiWorkflow;
  }
  if (typeof body.comfyLowMemory === "boolean") patch.comfyLowMemory = body.comfyLowMemory;
  if (body.budgetCap === null || body.budgetCap === "") {
    patch.budgetCap = null;
  } else if (body.budgetCap !== undefined) {
    const cap = Number(body.budgetCap);
    if (!Number.isFinite(cap) || cap < 0) {
      return NextResponse.json({ error: "Budget cap must be a number that is zero or more." }, { status: 400 });
    }
    patch.budgetCap = cap;
  }
  if (body.rateUpdate && typeof body.rateUpdate === "object") {
    const provider = body.rateUpdate.provider;
    const model = typeof body.rateUpdate.model === "string" ? body.rateUpdate.model.trim() : "";
    if ((provider === "fal" || provider === "replicate") && model) {
      const rateProvider: "fal" | "replicate" = provider;
      const rates: RateTable = {
        fal: { ...current.rates.fal },
        replicate: { ...current.rates.replicate },
      };
      const raw = body.rateUpdate.amount !== undefined ? body.rateUpdate.amount : body.rateUpdate.perSecond;
      const unitRaw = body.rateUpdate.unit;
      if (unitRaw !== undefined && !isBillingUnit(unitRaw)) {
        return NextResponse.json(
          {
            error:
              "Billing unit must be per second, per clip, per 1M video tokens, or per megapixel of video.",
          },
          { status: 400 }
        );
      }
      const unit: BillingUnit = isBillingUnit(unitRaw) ? unitRaw : "second";
      if (raw === null || raw === "") {
        delete rates[rateProvider][model];
      } else {
        const rate = Number(raw);
        if (!Number.isFinite(rate) || rate < 0) {
          return NextResponse.json(
            { error: "Rate must be a number that is zero or more." },
            { status: 400 }
          );
        }
        const stored: StoredRate = unit === "second" ? rate : { amount: rate, unit };
        rates[rateProvider][model] = stored;
      }
      patch.rates = rates;
    }
  }
  return NextResponse.json(withEnv(saveSettings(patch)));
}
