"use client";

import { COMFY_WORKFLOW_ORDER, COMFY_WORKFLOWS } from "@/lib/provider-info";
import { ComfyWorkflowId } from "@/lib/types";

export function ComfyWorkflowCards(props: {
  selected: ComfyWorkflowId;
  onSelect: (id: ComfyWorkflowId) => void;
}) {
  return (
    <div className="grid gap-2 lg:grid-cols-3">
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
    </div>
  );
}
