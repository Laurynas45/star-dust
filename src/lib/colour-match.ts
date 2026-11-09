/**
 * Even out colour between shots at stitch time. ffmpeg only.
 *
 * The reference is the first clip included in that stitch. Each later clip
 * whose boundary is on is matched to that reference with one Reinhard
 * transfer in CIE LAB (D65). Mean and standard deviation come from every
 * frame, area-downscaled, so the statistic is the whole clip. One 3D LUT
 * is then applied to every frame. Nothing is measured per frame, so the
 * grade does not flicker.
 *
 * A boundary that is off keeps that clip's own colour. Matching shot 3 to
 * the first shot, while shot 2 is left alone, does not follow shot 2.
 *
 * This evens overall colour and brightness. It does not change who is in
 * the shot or what they are wearing.
 */

import { spawnSync } from "child_process";
import fs from "fs";
import { probeHasAudio, runFfmpeg } from "./ffmpeg";

/** Below this CIE LAB standard deviation, contrast is not scaled. Encoder noise on a flat field stays put. */
const STD_FLOOR = 1;
/** Contrast scale is clamped so a short generated clip is not blown out or crushed. */
const GAIN_MIN = 0.5;
const GAIN_MAX = 2;
/** Area-downscaled sample. The mean of a frame is kept; the grade is still one number for the clip. */
const SAMPLE_W = 24;
const SAMPLE_H = 14;
const LUT_SIZE = 17;
/** A gain this close to 1 and an offset this small in LAB is left ungraded. */
const IDENTITY_GAIN = 0.02;
const IDENTITY_OFFSET = 0.75;

const D65 = { x: 0.95047, y: 1, z: 1.08883 };

export interface Lab {
  L: number;
  a: number;
  b: number;
}

export interface LabStats {
  mean: Lab;
  std: Lab;
  samples: number;
}

/** out = in * gain + offset, per CIE LAB channel. */
export interface LabAffine {
  gain: Lab;
  offset: Lab;
}

export type ColourRole = "reference" | "evened" | "kept";

export interface ColourShotReport {
  shotId: string;
  position: number;
  role: ColourRole;
  /** Why a later shot was not graded. Absent on the reference and on an evened shot. */
  reason?: "off" | "close";
  /** Plain sentence for a later shot. Absent on the reference. */
  note?: string;
}

export interface StitchColour {
  /**
   * True when at least one later shot resolved Even out colour on,
   * including a shot that was already close and was not re-encoded.
   */
  active: boolean;
  /** How the reference was chosen. */
  reference: "first-included-shot";
  referenceShotId: string;
  summary: string;
  shots: ColourShotReport[];
}

export interface ColourClipInput {
  shotId: string;
  position: number;
  /** File that is joined. A seam preview passes the short window. */
  abs: string;
  evenColour?: boolean | null;
}

function srgbToLinear(channel: number): number {
  const x = channel / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
  const x = channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, x)) * 255);
}

function labF(t: number): number {
  const delta = 6 / 29;
  return t > delta ** 3 ? Math.cbrt(t) : t / (3 * delta * delta) + 4 / 29;
}

function labFInv(t: number): number {
  const delta = 6 / 29;
  return t > delta ? t ** 3 : 3 * delta * delta * (t - 4 / 29);
}

