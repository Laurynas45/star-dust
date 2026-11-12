/**
 * Minimal ComfyUI websocket client. Node's global WebSocket cannot set
 * COMFYUI_AUTH_HEADER, so this speaks the upgrade itself.
 * Failures reject with a fixed message. The URL and headers are not included.
 */
import crypto from "crypto";
import http from "http";
import https from "https";
import type { Socket } from "net";

export type ComfySocket = {
  onText: (handler: (text: string) => void) => void;
  close: () => void;
};

export type WsFrame = { opcode: number; fin: boolean; payload: Buffer };

const MAX_FRAME = 16 * 1024 * 1024;

export function readWsFrames(input: Buffer): { frames: WsFrame[]; rest: Buffer } {
  const frames: WsFrame[] = [];
  let offset = 0;
  while (offset + 2 <= input.length) {
    const first = input[offset];
    const second = input[offset + 1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let header = 2;
    if (length === 126) {
      if (offset + 4 > input.length) break;
      length = input.readUInt16BE(offset + 2);
      header = 4;
    } else if (length === 127) {
      if (offset + 10 > input.length) break;
      const big = input.readBigUInt64BE(offset + 2);
      if (big > BigInt(MAX_FRAME)) {
        throw new Error("websocket unavailable");
      }
      length = Number(big);
      header = 10;
    }
    if (length > MAX_FRAME) throw new Error("websocket unavailable");
    const maskLen = masked ? 4 : 0;
    const total = header + maskLen + length;
    if (offset + total > input.length) break;
    let payload = input.subarray(offset + header + maskLen, offset + total);
    if (masked) {
      const mask = input.subarray(offset + header, offset + header + 4);
      const out = Buffer.alloc(length);
      for (let i = 0; i < length; i++) out[i] = payload[i] ^ mask[i % 4];
      payload = out;
    } else {
      payload = Buffer.from(payload);
    }
    frames.push({ opcode, fin, payload });
    offset += total;
  }
  return { frames, rest: input.subarray(offset) };
}

function sendFrame(socket: Socket, opcode: number, payload: Buffer) {
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  header[0] = 0x80 | opcode;
  if (!socket.destroyed) socket.write(Buffer.concat([header, mask, masked]));
}

export function openComfySocket(options: {
  base: string;
  clientId: string;
  headers: Record<string, string>;
  timeoutMs?: number;
}): Promise<ComfySocket> {
  const timeoutMs = options.timeoutMs ?? 4000;
  let root: URL;
  try {
    root = new URL(options.base);
  } catch {
    return Promise.reject(new Error("websocket unavailable"));
  }
  const secure = root.protocol === "https:";
  const prefix = root.pathname.replace(/\/$/, "");
  const path = `${prefix}/ws?clientId=${encodeURIComponent(options.clientId)}`;
  const headers: Record<string, string> = {
    ...options.headers,
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"),
  };
  const auth =
    root.username || root.password
      ? `${decodeURIComponent(root.username)}:${decodeURIComponent(root.password)}`
      : undefined;

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      reject(new Error("websocket unavailable"));
    };
    const timer = setTimeout(fail, timeoutMs);
    const req = (secure ? https : http).request({
      protocol: root.protocol,
      hostname: root.hostname,
      port: root.port || (secure ? 443 : 80),
      path,
      method: "GET",
      headers,
      auth,
      timeout: timeoutMs,
    });
    req.on("error", fail);
    req.on("timeout", fail);
    req.on("response", (res) => {
      res.resume();
      fail();
    });
    req.on("upgrade", (res, socket, head) => {
      if (settled) {
        socket.destroy();
        return;
      }
      if (res.statusCode !== 101) {
        socket.destroy();
        fail();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(wrapSocket(socket, head));
    });
    req.end();
  });
}

function wrapSocket(socket: Socket, head: Buffer): ComfySocket {
  let handler: ((text: string) => void) | undefined;
  let buffer: Buffer = Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let closed = false;
  const pending: string[] = [];

  const emit = (text: string) => {
    if (handler) handler(text);
    else pending.push(text);
  };

  const close = () => {
    if (closed) return;
    closed = true;
    try {
      sendFrame(socket, 0x8, Buffer.alloc(0));
    } catch {
      // The job keeps polling history if the socket is already gone.
    }
    socket.destroy();
  };

  const take = (chunk: Buffer) => {
    if (closed || chunk.length === 0) return;
    buffer = Buffer.concat([buffer, chunk]);
    let parsed: { frames: WsFrame[]; rest: Buffer };
    try {
      parsed = readWsFrames(buffer);
    } catch {
      close();
      return;
    }
    buffer = Buffer.from(parsed.rest);
    for (const frame of parsed.frames) {
      if (frame.opcode === 0x8) {
        close();
        return;
      }
      if (frame.opcode === 0x9) {
        try {
          sendFrame(socket, 0xa, frame.payload);
        } catch {
          close();
          return;
        }
        continue;
      }
      if (frame.opcode === 0x1 || frame.opcode === 0x0) {
        if (frame.opcode === 0x1 && frame.fin) {
          emit(frame.payload.toString("utf8"));
          fragments = [];
          continue;
        }
        if (frame.opcode === 0x1) fragments = [frame.payload];
        else fragments.push(frame.payload);
        if (frame.fin && fragments.length > 0) {
          emit(Buffer.concat(fragments).toString("utf8"));
          fragments = [];
        }
      }
    }
  };

  socket.on("data", take);
  socket.on("error", () => close());
  socket.on("close", () => {
    closed = true;
  });
  if (head.length > 0) take(Buffer.from(head));

  return {
    onText(next) {
      handler = next;
      const queued = pending.splice(0);
      for (const text of queued) next(text);
    },
    close,
  };
}
