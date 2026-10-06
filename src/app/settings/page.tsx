"use client";

import { useEffect, useState } from "react";
import { CAPABILITY, CLOUD_RISK_NOTE, COMFY_WORKFLOWS } from "@/lib/provider-info";
import { AppSettings, ComfyWorkflowId, ProviderId } from "@/lib/types";

type SettingsResponse = AppSettings & {
  env: { hasFalKey: boolean; hasReplicateToken: boolean };
};

const ORDER: ProviderId[] = ["mock", "fal", "replicate", "comfyui"];

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [probeMsg, setProbeMsg] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/settings")
      .then((res) => {
        if (!res.ok) throw new Error("load");
        return res.json();
      })
      .then(setSettings)
      .catch(() => setError("Could not load providers."));
  }, []);

  async function save(patch: Record<string, unknown>) {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "save");
      setSettings((prev) =>
        prev
          ? { ...prev, ...data }
          : { ...data, env: data.env ?? { hasFalKey: false, hasReplicateToken: false } }
      );
      setMessage("Saved");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function probe() {
    if (!settings) return;
    setProbeMsg("Checking the server…");
    const res = await fetch("/api/comfyui/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: settings.comfyuiBaseUrl }),
    });
    const data = await res.json();
    setProbeMsg(data.message);
  }

  function saveRate(provider: "fal" | "replicate", model: string, raw: string) {
    const trimmed = raw.trim();
    if (trimmed !== "" && (!Number.isFinite(Number(trimmed)) || Number(trimmed) < 0)) {
      setMessage("Per-second rate must be a number that is zero or more.");
      return;
    }
    void save({
      rateUpdate: {
        provider,
        model,
        perSecond: trimmed === "" ? null : Number(trimmed),
      },
    });
  }

  if (error) return <p className="text-sm text-rose-300">{error}</p>;
  if (!settings) return <p className="text-sm text-[var(--muted)]">Loading providers…</p>;

  const falRate = settings.rates.fal[settings.falModel];
  const replicateRate = settings.rates.replicate[settings.replicateModel];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-semibold text-white">Providers</h1>
        <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">
          Mock is the default and needs no key. API keys live in{" "}
          <code className="text-violet-300">.env.local</code> only — never in
          this page and never in the database. Per-second rates are plain
          settings you type yourself.
        </p>
      </div>

      <section className="grid gap-3 sm:grid-cols-2">
        {ORDER.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => save({ provider: id })}
            className={`rounded-2xl border p-4 text-left transition ${
              settings.provider === id
                ? "border-violet-500/60 bg-violet-500/10"
                : "border-[var(--border)] bg-[var(--panel)] hover:border-violet-500/30"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-white">{CAPABILITY[id].title}</span>
              {settings.provider === id && (
                <span className="text-[10px] uppercase tracking-wide text-violet-300">Active</span>
              )}
            </div>
            <p className="mt-2 text-xs leading-relaxed text-[var(--muted)]">{CAPABILITY[id].label}</p>
          </button>
        ))}
      </section>
      {message && <p className="text-xs text-emerald-300">{saving ? "Saving…" : message}</p>}

      <section className="panel space-y-3 p-6">
        <h2 className="text-sm font-semibold text-violet-200">Keys</h2>
        <ul className="space-y-2 text-sm">
          <li className="flex items-center justify-between rounded-lg bg-[var(--panel-2)] px-3 py-2">
            <code className="text-violet-300">FAL_KEY</code>
            <span className={settings.env.hasFalKey ? "text-emerald-300" : "text-rose-300"}>
              {settings.env.hasFalKey ? "Present" : "Missing"}
            </span>
          </li>
          <li className="flex items-center justify-between rounded-lg bg-[var(--panel-2)] px-3 py-2">
            <code className="text-violet-300">REPLICATE_API_TOKEN</code>
            <span className={settings.env.hasReplicateToken ? "text-emerald-300" : "text-rose-300"}>
              {settings.env.hasReplicateToken ? "Present" : "Missing"}
            </span>
          </li>
        </ul>
        <p className="text-xs leading-relaxed text-[var(--muted)]">{CLOUD_RISK_NOTE}</p>
      </section>

      <section className="panel space-y-4 p-6">
        <h2 className="text-sm font-semibold text-violet-200">Your rates</h2>
        <p className="text-xs leading-relaxed text-[var(--muted)]">
          Enter a per-second rate for the fal or Replicate model you selected.
          Star Dust multiplies shot seconds by that number before a paid Render
          all. It is your own estimate, not a vendor quote. Leave a rate blank
          and the cost stays unknown. An optional budget cap blocks a paid
          Render all whose estimate is over it.
        </p>
        <div>
          <label className="label" htmlFor="fal-rate">
            fal per-second rate
          </label>
          <input
            id="fal-rate"
            className="input"
            type="number"
            min={0}
            step="0.01"
            placeholder="Blank if unknown"
            value={falRate === undefined ? "" : String(falRate)}
            onChange={(e) => {
              const rates = {
                fal: { ...settings.rates.fal },
                replicate: { ...settings.rates.replicate },
              };
              if (e.target.value.trim() === "") delete rates.fal[settings.falModel];
              else rates.fal[settings.falModel] = Number(e.target.value);
              setSettings({ ...settings, rates });
            }}
            onBlur={(e) => saveRate("fal", settings.falModel, e.target.value)}
          />
          <p className="mt-1 text-[11px] text-[var(--muted)]">For {settings.falModel}</p>
        </div>
        <div>
          <label className="label" htmlFor="replicate-rate">
            Replicate per-second rate
          </label>
          <input
            id="replicate-rate"
            className="input"
            type="number"
            min={0}
            step="0.01"
            placeholder="Blank if unknown"
            value={replicateRate === undefined ? "" : String(replicateRate)}
            onChange={(e) => {
              const rates = {
                fal: { ...settings.rates.fal },
                replicate: { ...settings.rates.replicate },
              };
              if (e.target.value.trim() === "") delete rates.replicate[settings.replicateModel];
              else rates.replicate[settings.replicateModel] = Number(e.target.value);
              setSettings({ ...settings, rates });
            }}
            onBlur={(e) => saveRate("replicate", settings.replicateModel, e.target.value)}
          />
          <p className="mt-1 text-[11px] text-[var(--muted)]">For {settings.replicateModel}</p>
        </div>
        <div>
          <label className="label" htmlFor="budget-cap">
            Budget cap, optional
          </label>
          <input
            id="budget-cap"
            className="input"
            type="number"
            min={0}
            step="0.01"
            placeholder="No cap"
            value={settings.budgetCap == null ? "" : String(settings.budgetCap)}
            onChange={(e) =>
              setSettings({
                ...settings,
                budgetCap: e.target.value.trim() === "" ? null : Number(e.target.value),
              })
            }
            onBlur={(e) => {
              const raw = e.target.value.trim();
              if (raw === "") {
                void save({ budgetCap: null });
                return;
              }
              const cap = Number(raw);
              if (!Number.isFinite(cap) || cap < 0) {
                setMessage("Budget cap must be a number that is zero or more.");
                return;
              }
              void save({ budgetCap: cap });
            }}
          />
        </div>
      </section>

      <section className="panel space-y-4 p-6">
        <h2 className="text-sm font-semibold text-violet-200">Model and server</h2>
        <p className="text-xs text-[var(--muted)]">
          The model name is shown again before a fal or Replicate job starts.
          Star Dust does not fetch a vendor price.
        </p>
        <div>
          <label className="label" htmlFor="fal-model">
            fal model
          </label>
          <input
            id="fal-model"
            className="input"
            value={settings.falModel}
            onChange={(e) => setSettings({ ...settings, falModel: e.target.value })}
            onBlur={() => save({ falModel: settings.falModel })}
          />
        </div>
        <div>
          <label className="label" htmlFor="replicate-model">
            Replicate model
          </label>
          <input
            id="replicate-model"
            className="input"
            value={settings.replicateModel}
            onChange={(e) => setSettings({ ...settings, replicateModel: e.target.value })}
            onBlur={() => save({ replicateModel: settings.replicateModel })}
          />
        </div>
        <div>
          <p className="label">ComfyUI workflow</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {(Object.keys(COMFY_WORKFLOWS) as ComfyWorkflowId[]).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => save({ comfyuiWorkflow: id })}
                className={`rounded-xl border p-3 text-left ${
                  settings.comfyuiWorkflow === id
                    ? "border-violet-500/60 bg-violet-500/10"
                    : "border-[var(--border)] bg-[var(--panel-2)]"
                }`}
              >
                <span className="text-sm font-medium text-white">{COMFY_WORKFLOWS[id].title}</span>
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">
                  {COMFY_WORKFLOWS[id].detail}
                </p>
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="label" htmlFor="comfy-url">
            ComfyUI base URL
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="comfy-url"
              className="input"
              value={settings.comfyuiBaseUrl}
              onChange={(e) => setSettings({ ...settings, comfyuiBaseUrl: e.target.value })}
              onBlur={() => save({ comfyuiBaseUrl: settings.comfyuiBaseUrl })}
            />
            <button type="button" className="btn-ghost shrink-0" onClick={() => void probe()}>
              Check server
            </button>
          </div>
          <p className="mt-2 text-xs text-[var(--muted)]">
            Star Dust posts <code>{COMFY_WORKFLOWS[settings.comfyuiWorkflow].file}</code>, polls{" "}
            <code>/history</code>, and downloads the video. If the server is down,
            the job fails with the URL and status.
          </p>
          {probeMsg && <p className="mt-2 text-xs text-white">{probeMsg}</p>}
        </div>
      </section>

      <p className="text-xs text-[var(--muted)]">
        This release is the local studio. Accounts and billing are not wired up.
      </p>
    </div>
  );
}
