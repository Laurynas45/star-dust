import fs from "fs";
import { generationIsRefused, MINOR_SEXUAL_REFUSAL } from "./safety";
import { resolveDataPath, saveUpload } from "./storage";

const MAX_BYTES = 12 * 1024 * 1024;

export function sniffImage(buf: Buffer): "png" | "jpeg" | "webp" | "gif" | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  const head = buf.toString("ascii", 0, 6);
  if (head === "GIF87a" || head === "GIF89a") return "gif";
  return null;
}

export function storeImageIfAllowed(opts: {
  projectId: string;
  prompt: string;
  filename: string;
  buffer: Buffer;
  extraFilenames?: string[];
}): { ok: true; path: string } | { ok: false; status: number; error: string; refused?: boolean } {
  const names = [opts.filename, ...(opts.extraFilenames ?? [])];
  if (generationIsRefused(opts.prompt, names)) {
    return { ok: false, status: 400, error: MINOR_SEXUAL_REFUSAL, refused: true };
  }
  if (opts.buffer.length === 0) {
    return { ok: false, status: 400, error: "Empty image file" };
  }
  if (opts.buffer.length > MAX_BYTES) {
    return { ok: false, status: 400, error: "Image is larger than 12 MB" };
  }
  if (!sniffImage(opts.buffer)) {
    return { ok: false, status: 400, error: "Start and end images must be PNG, JPEG, WebP, or GIF" };
  }
  const imagePath = saveUpload(opts.projectId, opts.filename, opts.buffer);
  return { ok: true, path: imagePath };
}

export function imageExists(relativePath?: string): boolean {
  if (!relativePath) return false;
  try {
    const abs = resolveDataPath(relativePath);
    return fs.existsSync(abs) && fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}
