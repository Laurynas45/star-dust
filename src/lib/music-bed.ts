import { captionPhrase } from "./captions";
import type { CaptionMode, FinishView } from "./types";

export const AUDIO_EXTENSIONS: readonly string[] = [".wav", ".mp3", ".m4a", ".aac", ".ogg", ".flac", ".aiff", ".aif"];

/**
 * Bed processing, then a sidechain against clip audio when the cut has any.
 * A short file is looped by the caller (`-stream_loop -1`) and trimmed here.
 * Fade-out always lands at the end of the cut.
 */
export function musicFilter(input: {
  durationSec: number;
  levelDb: number;
  fadeInSec: number;
  fadeOutSec: number;
  duck: boolean;
}): string {
  const duration = Math.max(0.05, input.durationSec);
  const fadeIn = Math.min(Math.max(0, input.fadeInSec), duration / 2);
  const fadeOut = Math.min(Math.max(0, input.fadeOutSec), duration / 2);
  const fadeOutStart = Math.max(0, duration - fadeOut);
  const fades = [
    fadeIn > 0 ? `afade=t=in:st=0:d=${fadeIn.toFixed(3)}` : "",
    fadeOut > 0 ? `afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOut.toFixed(3)}` : "",
  ].filter((part) => part.length > 0);
  const chain = [
    "aformat=sample_rates=48000:channel_layouts=stereo",
    `volume=${input.levelDb.toFixed(1)}dB`,
    ...fades,
    `atrim=start=0:end=${duration.toFixed(3)}`,
    "asetpts=PTS-STARTPTS",
  ].join(",");
  if (!input.duck) return `[1:a]${chain}[a]`;
  return [
    `[1:a]${chain}[bed]`,
    "[0:a]aformat=sample_rates=48000:channel_layouts=stereo,asplit=2[dry][sc]",
    "[bed][sc]sidechaincompress=threshold=0.02:ratio=20:attack=20:release=400:makeup=1[ducked]",
    "[dry][ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]",
  ].join(";");
}

export function musicFitsByLoop(musicSec: number, cutSec: number): boolean {
  return Number.isFinite(musicSec) && Number.isFinite(cutSec) && musicSec + 0.05 < cutSec;
}

export function musicFitNote(loops: boolean): string {
  return loops
    ? "The bed loops to fill the cut and fades out at the end."
    : "The bed fades out to fit the cut.";
}

/**
 * What the preview cut and the stitch will add.
 * "music bed, ducked; 14 captions burned in" when a bed ducks and captions burn in.
 */
export function finishLine(input: {
  hasMusic: boolean;
  anyClipAudio: boolean;
  captionCount: number;
  captionMode: CaptionMode | null;
}): string {
  const parts: string[] = [];
  if (input.hasMusic) {
    parts.push(input.anyClipAudio ? "music bed, ducked" : "music bed, at its level");
  }
  if (input.captionCount > 0 && input.captionMode) {
    parts.push(captionPhrase(input.captionCount, input.captionMode));
  }
  return parts.join("; ");
}

export function describeFinish(input: {
  hasMusic: boolean;
  anyClipAudio: boolean;
  captionCount: number;
  captionMode: CaptionMode | null;
  captionErrors?: string[];
  loudnessOn: boolean;
  musicLoops?: boolean | null;
}): FinishView {
  const line = finishLine(input);
  const loudnessNote = !input.hasMusic
    ? null
    : input.loudnessOn
      ? "The final file is mastered to −14 LUFS."
      : "Loudness is off, so the bed stays at the level you set.";
  return {
    line,
    music: input.hasMusic ? (input.anyClipAudio ? "ducked" : "level") : null,
    captions:
      input.captionCount > 0 && input.captionMode
        ? { count: input.captionCount, mode: input.captionMode }
        : null,
    captionErrors: input.captionErrors ?? [],
    loudnessNote,
    fitNote:
      input.hasMusic && input.musicLoops != null ? musicFitNote(input.musicLoops) : null,
  };
}
