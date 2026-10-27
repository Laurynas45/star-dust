import fs from "fs";
import path from "path";
import { canonicalFps } from "./conform";
import { ffmpegFilters } from "./ffmpeg";
import type { CaptionMode } from "./types";

export interface SrtCue {
  index: number;
  startSec: number;
  endSec: number;
  text: string;
}

export const SRT_CUE_LIMIT = 2000;

export const BURN_FONT_NAME = "DejaVu Sans";
export const BURN_FONT_CANDIDATES = ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"];

export const BURN_RENDERER_MISSING =
  "Burn-in needs ffmpeg's subtitles filter (libass). This ffmpeg does not include it, so captions were not drawn. Choose a sidecar .srt, or install an ffmpeg built with libass.";

export const BURN_FONT_MISSING =
  "Burn-in needs DejaVu Sans from the fonts-dejavu-core package. That font is not installed, so captions were not drawn. Choose a sidecar .srt, or install fonts-dejavu-core.";

const STAMP =
  /^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})/;

function clockSeconds(hours: string, minutes: string, seconds: string, millis: string): number | null {
  const hh = Number(hours);
  const mm = Number(minutes);
  const ss = Number(seconds);
  const ms = Number(millis.padEnd(3, "0").slice(0, 3));
  if (![hh, mm, ss, ms].every((part) => Number.isFinite(part))) return null;
  if (mm > 59 || ss > 59) return null;
  return hh * 3600 + mm * 60 + ss + ms / 1000;
}

/**
 * Parse an SRT file. Every problem is listed. A file with any error is not a
 * usable cue list: cues is empty whenever errors is not.
 */
export function parseSrt(raw: string): { cues: SrtCue[]; errors: string[] } {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!text) return { cues: [], errors: ["The SRT file is empty."] };
  if (!text.includes("-->")) {
    return {
      cues: [],
      errors: [
        "This is not an SRT file. Each cue needs a number, a line like 00:00:01,000 --> 00:00:02,000, and the caption text.",
      ],
    };
  }

  const cues: SrtCue[] = [];
  const errors: string[] = [];
  let seen = 0;
  for (const block of text.split(/\n{2,}/)) {
    const content = block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (content.length === 0) continue;
    seen += 1;
    const label = `Cue ${seen}`;
    let cursor = 0;
    if (/^\d+$/.test(content[0])) cursor = 1;
    const stamp = content[cursor] ?? "";
    if (!stamp.includes("-->")) {
      errors.push(`${label}: missing a timestamp line like 00:00:01,000 --> 00:00:02,000.`);
      continue;
    }
    const match = STAMP.exec(stamp);
    if (!match) {
      errors.push(`${label}: the timestamp is not HH:MM:SS,mmm.`);
      continue;
    }
    const startSec = clockSeconds(match[1], match[2], match[3], match[4]);
    const endSec = clockSeconds(match[5], match[6], match[7], match[8]);
    if (startSec == null || endSec == null) {
      errors.push(`${label}: the timestamp is not a real clock time.`);
      continue;
    }
    if (endSec <= startSec) {
      errors.push(`${label}: the end time is not after the start time.`);
      continue;
    }
    const cueText = content.slice(cursor + 1).join("\n").trim();
    if (!cueText) {
      errors.push(`${label}: the caption text is empty.`);
      continue;
    }
    cues.push({ index: cues.length + 1, startSec, endSec, text: cueText });
  }

  if (seen === 0 || (cues.length === 0 && errors.length === 0)) {
    errors.push("No cues. An SRT needs at least one numbered cue with a start and end time.");
  }
  if (cues.length > SRT_CUE_LIMIT) {
    errors.push(`This SRT has ${cues.length} cues. The limit is ${SRT_CUE_LIMIT}.`);
  }
  if (errors.length > 0) return { cues: [], errors };
  return { cues, errors };
}

export function readSrtFile(file: string): { cues: SrtCue[]; errors: string[] } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { cues: [], errors: ["The SRT file is missing. Import it again."] };
  }
  return parseSrt(raw);
}

/** Nearest frame on the conformed rate. The clock time stays, the picture is not sped up. */
export function snapSeconds(sec: number, fps: number): number {
  const rate = canonicalFps(fps);
  if (!Number.isFinite(sec) || sec <= 0) return 0;
  return Math.round(sec * rate) / rate;
}

export function formatSrtTimestamp(sec: number): string {
  const totalMs = Math.max(0, Math.round(sec * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const millis = totalMs % 1000;
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

/**
 * Cue times on the finished cut. They snap to the conformed frame rate and
 * stop at the end of that cut. A cue that starts after the cut is left out.
 */
export function cuesOnTimeline(cues: readonly SrtCue[], fps: number, durationSec: number): SrtCue[] {
  const rate = canonicalFps(fps);
  const frame = 1 / rate;
  const limit = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  const out: SrtCue[] = [];
  for (const cue of cues) {
    const startSec = snapSeconds(cue.startSec, rate);
    let endSec = snapSeconds(cue.endSec, rate);
    if (endSec <= startSec) endSec = startSec + frame;
    if (limit > 0 && startSec >= limit - 0.0005) continue;
    if (limit > 0) endSec = Math.min(endSec, limit);
    if (endSec <= startSec + 0.0005) continue;
    out.push({ index: out.length + 1, startSec, endSec, text: cue.text });
  }
  return out;
}

export function formatSrt(cues: readonly SrtCue[]): string {
  if (cues.length === 0) return "";
  return (
    cues
      .map(
        (cue, index) =>
          `${index + 1}\n${formatSrtTimestamp(cue.startSec)} --> ${formatSrtTimestamp(cue.endSec)}\n${cue.text}\n`
      )
      .join("\n") + "\n"
  );
}

export function findBurnFont(exists: (file: string) => boolean = fs.existsSync): string | null {
  for (const file of BURN_FONT_CANDIDATES) {
    if (exists(file)) return file;
  }
  return null;
}

/** Pure check used by the stitch and by tests. A missing renderer or font is named. */
export function burnInProblemFrom(filters: string, fontPath: string | null): string | null {
  if (!/\bsubtitles\b/.test(filters)) return BURN_RENDERER_MISSING;
  if (!fontPath) return BURN_FONT_MISSING;
  return null;
}

export function burnInProblem(): string | null {
  return burnInProblemFrom(ffmpegFilters(), findBurnFont());
}

export function escapeFilterPath(file: string): string {
  return file.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

/** libass burn-in. FontName is DejaVu Sans, which fonts-dejavu-core installs. */
export function subtitlesVideoFilter(srtPath: string, fontFile: string): string {
  const file = escapeFilterPath(srtPath);
  const fontsDir = escapeFilterPath(path.dirname(fontFile));
  const style = [
    `FontName=${BURN_FONT_NAME}`,
    "FontSize=22",
    "PrimaryColour=&H00FFFFFF",
    "OutlineColour=&H00000000",
    "BorderStyle=1",
    "Outline=2",
    "Shadow=0",
    "Alignment=2",
    "MarginV=36",
  ].join(",");
  return `subtitles=filename='${file}':fontsdir='${fontsDir}':force_style='${style}'`;
}

export function captionPhrase(count: number, mode: CaptionMode): string {
  const noun = count === 1 ? "caption" : "captions";
  const how = mode === "burn" ? "burned in" : "as a sidecar";
  return `${count} ${noun} ${how}`;
}
