/**
 * Follow one ComfyUI prompt. A socket that never opens does not fail the job.
 * Queue position comes from GET /queue when that body is usable.
 */
import { openComfySocket, type ComfySocket } from "./comfy-socket";
import {
  ComfyNodes,
  ComfySnapshot,
  applyComfyMessage,
  emptyComfySnapshot,
  queuePlacement,
} from "./comfy-progress";
import { setComfyLive } from "./job-activity";

export type ComfyProgressWatch = {
  /** Resolves when the socket is up or has failed. Never rejects. */
  ready: Promise<void>;
  setPromptId: (promptId: string) => void;
  pollQueue: () => Promise<void>;
  stop: () => void;
};

export function startComfyProgressWatch(options: {
  jobId: string;
  base: string;
  clientId: string;
  nodes: ComfyNodes;
  headers: Record<string, string>;
  fetchQueue: () => Promise<unknown>;
}): ComfyProgressWatch {
  let promptId = "";
  let snapshot: ComfySnapshot = emptyComfySnapshot();
  let wsOpen = false;
  let socketDown = false;
  let stopped = false;
  let socket: ComfySocket | null = null;
  const buffered: unknown[] = [];

  const publish = () => {
    if (stopped) return;
    setComfyLive(options.jobId, { snapshot, wsOpen, socketDown });
  };

  const apply = (message: unknown) => {
    if (!promptId) {
      buffered.push(message);
      return;
    }
    const next = applyComfyMessage(snapshot, message, promptId, options.nodes);
    if (next !== snapshot) {
      snapshot = next;
      publish();
    }
  };

  const ready = openComfySocket({
    base: options.base,
    clientId: options.clientId,
    headers: options.headers,
  })
    .then((opened) => {
      if (stopped) {
        opened.close();
        return;
      }
      socket = opened;
      wsOpen = true;
      socketDown = false;
      publish();
      opened.onText((text) => {
        let message: unknown;
        try {
          message = JSON.parse(text);
        } catch {
          return;
        }
        apply(message);
      });
    })
    .catch(() => {
      if (stopped) return;
      wsOpen = false;
      socketDown = true;
      publish();
    });

  return {
    ready,
    setPromptId(id: string) {
      promptId = id;
      const pending = buffered.splice(0);
      for (const message of pending) apply(message);
    },
    async pollQueue() {
      if (stopped) return;
      let body: unknown;
      try {
        body = await options.fetchQueue();
      } catch {
        return;
      }
      if (body == null || !promptId) return;
      const place = queuePlacement(body, promptId);
      if (!place || place.where === "absent") return;
      if (place.where === "running") {
        if (snapshot.phase !== "queued") return;
        snapshot = { ...snapshot, phase: "running", queuePosition: undefined };
        publish();
        return;
      }
      if (snapshot.seenExecution || snapshot.phase === "sampling" || snapshot.phase === "decoding") return;
      if (snapshot.phase === "queued" && snapshot.queuePosition === place.position) return;
      snapshot = { ...snapshot, phase: "queued", queuePosition: place.position };
      publish();
    },
    stop() {
      stopped = true;
      socket?.close();
      socket = null;
    },
  };
}
