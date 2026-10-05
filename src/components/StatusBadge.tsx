import { JobStatus } from "@/lib/types";

const styles: Record<JobStatus, string> = {
  queued: "bg-slate-500/20 text-slate-300",
  running: "bg-sky-500/20 text-sky-300",
  completed: "bg-emerald-500/20 text-emerald-300",
  failed: "bg-rose-500/20 text-rose-300",
  cancelled: "bg-amber-500/15 text-amber-200",
};

export function StatusBadge({ status }: { status: JobStatus }) {
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${styles[status]}`}
    >
      {status}
    </span>
  );
}
