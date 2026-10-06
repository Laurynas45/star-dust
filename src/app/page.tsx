"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CAPABILITY } from "@/lib/provider-info";
import { Project, ProviderId } from "@/lib/types";

const ORDER: ProviderId[] = ["mock", "fal", "replicate", "comfyui"];

export default function StudioHome() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/projects");
      if (!res.ok) throw new Error("Failed to load projects");
      setProjects(await res.json());
      setError(null);
    } catch {
      setError("Could not load the studio. Is the server running?");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description }),
      });
      if (!res.ok) throw new Error("Create failed");
      const project = (await res.json()) as Project;
      window.location.href = `/projects/${project.id}`;
    } catch {
      setError("Could not create the project");
      setCreating(false);
    }
  }

  async function onDelete(id: string, projectName: string) {
    if (!confirm(`Delete “${projectName}”? Clips in this project go with it.`)) return;
    await fetch(`/api/projects/${id}`, { method: "DELETE" });
    void load();
  }

  const sample = projects.find((project) => project.isSample);
  const rest = projects.filter((project) => !project.isSample);

  return (
    <div className="space-y-10">
      <section className="grid items-end gap-8 lg:grid-cols-[1.4fr_1fr]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-violet-300">
            Shot list · Render all · Export stitch
          </p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-white sm:text-5xl">
            One still becomes a clip. A shot list becomes a film.
          </h1>
          <p className="mt-4 max-w-xl text-sm leading-relaxed text-[var(--muted)]">
            Star Dust is a local image-to-video studio. Mock renders camera
            motion with ffmpeg and no GPU. Preview cut plays the whole list that
            way for $0, and it does not replace a take. When you want a cloud
            model, you bring the key. The unit of work is one clip from a still.
            Stitch joins those clips — it does not call another model.
          </p>
        </div>
        <ol className="grid gap-2 sm:grid-cols-3 lg:grid-cols-1">
          {[
            ["01", "Shot list", "Start still, optional end still, prompt, duration, preset."],
            ["02", "Render all", "Shots run in order. A matching completed take is skipped."],
            ["03", "Export stitch", "ffmpeg writes one mp4 from the completed clips."],
          ].map(([index, title, copy]) => (
            <li key={index} className="panel flex gap-3 p-3">
              <span className="font-mono text-xs text-violet-300">{index}</span>
              <div>
                <div className="text-sm font-medium text-white">{title}</div>
                <p className="text-xs text-[var(--muted)]">{copy}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="grid gap-2 sm:grid-cols-2">
        {ORDER.map((id) => (
          <div key={id} className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)]/60 px-3 py-2">
            <div className="text-xs font-semibold text-white">{CAPABILITY[id].title}</div>
            <p className="text-xs text-[var(--muted)]">{CAPABILITY[id].label}</p>
          </div>
        ))}
      </section>

      {sample && (
        <Link
          href={`/projects/${sample.id}`}
          className="panel group grid overflow-hidden transition hover:border-violet-500/40 md:grid-cols-[280px_1fr]"
        >
          <div className="relative min-h-44 bg-black">
            {sample.coverPath ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/media/${sample.coverPath}`}
                alt="Harbor dusk sample still"
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">
                Sample still
              </div>
            )}
          </div>
          <div className="flex flex-col justify-between p-5">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-300">
                Included sample
              </p>
              <h2 className="mt-1 text-2xl font-semibold text-white">{sample.name}</h2>
              <p className="mt-2 text-sm text-[var(--muted)]">{sample.description}</p>
            </div>
            <div className="mt-4 flex items-center justify-between text-sm">
              <span className="text-[var(--muted)]">
                {sample.shotCount ?? 0} shots
                {sample.completedCount ? ` · ${sample.completedCount} clips` : ""}
              </span>
              <span className="text-violet-200 group-hover:text-white">Open the shot list →</span>
            </div>
          </div>
        </Link>
      )}

      <section className="panel p-5">
        <h2 className="text-sm font-semibold text-violet-200">New project</h2>
        <form onSubmit={onCreate} className="mt-4 grid gap-4 md:grid-cols-[1fr_1fr_auto]">
          <div>
            <label className="label" htmlFor="project-name">
              Name
            </label>
            <input
              id="project-name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Night market"
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="project-description">
              Note
            </label>
            <input
              id="project-description"
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
            />
          </div>
          <div className="flex items-end">
            <button type="submit" className="btn-primary w-full md:w-auto" disabled={creating}>
              {creating ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
        {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-white">Your projects</h2>
        {loading ? (
          <p className="text-sm text-[var(--muted)]">Loading the studio…</p>
        ) : rest.length === 0 ? (
          <div className="panel p-8 text-sm text-[var(--muted)]">
            Nothing else yet. The Harbor dusk sample is enough to render a mock
            mp4, or create a project above.
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {rest.map((project) => (
              <li key={project.id} className="panel group flex flex-col p-4">
                <div className="flex items-start justify-between gap-2">
                  <Link href={`/projects/${project.id}`} className="text-lg font-medium text-white hover:text-violet-200">
                    {project.name}
                  </Link>
                  <button
                    type="button"
                    className="btn-ghost !px-2 !py-1 text-xs"
                    onClick={() => onDelete(project.id, project.name)}
                  >
                    Delete
                  </button>
                </div>
                {project.description && (
                  <p className="mt-1 line-clamp-2 text-sm text-[var(--muted)]">{project.description}</p>
                )}
                <div className="mt-4 flex items-center justify-between text-[11px] text-[var(--muted)]">
                  <span>
                    {project.shotCount ?? 0} shots · {project.completedCount ?? 0} clips
                  </span>
                  <Link href={`/projects/${project.id}`} className="text-violet-300">
                    Open
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
