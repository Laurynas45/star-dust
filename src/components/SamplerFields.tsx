"use client";

import { useState } from "react";
import { CFG_MAX, CFG_MIN, STEPS_MAX, STEPS_MIN, parseCfgValue, parseStepsValue } from "@/lib/sampler";

/**
 * Empty means unset: the project keeps the graph default, and a shot keeps the project value.
 */
export function SamplerFields(props: {
  steps: number | null;
  cfg: number | null;
  stepsPlaceholder: string;
  cfgPlaceholder: string;
  hint: string;
  onChange: (patch: { steps: number | null } | { cfg: number | null }) => void;
}) {
  const [stepsError, setStepsError] = useState<string | null>(null);
  const [cfgError, setCfgError] = useState<string | null>(null);
  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-[11px] text-[var(--muted)]">
          Steps
          <input
            key={`steps:${props.steps ?? "default"}`}
            className="input mt-1 w-28"
            type="number"
            inputMode="numeric"
            min={STEPS_MIN}
            max={STEPS_MAX}
            step={1}
            placeholder={props.stepsPlaceholder}
            defaultValue={props.steps ?? ""}
            onBlur={(event) => {
              const raw = event.target.value.trim();
              if (raw === "") {
                setStepsError(null);
                if (props.steps != null) props.onChange({ steps: null });
                return;
              }
              const parsed = parseStepsValue(raw, "steps", { allowString: true });
              if (!parsed.ok) {
                setStepsError(parsed.error);
                return;
              }
              setStepsError(null);
              if (parsed.steps !== props.steps) props.onChange({ steps: parsed.steps });
            }}
          />
        </label>
        <label className="text-[11px] text-[var(--muted)]">
          CFG
          <input
            key={`cfg:${props.cfg ?? "default"}`}
            className="input mt-1 w-28"
            type="number"
            inputMode="decimal"
            min={CFG_MIN}
            max={CFG_MAX}
            step="any"
            placeholder={props.cfgPlaceholder}
            defaultValue={props.cfg ?? ""}
            onBlur={(event) => {
              const raw = event.target.value.trim();
              if (raw === "") {
                setCfgError(null);
                if (props.cfg != null) props.onChange({ cfg: null });
                return;
              }
              const parsed = parseCfgValue(raw, "cfg", { allowString: true });
              if (!parsed.ok) {
                setCfgError(parsed.error);
                return;
              }
              setCfgError(null);
              if (parsed.cfg !== props.cfg) props.onChange({ cfg: parsed.cfg });
            }}
          />
        </label>
      </div>
      {stepsError && <p className="mt-1 text-[11px] leading-relaxed text-amber-100">{stepsError}</p>}
      {cfgError && <p className="mt-1 text-[11px] leading-relaxed text-amber-100">{cfgError}</p>}
      <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">{props.hint}</p>
    </div>
  );
}
