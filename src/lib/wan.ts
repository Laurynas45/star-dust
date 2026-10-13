/** Frame size and count written into the Wan 2.2 TI2V-5B graph. */

export const WAN_MAX_WIDTH = 832;
export const WAN_MAX_HEIGHT = 480;
export const WAN_FPS = 16;
/** 4n+1, short clip. The graph is not a long-form generator. */
export const WAN_MAX_FRAMES = 81;
/** 4n+1. About one second at 16 fps. Used by the low-memory preset. */
export const WAN_LOW_MAX_FRAMES = 17;

/**
 * Official Wan 2.2 14B FLF template's small box.
 * Heavier than TI2V-5B. Not a measured Star Dust benchmark.
 */
export const WAN_FLF_MAX_WIDTH = 640;
export const WAN_FLF_MAX_HEIGHT = 640;
/** Low-memory preset box for the same 14B weights. Still not the 5B graph. */
export const WAN_FLF_LOW_MAX_WIDTH = 480;
export const WAN_FLF_LOW_MAX_HEIGHT = 480;

function snap32(value: number): number {
  return Math.max(32, Math.round(value / 32) * 32);
}

export function wanFrameSize(
  width: number,
  height: number,
  limits: { maxWidth: number; maxHeight: number } = {
    maxWidth: WAN_MAX_WIDTH,
    maxHeight: WAN_MAX_HEIGHT,
  }
): { width: number; height: number } {
  const maxWidth = limits.maxWidth;
  const maxHeight = limits.maxHeight;
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

/** Both stills are fitted inside this box. The node resizes the end image to match. */
export function wanFlfFrameSize(
  width: number,
  height: number,
  lowMemory: boolean
): { width: number; height: number } {
  return wanFrameSize(
    width,
    height,
    lowMemory
      ? { maxWidth: WAN_FLF_LOW_MAX_WIDTH, maxHeight: WAN_FLF_LOW_MAX_HEIGHT }
      : { maxWidth: WAN_FLF_MAX_WIDTH, maxHeight: WAN_FLF_MAX_HEIGHT }
  );
}

export function wanFrameCount(durationSec: number, maxFrames: number = WAN_MAX_FRAMES): number {
  const cap = Number.isFinite(maxFrames) && maxFrames >= 5 ? maxFrames : WAN_MAX_FRAMES;
  const seconds = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 4;
  const raw = Math.max(1, Math.round(seconds * WAN_FPS));
  let length = Math.round((raw - 1) / 4) * 4 + 1;
  if (length < 5) length = 5;
  if (length > cap) length = cap;
  return Math.round((length - 1) / 4) * 4 + 1;
}

export function imagePixelSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length >= 24 && buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && (buf.toString("ascii", 0, 6) === "GIF87a" || buf.toString("ascii", 0, 6) === "GIF89a")) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (
    buf.length >= 30 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8X") {
      return {
        width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
        height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
      };
    }
    if (chunk === "VP8L" && buf.length >= 25) {
      const b0 = buf[21];
      const b1 = buf[22];
      const b2 = buf[23];
      const b3 = buf[24];
      return {
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      };
    }
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buf[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const size = buf.readUInt16BE(offset + 2);
      if (size < 2) break;
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof) {
        return {
          width: buf.readUInt16BE(offset + 7),
          height: buf.readUInt16BE(offset + 5),
        };
      }
      offset += 2 + size;
    }
  }
  return null;
}
