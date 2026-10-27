import fs from "fs";
import { readSrtFile } from "./captions";
import { masterLoudnessOn } from "./conform";
import { probeDurationSec } from "./ffmpeg";
import { describeFinish, musicFitsByLoop } from "./music-bed";
import { resolveDataPath } from "./storage";
import type { FinishView, Project } from "./types";

/**
 * What a cut will add before ffmpeg runs.
 * Preview clips from Mock have no audio, so pass anyClipAudio false for that card.
 * Export stitch passes whether a take in the cut has an audio stream.
 */
export function planProjectFinish(
  project: Project,
  input: { anyClipAudio: boolean; cutSec: number | null }
): FinishView {
  const errors: string[] = [];
  let count = 0;
  let mode = project.captionMode;
  if (project.captionsPath) {
    const abs = resolveDataPath(project.captionsPath);
    if (!fs.existsSync(abs)) {
      errors.push("The SRT file is missing. Import it again.");
    } else {
      const parsed = readSrtFile(abs);
      if (parsed.errors.length > 0) errors.push(...parsed.errors);
      else {
        count = parsed.cues.length;
        if (mode !== "burn" && mode !== "sidecar") mode = "burn";
      }
    }
  }

  let hasMusic = Boolean(project.musicBedPath);
  let musicLoops: boolean | null = null;
  if (project.musicBedPath) {
    const abs = resolveDataPath(project.musicBedPath);
    if (!fs.existsSync(abs)) {
      errors.push("The music bed file is missing. Upload it again.");
      hasMusic = false;
    } else if (input.cutSec != null && input.cutSec > 0) {
      try {
        musicLoops = musicFitsByLoop(probeDurationSec(abs), input.cutSec);
      } catch {
        musicLoops = null;
      }
    }
  }

  return describeFinish({
    hasMusic,
    anyClipAudio: input.anyClipAudio,
    captionCount: count,
    captionMode: count > 0 ? mode : null,
    captionErrors: errors,
    loudnessOn: masterLoudnessOn(project.loudnessNormalize, input.anyClipAudio, hasMusic),
    musicLoops,
  });
}
