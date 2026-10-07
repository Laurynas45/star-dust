/** Frame size and count written into the LTX-2.3 image-to-video graph. */

export const LTX_FPS = 24;
/** Default box. Both sides are divisible by 32. About five seconds at the cap. */
export const LTX_MAX_WIDTH = 960;
export const LTX_MAX_HEIGHT = 544;
/** 8n+1. 121 frames is about five seconds at 24 fps. Not a long film. */
export const LTX_MAX_FRAMES = 121;
/** Low-memory box. About 480p, sides divisible by 32. */
export const LTX_LOW_WIDTH = 832;
export const LTX_LOW_HEIGHT = 480;
/** 8n+1. About one second at 24 fps. */
export const LTX_LOW_MAX_FRAMES = 25;
const LTX_MIN_FRAMES = 9;

function snap32(value: number): number {
  return Math.max(32, Math.round(value / 32) * 32);
}

export function ltxFrameSize(
  width: number,
  height: number,
  lowMemory: boolean
): { width: number; height: number } {
  const maxWidth = lowMemory ? LTX_LOW_WIDTH : LTX_MAX_WIDTH;
  const maxHeight = lowMemory ? LTX_LOW_HEIGHT : LTX_MAX_HEIGHT;
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

export function ltxFrameCount(durationSec: number, lowMemory: boolean): number {
  const cap = lowMemory ? LTX_LOW_MAX_FRAMES : LTX_MAX_FRAMES;
  const seconds = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 4;
  const raw = Math.max(1, Math.round(seconds * LTX_FPS));
  let length = Math.round((raw - 1) / 8) * 8 + 1;
  if (length < LTX_MIN_FRAMES) length = LTX_MIN_FRAMES;
  if (length > cap) length = cap;
  return length;
}
