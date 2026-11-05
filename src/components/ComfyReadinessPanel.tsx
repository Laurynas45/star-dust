"use client";

import type { ComfyServerCheck } from "@/lib/comfy-readiness";
import type { ComfyWorkflowId } from "@/lib/types";

type Shown = ComfyServerCheck & { workflows: ComfyServerCheck["workflows"] };

export function ComfyReadinessPanel(props: {
  report: Shown | null;
  checking?: boolean;
  onRecheck?: () => void;
}) {
  const report = props.report;
  return (
    <div className="mt-3 space-y-2" role="status" aria-label="ComfyUI check">
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[11px] text-violet-300">ComfyUI check</p>
        {props.onRecheck && (
          <button type="button" className="text-[11px] text-violet-200 underline" onClick={props.onRecheck}>
            {props.checking ? "Checking…" : "Check again"}
          </button>
        )}
      </div>
      {props.checking && !report && (
        <p className="text-[11px] leading-relaxed text-[var(--muted)]">Checking the server…</p>
      )}
      {report && (
        <>
          <p className="text-[11px] leading-relaxed text-[var(--muted)]">{report.honesty}</p>
          <p
            className={`text-[11px] leading-relaxed ${
              report.blocksQueue ? "text-rose-100" : "text-[var(--muted)]"
            }`}
          >
            {report.message}
          </p>
          {report.workflows.map((workflow) => {
            const issues = [...workflow.missingNodes, ...workflow.missingModels];
            const notes = workflow.vaeWarnings;
            const warnOnly = workflow.ok && notes.length > 0;
            return (
              <div
                key={workflow.id}
                className={`rounded-lg border px-2.5 py-2 ${
                  workflow.ok
                    ? warnOnly
                      ? "border-amber-400/40 bg-amber-500/10"
                      : "border-white/10 bg-white/5"
                    : "border-rose-400/40 bg-rose-500/10"
                }`}
              >
                <p className="text-[11px] leading-relaxed text-white">
                  {workflow.title}
                  <span className="text-[var(--muted)]"> · {workflow.file}</span>
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">
                  {workflow.ok
                    ? "Can run on this server. This is not a promise about the picture."
                    : "Would not run. A render that uses this graph is refused before the shot is queued."}
                </p>
                {issues.map((issue) => (
                  <p
                    key={`${issue.kind}:${issue.classType}:${issue.nodeId}:${issue.input ?? ""}:${issue.filename ?? ""}`}
                    className="mt-1 text-[11px] leading-relaxed text-rose-50"
                  >
                    {issue.nextStep}
                  </p>
                ))}
                {notes.map((issue) => (
                  <p
                    key={`${issue.kind}:${issue.filename ?? ""}:${issue.nextStep}`}
                    className="mt-1 text-[11px] leading-relaxed text-amber-50"
                  >
                    {issue.nextStep}
                  </p>
                ))}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

export function ShotComfyNote(props: { report: Shown | null; workflow: ComfyWorkflowId }) {
  const row = props.report?.workflows.find((item) => item.id === props.workflow);
  if (!row) return null;
  if (!row.ok) {
    const first = [...row.missingNodes, ...row.missingModels][0];
    return (
      <p className="mt-2 text-[11px] leading-relaxed text-rose-100">
        ComfyUI check: {row.title} would not run, so a render of this shot is refused.
        {first ? ` ${first.nextStep}` : ""}
      </p>
    );
  }
  const note = row.vaeWarnings[0];
  if (!note) return null;
  return <p className="mt-2 text-[11px] leading-relaxed text-amber-100">ComfyUI check: {note.nextStep}</p>;
}
