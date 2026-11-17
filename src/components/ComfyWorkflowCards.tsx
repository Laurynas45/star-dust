"use client";

import type { CustomGraphCard } from "@/lib/custom-workflow";
import { COMFY_WORKFLOW_ORDER, COMFY_WORKFLOWS } from "@/lib/provider-info";
import { ComfyGraphId } from "@/lib/types";

export function ComfyWorkflowCards(props: {
  selected: ComfyGraphId;
  onSelect: (id: ComfyGraphId) => void;
  custom?: readonly CustomGraphCard[];
}) {
  const custom = props.custom ?? [];
  const ready = custom.filter((card) => card.ok);
  const broken = custom.filter((card) => !card.ok);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        {COMFY_WORKFLOW_ORDER.map((id) => {
          const info = COMFY_WORKFLOWS[id];
          const on = props.selected === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => props.onSelect(id)}
              className={`rounded-xl border p-3 text-left ${
                on
                  ? "border-violet-500/60 bg-violet-500/10"
                  : "border-[var(--border)] bg-[var(--panel-2)]"
              }`}
            >
              <span className="text-sm font-medium text-white">{info.title}</span>
              <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">
                <span className="text-violet-200">Good at. </span>
                {info.goodAt}
              </p>
              <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">
                <span className="text-violet-200">Memory. </span>
                {info.memory}
              </p>
              <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">
                <span className="text-violet-200">Default. </span>
                {info.defaults}
              </p>
              <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">
                <span className="text-violet-200">Low-memory preset. </span>
                {info.lowMemory}
              </p>
            </button>
          );
        })}
        {ready.map((card) => {
          const on = props.selected === card.id;
          return (
            <button
              key={card.id}
              type="button"
              onClick={() => props.onSelect(card.id)}
              className={`rounded-xl border p-3 text-left ${
                on
                  ? "border-violet-500/60 bg-violet-500/10"
                  : "border-[var(--border)] bg-[var(--panel-2)]"
              }`}
            >
              <span className="text-sm font-medium text-white">{card.title}</span>
              <p className="mt-1 font-mono text-[10px] text-[var(--muted)]">{card.id}</p>
              <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">
                <span className="text-violet-200">Good at. </span>
                {card.goodAt}
              </p>
              <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">
                <span className="text-violet-200">Memory. </span>
                {card.memory}
              </p>
              <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">
                <span className="text-violet-200">Default. </span>
                {card.defaults}
              </p>
              <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">
                <span className="text-violet-200">Low-memory preset. </span>
                {card.lowMemory}
              </p>
            </button>
          );
        })}
      </div>
      {broken.map((card) => (
        <div key={card.id} className="rounded-xl border border-rose-400/40 bg-rose-500/10 p-3 text-left">
          <p className="text-sm font-medium text-white">{card.id}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-rose-50">
            This mapping is not usable. Star Dust does not fall back to a shipped graph.
          </p>
          {card.errors.map((error) => (
            <p key={error} className="mt-1 text-[11px] leading-relaxed text-rose-50">
              {error}
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}
