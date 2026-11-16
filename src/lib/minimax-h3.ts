/** Frame size and count written into the MiniMax H3 image-to-video graph. */

export const H3_FPS = 24;
/**
 * MiniMaxH3ImageToVideo default, and the official I2V template's 768p size.
 * Both sides are divisible by 32. Not a measured Star Dust benchmark.
 */
export const H3_MAX_WIDTH = 1344;
export const H3_MAX_HEIGHT = 768;
/**
 * 17k+5. 124 frames is the node's ~5 second point at 24 fps.
 * The node tooltip calls 124 about five seconds. Longer than this is past the cap.
 */
export const H3_MAX_FRAMES = 124;
/**
 * Official I2V template size table, 0.4 megapixels at 16:9.
 * About 480p. The template opens the Resolution Selector at 0.4 megapixels.
 */
export const H3_LOW_WIDTH = 864;
export const H3_LOW_HEIGHT = 480;
/** 17k+5. 22 frames is just under one second at 24 fps. */
export const H3_LOW_MAX_FRAMES = 22;
/** Shortest length the node accepts. 17*0+5. */
export const H3_MIN_FRAMES = 5;
const H3_BLOCK = 17;

function snap32(value: number): number {
  return Math.max(32, Math.round(value / 32) * 32);
}

/** Snap up to the model's 17k+5 grid. Matches align_frame_count in ComfyUI. */
export function h3AlignFrames(length: number): number {
  let next = Number.isFinite(length) ? Math.round(length) : H3_MIN_FRAMES;
  if (next < H3_MIN_FRAMES) next = H3_MIN_FRAMES;
  while (next % H3_BLOCK !== 5) next += 1;
  return next;
}

export function h3FrameSize(
  width: number,
  height: number,
  lowMemory: boolean
): { width: number; height: number } {
  const maxWidth = lowMemory ? H3_LOW_WIDTH : H3_MAX_WIDTH;
  const maxHeight = lowMemory ? H3_LOW_HEIGHT : H3_MAX_HEIGHT;
  if (!(width > 0) || !(height > 0)) {
    return { width: maxWidth, height: maxHeight };
  }
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  let nextWidth = snap32(width * scale);
  let nextHeight = snap32(height * scale);
  if (nextWidth > maxWidth) nextWidth = Math.floor(maxWidth / 32) * 32;
  if (nextHeight > maxHeight) nextHeight = Math.floor(maxHeight / 32) * 32;
  return { width: nextWidth, height: nextHeight };
}

export function h3FrameCount(durationSec: number, lowMemory: boolean): number {
  const cap = lowMemory ? H3_LOW_MAX_FRAMES : H3_MAX_FRAMES;
  const seconds = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 5;
  const raw = Math.max(H3_MIN_FRAMES, Math.round(seconds * H3_FPS));
  const aligned = h3AlignFrames(raw);
  if (aligned > cap) return cap;
  return aligned;
}
