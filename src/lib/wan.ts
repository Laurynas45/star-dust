/** Frame size and count written into the Wan 2.2 TI2V-5B graph. */

export const WAN_MAX_WIDTH = 832;
export const WAN_MAX_HEIGHT = 480;
export const WAN_FPS = 16;
/** 4n+1, short clip. The graph is not a long-form generator. */
export const WAN_MAX_FRAMES = 81;

function snap32(value: number): number {
  return Math.max(32, Math.round(value / 32) * 32);
}

export function wanFrameSize(
  width: number,
  height: number
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) {
    return { width: WAN_MAX_WIDTH, height: WAN_MAX_HEIGHT };
  }
  const scale = Math.min(WAN_MAX_WIDTH / width, WAN_MAX_HEIGHT / height, 1);
  let nextWidth = snap32(width * scale);
  let nextHeight = snap32(height * scale);
  if (nextWidth > WAN_MAX_WIDTH) nextWidth = Math.floor(WAN_MAX_WIDTH / 32) * 32;
  if (nextHeight > WAN_MAX_HEIGHT) nextHeight = Math.floor(WAN_MAX_HEIGHT / 32) * 32;
  return { width: nextWidth, height: nextHeight };
}

export function wanFrameCount(durationSec: number): number {
  const seconds = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 4;
  const raw = Math.max(1, Math.round(seconds * WAN_FPS));
  let length = Math.round((raw - 1) / 4) * 4 + 1;
  if (length < 5) length = 5;
  if (length > WAN_MAX_FRAMES) length = WAN_MAX_FRAMES;
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
