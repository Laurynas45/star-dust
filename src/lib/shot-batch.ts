import { MOTION_PRESETS } from "./types";

/**
 * One request. Each still still has the 12 MB limit used when adding one shot.
 * Forty is enough for a folder of stills and stays under the shot-list cap.
 */
export const MAX_BATCH_SHOTS = 40;

/** Multipart field. Repeat it once per still. */
export const BATCH_IMAGE_FIELD = "images";

export type RejectedStill = {
  name: string;
  error: string;
};

/** Base name only, so a path is not echoed back. */
export function stillFileName(name: string): string {
  const base = name.split(/[/\\]/).pop()?.trim();
  return base || "image";
}

/**
 * Prompt used when the shared prompt is empty.
 * The last extension is removed. `shot10.png` becomes `shot10`.
 */
export function promptFromStillName(filename: string): string {
  const base = stillFileName(filename);
  const stem = base.replace(/\.[^.]+$/, "").trim();
  return stem || "Still";
}

/** File-name order. `shot2.png` comes before `shot10.png`. Case does not matter. */
export function naturalCompare(a: string, b: string): number {
  const primary = a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
  if (primary !== 0) return primary;
  return a.localeCompare(b, "en", { numeric: true });
}

export function sortByFileName<T extends { name: string }>(files: readonly T[]): T[] {
  return files
    .map((file, index) => ({ file, index }))
    .sort((a, b) => {
      const byName = naturalCompare(stillFileName(a.file.name), stillFileName(b.file.name));
      if (byName !== 0) return byName;
      return a.index - b.index;
    })
    .map((item) => item.file);
}

export function defaultBatchDurationSec(): number {
  return MOTION_PRESETS[0].durationSec;
}

export function tooManyStillsError(count: number): string {
  return `This request has ${count} stills. The limit is ${MAX_BATCH_SHOTS}.`;
}

export function batchAddedText(
  added: number,
  rejected: readonly RejectedStill[],
  providerTitle?: string | null
): string {
  const count = added === 1 ? "Added 1 shot." : `Added ${added} shots.`;
  const skipped = rejected.length
    ? ` Not added: ${rejected.map((item) => `${item.name} (${item.error})`).join(" ")}.`
    : "";
  const backend = providerTitle ? ` Studio provider is ${providerTitle}.` : "";
  return `${count}${skipped}${backend} Nothing was rendered.`;
}

export function batchFailureText(rejected: readonly RejectedStill[]): string {
  if (rejected.length === 0) return "No shots were added.";
  const names = rejected.map((item) => `${item.name}: ${item.error}`).join(" ");
  return `No shots were added. ${names}`;
}
