import { completedTakesFor, cutTake, type CutCandidate } from "./chain-stale";
import type { Job, JobKind, ProviderId, Shot } from "./types";

/** Free Mock and preview clips. A real provider take is fal, Replicate, or ComfyUI. */
export const MIXED_PASS_HEADING = "MIXED PASSES";

export interface CutPass {
  shotId: string;
  position: number;
  jobId: string;
  provider: ProviderId;
  kind: JobKind;
  stale: boolean;
}

export interface MixedPassReport {
  /** True when Export stitch should stop and ask. */
  warn: boolean;
  /** True when the cut joins a free clip with a real provider take. */
  mixed: boolean;
  /** Free clips named because a real provider take is also in the cut. */
  fallback: CutPass[];
  /** Real provider takes named in a mixed cut. */
  real: CutPass[];
  /** Shots in the cut whose upstream take changed. */
  stale: CutPass[];
  paragraphs: string[];
  /** paragraphs joined with a space. Empty when warn is false. */
  text: string;
}

export function providerContactName(provider: ProviderId): string {
  switch (provider) {
    case "mock":
      return "mock";
    case "fal":
      return "fal";
    case "replicate":
      return "Replicate";
    case "comfyui":
      return "ComfyUI";
  }
}

/** Mock takes and preview clips are the free path. Preview clips are not takes. */
export function isFreePass(provider: ProviderId, kind: JobKind): boolean {
  return kind === "preview" || provider === "mock";
}

export function isRealProvider(provider: ProviderId): boolean {
  return provider === "fal" || provider === "replicate" || provider === "comfyui";
}

function shotName(pass: CutPass): string {
  return `Shot ${pass.position} (${pass.shotId})`;
}

function passName(pass: CutPass): string {
  const provider = providerContactName(pass.provider);
  if (pass.kind === "preview") return `${shotName(pass)} is a preview clip on ${provider}`;
  return `${shotName(pass)} is ${provider}`;
}

/**
 * Names free clips when they share a cut with a real provider take, and names
 * out-of-date shots. The text does not promise that the join will look consistent.
 */
export function describeMixedPass(passes: readonly CutPass[]): MixedPassReport {
  const ordered = [...passes].sort((a, b) => a.position - b.position || a.shotId.localeCompare(b.shotId));
  const free = ordered.filter((pass) => isFreePass(pass.provider, pass.kind));
  const real = ordered.filter((pass) => pass.kind !== "preview" && isRealProvider(pass.provider));
  const mixed = free.length > 0 && real.length > 0;
  const stale = ordered.filter((pass) => pass.stale);
  const fallback = mixed ? free : [];
  const namedReal = mixed ? real : [];
  const warn = mixed || stale.length > 0;
  const paragraphs: string[] = [];
  if (mixed) {
    paragraphs.push(
      `${MIXED_PASS_HEADING}. This cut joins free Mock or preview clips with takes from fal, Replicate, or ComfyUI.`
    );
    paragraphs.push(`Free clips: ${fallback.map(passName).join("; ")}.`);
    paragraphs.push(`Other providers: ${namedReal.map(passName).join("; ")}.`);
    paragraphs.push(
      "Mock is camera motion on the still, not a generated clip. A preview clip is that same free path and is not a take. A fal, Replicate, or ComfyUI take is a different picture. Joining them does not make the shots match, and it does not promise quality."
    );
  }
  if (stale.length > 0) {
    paragraphs.push(
      `Out of date: ${stale.map(shotName).join("; ")}. The previous shot's take changed since this clip was rendered. The stitch still uses that older clip. It does not replace the frame, and it does not promise quality.`
    );
  }
  if (warn) {
    paragraphs.push(
      "Stitch anyway joins these clips as they are. Cancel leaves the cut unstitched. This does not lock a character, lip-sync, or turn the shot list into a long film."
    );
  }
  return {
    warn,
    mixed,
    fallback,
    real: namedReal,
    stale,
    paragraphs,
    text: paragraphs.join(" "),
  };
}

type ReviewShot = Pick<Shot, "id" | "position" | "selectedJobId" | "approvedJobId">;
type ReviewJob = CutCandidate & Pick<Job, "provider">;

/**
 * The takes Export stitch would join, in shot order.
 * A shot with no completed take is left out. Preview clips are not takes.
 */
export function reviewStitchPasses(args: {
  shots: readonly ReviewShot[];
  jobs: readonly ReviewJob[];
  staleShotIds: ReadonlySet<string>;
}): MixedPassReport {
  const shots = [...args.shots].sort((a, b) => a.position - b.position);
  const passes: CutPass[] = [];
  for (const shot of shots) {
    const takes = completedTakesFor(args.jobs, shot.id);
    const job = cutTake(shot.selectedJobId, takes, shot.approvedJobId);
    if (!job?.outputPath) continue;
    const provider = args.jobs.find((item) => item.id === job.id)?.provider;
    if (!provider) continue;
    passes.push({
      shotId: shot.id,
      position: shot.position,
      jobId: job.id,
      provider,
      kind: job.kind === "preview" ? "preview" : "take",
      stale: args.staleShotIds.has(shot.id),
    });
  }
  return describeMixedPass(passes);
}
