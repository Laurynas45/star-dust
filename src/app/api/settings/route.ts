import { NextRequest, NextResponse } from "next/server";
import { getSettings, saveSettings } from "@/lib/storage";
import { AppSettings, ComfyWorkflowId, ProviderId, RateTable } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function withEnv(settings: AppSettings) {
  return {
    ...settings,
    env: {
      hasFalKey: Boolean(process.env.FAL_KEY),
      hasReplicateToken: Boolean(process.env.REPLICATE_API_TOKEN),
    },
  };
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
  if (body.comfyuiWorkflow === "svd" || body.comfyuiWorkflow === "wan") {
    patch.comfyuiWorkflow = body.comfyuiWorkflow as ComfyWorkflowId;
  }
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
      const raw = body.rateUpdate.perSecond;
      if (raw === null || raw === "") {
        delete rates[rateProvider][model];
      } else {
        const rate = Number(raw);
        if (!Number.isFinite(rate) || rate < 0) {
          return NextResponse.json(
            { error: "Per-second rate must be a number that is zero or more." },
            { status: 400 }
          );
        }
        rates[rateProvider][model] = rate;
      }
      patch.rates = rates;
    }
  }
  return NextResponse.json(withEnv(saveSettings(patch)));
}
