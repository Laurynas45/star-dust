"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { StatusBadge } from "@/components/StatusBadge";
import {
  CAPABILITY,
  CHARACTER_SHEET_HONESTY,
  CLOUD_RISK_NOTE,
  isPaidProvider,
  modelNameFor,
} from "@/lib/provider-info";
import {
  AppSettings,
  CostEstimate,
  Job,
  MAX_SHOT_SECONDS,
  MIN_SHOT_SECONDS,
  MOTION_PRESETS,
  Project,
  ProviderId,
  Shot,
  presetById,
} from "@/lib/types";

type SettingsResponse = AppSettings & {
  env: { hasFalKey: boolean; hasReplicateToken: boolean };
};

type Detail = { project: Project; shots: Shot[]; jobs: Job[] };

type StitchResponse = {
  outputPath: string;
  includedShotIds: string[];
  includedJobIds?: string[];
  skipped: { shotId: string; position: number; reason: string }[];
  kind?: "takes" | "preview";
};

type SkippedShot = {
  shotId: string;
  position: number;
  reason: string;
  jobId?: string;
};

type Pending =
  | { kind: "shot"; shotId: string; force?: boolean }
  | { kind: "all" }
  | { kind: "retry"; jobId: string; provider: ProviderId };

export default function ProjectStudioPage() {
  const params = useParams();
  const projectId = String(params.id);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [ackCost, setAckCost] = useState<CostEstimate | null>(null);
  const [cost, setCost] = useState<CostEstimate | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [stitch, setStitch] = useState<StitchResponse | null>(null);
  const [previewCut, setPreviewCut] = useState<StitchResponse | null>(null);

  const [prompt, setPrompt] = useState("");
  const [presetId, setPresetId] = useState(MOTION_PRESETS[0].id);
  const [durationSec, setDurationSec] = useState(MOTION_PRESETS[0].durationSec);
  const [startImage, setStartImage] = useState<File | null>(null);
  const [endImage, setEndImage] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [savingShot, setSavingShot] = useState(false);

  const load = useCallback(async () => {
    try {
      const [projectRes, settingsRes, costRes] = await Promise.all([
        fetch(`/api/projects/${projectId}`),
        fetch("/api/settings"),
        fetch(`/api/projects/${projectId}/cost`),
      ]);
      if (!projectRes.ok) {
        setDetail(null);
        setError("Project not found");
        return;
      }
      setDetail(await projectRes.json());
      if (settingsRes.ok) setSettings(await settingsRes.json());
      if (costRes.ok) setCost(await costRes.json());
      setError(null);
    } catch {
      setError("Could not load this project");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const jobs = useMemo(() => detail?.jobs ?? [], [detail]);
  const shots = useMemo(() => detail?.shots ?? [], [detail]);
  const hasActive = jobs.some((job) => job.status === "queued" || job.status === "running");

  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => void load(), 1500);
    return () => clearInterval(timer);
  }, [hasActive, load]);

  useEffect(() => {
    if (!startImage) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(startImage);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [startImage]);

  const provider: ProviderId = settings?.provider ?? "mock";
  const modelName = settings ? modelNameFor(provider, settings) : CAPABILITY.mock.title;
  const paid = isPaidProvider(provider);
  const takeClips = useMemo(
    () => jobs.filter((job) => job.kind !== "preview" && job.status === "completed" && job.outputPath),
    [jobs]
  );

  function latestTake(shotId: string): Job | undefined {
    return jobs.find((job) => job.shotId === shotId && job.kind !== "preview");
  }

  function takesFor(shotId: string): Job[] {
    return jobs
      .filter(
        (job) =>
          job.shotId === shotId &&
          job.kind !== "preview" &&
          job.status === "completed" &&
          job.outputPath
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  function stitchChoice(shot: Shot, takes: Job[]): string | undefined {
    if (shot.selectedJobId && takes.some((take) => take.id === shot.selectedJobId)) {
      return shot.selectedJobId;
    }
    return takes[takes.length - 1]?.id;
  }

  async function run(action: Pending, acknowledgeModel?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const body: Record<string, unknown> = {};
    if (acknowledgeModel) body.acknowledgeModel = acknowledgeModel;
    if (action.kind === "shot" && action.force) body.force = true;
    const url =
      action.kind === "all"
        ? `/api/projects/${projectId}/render`
        : action.kind === "shot"
          ? `/api/projects/${projectId}/shots/${action.shotId}/render`
          : `/api/jobs/${action.jobId}/retry`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.cost) setAckCost(data.cost as CostEstimate);
        if (data.needsModelAck && data.modelName) {
          setPending(action);
          setError(data.overBudget ? data.error : null);
          return;
        }
        if (data.overBudget) {
          setPending(action);
          setError(data.error || "Over your budget cap");
          return;
        }
        throw new Error(data.error || "Could not queue the render");
      }
      setPending(null);
      setAckCost(null);
      const skipped = (data.skipped ?? []) as SkippedShot[];
      if ((data.jobs ?? []).length === 0 && skipped.length > 0) {
        setNotice(skipped.map((item) => `Shot ${item.position}: ${item.reason}`).join(" "));
      }
      await load();
      if ((data.jobs ?? []).length > 0) {
        document.getElementById("jobs")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not queue the render");
    } finally {
      setBusy(false);
    }
  }

  function ask(action: Pending) {
    const actionProvider = action.kind === "retry" ? action.provider : provider;
    if (isPaidProvider(actionProvider)) {
      setPending(action);
      return;
    }
    void run(action);
  }

  async function onAddShot(e: React.FormEvent) {
    e.preventDefault();
    if (!startImage) {
      setError("Choose a start image. A shot is one clip from a still.");
      return;
    }
    setSavingShot(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("prompt", prompt);
      form.set("presetId", presetId);
      form.set("durationSec", String(durationSec));
      form.set("startImage", startImage);
      if (endImage) form.set("endImage", endImage);
      const res = await fetch(`/api/projects/${projectId}/shots`, { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not add the shot");
      setPrompt("");
      setStartImage(null);
      setEndImage(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the shot");
    } finally {
      setSavingShot(false);
    }
  }

  async function onPreview() {
    setPreviewing(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/preview`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not start the preview cut");
      const ids = ((data.jobs ?? []) as Job[]).map((job) => job.id);
      const deadline = Date.now() + 180000;
      let finished: Job[] = [];
      while (Date.now() < deadline) {
        const projectRes = await fetch(`/api/projects/${projectId}`);
        if (projectRes.ok) {
          const next = (await projectRes.json()) as Detail;
          setDetail(next);
          finished = next.jobs.filter((job) => ids.includes(job.id));
          const settled = finished.every(
            (job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled"
          );
          if (finished.length === ids.length && settled) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      const ready = finished.filter((job) => job.status === "completed").map((job) => job.id);
      if (ready.length === 0) {
        throw new Error("Preview cut did not finish. Check the job list.");
      }
      const stitchRes = await fetch(`/api/projects/${projectId}/preview/stitch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobIds: ready }),
      });
      const stitchData = await stitchRes.json();
      if (!stitchRes.ok) throw new Error(stitchData.error || "Preview stitch failed");
      setPreviewCut(stitchData);
      document.getElementById("preview-cut")?.scrollIntoView({ behavior: "smooth", block: "start" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the preview cut");
    } finally {
      setPreviewing(false);
    }
  }

  async function onSelectTake(shotId: string, jobId: string) {
    setError(null);
    const res = await fetch(`/api/projects/${projectId}/shots/${shotId}/take`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "Could not choose that take");
      return;
    }
    await load();
  }

  async function onExport() {
    setExporting(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/export`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Stitch failed");
      setStitch(data);
      document.getElementById("stitch")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Stitch failed");
    } finally {
      setExporting(false);
    }
  }

  async function onSheet(file: File | null) {
    if (!file) return;
    setError(null);
    const form = new FormData();
    form.set("image", file);
    const res = await fetch(`/api/projects/${projectId}/character-sheet`, {
      method: "POST",
      body: form,
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "Could not pin the sheet");
      return;
    }
    await load();
  }

  async function clearSheet() {
    await fetch(`/api/projects/${projectId}/character-sheet`, { method: "DELETE" });
    await load();
  }

  if (loading) {
    return <p className="text-sm text-[var(--muted)]">Opening the shot list…</p>;
  }
  if (!detail) {
    return (
      <div className="panel p-8 text-center">
        <p className="text-white">{error || "Project not found"}</p>
        <Link href="/" className="btn-ghost mt-4 inline-flex">
          Back to the studio
        </Link>
      </div>
    );
  }

  const { project } = detail;
  const confirmModel =
    pending?.kind === "retry" && settings
      ? modelNameFor(pending.provider, settings)
      : modelName;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href="/" className="text-xs text-[var(--muted)] hover:text-violet-300">
            ← Studio
          </Link>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <h1 className="text-3xl font-semibold text-white">{project.name}</h1>
            {project.isSample && (
              <span className="rounded-full bg-violet-500/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-violet-200">
                Sample
              </span>
            )}
          </div>
          {project.description && (
            <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">{project.description}</p>
          )}
        </div>
        <p className="max-w-sm text-xs leading-relaxed text-[var(--muted)]">
          <span className="font-medium text-white">{CAPABILITY[provider].title}.</span>{" "}
          {CAPABILITY[provider].label}
        </p>
      </div>

      <section className="grid gap-3 lg:grid-cols-3">
        <article className="panel p-4">
          <p className="font-mono text-[11px] text-violet-300">01 · Shot list</p>
          <h2 className="mt-1 text-lg font-medium text-white">One clip from a still</h2>
          <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
            Start image, optional end image, prompt, duration, preset. This is
            the unit Star Dust renders.
          </p>
        </article>
        <article className="panel flex flex-col p-4">
          <p className="font-mono text-[11px] text-violet-300">02 · Render all</p>
          <h2 className="mt-1 text-lg font-medium text-white">In shot order</h2>
          <p className="mt-1 flex-1 text-xs leading-relaxed text-[var(--muted)]">
            {shots.length === 0
              ? "Add a shot, then run the list."
              : "Skips a shot that already has a matching completed take, and any shot already queued or running."}
          </p>
          <button
            type="button"
            className="btn-primary mt-3 w-full"
            disabled={busy || shots.length === 0 || Boolean(paid && cost?.overBudget)}
            onClick={() => ask({ kind: "all" })}
          >
            {busy ? "Working…" : "Render all"}
          </button>
        </article>
        <article className="panel flex flex-col p-4">
          <p className="font-mono text-[11px] text-violet-300">03 · Export stitch</p>
          <h2 className="mt-1 text-lg font-medium text-white">One mp4, same editor</h2>
          <p className="mt-1 flex-1 text-xs leading-relaxed text-[var(--muted)]">
            ffmpeg joins the take you chose for each shot. The stitch is not a new model.
          </p>
          <button
            type="button"
            className="btn-ghost mt-3 w-full"
            disabled={exporting || takeClips.length === 0}
            onClick={() => void onExport()}
          >
            {exporting ? "Stitching…" : "Export stitch"}
          </button>
        </article>
      </section>

      <section className="panel flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-mono text-[11px] text-emerald-300">Preview cut · free</p>
          <h2 className="mt-1 text-lg font-medium text-white">Watch the whole edit for $0</h2>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-[var(--muted)]">
            Renders every shot with Mock and stitches them. Camera motion on stills, not AI
            motion. Preview clips do not replace or count as the shot&apos;s takes.
          </p>
        </div>
        <button
          type="button"
          className="btn-ghost shrink-0"
          disabled={previewing || busy || shots.length === 0}
          onClick={() => void onPreview()}
        >
          {previewing ? "Previewing…" : "Preview cut"}
        </button>
      </section>

      {paid && (
        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            cost?.overBudget
              ? "border-rose-400/40 bg-rose-500/10 text-rose-50"
              : "border-amber-400/30 bg-amber-400/10 text-amber-50"
          }`}
        >
          <p>
            Next cloud run uses <span className="font-semibold">{modelName}</span>.
          </p>
          <p className="mt-1 text-xs leading-relaxed text-current/80">
            {cost?.label ?? "Cost unknown. No per-second rate is set for this model."}
          </p>
          <p className="mt-1 text-xs text-current/70">{CLOUD_RISK_NOTE}</p>
        </div>
      )}
      {provider === "comfyui" && (
        <div className="rounded-xl border border-sky-400/30 bg-sky-400/10 px-4 py-3 text-sm text-sky-50">
          ComfyUI runs <span className="font-semibold">{modelName}</span>.{" "}
          {settings?.comfyuiWorkflow === "wan"
            ? "This graph reads the prompt and sends the start image, frame count, and size."
            : "This SVD graph does not read the text prompt."}{" "}
          The server must be reachable. This is not a node editor.
        </div>
      )}
      {provider === "mock" && (
        <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-[var(--muted)]">
          Mock is camera motion only — ffmpeg Ken Burns, not AI motion. No key,
          no GPU. A pinned character sheet is not applied to the pixels.
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-[var(--muted)]">
          {notice}
        </div>
      )}

      <section className="panel grid gap-4 p-5 md:grid-cols-[160px_1fr] md:items-center">
        <div className="overflow-hidden rounded-xl bg-black">
          {project.characterSheetPath ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/media/${project.characterSheetPath}`}
              alt="Pinned reference"
              className="aspect-square w-full object-cover"
            />
          ) : (
            <div className="flex aspect-square items-center justify-center px-3 text-center text-xs text-[var(--muted)]">
              No reference pinned
            </div>
          )}
        </div>
        <div>
          <h2 className="text-sm font-semibold text-white">Character sheet</h2>
          <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">{CHARACTER_SHEET_HONESTY}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <label className="btn-ghost cursor-pointer">
              Pin reference
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="sr-only"
                onChange={(e) => void onSheet(e.target.files?.[0] ?? null)}
              />
            </label>
            {project.characterSheetPath && (
              <button type="button" className="btn-ghost" onClick={() => void clearSheet()}>
                Remove
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex items-end justify-between gap-3">
          <h2 className="text-lg font-semibold text-white">Shot list</h2>
          <p className="text-xs text-[var(--muted)]">{shots.length} shots</p>
        </div>

        <form onSubmit={onAddShot} className="panel grid gap-4 p-5 lg:grid-cols-2">
          <div className="space-y-3">
            <div>
              <label className="label" htmlFor="start-image">
                Start image
              </label>
              <input
                id="start-image"
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="block w-full text-sm text-[var(--muted)] file:mr-3 file:rounded-lg file:border-0 file:bg-violet-500/20 file:px-3 file:py-1.5 file:text-violet-100"
                onChange={(e) => setStartImage(e.target.files?.[0] ?? null)}
              />
              {preview && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={preview} alt="Start frame preview" className="mt-3 max-h-48 rounded-lg object-contain" />
              )}
            </div>
            <div>
              <label className="label" htmlFor="end-image">
                End image, optional
              </label>
              <input
                id="end-image"
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="block w-full text-sm text-[var(--muted)] file:mr-3 file:rounded-lg file:border-0 file:bg-white/10 file:px-3 file:py-1.5 file:text-white"
                onChange={(e) => setEndImage(e.target.files?.[0] ?? null)}
              />
              <p className="mt-1 text-[11px] text-[var(--muted)]">
                Mock can crossfade toward it. Cloud calls and the shipped ComfyUI
                workflows say so when they leave it unused.
              </p>
            </div>
          </div>
          <div className="space-y-3">
            <div>
              <label className="label" htmlFor="shot-prompt">
                Prompt
              </label>
              <textarea
                id="shot-prompt"
                className="input min-h-[96px] resize-y"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Lantern light drifts as the camera pushes in."
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="preset">
                  Preset
                </label>
                <select
                  id="preset"
                  className="input"
                  value={presetId}
                  onChange={(e) => {
                    setPresetId(e.target.value);
                    setDurationSec(presetById(e.target.value).durationSec);
                  }}
                >
                  {MOTION_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="duration">
                  Seconds
                </label>
                <input
                  id="duration"
                  className="input"
                  type="number"
                  min={MIN_SHOT_SECONDS}
                  max={MAX_SHOT_SECONDS}
                  step={1}
                  value={durationSec}
                  onChange={(e) => setDurationSec(Number(e.target.value))}
                />
              </div>
            </div>
            <button type="submit" className="btn-primary w-full" disabled={savingShot}>
              {savingShot ? "Adding…" : "Add shot"}
            </button>
          </div>
        </form>

        {shots.length === 0 ? (
          <div className="panel p-8 text-center text-sm text-[var(--muted)]">
            The list is empty. Add a still to start the film.
          </div>
        ) : (
          <ol className="space-y-3">
            {shots.map((shot, index) => {
              const job = latestTake(shot.id);
              const takes = takesFor(shot.id);
              const chosen = stitchChoice(shot, takes);
              const takeBusy = job?.status === "queued" || job?.status === "running";
              const preset = presetById(shot.presetId);
              return (
                <li key={shot.id} className="panel grid gap-4 p-4 sm:grid-cols-[140px_1fr]">
                  <div className="overflow-hidden rounded-lg bg-black">
                    {shot.startImagePath ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`/api/media/${shot.startImagePath}`}
                        alt=""
                        className="aspect-video w-full object-cover"
                      />
                    ) : (
                      <div className="flex aspect-video items-center justify-center text-xs text-[var(--muted)]">
                        No still
                      </div>
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[11px] text-violet-300">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="text-xs text-[var(--muted)]">
                        {preset.label} · {shot.durationSec}s
                        {shot.endImagePath ? " · end still" : ""}
                      </span>
                      {job && <StatusBadge status={job.status} />}
                    </div>
                    <p className="mt-2 text-sm text-white">{shot.prompt}</p>
                    {takes.length > 0 && (
                      <fieldset className="mt-3 space-y-1">
                        <legend className="text-[11px] uppercase tracking-wide text-[var(--muted)]">
                          Takes kept on disk. Stitch uses the one you pick.
                        </legend>
                        {takes.map((take, takeIndex) => (
                          <label key={take.id} className="flex items-center gap-2 text-xs text-[var(--muted)]">
                            <input
                              type="radio"
                              name={`take-${shot.id}`}
                              checked={chosen === take.id}
                              onChange={() => void onSelectTake(shot.id, take.id)}
                            />
                            <span className="text-white">
                              Take {takeIndex + 1}
                              {chosen === take.id ? " · in the stitch" : ""}
                            </span>
                            <span className="truncate">{take.modelName || take.provider}</span>
                          </label>
                        ))}
                      </fieldset>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="btn-primary !px-3 !py-1.5"
                        disabled={busy || takeBusy}
                        onClick={() => ask({ kind: "shot", shotId: shot.id })}
                      >
                        Render
                      </button>
                      {takes.length > 0 && (
                        <button
                          type="button"
                          className="btn-ghost !px-3 !py-1.5"
                          disabled={busy || takeBusy}
                          onClick={() => ask({ kind: "shot", shotId: shot.id, force: true })}
                        >
                          Re-render
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn-ghost !px-3 !py-1.5"
                        disabled={index === 0}
                        onClick={async () => {
                          await fetch(`/api/projects/${projectId}/shots/${shot.id}/move`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ direction: "up" }),
                          });
                          await load();
                        }}
                      >
                        Up
                      </button>
                      <button
                        type="button"
                        className="btn-ghost !px-3 !py-1.5"
                        disabled={index === shots.length - 1}
                        onClick={async () => {
                          await fetch(`/api/projects/${projectId}/shots/${shot.id}/move`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ direction: "down" }),
                          });
                          await load();
                        }}
                      >
                        Down
                      </button>
                      <button
                        type="button"
                        className="btn-ghost !px-3 !py-1.5"
                        onClick={async () => {
                          if (!confirm("Remove this shot from the list?")) return;
                          await fetch(`/api/projects/${projectId}/shots/${shot.id}`, {
                            method: "DELETE",
                          });
                          await load();
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section id="jobs" className="space-y-3">
        <h2 className="text-lg font-semibold text-white">Jobs</h2>
        <div className="panel overflow-hidden">
          {jobs.length === 0 ? (
            <p className="p-8 text-center text-sm text-[var(--muted)]">
              No jobs yet. Render a shot to fill the queue.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {jobs.map((job) => (
                <li key={job.id} className="space-y-2 px-4 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={job.status} />
                    <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">
                      {job.kind === "preview" ? "Preview" : "Take"} · {CAPABILITY[job.provider].title}
                    </span>
                    {typeof job.progress === "number" &&
                      (job.status === "running" || job.status === "queued") && (
                        <span className="text-xs text-sky-300">{job.progress}%</span>
                      )}
                  </div>
                  {job.modelName && (
                    <p className="text-sm text-white">
                      Model <span className="font-medium">{job.modelName}</span>
                    </p>
                  )}
                  <p className="text-sm text-[var(--muted)]">{job.prompt}</p>
                  {job.providerNote && (
                    <p className="text-xs leading-relaxed text-[var(--muted)]">{job.providerNote}</p>
                  )}
                  {job.characterNote && (
                    <p className="text-xs leading-relaxed text-amber-100/80">{job.characterNote}</p>
                  )}
                  {job.error && <p className="text-xs text-rose-300">{job.error}</p>}
                  {(job.status === "running" || job.status === "queued") && (
                    <div className="h-1 overflow-hidden rounded-full bg-white/10">
                      <div
                        className="h-full bg-sky-400"
                        style={{ width: `${Math.max(4, job.progress ?? 4)}%` }}
                      />
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {(job.status === "queued" || job.status === "running") && (
                      <button
                        type="button"
                        className="btn-ghost !px-3 !py-1.5 text-xs"
                        onClick={async () => {
                          await fetch(`/api/jobs/${job.id}/cancel`, { method: "POST" });
                          await load();
                        }}
                      >
                        Cancel
                      </button>
                    )}
                    {job.status !== "queued" && job.status !== "running" && (
                      <button
                        type="button"
                        className="btn-ghost !px-3 !py-1.5 text-xs"
                        onClick={() => ask({ kind: "retry", jobId: job.id, provider: job.provider })}
                      >
                        Retry
                      </button>
                    )}
                    {job.status === "completed" && job.outputPath && (
                      <a className="btn-ghost !px-3 !py-1.5 text-xs" href={`/api/media/${job.outputPath}`} download>
                        Download
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section id="preview-cut" className="space-y-3">
        <h2 className="text-lg font-semibold text-white">Preview cut</h2>
        {previewCut ? (
          <article className="panel overflow-hidden">
            <video
              className="aspect-video w-full bg-black"
              src={`/api/media/${previewCut.outputPath}`}
              controls
              playsInline
            />
            <div className="space-y-2 p-4">
              <p className="text-sm text-white">
                Camera motion on stills, not AI motion. {previewCut.includedShotIds.length} shot
                {previewCut.includedShotIds.length === 1 ? "" : "s"}. This is not a take.
              </p>
              <a className="btn-ghost inline-flex" href={`/api/media/${previewCut.outputPath}`} download>
                Download preview mp4
              </a>
            </div>
          </article>
        ) : (
          <div className="panel p-6 text-sm text-[var(--muted)]">
            Preview cut plays the whole list with Mock for $0. It does not replace the takes
            Export stitch uses.
          </div>
        )}
      </section>

      <section id="stitch" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-lg font-semibold text-white">Gallery</h2>
          <a
            className={`btn-ghost text-xs ${takeClips.length === 0 ? "pointer-events-none opacity-40" : ""}`}
            href={`/api/projects/${projectId}/gallery`}
          >
            Download all zip
          </a>
        </div>
        {stitch && (
          <article className="panel overflow-hidden">
            <video
              className="aspect-video w-full bg-black"
              src={`/api/media/${stitch.outputPath}`}
              controls
              playsInline
            />
            <div className="space-y-2 p-4">
              <p className="text-sm text-white">
                Stitch of {stitch.includedShotIds.length} completed shot
                {stitch.includedShotIds.length === 1 ? "" : "s"}.
              </p>
              {stitch.skipped.length > 0 && (
                <p className="text-xs text-[var(--muted)]">
                  {stitch.skipped.map((item) => `Shot ${item.position}: ${item.reason}`).join(" · ")}
                </p>
              )}
              <a className="btn-primary inline-flex" href={`/api/media/${stitch.outputPath}`} download>
                Download stitched mp4
              </a>
            </div>
          </article>
        )}
        {takeClips.length === 0 ? (
          <div className="panel p-8 text-center text-sm text-[var(--muted)]">
            Completed takes show up here. Preview clips stay out of this gallery.
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {takeClips.map((job) => (
              <article key={job.id} className="panel overflow-hidden">
                <video
                  className="aspect-video w-full bg-black"
                  src={`/api/media/${job.outputPath}`}
                  controls
                  playsInline
                  preload="metadata"
                />
                <div className="space-y-2 p-4">
                  <p className="line-clamp-2 text-sm text-white">{job.prompt}</p>
                  <p className="text-[11px] text-[var(--muted)]">
                    {job.modelName || CAPABILITY[job.provider].label}
                  </p>
                  <a
                    className="btn-ghost !py-1 text-xs"
                    href={`/api/media/${job.outputPath}`}
                    download={`${job.id}.mp4`}
                  >
                    Download mp4
                  </a>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {pending && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center">
          <div className="panel w-full max-w-md p-5" role="dialog" aria-modal="true" aria-labelledby="model-title">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-200">
              Cloud image-to-video
            </p>
            <h2 id="model-title" className="mt-2 text-xl font-semibold text-white">
              {confirmModel}
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">{CLOUD_RISK_NOTE}</p>
            {pending.kind === "all" && (
              <p className="mt-3 text-sm leading-relaxed text-white">
                {(ackCost ?? cost)?.label ??
                  "Cost unknown. No per-second rate is set for this model. This is not a vendor quote."}
              </p>
            )}
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  setPending(null);
                  setAckCost(null);
                }}
                disabled={busy}
              >
                Back
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={busy || Boolean(pending.kind === "all" && (ackCost ?? cost)?.overBudget)}
                onClick={() => void run(pending, confirmModel)}
              >
                {busy ? "Queuing…" : "Run this model"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
