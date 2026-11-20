"use client";

import { useState } from "react";
import { parseLoraList, MAX_LORAS, LORA_STRENGTH_MAX, LORA_STRENGTH_MIN } from "@/lib/loras";
import type { LoraRef } from "@/lib/types";

export function LoraEditor(props: {
  loras: LoraRef[];
  allowInherit?: boolean;
  inherited?: boolean;
  projectLoras?: LoraRef[];
  missingNames?: readonly string[];
  inactiveNote?: string;
  hint?: string;
  onChange: (next: LoraRef[] | null) => void;
}) {
  const [draftName, setDraftName] = useState("");
  const [draftStrength, setDraftStrength] = useState("1");
  const [error, setError] = useState<string | null>(null);
  const missing = new Set(props.missingNames ?? []);
  const shown = props.inherited ? props.projectLoras ?? [] : props.loras;

  function commit(next: LoraRef[] | null) {
    setError(null);
    props.onChange(next);
  }

  function addDraft() {
    const strength = draftStrength.trim() === "" ? 1 : Number(draftStrength);
    const parsed = parseLoraList([...props.loras, { name: draftName, strength }], "loras");
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setDraftName("");
    setDraftStrength("1");
    commit(parsed.loras);
  }

  function editRow(index: number, name: string, strengthText: string) {
    const strength = strengthText.trim() === "" ? 1 : Number(strengthText);
    const next = props.loras.map((lora, item) => (item === index ? { name, strength } : lora));
    const parsed = parseLoraList(next, "loras");
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    commit(parsed.loras);
  }

  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-sky-50/90">LoRAs</p>
        {props.allowInherit && (
          <button
            type="button"
            className="text-[11px] text-sky-100 underline"
            onClick={() => commit(props.inherited ? [...(props.projectLoras ?? [])] : null)}
          >
            {props.inherited ? "Set LoRAs on this shot" : "Use project LoRAs"}
          </button>
        )}
      </div>
      {props.inactiveNote && <p className="text-[11px] leading-relaxed text-sky-50/70">{props.inactiveNote}</p>}
      {props.hint && <p className="text-[11px] leading-relaxed text-sky-50/70">{props.hint}</p>}
      {shown.length === 0 && (
        <p className="text-[11px] leading-relaxed text-sky-50/70">
          {props.inherited ? "The project has no LoRAs." : "No LoRAs."}
        </p>
      )}
      {shown.map((lora, index) => (
        <div key={`${index}:${lora.name}:${lora.strength}`} className="flex flex-wrap items-end gap-2">
          <label className="min-w-[12rem] flex-1 text-[11px] text-sky-50/80">
            File name
            <input
              className="input mt-1"
              defaultValue={lora.name}
              disabled={props.inherited}
              onBlur={(event) => {
                if (props.inherited) return;
                if (event.target.value === lora.name) return;
                editRow(index, event.target.value, String(lora.strength));
              }}
            />
          </label>
          <label className="w-24 text-[11px] text-sky-50/80">
            Strength
            <input
              className="input mt-1"
              type="number"
              min={LORA_STRENGTH_MIN}
              max={LORA_STRENGTH_MAX}
              step={0.05}
              defaultValue={lora.strength}
              disabled={props.inherited}
              onBlur={(event) => {
                if (props.inherited) return;
                if (Number(event.target.value) === lora.strength) return;
                editRow(index, lora.name, event.target.value);
              }}
            />
          </label>
          {!props.inherited && (
            <button
              type="button"
              className="btn-ghost !px-2 !py-1 text-[11px]"
              onClick={() => commit(props.loras.filter((_, item) => item !== index))}
            >
              Remove
            </button>
          )}
          {missing.has(lora.name) && (
            <p className="w-full text-[11px] leading-relaxed text-rose-100">
              {lora.name} is not in LoraLoaderModelOnly lora_name. The render does not start.
            </p>
          )}
        </div>
      ))}
      {!props.inherited && props.loras.length < MAX_LORAS && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[12rem] flex-1 text-[11px] text-sky-50/80">
            Add file name
            <input
              className="input mt-1"
              value={draftName}
              placeholder="style.safetensors"
              onChange={(event) => setDraftName(event.target.value)}
            />
          </label>
          <label className="w-24 text-[11px] text-sky-50/80">
            Strength
            <input
              className="input mt-1"
              type="number"
              min={LORA_STRENGTH_MIN}
              max={LORA_STRENGTH_MAX}
              step={0.05}
              value={draftStrength}
              onChange={(event) => setDraftStrength(event.target.value)}
            />
          </label>
          <button type="button" className="btn-ghost !px-2 !py-1 text-[11px]" onClick={addDraft}>
            Add
          </button>
        </div>
      )}
      {error && <p className="text-[11px] leading-relaxed text-rose-100">{error}</p>}
    </div>
  );
}
