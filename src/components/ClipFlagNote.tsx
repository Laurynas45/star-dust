"use client";

import { CLIP_CHECK_HONESTY, type ClipCheck } from "@/lib/types";

export function ClipFlagNote(props: {
  check: ClipCheck | undefined;
  busy?: boolean;
  onInclude?: (include: boolean) => void;
}) {
  const check = props.check;
  if (!check?.flagged) return null;
  return (
    <div className="mt-2 space-y-2 rounded-lg border border-amber-400/40 bg-amber-400/10 p-3" role="status">
      <p className="text-xs leading-relaxed text-amber-50">{check.status}</p>
      {check.includeAnyway && (
        <p className="text-[11px] leading-relaxed text-amber-100">Included in the stitch because you asked.</p>
      )}
      {check.hints.length > 0 && (
        <ol className="list-decimal space-y-1 pl-4 text-[11px] leading-relaxed text-amber-50">
          {check.hints.map((hint) => (
            <li key={hint}>{hint}</li>
          ))}
        </ol>
      )}
      <p className="text-[11px] leading-relaxed text-[var(--muted)]">{CLIP_CHECK_HONESTY}</p>
      {props.onInclude && (
        <button
          type="button"
          className="btn-ghost !px-3 !py-1.5 text-xs"
          disabled={props.busy}
          onClick={() => props.onInclude?.(!check.includeAnyway)}
        >
          {check.includeAnyway ? "Leave it out of the stitch" : "Include in the stitch anyway"}
        </button>
      )}
    </div>
  );
}