/** sRGB 0–255 to CIE LAB D65. */
export function rgbToLab(r: number, g: number, b: number): Lab {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  const x = 0.4124564 * R + 0.3575761 * G + 0.1804375 * B;
  const y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const z = 0.0193339 * R + 0.119192 * G + 0.9503041 * B;
  const fx = labF(x / D65.x);
  const fy = labF(y / D65.y);
  const fz = labF(z / D65.z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** CIE LAB D65 to sRGB 0–255. Out-of-gamut channels are clipped. */
export function labToRgb(lab: Lab): { r: number; g: number; b: number } {
  const fy = (lab.L + 16) / 116;
  const fx = fy + lab.a / 500;
  const fz = fy - lab.b / 200;
  const x = D65.x * labFInv(fx);
  const y = D65.y * labFInv(fy);
  const z = D65.z * labFInv(fz);
  const R = 3.2404542 * x + -1.5371385 * y + -0.4985314 * z;
  const G = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const B = 0.0556434 * x + -0.2040259 * y + 1.0572252 * z;
  return { r: linearToSrgb(R), g: linearToSrgb(G), b: linearToSrgb(B) };
}

function gainFor(srcStd: number, refStd: number): number {
  if (!(srcStd >= STD_FLOOR) || !(refStd >= 0)) return 1;
  const raw = refStd / srcStd;
  if (!Number.isFinite(raw)) return 1;
  return Math.min(GAIN_MAX, Math.max(GAIN_MIN, raw));
}

/** Reinhard transfer: match mean and standard deviation per LAB channel. */
export function reinhardAffine(src: LabStats, ref: LabStats): LabAffine {
  const gain = {
    L: gainFor(src.std.L, ref.std.L),
    a: gainFor(src.std.a, ref.std.a),
    b: gainFor(src.std.b, ref.std.b),
  };
  return {
    gain,
    offset: {
      L: ref.mean.L - src.mean.L * gain.L,
      a: ref.mean.a - src.mean.a * gain.a,
      b: ref.mean.b - src.mean.b * gain.b,
    },
  };
}

export function applyAffine(lab: Lab, affine: LabAffine): Lab {
  return {
    L: Math.min(100, Math.max(0, lab.L * affine.gain.L + affine.offset.L)),
    a: Math.min(128, Math.max(-128, lab.a * affine.gain.a + affine.offset.a)),
    b: Math.min(128, Math.max(-128, lab.b * affine.gain.b + affine.offset.b)),
  };
}

export function applyAffineToRgb(
  rgb: { r: number; g: number; b: number },
  affine: LabAffine
): { r: number; g: number; b: number } {
  return labToRgb(applyAffine(rgbToLab(rgb.r, rgb.g, rgb.b), affine));
}

/** True when the transfer would not move a typical pixel enough to re-encode. */
export function affineIsClose(affine: LabAffine): boolean {
  const channels: (keyof Lab)[] = ["L", "a", "b"];
  return channels.every(
    (channel) =>
      Math.abs(affine.gain[channel] - 1) <= IDENTITY_GAIN &&
      Math.abs(affine.offset[channel]) <= IDENTITY_OFFSET
  );
}

/** Mean and population standard deviation of packed RGB bytes (3 bytes per sample). */
export function labStatsFromRgb(bytes: Buffer): LabStats {
  const samples = Math.floor(bytes.length / 3);
  if (samples < 1) {
    return { mean: { L: 0, a: 0, b: 0 }, std: { L: 0, a: 0, b: 0 }, samples: 0 };
  }
  let sumL = 0;
  let sumA = 0;
  let sumB = 0;
  const labs: Lab[] = new Array(samples);
  for (let index = 0; index < samples; index += 1) {
    const lab = rgbToLab(bytes[index * 3], bytes[index * 3 + 1], bytes[index * 3 + 2]);
    labs[index] = lab;
    sumL += lab.L;
    sumA += lab.a;
    sumB += lab.b;
  }
  const mean = { L: sumL / samples, a: sumA / samples, b: sumB / samples };
  let varL = 0;
  let varA = 0;
  let varB = 0;
  for (const lab of labs) {
    varL += (lab.L - mean.L) ** 2;
    varA += (lab.a - mean.a) ** 2;
    varB += (lab.b - mean.b) ** 2;
  }
  return {
    mean,
    std: { L: Math.sqrt(varL / samples), a: Math.sqrt(varA / samples), b: Math.sqrt(varB / samples) },
    samples,
  };
}

/**
 * A shot override wins. Otherwise the project flag. Missing means off.
 * The first included shot is the reference either way.
 */
export function resolveEvenColour(
  project: { evenColour?: boolean | null },
  shot: { evenColour?: boolean | null }
): boolean {
  if (typeof shot.evenColour === "boolean") return shot.evenColour;
  return project.evenColour === true;
}

function listPositions(shots: ColourShotReport[]): string {
  const names = shots.map((shot) => `shot ${shot.position}`);
  if (names.length <= 1) return names[0] ?? "the later shot";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

export const COLOUR_FLICKER_SENTENCE =
  "One measurement for each whole clip, so the grade does not flicker.";

export const COLOUR_LIMIT_SENTENCE = "This does not fix a character or an outfit.";

/** What the stitch card and the manifest say about this cut. */
export function colourMatchSummary(shots: ColourShotReport[], active: boolean): string {
  if (!active) return "Colour and brightness were left as rendered.";
  const evened = shots.filter((shot) => shot.role === "evened");
  const close = shots.filter((shot) => shot.reason === "close");
  const off = shots.filter((shot) => shot.reason === "off");
  const parts: string[] = [];
  if (evened.length > 0) {
    parts.push(
      `Evened overall colour and brightness of ${listPositions(evened)} to the first included shot.`
    );
  }
  if (close.length > 0 && evened.length === 0 && off.length === 0) {
    parts.push(
      "Even out colour between shots was on. The later shots were already close to the first included shot, so they were left as rendered."
    );
  } else if (close.length > 0) {
    const verb = close.length === 1 ? "was" : "were";
    const pronoun = close.length === 1 ? "that shot was" : "those shots were";
    const named = listPositions(close);
    parts.push(
      `${named.charAt(0).toUpperCase()}${named.slice(1)} ${verb} already close to the first included shot, so ${pronoun} left as rendered.`
    );
  }
  if (off.length > 0 && evened.length === 0 && close.length === 0) {
    parts.push(
      "Even out colour between shots was on for the project, and each later shot was set to leave colour as rendered."
    );
  } else if (off.length > 0) {
    const own = off.length === 1 ? "its" : "their";
    const named = listPositions(off);
    parts.push(`${named.charAt(0).toUpperCase()}${named.slice(1)} kept ${own} own colour.`);
  }
  if (parts.length === 0) {
    parts.push("Even out colour between shots was on. Colour and brightness were left as rendered.");
  }
  parts.push(COLOUR_FLICKER_SENTENCE);
  parts.push(COLOUR_LIMIT_SENTENCE);
  return parts.join(" ");
}

function finishColour(shots: ColourShotReport[], active: boolean, referenceShotId: string): StitchColour {
  const published = active
    ? shots
    : shots.map((shot) =>
        shot.role === "reference"
          ? { shotId: shot.shotId, position: shot.position, role: "reference" as const }
          : { shotId: shot.shotId, position: shot.position, role: "kept" as const }
      );
  const reference = published.find((shot) => shot.role === "reference");
  return {
    active,
    reference: "first-included-shot",
    referenceShotId: reference?.shotId ?? referenceShotId,
    summary: colourMatchSummary(published, active),
    shots: published,
  };
}

/** Adobe-style .cube. R changes fastest. Values are 0–1 sRGB. */
export function reinhardCube(affine: LabAffine): string {
  const lines = ['TITLE "stardust-even-colour"', `LUT_3D_SIZE ${LUT_SIZE}`, ""];
  const denom = LUT_SIZE - 1;
  for (let b = 0; b < LUT_SIZE; b += 1) {
    for (let g = 0; g < LUT_SIZE; g += 1) {
      for (let r = 0; r < LUT_SIZE; r += 1) {
        const rgb = applyAffineToRgb(
          { r: (r / denom) * 255, g: (g / denom) * 255, b: (b / denom) * 255 },
          affine
        );
        lines.push(
          `${(rgb.r / 255).toFixed(6)} ${(rgb.g / 255).toFixed(6)} ${(rgb.b / 255).toFixed(6)}`
        );
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function filterPath(file: string): string {
  return file.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

/** Whole-clip LAB statistic. Area scale keeps each frame's mean. */
export function measureClipLab(file: string): LabStats {
  const probe = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      file,
      "-vf",
      `scale=${SAMPLE_W}:${SAMPLE_H}:flags=area,format=rgb24`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { maxBuffer: 32 * 1024 * 1024 }
  );
  if (probe.error) {
    const code = (probe.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error("ffmpeg is not on PATH. Install ffmpeg and try again.");
    throw probe.error;
  }
  const bytes = probe.stdout;
  if (probe.status !== 0 || !Buffer.isBuffer(bytes) || bytes.length < 3) {
    const detail = Buffer.isBuffer(probe.stderr) ? probe.stderr.toString().slice(-400) : String(probe.stderr ?? "");
    throw new Error(detail || "Could not read colour from the clip.");
  }
  const stats = labStatsFromRgb(bytes);
  if (stats.samples < 1) throw new Error("Could not read colour from the clip.");
  return stats;
}

async function gradeFile(src: string, dest: string, cubePath: string): Promise<void> {
  const audio = probeHasAudio(src) ? ["-c:a", "copy"] : ["-an"];
  const cube = filterPath(cubePath);
  await runFfmpeg([
    "-y",
    "-i",
    src,
    "-vf",
    `format=rgb24,lut3d=file='${cube}':interp=tetrahedral,format=yuv420p`,
    "-fps_mode",
    "passthrough",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    ...audio,
    "-movflags",
    "+faststart",
    dest,
  ]);
}

export interface EvenOutResult {
  /** Joined path for each shot. The reference and untouched shots keep their file. */
  paths: Map<string, string>;
  /** Graded mp4s and LUT files. The caller deletes them after the join. */
  temps: string[];
  colour: StitchColour;
}

/**
 * Grade the clips that resolve on. The file that is measured can differ from
 * the file that is graded: a seam preview grades a short window with the
 * whole-take statistic.
 */
export async function evenOutClips(input: {
  project: { evenColour?: boolean | null };
  clips: ColourClipInput[];
  /** Whole file of the reference shot. Defaults to the first clip. */
  reference?: { shotId: string; abs: string };
  /** Whole-clip file to measure, when it is not clips[].abs. */
  measureAbs?: ReadonlyMap<string, string>;
  destFor: (shotId: string) => string;
}): Promise<EvenOutResult> {
  const clips = input.clips;
  const paths = new Map(clips.map((clip) => [clip.shotId, clip.abs]));
  if (clips.length === 0) {
    return {
      paths,
      temps: [],
      colour: {
        active: false,
        reference: "first-included-shot",
        referenceShotId: "",
        summary: "Colour and brightness were left as rendered.",
        shots: [],
      },
    };
  }
  const referenceId = input.reference?.shotId ?? clips[0].shotId;
  const wants = clips.filter((clip) => clip.shotId !== referenceId && resolveEvenColour(input.project, clip));
  const projectOn = input.project.evenColour === true;
  const explicitOff = clips.some((clip) => clip.shotId !== referenceId && clip.evenColour === false);
  const active = wants.length > 0 || (projectOn && explicitOff);
  const shots: ColourShotReport[] = clips.map((clip) => {
    if (clip.shotId === referenceId) return { shotId: clip.shotId, position: clip.position, role: "reference" };
    if (!resolveEvenColour(input.project, clip)) {
      return {
        shotId: clip.shotId,
        position: clip.position,
        role: "kept",
        reason: "off",
        note: "Left this shot's colour as rendered.",
      };
    }
    return { shotId: clip.shotId, position: clip.position, role: "kept" };
  });
  if (wants.length === 0) {
    return { paths, temps: [], colour: finishColour(shots, active, referenceId) };
  }

  const referenceAbs =
    input.reference?.abs ??
    clips.find((clip) => clip.shotId === referenceId)?.abs ??
    clips[0].abs;
  let refStats: LabStats;
  try {
    refStats = measureClipLab(referenceAbs);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read colour from the first shot.";
    throw new Error(`Could not read colour from the first included shot, so the stitch was not written. ${message}`);
  }

  const temps: string[] = [];
  try {
    for (const clip of wants) {
      const measure = input.measureAbs?.get(clip.shotId) || clip.abs;
      const srcStats = measureClipLab(measure);
      const affine = reinhardAffine(srcStats, refStats);
      const report = shots.find((shot) => shot.shotId === clip.shotId);
      if (!report) continue;
      if (affineIsClose(affine)) {
        report.role = "kept";
        report.reason = "close";
        report.note = "Already close to the first included shot, so colour was left as rendered.";
        continue;
      }
      const dest = input.destFor(clip.shotId);
      const cubePath = `${dest}.cube`;
      temps.push(dest, cubePath);
      fs.writeFileSync(cubePath, reinhardCube(affine));
      await gradeFile(clip.abs, dest, cubePath);
      paths.set(clip.shotId, dest);
      report.role = "evened";
      report.note = "Evened overall colour and brightness to the first included shot.";
    }
  } catch (error) {
    for (const file of temps) fs.rmSync(file, { force: true });
    const message = error instanceof Error ? error.message : "Colour match failed.";
    throw new Error(
      message.includes("Colour") || message.includes("ffmpeg")
        ? message
        : `Could not even out colour, so the stitch was not written. ${message}`
    );
  }
  return { paths, temps, colour: finishColour(shots, true, referenceId) };
}
