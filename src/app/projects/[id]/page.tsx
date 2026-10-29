"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { StatusBadge } from "@/components/StatusBadge";
import { chainDepth, chainDepthLabel, chainDepthNote } from "@/lib/chain-depth";
import { chainStaleShotIds } from "@/lib/chain-stale";
import { reviewStitchPasses } from "@/lib/mixed-pass";
import { resolveComfyChoice } from "@/lib/comfy-choice";
import {
  CAPABILITY,
  CHARACTER_SHEET_HONESTY,
  CLOUD_RISK_NOTE,
  COMFY_WORKFLOW_ORDER,
  COMFY_WORKFLOWS,
  WAN_FLF_MISSING_END,
  isPaidProvider,
  modelNameFor,
} from "@/lib/provider-info";
import {
  APPROVE_HONESTY,
  APPROVED_LABEL,
  CONFORM_HONESTY,
  FINISH_HONESTY,
  FinishView,
  APPROVED_MISMATCH_NOTE,
  EDIT_EXPORT_HONESTY,
  AppSettings,
  CHAIN_FRAME_BACK_CHOICES,
  CHAIN_HONESTY,
  CHAIN_STALE_NOTE,
  CHAIN_TRIM_START_CHOICES,
  ComfyWorkflowId,
  CostEstimate,
  ShotCostLine,
  FRAME_BACK_HONESTY,
  HUNT_NOTE,
  HUNT_SEED_CHOICES,
  HuntSeedCount,
  Job,
  MAX_SHOT_SECONDS,
  MIN_SHOT_SECONDS,
  MOTION_PRESETS,
  MUSIC_FADE_CHOICES,
  MUSIC_LEVEL_CHOICES,
  CaptionMode,
  Project,
  ProviderId,
  REUSE_HONESTY,
  REUSE_LABEL,
  RETAKE_NOTE,
  SEAM_FADE_CHOICES,
  SEAM_FRAME_HONESTY,
  SEAM_HONESTY,
  SEAM_PREVIEW_HONESTY,
  STYLE_BASE_HONESTY,
  SeamMode,
  Shot,
  chainFramePhrase,
  chainTrimChoiceLabel,
  effectivePrompt,
  presetById,
  styleBaseText,
} from "@/lib/types";

type SettingsResponse = AppSettings & {
  env: { hasFalKey: boolean; hasReplicateToken: boolean };
};

type StudioShot = Shot & { currentInputKey?: string; approvedMismatch?: boolean };

type Detail = {
  project: Project;
  shots: StudioShot[];
  jobs: Job[];
  conform?: {
    summary: string;
    shots: { shotId: string; label: string | null }[];
  };
  finish?: FinishView;
  previewFinish?: FinishView;
};

const OUTPUT_FPS_CHOICES = [16, 24, 25, 30] as const;
const OUTPUT_SIZE_CHOICES = [
  [1280, 720],
  [1920, 1080],
  [1024, 576],
  [960, 544],
  [832, 480],
] as const;

function moneyText(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "unknown";
  return String(Math.round(value * 10000) / 10000);
}

function ShotCostNote(props: { line: ShotCostLine | undefined }) {
  const line = props.line;
  if (!line) return null;
  if (line.amount == null) {
    return (
      <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">
        Estimate unknown for this shot until a rate is set and the still size can be read.
      </p>
    );
  }
  const size =
    line.width != null && line.height != null
      ? ` Still ${line.width}×${line.height}, ${line.durationSec}s, 24 fps.`
      : "";
  return (
    <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">
      {line.remaining
        ? `This remaining take adds ${moneyText(line.amount)}.`
        : "This shot is not in the remaining total."}{" "}
      {line.retakeAdd != null ? `A retake of this clip would add ${moneyText(line.retakeAdd)}.` : "No clip yet, so a retake adds nothing."}
      {size}
    </p>
  );
}

type StitchResponse = {
  outputPath: string;
  includedShotIds: string[];
  includedJobIds?: string[];
  skipped: { shotId: string; position: number; reason: string }[];
  kind?: "takes" | "preview";
  durationSec?: number;
  seams?: { position: number; mode: "cut" | "crossfade"; fadeSec: number; note?: string }[];
  finish?: FinishView;
  contactSheetPath?: string;
};

type SkippedShot = {
  shotId: string;
  position: number;
  reason: string;
  jobId?: string;
};

