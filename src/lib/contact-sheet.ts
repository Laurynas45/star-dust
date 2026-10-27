import fs from "fs";
import os from "os";
import path from "path";
import { findBurnFont } from "./captions";
import { ffmpegFilters, runFfmpeg } from "./ffmpeg";
import { providerContactName } from "./mixed-pass";
import type { ProviderId } from "./types";

/** Cells per row. A longer list wraps instead of becoming one wide strip. */
export const CONTACT_COLUMNS = 3;
export const CONTACT_CELL_W = 480;
export const CONTACT_THUMB_H = 270;
export const CONTACT_LABEL_H = 120;
export const CONTACT_CELL_H = CONTACT_THUMB_H + CONTACT_LABEL_H;

export const CONTACT_DRAWTEXT_MISSING =
  "The contact sheet needs ffmpeg's drawtext filter. This ffmpeg does not include it, so the sheet was not written.";

export const CONTACT_FONT_MISSING =
  "The contact sheet needs DejaVu Sans from the fonts-dejavu-core package. That font is not installed, so the labels were not drawn.";

export interface ContactGrid {
  cols: number;
  rows: number;
  width: number;
  height: number;
}

export function contactGrid(count: number): ContactGrid {
  const n = Math.max(1, Math.floor(count));
  const cols = Math.min(CONTACT_COLUMNS, n);
  const rows = Math.ceil(n / cols);
  return {
    cols,
    rows,
    width: cols * CONTACT_CELL_W,
    height: rows * CONTACT_CELL_H,
  };
}

export interface ContactSheetCell {
  abs: string;
  shotId: string;
  /** 1-based place among this shot's completed takes, oldest first. */
  version: number;
  /** Preview clips are not takes. The label says so. */
  preview: boolean;
  provider: ProviderId;
  seed: number | null;
  durationSec: number;
}

/** Same ordering as the edit-export version number. */
export function contactVersion(takes: readonly { id: string; createdAt: string }[], jobId: string): number {
  const ordered = [...takes].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  );
  const index = ordered.findIndex((take) => take.id === jobId);
  return index < 0 ? 1 : index + 1;
}

function versionTag(version: number): string {
  const number = Math.max(1, Math.round(version));
  return `v${String(number).padStart(2, "0")}`;
}

/**
 * Lines drawn under one thumbnail: shot id, take version, provider, seed, duration.
 * A missing seed stays "unset". The duration is the clip's own length.
 */
export function contactLabelLines(cell: Omit<ContactSheetCell, "abs">): string[] {
  const versionText = cell.preview ? `preview ${versionTag(cell.version)}` : `take ${versionTag(cell.version)}`;
  const seedText = cell.seed == null || !Number.isFinite(cell.seed) ? "seed unset" : `seed ${Math.floor(cell.seed)}`;
  const seconds =
    Number.isFinite(cell.durationSec) && cell.durationSec >= 0 ? `${cell.durationSec.toFixed(2)}s` : "duration unset";
  return [cell.shotId, versionText, providerContactName(cell.provider), seedText, seconds];
}

export function contactSheetProblem(
  filters: string = ffmpegFilters(),
  font: string | null = findBurnFont()
): string | null {
  if (!/\bdrawtext\b/.test(filters)) return CONTACT_DRAWTEXT_MISSING;
  if (!font) return CONTACT_FONT_MISSING;
  return null;
}

function escapeFilterPath(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/,/g, "\\,");
}

/**
 * One PNG, shot order left to right then top to bottom.
 * ffmpeg draws the labels. An empty list is an error, not a blank image.
 */
export async function writeContactSheet(cells: readonly ContactSheetCell[], destAbs: string): Promise<void> {
  if (cells.length === 0) {
    throw new Error("A contact sheet needs at least one shot.");
  }
  const font = findBurnFont();
  const problem = contactSheetProblem(ffmpegFilters(), font);
  if (problem || !font) throw new Error(problem ?? CONTACT_FONT_MISSING);

  const grid = contactGrid(cells.length);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "star-dust-sheet-"));
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  try {
    const args: string[] = ["-y"];
    const filters: string[] = [];
    const tags: string[] = [];
    cells.forEach((cell, index) => {
      args.push("-i", cell.abs);
      const textFile = path.join(dir, `label-${index}.txt`);
      fs.writeFileSync(textFile, `${contactLabelLines(cell).join("\n")}\n`);
      const tag = `c${index}`;
      filters.push(
        `[${index}:v]trim=end_frame=1,setpts=PTS-STARTPTS,scale=${CONTACT_CELL_W}:${CONTACT_THUMB_H}:force_original_aspect_ratio=decrease,pad=${CONTACT_CELL_W}:${CONTACT_THUMB_H}:(ow-iw)/2:(oh-ih)/2:color=0x111111,pad=${CONTACT_CELL_W}:${CONTACT_CELL_H}:0:0:color=0x1a1a1a,fps=25,format=rgb24,drawtext=fontfile=${escapeFilterPath(font)}:textfile=${escapeFilterPath(textFile)}:expansion=none:fontcolor=white:fontsize=16:line_spacing=6:x=12:y=${CONTACT_THUMB_H + 8}[${tag}]`
      );
      tags.push(`[${tag}]`);
    });
    const blanks = grid.cols * grid.rows - cells.length;
    for (let blank = 0; blank < blanks; blank += 1) {
      const index = cells.length + blank;
      args.push(
        "-f",
        "lavfi",
        "-t",
        "1",
        "-i",
        `color=c=0x1a1a1a:s=${CONTACT_CELL_W}x${CONTACT_CELL_H}:r=25`
      );
      const tag = `c${index}`;
      filters.push(
        `[${index}:v]trim=end_frame=1,setpts=PTS-STARTPTS,scale=${CONTACT_CELL_W}:${CONTACT_CELL_H},fps=25,format=rgb24[${tag}]`
      );
      tags.push(`[${tag}]`);
    }

    const rowTags: string[] = [];
    for (let row = 0; row < grid.rows; row += 1) {
      const rowInputs = tags.slice(row * grid.cols, (row + 1) * grid.cols);
      const rowTag = `r${row}`;
      filters.push(
        rowInputs.length === 1
          ? `${rowInputs[0]}copy[${rowTag}]`
          : `${rowInputs.join("")}hstack=inputs=${rowInputs.length}[${rowTag}]`
      );
      rowTags.push(`[${rowTag}]`);
    }
    const outTag = grid.rows === 1 ? "r0" : "sheet";
    if (grid.rows > 1) {
      filters.push(`${rowTags.join("")}vstack=inputs=${grid.rows}[${outTag}]`);
    }
    args.push("-filter_complex", filters.join(";"), "-map", `[${outTag}]`, "-frames:v", "1", "-update", "1", destAbs);
    try {
      await runFfmpeg(args);
    } catch (error) {
      fs.rmSync(destAbs, { force: true });
      throw error;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
