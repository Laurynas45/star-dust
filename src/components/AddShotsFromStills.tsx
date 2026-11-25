"use client";

import { useRef, useState } from "react";
import { CAPABILITY } from "@/lib/provider-info";
import {
  MAX_BATCH_SHOTS,
  batchAddedText,
  sortByFileName,
  tooManyStillsError,
  type RejectedStill,
} from "@/lib/shot-batch";
import {
  MAX_SHOT_SECONDS,
  MIN_SHOT_SECONDS,
  MOTION_PRESETS,
  ProviderId,
  isProviderId,
} from "@/lib/types";

const PROVIDERS: ProviderId[] = ["mock", "fal", "replicate", "comfyui"];

type Props = {
  projectId: string;
  provider: ProviderId;
  onChanged: () => Promise<void> | void;
};

export function AddShotsFromStills({ projectId, provider, onChanged }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [prompt, setPrompt] = useState("");
  const [duration, setDuration] = useState("");
  const [backend, setBackend] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const preset = MOTION_PRESETS[0];
  const overLimit = files.length > MAX_BATCH_SHOTS;

  function choose(list: File[]) {
    setFiles(sortByFileName(list));
    setMessage(null);
    setProblem(null);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    setProblem(null);
    if (files.length === 0) {
      setProblem("Choose stills, or drop them here. One shot per image.");
      return;
    }
    if (overLimit) {
      setProblem(tooManyStillsError(files.length));
      return;
    }
    setSaving(true);
    let providerTitle: string | null = null;
    let providerChanged = false;
    try {
      if (backend && isProviderId(backend) && backend !== provider) {
        const saved = await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: backend }),
        });
        const data = (await saved.json().catch(() => ({}))) as { error?: string };
        if (!saved.ok) {
          setProblem(data.error || "Could not set the studio provider.");
          return;
        }
        providerTitle = CAPABILITY[backend].title;
        providerChanged = true;
      }

      const form = new FormData();
      if (prompt.trim()) form.set("prompt", prompt.trim());
      if (duration.trim()) form.set("durationSec", duration.trim());
      for (const file of files) form.append("images", file, file.name);
      const res = await fetch(`/api/projects/${projectId}/shots/batch`, { method: "POST", body: form });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        added?: number;
        rejected?: RejectedStill[];
      };
      if (!res.ok) {
        const lead = providerTitle ? `Studio provider is ${providerTitle}. ` : "";
        setProblem(`${lead}${data.error || "Could not add the shots"}`);
        if (providerChanged) await onChanged();
        return;
      }
      const rejected = Array.isArray(data.rejected) ? data.rejected : [];
      const added = typeof data.added === "number" ? data.added : 0;
      setMessage(batchAddedText(added, rejected, providerTitle));
      setFiles([]);
      if (inputRef.current) inputRef.current.value = "";
      await onChanged();
    } catch {
      setProblem("Could not add the shots.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form id="add-shots-from-stills" onSubmit={onSubmit} className="panel space-y-3 p-5">
      <div>
        <p className="font-mono text-[11px] text-violet-300">From a folder</p>
        <h3 className="mt-1 text-base font-medium text-white">Add shots from stills</h3>
        <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
          One shot per image, added after the shots already in the list, in file-name order.
          Each still is the start image. Nothing is rendered, and no credits are spent.
        </p>
      </div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const dropped = Array.from(e.dataTransfer.files);
          if (dropped.length === 0) {
            setProblem("Drop image files. One shot per image.");
            return;
          }
          choose(dropped);
        }}
        className={`rounded-xl border border-dashed px-4 py-4 ${
          dragOver ? "border-violet-300 bg-violet-500/10" : "border-white/15 bg-black/20"
        }`}
      >
        <label className="label" htmlFor="batch-stills">
          Stills
        </label>
        <input
          ref={inputRef}
          id="batch-stills"
          type="file"
          multiple
          className="block w-full text-sm text-[var(--muted)] file:mr-3 file:rounded-lg file:border-0 file:bg-violet-500/20 file:px-3 file:py-1.5 file:text-violet-100"
          onChange={(e) => choose(Array.from(e.target.files ?? []))}
        />
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">
          Choose several files, or drop them here. PNG, JPEG, WebP, or GIF. 12 MB each.{" "}
          {MAX_BATCH_SHOTS} stills at a time. A file that does not fit is named. It is not dropped quietly.
        </p>
      </div>
      {files.length > 0 && (
        <div className="text-xs text-[var(--muted)]">
          <p>
            {files.length} {files.length === 1 ? "still" : "stills"}
            {overLimit ? `. ${tooManyStillsError(files.length)}` : ", in this order:"}
          </p>
          {!overLimit && (
            <ol className="mt-1 max-h-36 list-decimal space-y-0.5 overflow-auto pl-5">
              {files.map((file, index) => (
                <li key={`${file.name}:${file.size}:${index}`}>{file.name}</li>
              ))}
            </ol>
          )}
        </div>
      )}
      <div className="grid gap-3 lg:grid-cols-3">
        <label className="text-xs text-[var(--muted)] lg:col-span-3" htmlFor="batch-prompt">
          Prompt, optional
          <textarea
            id="batch-prompt"
            className="input mt-1 min-h-[72px] resize-y"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Leave empty and each shot uses the still's file name."
          />
        </label>
        <label className="text-xs text-[var(--muted)]" htmlFor="batch-backend">
          Backend
          <select
            id="batch-backend"
            className="input mt-1"
            value={backend}
            onChange={(e) => setBackend(e.target.value)}
          >
            <option value="">Project default ({CAPABILITY[provider].title})</option>
            {PROVIDERS.map((id) => (
              <option key={id} value={id}>
                {CAPABILITY[id].title}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-[var(--muted)]" htmlFor="batch-duration">
          Seconds, optional
          <input
            id="batch-duration"
            className="input mt-1"
            type="number"
            min={MIN_SHOT_SECONDS}
            max={MAX_SHOT_SECONDS}
            step={1}
            value={duration}
            placeholder={String(preset.durationSec)}
            onChange={(e) => setDuration(e.target.value)}
          />
        </label>
        <div className="flex items-end">
          <button type="submit" className="btn-primary w-full" disabled={saving || files.length === 0 || overLimit}>
            {saving ? "Adding…" : "Add shots from stills"}
          </button>
        </div>
      </div>
      <p className="text-[11px] leading-relaxed text-[var(--muted)]">
        Leave the prompt empty and each shot uses the still&apos;s file name. Leave the seconds empty
        and the shot is {preset.durationSec} seconds, {preset.label}, the same default as a new shot.
        Leave the backend on the project default and the provider in Settings stays as it is. Choosing
        one sets the studio provider, the same way the Providers page does. These shots are not rendered.
      </p>
      {problem && (
        <p className="whitespace-pre-wrap text-sm text-rose-100" role="alert">
          {problem}
        </p>
      )}
      {message && <p className="whitespace-pre-wrap text-sm text-white">{message}</p>}
    </form>
  );
}