type Pending =
  | { kind: "shot"; shotId: string; force?: boolean; confirmedApproval?: boolean }
  | { kind: "all" }
  | { kind: "retake"; shotId: string; confirmedApproval?: boolean }
  | { kind: "hunt"; shotId: string; count: HuntSeedCount; confirmedApproval?: boolean }
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
  const [huntCounts, setHuntCounts] = useState<Record<string, HuntSeedCount>>({});
  const [cost, setCost] = useState<CostEstimate | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [stitchGate, setStitchGate] = useState(false);
  const [editExporting, setEditExporting] = useState(false);
  const [stitch, setStitch] = useState<StitchResponse | null>(null);
  const [previewCut, setPreviewCut] = useState<StitchResponse | null>(null);
  const [seamBusyId, setSeamBusyId] = useState<string | null>(null);
  const [seamClips, setSeamClips] = useState<
    Record<string, { outputPath: string; durationSec: number; note?: string; label: string }>
  >({});

  const [prompt, setPrompt] = useState("");
  const [presetId, setPresetId] = useState(MOTION_PRESETS[0].id);
  const [durationSec, setDurationSec] = useState(MOTION_PRESETS[0].durationSec);
  const [startImage, setStartImage] = useState<File | null>(null);
  const [endImage, setEndImage] = useState<File | null>(null);
  const [shotWorkflow, setShotWorkflow] = useState("");
  const [shotLowMemory, setShotLowMemory] = useState("");
  const [chainNew, setChainNew] = useState(false);
  const [chainBackNew, setChainBackNew] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const [savingShot, setSavingShot] = useState(false);
  const [styleBaseDraft, setStyleBaseDraft] = useState<string | null>(null);
  const styleBaseDraftRef = useRef<string | null>(null);

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
  const staleShotIds = useMemo(() => {
    if (!detail || !settings) return new Set<string>();
    return new Set(
      chainStaleShotIds({
        shots: detail.shots,
        jobs: detail.jobs,
        provider: settings.provider,
        styleBase: detail.project.styleBase,
        modelNameForShot: (shot) => {
          const full = detail.shots.find((item) => item.id === shot.id) ?? shot;
          return modelNameFor(
            settings.provider,
            settings,
            settings.provider === "comfyui"
              ? resolveComfyChoice({ settings, project: detail.project, shot: full })
              : undefined
          );
        },
      })
    );
  }, [detail, settings]);
  const stitchReview = useMemo(() => {
    if (!detail) return null;
    return reviewStitchPasses({
      shots: detail.shots,
      jobs: detail.jobs,
      staleShotIds,
    });
  }, [detail, staleShotIds]);
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
  const projectChoice =
    settings && detail
      ? resolveComfyChoice({ settings, project: detail.project, shot: null })
      : null;
  const appChoice = settings ? resolveComfyChoice({ settings, project: null, shot: null }) : null;
  const modelName =
    settings
      ? modelNameFor(
          provider,
          settings,
          provider === "comfyui" && projectChoice ? projectChoice : undefined
        )
      : CAPABILITY.mock.title;
  const paid = isPaidProvider(provider);
  const spendBlocked = Boolean(paid && (cost?.overBudget || cost?.credits?.insufficient));
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
    if (shot.approvedJobId && takes.some((take) => take.id === shot.approvedJobId)) {
      return shot.approvedJobId;
    }
    if (shot.selectedJobId && takes.some((take) => take.id === shot.selectedJobId)) {
      return shot.selectedJobId;
    }
    return takes[takes.length - 1]?.id;
  }

  function editStyleBase(value: string) {
    styleBaseDraftRef.current = value;
    setStyleBaseDraft(value);
  }

  async function persistStyleBase(value: string): Promise<boolean> {
    const current = detail?.project.styleBase ?? "";
    if (value.trim() === current) {
      styleBaseDraftRef.current = null;
      setStyleBaseDraft(null);
      return true;
    }
    const res = await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ styleBase: value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error || "Could not save the shared style text");
      return false;
    }
    styleBaseDraftRef.current = null;
    setStyleBaseDraft(null);
    await load();
    return true;
  }

  async function flushStyleBase(): Promise<boolean> {
    const draft = styleBaseDraftRef.current;
    if (draft === null) return true;
    return persistStyleBase(draft);
  }

  async function run(action: Pending, acknowledgeModel?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    if (!(await flushStyleBase())) {
      setBusy(false);
      return;
    }
    const body: Record<string, unknown> = {};
    if (acknowledgeModel) body.acknowledgeModel = acknowledgeModel;
    if (action.kind === "shot" && action.force) body.force = true;
    if ("confirmedApproval" in action && action.confirmedApproval) body.confirmApproved = true;
    if (action.kind === "hunt") body.count = action.count;
    const url =
      action.kind === "all"
        ? `/api/projects/${projectId}/render`
        : action.kind === "shot"
          ? `/api/projects/${projectId}/shots/${action.shotId}/render`
          : action.kind === "retake"
            ? `/api/projects/${projectId}/shots/${action.shotId}/retake`
            : action.kind === "hunt"
              ? `/api/projects/${projectId}/shots/${action.shotId}/hunt`
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
        if (data.needsApprovalConfirm && !("confirmedApproval" in action && action.confirmedApproval)) {
          setPending(action);
          setError(null);
          return;
        }
        if (data.needsModelAck && data.modelName) {
          setPending(action);
          setError(data.overBudget || data.insufficientCredits ? data.error : null);
          return;
        }
        if (data.overBudget || data.insufficientCredits) {
          setPending(action);
          setError(data.error || "Paid Render all is blocked");
          return;
        }
        throw new Error(data.error || "Could not queue the render");
      }
      setPending(null);
      setAckCost(null);
      const skipped = (data.skipped ?? []) as SkippedShot[];
      if (skipped.length > 0) {
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
    const shot = "shotId" in action ? shots.find((item) => item.id === action.shotId) : undefined;
    if ("shotId" in action && shot?.approvedJobId && !action.confirmedApproval) {
      setAckCost(null);
      setError(null);
      setPending(action);
      return;
    }
    const actionProvider = action.kind === "retry" ? action.provider : provider;
    if (action.kind === "hunt" || isPaidProvider(actionProvider)) {
      setAckCost(null);
      setPending(action);
      return;
    }
    void run(action);
  }

  useEffect(() => {
    if (!pending || (pending.kind !== "hunt" && pending.kind !== "retake")) return;
    let cancelled = false;
    const url =
      pending.kind === "hunt"
        ? `/api/projects/${projectId}/shots/${pending.shotId}/hunt?count=${pending.count}`
        : `/api/projects/${projectId}/shots/${pending.shotId}/retake`;
    void fetch(url)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error || "Could not estimate this run");
          return;
        }
        setAckCost(data as CostEstimate);
      })
      .catch(() => {
        if (!cancelled) setError("Could not estimate this run");
      });
    return () => {
      cancelled = true;
    };
  }, [pending, projectId]);

  async function onAddShot(e: React.FormEvent) {
    e.preventDefault();
    if (!startImage) {
      setError("Choose a start image. A shot is one clip from a still.");
      return;
    }
    setSavingShot(true);
    setError(null);
    if (!(await flushStyleBase())) {
      setSavingShot(false);
      return;
    }
    try {
      const form = new FormData();
      form.set("prompt", prompt);
      form.set("presetId", presetId);
      form.set("durationSec", String(durationSec));
      form.set("startImage", startImage);
      if (endImage) form.set("endImage", endImage);
      if (shotWorkflow) form.set("comfyuiWorkflow", shotWorkflow);
      if (shotLowMemory) form.set("comfyLowMemory", shotLowMemory);
      if (chainNew) {
        form.set("chainFromPrevious", "1");
        form.set("chainFrameBack", String(chainBackNew));
      }
      const res = await fetch(`/api/projects/${projectId}/shots`, { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not add the shot");
      setPrompt("");
      setStartImage(null);
      setEndImage(null);
      setShotWorkflow("");
      setShotLowMemory("");
      setChainNew(false);
      setChainBackNew(0);
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
    if (!(await flushStyleBase())) {
      setPreviewing(false);
      return;
    }
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

  async function onApprove(shot: Shot, jobId: string | undefined) {
    setError(null);
    const res = await fetch(`/api/projects/${projectId}/shots/${shot.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(shot.approvedJobId ? { clear: true } : { jobId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error || "Could not update approval");
      return;
    }
    await load();
  }

  async function saveShotPrompt(shotId: string, nextPrompt: string) {
    const res = await fetch(`/api/projects/${projectId}/shots/${shotId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: nextPrompt }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error || "Could not save the prompt");
      return;
    }
    await load();
  }

  async function replaceStartImage(shotId: string, file: File) {
    const form = new FormData();
    form.set("startImage", file);
    const res = await fetch(`/api/projects/${projectId}/shots/${shotId}`, {
      method: "PATCH",
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error || "Could not replace the image");
      return;
    }
    await load();
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

  async function onExportEdit() {
    setEditExporting(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/export/edit`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Export failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const header = res.headers.get("Content-Disposition") || "";
      const named = /filename="([^"]+)"/.exec(header);
      link.href = url;
      link.download = named?.[1] || "star-dust-edit.zip";
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setEditExporting(false);
    }
  }

  async function onPreviewSeam(shotId: string) {
    setSeamBusyId(shotId);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/shots/${shotId}/seam`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Seam preview failed");
      const seam = data.seam as { mode?: string; fadeSec?: number; note?: string } | null;
      const label =
        seam?.mode === "crossfade" ? `crossfade ${seam.fadeSec ?? ""}s` : "hard cut";
      setSeamClips((current) => ({
        ...current,
        [shotId]: {
          outputPath: data.outputPath,
          durationSec: Number(data.durationSec) || 0,
          note: seam?.note,
          label,
        },
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Seam preview failed");
    } finally {
      setSeamBusyId(null);
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

  async function saveProjectPatch(patch: {
    comfyuiWorkflow?: ComfyWorkflowId | null;
    comfyLowMemory?: boolean | null;
    seamMode?: SeamMode;
    seamFadeSec?: number;
    chainTrimStartFrames?: number;
    dropDuplicateFrame?: boolean;
    outputFps?: number | null;
    outputWidth?: number | null;
    outputHeight?: number | null;
    loudnessNormalize?: boolean | null;
    musicLevelDb?: number;
    musicFadeInSec?: number;
    musicFadeOutSec?: number;
    captionMode?: CaptionMode | null;
  }) {
    const res = await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error || "Could not save the workflow");
      return;
    }
    await load();
  }

  async function saveShotPatch(
    shotId: string,
    patch: {
      comfyuiWorkflow?: ComfyWorkflowId | null;
      comfyLowMemory?: boolean | null;
      chainFromPrevious?: boolean;
      chainFrameBack?: number;
      chainTrimStartFrames?: number | null;
      dropDuplicateFrame?: boolean | null;
      seamMode?: SeamMode | null;
      seamFadeSec?: number | null;
    }
  ) {
    const res = await fetch(`/api/projects/${projectId}/shots/${shotId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error || "Could not save the shot workflow");
      return;
    }
    await load();
  }

  async function clearSheet() {
    await fetch(`/api/projects/${projectId}/character-sheet`, { method: "DELETE" });
    await load();
  }

  async function onMusic(file: File | null) {
    if (!file) return;
    setError(null);
    const form = new FormData();
    form.set("audio", file);
    const res = await fetch(`/api/projects/${projectId}/music`, { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error || "Could not add the music bed");
      return;
    }
    await load();
  }

  async function clearMusic() {
    setError(null);
    await fetch(`/api/projects/${projectId}/music`, { method: "DELETE" });
    await load();
  }

  async function onCaptions(file: File | null) {
    if (!file) return;
    setError(null);
    const form = new FormData();
    form.set("srt", file);
    const res = await fetch(`/api/projects/${projectId}/captions`, { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const details = Array.isArray(data.errors) ? data.errors.join(" ") : "";
      setError(details || data.error || "Could not import the SRT");
      return;
    }
    await load();
  }

  async function clearCaptions() {
    setError(null);
    await fetch(`/api/projects/${projectId}/captions`, { method: "DELETE" });
    await load();
  }

  function storedName(rel?: string): string {
    if (!rel) return "";
    const base = rel.split("/").pop() ?? rel;
    return base.replace(/^\d+_/, "");
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
  const pendingShot =
    pending && "shotId" in pending ? shots.find((shot) => shot.id === pending.shotId) : undefined;
  const approvalGate = Boolean(
    pendingShot?.approvedJobId &&
      !(pending && "confirmedApproval" in pending && pending.confirmedApproval)
  );

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
            Start image, optional end image, prompt, duration, preset. Shared style
            text, when set, is prefixed onto the prompt a provider sees. A later
            shot can start from the previous shot&apos;s last frame.
          </p>
        </article>
        <article className="panel flex flex-col p-4">
          <p className="font-mono text-[11px] text-violet-300">02 · Render all</p>
          <h2 className="mt-1 text-lg font-medium text-white">In shot order</h2>
          <p className="mt-1 flex-1 text-xs leading-relaxed text-[var(--muted)]">
            {shots.length === 0
              ? "Add a shot, then run the list."
              : "Loads a finished clip when its inputs are unchanged, and does not spend again. A chained shot is rendered again when an earlier take in that chain changed, unless that shot is approved. Retake changes one shot's seed and stops at the next approved take."}
          </p>
          <button
            type="button"
            className="btn-primary mt-3 w-full"
            disabled={busy || shots.length === 0 || spendBlocked}
            onClick={() => ask({ kind: "all" })}
          >
            {busy ? "Working…" : "Render all"}
          </button>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">{REUSE_HONESTY}</p>
        </article>
        <article className="panel flex flex-col p-4">
          <p className="font-mono text-[11px] text-violet-300">03 · Export stitch</p>
          <h2 className="mt-1 text-lg font-medium text-white">One mp4, same editor</h2>
          <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
            ffmpeg joins the take you chose. An approved take stays in that stitch. Hard cut, or a
            short crossfade. A chained hard cut can trim a few start frames of the next clip. Mixed
            clips are conformed to one frame rate and size first. A music bed and an imported SRT
            can ride on that same file. The stitch also writes a contact sheet of those shots.
            The stitch is not a new model.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className="text-xs text-[var(--muted)]">
              Output frame rate
              <select
                className="input mt-1"
                value={project.outputFps ?? ""}
                onChange={(e) => {
                  const value = e.target.value;
                  void saveProjectPatch({ outputFps: value === "" ? null : Number(value) });
                }}
              >
                <option value="">Majority of the clips</option>
                {(project.outputFps && !OUTPUT_FPS_CHOICES.includes(project.outputFps as (typeof OUTPUT_FPS_CHOICES)[number])
                  ? [project.outputFps, ...OUTPUT_FPS_CHOICES]
                  : OUTPUT_FPS_CHOICES
                ).map((fps) => (
                  <option key={fps} value={fps}>
                    {fps} fps
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-[var(--muted)]">
              Output size
              <select
                className="input mt-1"
                value={
                  project.outputWidth && project.outputHeight
                    ? `${project.outputWidth}x${project.outputHeight}`
                    : ""
                }
                onChange={(e) => {
                  const value = e.target.value;
                  if (!value) {
                    void saveProjectPatch({ outputWidth: null, outputHeight: null });
                    return;
                  }
                  const [width, height] = value.split("x").map(Number);
                  void saveProjectPatch({ outputWidth: width, outputHeight: height });
                }}
              >
                <option value="">Majority of the clips</option>
                {OUTPUT_SIZE_CHOICES.map(([width, height]) => (
                  <option key={`${width}x${height}`} value={`${width}x${height}`}>
                    {width}×{height}
                  </option>
                ))}
                {project.outputWidth &&
                  project.outputHeight &&
                  !OUTPUT_SIZE_CHOICES.some(
                    ([width, height]) => width === project.outputWidth && height === project.outputHeight
                  ) && (
                    <option value={`${project.outputWidth}x${project.outputHeight}`}>
                      {project.outputWidth}×{project.outputHeight}
                    </option>
                  )}
              </select>
            </label>
            <label className="text-xs text-[var(--muted)]">
              Loudness
              <select
                className="input mt-1"
                value={project.loudnessNormalize == null ? "" : project.loudnessNormalize ? "on" : "off"}
                onChange={(e) => {
                  const value = e.target.value;
                  void saveProjectPatch({
                    loudnessNormalize: value === "" ? null : value === "on",
                  });
                }}
              >
                <option value="">
                  {project.musicBedPath ? "On — −14 LUFS with the music bed" : "On when a clip has audio"}
                </option>
                <option value="on">{project.musicBedPath ? "On — −14 LUFS" : "EBU R128 on"}</option>
                <option value="off">Off</option>
              </select>
            </label>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-white">{detail.conform?.summary}</p>
          {detail.finish?.line && (
            <p className="mt-2 text-xs leading-relaxed text-white">{detail.finish.line}</p>
          )}
          {detail.finish?.loudnessNote && (
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">{detail.finish.loudnessNote}</p>
          )}
          {detail.finish?.fitNote && (
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">{detail.finish.fitNote}</p>
          )}
          <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">{CONFORM_HONESTY}</p>
          {stitchReview?.warn && (
            <div className="mt-3 space-y-2 rounded-lg border border-amber-400/40 bg-amber-400/10 p-3" role="status">
              {stitchReview.paragraphs.map((paragraph, index) => (
                <p key={index} className="text-xs leading-relaxed text-amber-100">
                  {paragraph}
                </p>
              ))}
            </div>
          )}
          <button
            type="button"
            className="btn-ghost mt-3 w-full"
            disabled={exporting || takeClips.length === 0}
            onClick={() => {
              if (stitchReview?.warn) {
                setStitchGate(true);
                return;
              }
              void onExport();
            }}
          >
            {exporting ? "Stitching…" : "Export stitch"}
          </button>
          <p className="mt-3 text-xs leading-relaxed text-[var(--muted)]">
            Export for edit downloads a zip for an editor: one chosen take per shot, a CMX3600
            EDL, a JSON manifest per take, and a contact sheet. The EDL carries cuts, dissolves,
            and in/out only. It is not a Premiere or Resolve project. The mp4 is a review codec,
            not a mastering codec. An imported SRT is included, with times snapped to the
            conformed frame rate.
          </p>
          <button
            type="button"
            className="btn-ghost mt-3 w-full"
            disabled={editExporting || takeClips.length === 0}
            onClick={() => void onExportEdit()}
          >
            {editExporting ? "Packing…" : "Export for edit"}
          </button>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">{EDIT_EXPORT_HONESTY}</p>
        </article>
      </section>

      <section className="panel space-y-3 p-4">
        <div>
          <p className="font-mono text-[11px] text-violet-300">Music and captions</p>
          <h2 className="mt-1 text-lg font-medium text-white">A bed under the cut, and an SRT you wrote</h2>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-[var(--muted)]">{FINISH_HONESTY}</p>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="space-y-3">
            <p className="text-xs font-medium text-white">Music bed</p>
            <div className="flex flex-wrap gap-2">
              <label className="btn-ghost cursor-pointer">
                {project.musicBedPath ? "Replace audio" : "Upload audio"}
                <input
                  type="file"
                  accept=".wav,.mp3,.m4a,.aac,.ogg,.flac,.aiff,.aif,audio/*"
                  className="sr-only"
                  onChange={(e) => {
                    const file = e.target.files?.[0] ?? null;
                    e.target.value = "";
                    void onMusic(file);
                  }}
                />
              </label>
              {project.musicBedPath && (
                <button type="button" className="btn-ghost" onClick={() => void clearMusic()}>
                  Remove
                </button>
              )}
            </div>
            {project.musicBedPath && (
              <p className="text-[11px] text-[var(--muted)]">{storedName(project.musicBedPath)}</p>
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="text-xs text-[var(--muted)]">
                Level
                <select
                  className="input mt-1"
                  value={String(project.musicLevelDb)}
                  disabled={!project.musicBedPath}
                  onChange={(e) => void saveProjectPatch({ musicLevelDb: Number(e.target.value) })}
                >
                  {(MUSIC_LEVEL_CHOICES.includes(project.musicLevelDb as (typeof MUSIC_LEVEL_CHOICES)[number])
                    ? MUSIC_LEVEL_CHOICES
                    : [project.musicLevelDb, ...MUSIC_LEVEL_CHOICES]
                  ).map((level) => (
                    <option key={level} value={level}>
                      {level} dB
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-[var(--muted)]">
                Fade in
                <select
                  className="input mt-1"
                  value={String(project.musicFadeInSec)}
                  disabled={!project.musicBedPath}
                  onChange={(e) => void saveProjectPatch({ musicFadeInSec: Number(e.target.value) })}
                >
                  {(MUSIC_FADE_CHOICES.includes(project.musicFadeInSec as (typeof MUSIC_FADE_CHOICES)[number])
                    ? MUSIC_FADE_CHOICES
                    : [project.musicFadeInSec, ...MUSIC_FADE_CHOICES]
                  ).map((seconds) => (
                    <option key={`in-${seconds}`} value={seconds}>
                      {seconds}s
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-[var(--muted)]">
                Fade out
                <select
                  className="input mt-1"
                  value={String(project.musicFadeOutSec)}
                  disabled={!project.musicBedPath}
                  onChange={(e) => void saveProjectPatch({ musicFadeOutSec: Number(e.target.value) })}
                >
                  {(MUSIC_FADE_CHOICES.includes(project.musicFadeOutSec as (typeof MUSIC_FADE_CHOICES)[number])
                    ? MUSIC_FADE_CHOICES
                    : [project.musicFadeOutSec, ...MUSIC_FADE_CHOICES]
                  ).map((seconds) => (
                    <option key={`out-${seconds}`} value={seconds}>
                      {seconds}s
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
          <div className="space-y-3">
            <p className="text-xs font-medium text-white">SRT captions</p>
            <div className="flex flex-wrap gap-2">
              <label className="btn-ghost cursor-pointer">
                {project.captionsPath ? "Replace SRT" : "Import SRT"}
                <input
                  type="file"
                  accept=".srt,text/plain"
                  className="sr-only"
                  onChange={(e) => {
                    const file = e.target.files?.[0] ?? null;
                    e.target.value = "";
                    void onCaptions(file);
                  }}
                />
              </label>
              {project.captionsPath && (
                <button type="button" className="btn-ghost" onClick={() => void clearCaptions()}>
                  Remove
                </button>
              )}
            </div>
            {project.captionsPath && (
              <p className="text-[11px] text-[var(--muted)]">
                {storedName(project.captionsPath)}
                {detail.finish?.captions
                  ? ` · ${detail.finish.captions.count} cue${detail.finish.captions.count === 1 ? "" : "s"}`
                  : ""}
              </p>
            )}
            {detail.finish?.captionErrors && detail.finish.captionErrors.length > 0 && (
              <p className="text-[11px] leading-relaxed text-rose-200">
                {detail.finish.captionErrors.join(" ")}
              </p>
            )}
            <label className="block max-w-xs text-xs text-[var(--muted)]">
              How captions go out
              <select
                className="input mt-1"
                value={project.captionMode ?? "burn"}
                disabled={!project.captionsPath}
                onChange={(e) =>
                  void saveProjectPatch({ captionMode: e.target.value === "sidecar" ? "sidecar" : "burn" })
                }
              >
                <option value="burn">Burn in</option>
                <option value="sidecar">Sidecar .srt</option>
              </select>
            </label>
          </div>
        </div>
      </section>

      <section className="panel space-y-3 p-4">
        <div>
          <p className="font-mono text-[11px] text-violet-300">Joins</p>
          <h2 className="mt-1 text-lg font-medium text-white">Hard cut or a short crossfade</h2>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-[var(--muted)]">{SEAM_HONESTY}</p>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-[var(--muted)]">{CHAIN_HONESTY}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-[var(--muted)]">
            Project join
            <select
              className="input mt-1"
              value={project.seamMode}
              onChange={(e) => void saveProjectPatch({ seamMode: e.target.value as SeamMode })}
            >
              <option value="cut">Hard cut</option>
              <option value="crossfade">Crossfade</option>
            </select>
          </label>
          <label className="text-xs text-[var(--muted)]">
            Crossfade length
            <select
              className="input mt-1"
              value={String(project.seamFadeSec)}
              disabled={project.seamMode !== "crossfade"}
              onChange={(e) => void saveProjectPatch({ seamFadeSec: Number(e.target.value) })}
            >
              {SEAM_FADE_CHOICES.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {seconds}s
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="block max-w-md text-xs text-[var(--muted)]">
          Start frames trimmed on a chained hard cut
          <select
            className="input mt-1"
            value={String(project.chainTrimStartFrames)}
            onChange={(e) => void saveProjectPatch({ chainTrimStartFrames: Number(e.target.value) })}
          >
            {CHAIN_TRIM_START_CHOICES.map((frames) => (
              <option key={frames} value={frames}>
                {chainTrimChoiceLabel(frames)}
              </option>
            ))}
          </select>
          <span className="mt-1 block leading-relaxed">{SEAM_FRAME_HONESTY}</span>
        </label>
        <p className="text-[11px] leading-relaxed text-[var(--muted)]">
          A shot can override the join that leads into it, and how many start frames that chained
          hard cut trims. The first shot has no join.
        </p>
      </section>

      <section className="panel flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-mono text-[11px] text-emerald-300">Preview cut · free</p>
          <h2 className="mt-1 text-lg font-medium text-white">Watch the whole edit for $0</h2>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-[var(--muted)]">
            Renders every shot with Mock and stitches them. Camera motion on your stills, not AI
            motion. Those preview clips are conformed before they join, the same way as Export
            stitch. Last-frame chaining, and the start-frame trim, apply when you render a take
            and export the stitch, not in this preview. Preview clips do not replace or count as
            the shot&apos;s takes. Those preview clips have no audio, so a music bed plays at its
            level instead of ducking.
          </p>
          {detail.previewFinish?.line && (
            <p className="mt-2 text-xs leading-relaxed text-white">{detail.previewFinish.line}</p>
          )}
          {detail.previewFinish?.fitNote && (
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">{detail.previewFinish.fitNote}</p>
          )}
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
            spendBlocked
              ? "border-rose-400/40 bg-rose-500/10 text-rose-50"
              : "border-amber-400/30 bg-amber-400/10 text-amber-50"
          }`}
        >
          <p>
            Next cloud run uses <span className="font-semibold">{modelName}</span>.
          </p>
          <p className="mt-1 text-xs leading-relaxed text-current/80">
            {cost?.label ?? "Cost unknown. No rate is set for this model."}
          </p>
          {cost && !cost.unknown && (
            <ul className="mt-2 space-y-1 text-xs leading-relaxed text-current/80">
              <li>Total for every shot: {moneyText(cost.projectTotal)}.</li>
              <li>Remaining takes add {moneyText(cost.remainingTotal)}.</li>
              <li>A retake of existing clips would add {moneyText(cost.retakeTotal)}.</li>
            </ul>
          )}
          <p className="mt-1 text-[11px] leading-relaxed text-current/70">
            Estimate from the rate and billing unit you entered. Per megapixel and per 1M video
            tokens use each still&apos;s width and height, the shot duration, and 24 fps. Star Dust
            has no vendor price table.
          </p>
          {cost?.credits?.hosted && (
            <p className="mt-1 text-xs leading-relaxed text-current/80">{cost.credits.label}</p>
          )}
          <p className="mt-1 text-xs text-current/70">{CLOUD_RISK_NOTE}</p>
        </div>
      )}
      {provider === "comfyui" && settings && projectChoice && appChoice && (
        <div className="rounded-xl border border-sky-400/30 bg-sky-400/10 px-4 py-3 text-sm text-sky-50">
          <p>
            This project runs <span className="font-semibold">{COMFY_WORKFLOWS[projectChoice.workflow].title}</span>
            {projectChoice.lowMemory ? " with the low-memory preset" : ""}.{" "}
            {COMFY_WORKFLOWS[projectChoice.workflow].goodAt}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-sky-50/80">
            {COMFY_WORKFLOWS[projectChoice.workflow].memory}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-sky-50/80">
            Default: {COMFY_WORKFLOWS[projectChoice.workflow].defaults} Low-memory preset:{" "}
            {COMFY_WORKFLOWS[projectChoice.workflow].lowMemory}
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-sky-50/90">
              Project workflow
              <select
                className="input mt-1"
                value={project.comfyuiWorkflow ?? ""}
                onChange={(e) => {
                  const value = e.target.value;
                  void saveProjectPatch({
                    comfyuiWorkflow: value === "" ? null : (value as ComfyWorkflowId),
                  });
                }}
              >
                <option value="">App default ({COMFY_WORKFLOWS[appChoice.workflow].title})</option>
                {COMFY_WORKFLOW_ORDER.map((id) => (
                  <option key={id} value={id}>
                    {COMFY_WORKFLOWS[id].title}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-sky-50/90">
              Low-memory preset
              <select
                className="input mt-1"
                value={project.comfyLowMemory == null ? "" : project.comfyLowMemory ? "1" : "0"}
                onChange={(e) => {
                  const value = e.target.value;
                  void saveProjectPatch({
                    comfyLowMemory: value === "" ? null : value === "1",
                  });
                }}
              >
                <option value="">App default ({appChoice.lowMemory ? "on" : "off"})</option>
                <option value="1">On — about 480p, short clip</option>
                <option value="0">Off</option>
              </select>
            </label>
          </div>
          {projectChoice.workflow === "wan-flf" && (
            <p className="mt-2 text-xs leading-relaxed text-sky-50/90">
              A shot with no end still does not render on this graph. Star Dust does not switch it to
              TI2V-5B. This steers one clip between two stills. It is not a character lock.
            </p>
          )}
          <p className="mt-2 text-xs text-sky-50/70">
            A shot can override this. The server is the URL in Providers, or COMFYUI_BASE_URL if that
            is set. This is not a node editor.
          </p>
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

      <section className="panel space-y-3 p-4">
        <div>
          <p className="font-mono text-[11px] text-violet-300">Shared text</p>
          <h2 className="mt-1 text-lg font-medium text-white">Shared style / character text</h2>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-[var(--muted)]">{STYLE_BASE_HONESTY}</p>
        </div>
        <label className="block text-xs text-[var(--muted)]" htmlFor="style-base">
          Shared style / character text
          <textarea
            id="style-base"
            name="star-dust-style-base"
            autoComplete="off"
            className="input mt-1 min-h-[88px] resize-y"
            key={project.updatedAt}
            value={styleBaseDraft ?? project.styleBase}
            placeholder="Leave empty to send each shot prompt alone"
            onChange={(e) => editStyleBase(e.target.value)}
            onBlur={() => {
              const draft = styleBaseDraftRef.current;
              if (draft !== null) void persistStyleBase(draft);
            }}
          />
        </label>
        {styleBaseText(styleBaseDraft ?? project.styleBase) ? (
          <p className="line-clamp-3 text-xs leading-relaxed text-[var(--muted)]">
            <span className="font-medium text-white">Effective prompt preview.</span>{" "}
            {shots[0]
              ? `Shot ${shots[0].position}: ${effectivePrompt(styleBaseDraft ?? project.styleBase, shots[0].prompt)}`
              : styleBaseText(styleBaseDraft ?? project.styleBase)}
            {shots.length > 1
              ? " The same text is prefixed on every shot. Each shot prompt stays the action."
              : " The shot prompt stays the action."}
          </p>
        ) : (
          <p className="text-[11px] leading-relaxed text-[var(--muted)]">
            Empty, so each shot prompt is sent on its own. An example, once you type it:
            dusk harbor, warm lantern light, same wool coat.
          </p>
        )}
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
              <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">
                Action or scene for this shot. Shared style text is not copied into the shot.
                It is added in front only when a take or preview is queued.
              </p>
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
          {provider === "comfyui" && projectChoice && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-[var(--muted)]">
                ComfyUI workflow
                <select
                  className="input mt-1"
                  value={shotWorkflow}
                  onChange={(e) => setShotWorkflow(e.target.value)}
                >
                  <option value="">Project default ({COMFY_WORKFLOWS[projectChoice.workflow].title})</option>
                  {COMFY_WORKFLOW_ORDER.map((id) => (
                    <option key={id} value={id}>
                      {COMFY_WORKFLOWS[id].title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-[var(--muted)]">
                Low-memory preset
                <select
                  className="input mt-1"
                  value={shotLowMemory}
                  onChange={(e) => setShotLowMemory(e.target.value)}
                >
                  <option value="">
                    Project default ({projectChoice.lowMemory ? "on" : "off"})
                  </option>
                  <option value="1">On — about 480p, short clip</option>
                  <option value="0">Off</option>
                </select>
              </label>
            </div>
          )}
          {provider === "comfyui" &&
            projectChoice &&
            (shotWorkflow === "wan-flf" || (!shotWorkflow && projectChoice.workflow === "wan-flf")) && (
              <p className="text-xs leading-relaxed text-amber-100/90">
                {endImage
                  ? "First-last frame steers this clip between the two stills. It is not a character lock. Identity can still drift. One short clip."
                  : WAN_FLF_MISSING_END}
              </p>
            )}
          {shots.length > 0 && (
            <label className="flex items-start gap-2 text-xs leading-relaxed text-[var(--muted)]">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={chainNew}
                onChange={(e) => setChainNew(e.target.checked)}
              />
              <span>
                <span className="text-white">Start from previous shot&apos;s last frame.</span>{" "}
                {CHAIN_HONESTY} Your still stays on the shot if you turn this off.
              </span>
            </label>
          )}
          {shots.length > 0 && chainNew && (
            <label className="text-xs text-[var(--muted)]">
              Start frame, counted back from the end
              <select
                className="input mt-1"
                value={String(chainBackNew)}
                onChange={(e) => setChainBackNew(Number(e.target.value))}
              >
                {CHAIN_FRAME_BACK_CHOICES.map((frames) => (
                  <option key={frames} value={frames}>
                    {frames === 0 ? "0 — last frame" : `${frames} ${frames === 1 ? "frame" : "frames"} before the end`}
                  </option>
                ))}
              </select>
              <span className="mt-1 block leading-relaxed">{FRAME_BACK_HONESTY}</span>
            </label>
          )}
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
              const prev = index > 0 ? shots[index - 1] : undefined;
              const prevTakes = prev ? takesFor(prev.id) : [];
              const prevLatest = prev ? latestTake(prev.id) : undefined;
              const prevBusy =
                prevLatest?.status === "queued" || prevLatest?.status === "running";
              const showChained = Boolean(shot.chainFromPrevious && shot.chainedStartImagePath);
              const depth = chainDepth(shots, shot.id);
              const depthNote = shot.chainFromPrevious ? chainDepthNote(depth) : null;
              const chosenBack = shot.chainFrameBack ?? 0;
              const frameWord = chainFramePhrase(chosenBack);
              const frameStale =
                Boolean(shot.chainedStartImagePath) && (shot.chainedFrameRequest ?? 0) !== chosenBack;
              const joinMode = shot.seamMode ?? project.seamMode;
              const trimFrames =
                shot.chainTrimStartFrames == null
                  ? project.chainTrimStartFrames
                  : shot.chainTrimStartFrames;
              const outOfDate = staleShotIds.has(shot.id);
              const prevChosen = prev ? stitchChoice(prev, prevTakes) : undefined;
              const chainLine = !shot.chainFromPrevious || !prev
                ? null
                : outOfDate
                  ? CHAIN_STALE_NOTE
                  : frameStale
                    ? `Frame choice changed. Render this shot again to start from the ${frameWord}. The take you have still uses the earlier frame.`
                    : prevBusy
                      ? `Waits for shot ${prev.position}'s take, then uses its ${frameWord}. Your still is not used.`
                      : prevTakes.length === 0
                        ? `Needs shot ${prev.position}'s finished take first. Your still is not used.`
                        : `The next render starts from the ${frameWord} of the previous shot.`;
              const seamClip = seamClips[shot.id];
              const conformLabel = detail.conform?.shots.find((row) => row.shotId === shot.id)?.label;
              return (
                <li key={shot.id} className="panel grid gap-4 p-4 sm:grid-cols-[140px_1fr]">
                  <div className="space-y-2">
                    <div className="overflow-hidden rounded-lg bg-black">
                      {showChained ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={`/api/media/${shot.chainedStartImagePath}`}
                          alt={
                            chosenBack === 0
                              ? "Last frame from the previous shot"
                              : "Frame from near the end of the previous shot"
                          }
                          className="aspect-video w-full object-cover"
                        />
                      ) : shot.startImagePath ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={`/api/media/${shot.startImagePath}`}
                          alt="Your still"
                          className="aspect-video w-full object-cover"
                        />
                      ) : (
                        <div className="flex aspect-video items-center justify-center text-xs text-[var(--muted)]">
                          No still
                        </div>
                      )}
                    </div>
                    {showChained && shot.startImagePath && (
                      <div className="flex items-center gap-2">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`/api/media/${shot.startImagePath}`}
                          alt="Your still"
                          className="h-10 w-16 rounded object-cover"
                        />
                        <p className="text-[10px] leading-snug text-[var(--muted)]">
                          Your still. Turning chaining off uses this again.
                        </p>
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
                      {conformLabel && (
                        <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-sky-100">
                          {conformLabel}
                        </span>
                      )}
                      {job && <StatusBadge status={job.status} />}
                      {outOfDate && (
                        <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[11px] font-semibold text-amber-100">
                          Out of date
                        </span>
                      )}
                      {shot.approvedJobId && !shot.approvedMismatch && (
                        <span className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-200">
                          {APPROVED_LABEL}
                        </span>
                      )}
                      {shot.approvedMismatch && (
                        <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[11px] font-semibold text-amber-100">
                          {APPROVED_MISMATCH_NOTE}
                        </span>
                      )}
                    </div>
                    {paid && <ShotCostNote line={cost?.shots?.find((item) => item.shotId === shot.id)} />}
                    <label className="mt-2 block text-[11px] text-[var(--muted)]">
                      Prompt
                      <textarea
                        key={`${shot.id}:${shot.prompt}`}
                        className="input mt-1 min-h-16 text-sm text-white"
                        defaultValue={shot.prompt}
                        onBlur={(e) => {
                          const next = e.target.value;
                          if (next !== shot.prompt) void saveShotPrompt(shot.id, next);
                        }}
                      />
                    </label>
                    <label className="mt-2 block text-[11px] text-[var(--muted)]">
                      Replace start image
                      <input
                        className="mt-1 block w-full text-xs"
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = "";
                          if (file) void replaceStartImage(shot.id, file);
                        }}
                      />
                    </label>
                    {styleBaseText(project.styleBase) && (
                      <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-[var(--muted)]">
                        Provider sees: {effectivePrompt(project.styleBase, shot.prompt)}
                      </p>
                    )}
                    {index > 0 && (
                      <div className="mt-3 space-y-2">
                        <label className="flex items-start gap-2 text-xs leading-relaxed text-[var(--muted)]">
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={shot.chainFromPrevious}
                            onChange={(e) =>
                              void saveShotPatch(shot.id, { chainFromPrevious: e.target.checked })
                            }
                          />
                          <span>
                            <span className="text-white">Start from previous shot&apos;s last frame.</span>{" "}
                            {CHAIN_HONESTY}
                          </span>
                        </label>
                        {shot.chainFromPrevious && (
                          <div className="space-y-2">
                            <p className="text-[11px] font-medium text-white">{chainDepthLabel(depth)}</p>
                            {depthNote && (
                              <p
                                className={`text-[11px] leading-relaxed ${
                                  depth >= 4 ? "text-amber-100/90" : "text-[var(--muted)]"
                                }`}
                              >
                                {depthNote}
                              </p>
                            )}
                            <label className="block text-[11px] text-[var(--muted)]">
                              Start frame, counted back from the end
                              <select
                                className="input mt-1"
                                value={String(chosenBack)}
                                onChange={(e) =>
                                  void saveShotPatch(shot.id, { chainFrameBack: Number(e.target.value) })
                                }
                              >
                                {CHAIN_FRAME_BACK_CHOICES.map((frames) => (
                                  <option key={frames} value={frames}>
                                    {frames === 0
                                      ? "0 — last frame"
                                      : `${frames} ${frames === 1 ? "frame" : "frames"} before the end`}
                                  </option>
                                ))}
                              </select>
                              <span className="mt-1 block leading-relaxed">{FRAME_BACK_HONESTY}</span>
                            </label>
                            {chosenBack > 0 && joinMode !== "crossfade" && trimFrames > 0 && (
                              <p className="text-[11px] leading-relaxed text-[var(--muted)]">
                                This shot starts before the last frame, so this hard cut trims nothing.
                                The previous take still plays to the end.
                              </p>
                            )}
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                className="btn-ghost !px-3 !py-1.5 text-xs"
                                onClick={() =>
                                  void saveShotPatch(shot.id, { chainFromPrevious: false })
                                }
                              >
                                Use original still
                              </button>
                              <span className="text-[11px] leading-relaxed text-[var(--muted)]">
                                Turns the option off. Your still and any extracted frame stay.
                              </span>
                            </div>
                          </div>
                        )}
                        {chainLine && <p className="text-[11px] leading-relaxed text-amber-100/80">{chainLine}</p>}
                        <div className="space-y-2">
                          <button
                            type="button"
                            className="btn-ghost !px-3 !py-1.5 text-xs"
                            disabled={seamBusyId === shot.id || !chosen || !prevChosen}
                            onClick={() => void onPreviewSeam(shot.id)}
                          >
                            {seamBusyId === shot.id ? "Previewing seam…" : "Preview seam"}
                          </button>
                          <p className="text-[11px] leading-relaxed text-[var(--muted)]">{SEAM_PREVIEW_HONESTY}</p>
                          {seamClip && (
                            <div className="space-y-2">
                              <video
                                className="aspect-video w-full rounded-lg bg-black"
                                src={`/api/media/${seamClip.outputPath}`}
                                controls
                                playsInline
                              />
                              <p className="text-[11px] leading-relaxed text-[var(--muted)]">
                                {seamClip.durationSec.toFixed(2)}s · {seamClip.label}
                                {seamClip.note ? ` · ${seamClip.note}` : ""}. This is not a take.
                              </p>
                            </div>
                          )}
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2">
                          <label className="text-[11px] text-[var(--muted)]">
                            Join from the previous shot
                            <select
                              className="input mt-1"
                              value={shot.seamMode ?? ""}
                              onChange={(e) => {
                                const value = e.target.value;
                                void saveShotPatch(shot.id, {
                                  seamMode: value === "" ? null : (value as SeamMode),
                                });
                              }}
                            >
                              <option value="">
                                Project default (
                                {project.seamMode === "crossfade"
                                  ? `crossfade ${project.seamFadeSec}s`
                                  : "hard cut"}
                                )
                              </option>
                              <option value="cut">Hard cut</option>
                              <option value="crossfade">Crossfade</option>
                            </select>
                          </label>
                          {shot.seamMode === "crossfade" && (
                            <label className="text-[11px] text-[var(--muted)]">
                              This join&apos;s crossfade
                              <select
                                className="input mt-1"
                                value={String(shot.seamFadeSec ?? project.seamFadeSec)}
                                onChange={(e) =>
                                  void saveShotPatch(shot.id, { seamFadeSec: Number(e.target.value) })
                                }
                              >
                                {SEAM_FADE_CHOICES.map((seconds) => (
                                  <option key={seconds} value={seconds}>
                                    {seconds}s
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                          <label className="text-[11px] text-[var(--muted)]">
                            Start frames trimmed on this hard cut
                            <select
                              className="input mt-1"
                              value={
                                shot.chainTrimStartFrames == null ? "" : String(shot.chainTrimStartFrames)
                              }
                              onChange={(e) => {
                                const value = e.target.value;
                                void saveShotPatch(shot.id, {
                                  chainTrimStartFrames: value === "" ? null : Number(value),
                                });
                              }}
                            >
                              <option value="">
                                Project default ({chainTrimChoiceLabel(project.chainTrimStartFrames)})
                              </option>
                              {CHAIN_TRIM_START_CHOICES.map((frames) => (
                                <option key={frames} value={frames}>
                                  {chainTrimChoiceLabel(frames)}
                                </option>
                              ))}
                            </select>
                            <span className="mt-1 block leading-relaxed">
                              Only a chained hard cut that starts on the exact last frame. A crossfade,
                              an unchained shot, and a stepped-back start are unchanged. This softens a
                              re-enacted freeze. It does not lock a character or keep identity continuous.
                            </span>
                          </label>
                        </div>
                      </div>
                    )}
                    {provider === "comfyui" && settings && (
                      <ShotWorkflowFields
                        shot={shot}
                        projectDefault={resolveComfyChoice({ settings, project, shot: null })}
                        resolved={resolveComfyChoice({ settings, project, shot })}
                        onChange={(patch) => void saveShotPatch(shot.id, patch)}
                      />
                    )}
                    {shot.approvedJobId && (
                      <div className="mt-3 space-y-2">
                        <p
                          className={`text-sm leading-relaxed ${
                            shot.approvedMismatch ? "text-amber-100" : "text-emerald-200"
                          }`}
                        >
                          {shot.approvedMismatch ? APPROVED_MISMATCH_NOTE : "This take is approved."}
                        </p>
                        <p className="text-[11px] leading-relaxed text-[var(--muted)]">{APPROVE_HONESTY}</p>
                        {shot.approvedMismatch && (
                          <button
                            type="button"
                            className="btn-primary !px-3 !py-1.5 text-xs"
                            disabled={busy || takeBusy}
                            onClick={() => ask({ kind: "shot", shotId: shot.id, force: true })}
                          >
                            Re-render this shot
                          </button>
                        )}
                      </div>
                    )}
                    {takes.length > 0 && (
                      <fieldset className="mt-3 space-y-1">
                        <legend className="text-[11px] uppercase tracking-wide text-[var(--muted)]">
                          {shot.approvedJobId
                            ? "Takes kept on disk. The stitch uses the approved take."
                            : "Takes kept on disk. Stitch uses the one you pick."}
                        </legend>
                        {takes.map((take, takeIndex) => {
                          const reused =
                            !outOfDate &&
                            !shot.approvedJobId &&
                            Boolean(take.inputKey) &&
                            take.inputKey === shot.currentInputKey;
                          return (
                          <label key={take.id} className="flex items-center gap-2 text-xs text-[var(--muted)]">
                            <input
                              type="radio"
                              name={`take-${shot.id}`}
                              checked={chosen === take.id}
                              disabled={Boolean(shot.approvedJobId && take.id !== shot.approvedJobId)}
                              onChange={() => void onSelectTake(shot.id, take.id)}
                            />
                            <span className="text-white">
                              Take {takeIndex + 1}
                              {chosen === take.id ? " · in the stitch" : ""}
                              {shot.approvedJobId === take.id ? " · approved" : ""}
                              {take.seed != null ? ` · seed ${take.seed}` : ""}
                            </span>
                            {reused && (
                              <span className="text-emerald-300">{REUSE_LABEL}</span>
                            )}
                            <span className="truncate">{take.modelName || take.provider}</span>
                          </label>
                          );
                        })}
                      </fieldset>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="btn-ghost !px-3 !py-1.5"
                        disabled={busy || takeBusy || !chosen}
                        onClick={() => void onApprove(shot, chosen)}
                      >
                        {shot.approvedJobId ? "Clear approval" : "Approve take"}
                      </button>
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
                        disabled={busy || takeBusy}
                        onClick={() => ask({ kind: "retake", shotId: shot.id })}
                      >
                        Retake
                      </button>
                      <label className="flex items-center gap-2 text-[11px] text-[var(--muted)]">
                        Seeds
                        <select
                          className="input !w-auto !py-1"
                          value={huntCounts[shot.id] ?? 2}
                          disabled={busy || takeBusy}
                          onChange={(e) => {
                            const value = Number(e.target.value);
                            if (value !== 2 && value !== 3 && value !== 4) return;
                            setHuntCounts((current) => ({ ...current, [shot.id]: value }));
                          }}
                        >
                          {HUNT_SEED_CHOICES.map((count) => (
                            <option key={count} value={count}>
                              {count}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        className="btn-ghost !px-3 !py-1.5"
                        disabled={busy || takeBusy}
                        onClick={() =>
                          ask({ kind: "hunt", shotId: shot.id, count: huntCounts[shot.id] ?? 2 })
                        }
                      >
                        Try seeds
                      </button>
                      <p className="basis-full text-[11px] leading-relaxed text-[var(--muted)]">
                        {RETAKE_NOTE} {HUNT_NOTE}
                      </p>
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
              {previewCut.finish?.line && (
                <p className="text-xs text-white">{previewCut.finish.line}</p>
              )}
              {previewCut.contactSheetPath && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  className="w-full rounded-md bg-black"
                  src={`/api/media/${previewCut.contactSheetPath}`}
                  alt="Contact sheet of each shot in this preview cut"
                />
              )}
              <div className="flex flex-wrap gap-2">
                <a className="btn-ghost inline-flex" href={`/api/media/${previewCut.outputPath}`} download>
                  Download preview mp4
                </a>
                {previewCut.contactSheetPath && (
                  <a className="btn-ghost inline-flex" href={`/api/media/${previewCut.contactSheetPath}`} download>
                    Download contact sheet
                  </a>
                )}
              </div>
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
            {stitch.contactSheetPath && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className="w-full bg-black"
                src={`/api/media/${stitch.contactSheetPath}`}
                alt="Contact sheet of each shot in this stitch"
              />
            )}
            <div className="space-y-2 p-4">
              <p className="text-sm text-white">
                Stitch of {stitch.includedShotIds.length} completed shot
                {stitch.includedShotIds.length === 1 ? "" : "s"}
                {typeof stitch.durationSec === "number" ? ` · ${stitch.durationSec.toFixed(2)}s` : ""}.
              </p>
              {stitch.finish?.line && <p className="text-xs text-white">{stitch.finish.line}</p>}
              {stitch.finish?.loudnessNote && (
                <p className="text-xs text-[var(--muted)]">{stitch.finish.loudnessNote}</p>
              )}
              {stitch.seams && stitch.seams.length > 0 && (
                <p className="text-xs text-[var(--muted)]">
                  {stitch.seams
                    .map((seam) => {
                      const label =
                        seam.mode === "crossfade" ? `crossfade ${seam.fadeSec}s` : "hard cut";
                      return `Into shot ${seam.position}: ${label}${seam.note ? ` (${seam.note})` : ""}`;
                    })
                    .join(" · ")}
                </p>
              )}
              {stitch.skipped.length > 0 && (
                <p className="text-xs text-[var(--muted)]">
                  {stitch.skipped.map((item) => `Shot ${item.position}: ${item.reason}`).join(" · ")}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <a className="btn-primary inline-flex" href={`/api/media/${stitch.outputPath}`} download>
                  Download stitched mp4
                </a>
                {stitch.contactSheetPath && (
                  <a className="btn-ghost inline-flex" href={`/api/media/${stitch.contactSheetPath}`} download>
                    Download contact sheet
                  </a>
                )}
                {stitch.finish?.sidecarPath && (
                  <a className="btn-ghost inline-flex" href={`/api/media/${stitch.finish.sidecarPath}`} download>
                    Download sidecar .srt
                  </a>
                )}
              </div>
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

      {stitchGate && stitchReview?.warn && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center">
          <div
            className="panel w-full max-w-xl p-5"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mixed-pass-title"
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-200">
              {stitchReview.mixed ? "Mixed passes" : "Out of date"}
            </p>
            <h2 id="mixed-pass-title" className="mt-2 text-xl font-semibold text-white">
              Review this cut before the stitch
            </h2>
            <div className="mt-3 space-y-3">
              {stitchReview.paragraphs.map((paragraph, index) => (
                <p key={index} className="text-sm leading-relaxed text-white">
                  {paragraph}
                </p>
              ))}
            </div>
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                className="btn-ghost"
                disabled={exporting}
                onClick={() => setStitchGate(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={exporting}
                onClick={() => {
                  setStitchGate(false);
                  void onExport();
                }}
              >
                {exporting ? "Stitching…" : "Stitch anyway"}
              </button>
            </div>
          </div>
        </div>
      )}

      {pending && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center">
          <div className="panel w-full max-w-md p-5" role="dialog" aria-modal="true" aria-labelledby="model-title">
            {approvalGate ? (
              <>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-200">
                  Approved take
                </p>
                <h2 id="model-title" className="mt-2 text-xl font-semibold text-white">
                  {pendingShot?.approvedMismatch
                    ? APPROVED_MISMATCH_NOTE
                    : "This shot is approved."}
                </h2>
                <p className="mt-3 text-sm leading-relaxed text-white">
                  {pendingShot?.approvedMismatch
                    ? "The prompt or image changed after you approved this take. Rendering again replaces it. Render all will not do that on its own."
                    : pending.kind === "hunt"
                      ? "These seeds are extra takes. The stitch keeps the approved take until you clear approval and pick another."
                      : "Rendering again replaces the approved take. Render all will not do that on its own."}
                </p>
                <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">{APPROVE_HONESTY}</p>
                {(pending.kind === "retake" || pending.kind === "hunt") && ackCost?.label && (
                  <p className="mt-3 text-sm leading-relaxed text-white">{ackCost.label}</p>
                )}
              </>
            ) : pending.kind === "hunt" && !paid ? (
              <>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-300">
                  Try seeds
                </p>
                <h2 id="model-title" className="mt-2 text-xl font-semibold text-white">
                  Try {pending.count} seeds
                </h2>
                <p className="mt-3 text-sm leading-relaxed text-white">
                  {ackCost?.label ?? "Estimating this run…"}
                </p>
                <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">{HUNT_NOTE}</p>
              </>
            ) : (
              <>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-200">
                  Cloud image-to-video
                </p>
                <h2 id="model-title" className="mt-2 text-xl font-semibold text-white">
                  {pending.kind === "hunt"
                    ? `Try ${pending.count} seeds`
                    : pending.kind === "retake"
                      ? "Retake"
                      : confirmModel}
                </h2>
                <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">{CLOUD_RISK_NOTE}</p>
                {(pending.kind === "all" || pending.kind === "hunt" || pending.kind === "retake") && (
                  <p className="mt-3 text-sm leading-relaxed text-white">
                    {(pending.kind === "all" ? (ackCost ?? cost) : ackCost)?.label ??
                      "Estimating this run…"}
                  </p>
                )}
                {(pending.kind === "all" ? (ackCost ?? cost) : ackCost)?.credits?.hosted &&
                  (pending.kind === "all" || pending.kind === "hunt" || pending.kind === "retake") && (
                    <p className="mt-3 text-sm leading-relaxed text-white">
                      {(pending.kind === "all" ? (ackCost ?? cost) : ackCost)?.credits?.label}
                    </p>
                  )}
              </>
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
                disabled={
                  busy ||
                  Boolean(
                    (pending.kind === "all" || pending.kind === "hunt" || pending.kind === "retake") &&
                      ((pending.kind === "all" ? (ackCost ?? cost) : ackCost)?.overBudget ||
                        (pending.kind === "all" ? (ackCost ?? cost) : ackCost)?.credits?.insufficient)
                  )
                }
                onClick={() => {
                  if (approvalGate && pending && "shotId" in pending) {
                    const next = { ...pending, confirmedApproval: true as const };
                    const actionProvider = provider;
                    if (pending.kind === "hunt" || isPaidProvider(actionProvider)) {
                      setPending(next);
                      return;
                    }
                    void run(next);
                    return;
                  }
                  void run(pending, paid ? confirmModel : undefined);
                }}
              >
                {busy
                  ? "Queuing…"
                  : approvalGate
                    ? pending.kind === "hunt"
                      ? "Try these seeds"
                      : pending.kind === "retake"
                        ? "Retake anyway"
                        : "Re-render this shot"
                    : pending.kind === "hunt"
                      ? "Render these seeds"
                      : pending.kind === "retake"
                        ? "Retake"
                        : "Run this model"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ShotWorkflowFields(props: {
  shot: Shot;
  projectDefault: { workflow: ComfyWorkflowId; lowMemory: boolean };
  resolved: { workflow: ComfyWorkflowId; lowMemory: boolean };
  onChange: (patch: { comfyuiWorkflow?: ComfyWorkflowId | null; comfyLowMemory?: boolean | null }) => void;
}) {
  const info = COMFY_WORKFLOWS[props.resolved.workflow];
  return (
    <div className="mt-3 space-y-2">
      <p className="text-[11px] leading-relaxed text-[var(--muted)]">
        {info.title}
        {props.resolved.lowMemory ? " · low-memory preset" : ""}. {info.defaults}{" "}
        {props.resolved.lowMemory ? info.lowMemory : ""}
      </p>
      {props.resolved.workflow === "wan-flf" && (
        <p
          className={`text-[11px] leading-relaxed ${
            props.shot.endImagePath ? "text-[var(--muted)]" : "text-amber-100"
          }`}
        >
          {props.shot.endImagePath
            ? "Steers this clip between the start still and the end still. Not a character lock. Identity can still drift. One short clip."
            : WAN_FLF_MISSING_END}
        </p>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-[11px] text-[var(--muted)]">
          Shot workflow
          <select
            className="input mt-1"
            value={props.shot.comfyuiWorkflow ?? ""}
            onChange={(e) => {
              const value = e.target.value;
              props.onChange({
                comfyuiWorkflow: value === "" ? null : (value as ComfyWorkflowId),
              });
            }}
          >
            <option value="">
              Project default ({COMFY_WORKFLOWS[props.projectDefault.workflow].title})
            </option>
            {COMFY_WORKFLOW_ORDER.map((id) => (
              <option key={id} value={id}>
                {COMFY_WORKFLOWS[id].title}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[11px] text-[var(--muted)]">
          Low-memory preset
          <select
            className="input mt-1"
            value={props.shot.comfyLowMemory == null ? "" : props.shot.comfyLowMemory ? "1" : "0"}
            onChange={(e) => {
              const value = e.target.value;
              props.onChange({ comfyLowMemory: value === "" ? null : value === "1" });
            }}
          >
            <option value="">Project default ({props.projectDefault.lowMemory ? "on" : "off"})</option>
            <option value="1">On — about 480p, short clip</option>
            <option value="0">Off</option>
          </select>
        </label>
      </div>
    </div>
  );
}
