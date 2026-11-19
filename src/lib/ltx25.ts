/** Frame size and count written into the LTX-2.5 image-to-video graph. */

export const LTX25_FPS = 24;
/**
 * Output box. Both sides are divisible by 64, so the two-stage path can use
 * half of each side (a multiple of 32) and the x2 latent upscaler lands on
 * this size. About the template's 0.5 megapixel 16:9 box.
 */
export const LTX25_MAX_WIDTH = 960;
export const LTX25_MAX_HEIGHT = 512;
/** 8n+1. 121 frames is about five seconds at 24 fps. Not a long film. */
export const LTX25_MAX_FRAMES = 121;
/** Low-memory box. About 480p, sides divisible by 64. */
export const LTX25_LOW_WIDTH = 832;
export const LTX25_LOW_HEIGHT = 448;
/** 8n+1. About one second at 24 fps. */
export const LTX25_LOW_MAX_FRAMES = 25;
const LTX25_MIN_FRAMES = 9;

function snap64(value: number): number {
  return Math.max(64, Math.round(value / 64) * 64);
}

export function ltx25FrameSize(
  width: number,
  height: number,
  lowMemory: boolean
): { width: number; height: number } {
  const maxWidth = lowMemory ? LTX25_LOW_WIDTH : LTX25_MAX_WIDTH;
  const maxHeight = lowMemory ? LTX25_LOW_HEIGHT : LTX25_MAX_HEIGHT;
  if (!(width > 0) || !(height > 0)) {
    return { width: maxWidth, height: maxHeight };
  }
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  let nextWidth = snap64(width * scale);
  let nextHeight = snap64(height * scale);
  if (nextWidth > maxWidth) nextWidth = Math.floor(maxWidth / 64) * 64;
  if (nextHeight > maxHeight) nextHeight = Math.floor(maxHeight / 64) * 64;
  return { width: nextWidth, height: nextHeight };
}

/** First stage of the two-stage path. Half the fitted size, still a multiple of 32. */
export function ltx25StageSize(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.max(64, Math.floor(width / 2)),
    height: Math.max(64, Math.floor(height / 2)),
  };
}

export function ltx25FrameCount(durationSec: number, lowMemory: boolean): number {
  const cap = lowMemory ? LTX25_LOW_MAX_FRAMES : LTX25_MAX_FRAMES;
  const seconds = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 4;
  const raw = Math.max(1, Math.round(seconds * LTX25_FPS));
  let length = Math.round((raw - 1) / 8) * 8 + 1;
  if (length < LTX25_MIN_FRAMES) length = LTX25_MIN_FRAMES;
  if (length > cap) length = cap;
  return length;
}
