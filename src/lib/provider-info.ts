import { AppSettings, ComfyWorkflowId, ProviderId } from "./types";

export const LOW_MEMORY_MARK = " · low-memory preset";

/** Checkpoint name inside the shipped SVD ComfyUI API workflow. */
export const COMFY_CHECKPOINT = "svd_xt_1_1.safetensors";

export const COMFY_MODEL_NAME = `ComfyUI SVD image-to-video (${COMFY_CHECKPOINT})`;

/** Files the Wan 2.2 TI2V-5B graph expects on the ComfyUI server. */
export const WAN_DIFFUSION = "wan2.2_ti2v_5B_fp16.safetensors";
export const WAN_TEXT_ENCODER = "umt5_xxl_fp8_e4m3fn_scaled.safetensors";
export const WAN_VAE = "wan2.2_vae.safetensors";

export const WAN_MODEL_NAME = "ComfyUI Wan 2.2 TI2V-5B";

/** Distilled FP8 checkpoint the shipped LTX graph writes into the loaders. */
export const LTX_CHECKPOINT = "ltx-2.3-22b-distilled-fp8.safetensors";
/** Gemma file the shipped LTX graph writes into the text encoder loader. */
export const LTX_TEXT_ENCODER = "gemma_3_12B_it_fp4_mixed.safetensors";

export const LTX_MODEL_NAME = "ComfyUI LTX-2.3 distilled FP8";

export const COMFY_WORKFLOW_ORDER: ComfyWorkflowId[] = ["svd", "wan", "ltx"];

export type ComfyWorkflowInfo = {
  title: string;
  file: string;
  goodAt: string;
  memory: string;
  defaults: string;
  lowMemory: string;
  detail: string;
};

export const COMFY_WORKFLOWS: Record<ComfyWorkflowId, ComfyWorkflowInfo> = {
  svd: {
    title: "Stable Video Diffusion",
    file: "workflows/comfyui-svd-i2v.api.json",
    goodAt: "Short motion from one still. It does not read the prompt. Lightest of the three shipped graphs.",
    memory:
      "No measured VRAM or system-RAM figure. The checkpoint is svd_xt_1_1.safetensors, an older and smaller file than Wan 2.2 or LTX-2.3. System RAM is whatever ComfyUI needs to load that file.",
    defaults: "1024×576 in the graph. Shot duration becomes about 14–25 frames at 6 fps.",
    lowMemory: "768×448 and 14 frames. Smaller than the default graph, not a published 8 GB profile.",
    detail: "Does not read the text prompt. One start image. Duration becomes an SVD frame count.",
  },
  wan: {
    title: "Wan 2.2 TI2V-5B",
    file: "workflows/comfyui-wan22-ti2v-5b.api.json",
    goodAt:
      "Prompt-following image-to-video on the 5B TI2V graph. One short clip. A common pick when the 5B weights fit.",
    memory:
      "ComfyUI's own notes say this 5B graph fits about 8 GB VRAM with native offloading. That note is VRAM, not system RAM. The UMT5 text encoder and the diffusion file are large, and offloading uses system RAM. Star Dust does not publish a measured RAM number.",
    defaults: "The still fitted inside 832×480. 16 fps, length snapped to 4n+1, capped at 81 frames.",
    lowMemory: "Same 832×480 box (about 480p) with the frame count capped at 17, about one second.",
    detail:
      "Reads the prompt. Star Dust injects the start image, prompt, frame count, and size. ComfyUI's notes target about 8 GB VRAM with offloading. System RAM is separate and not measured here.",
  },
  ltx: {
    title: "LTX-2.3 distilled FP8",
    file: "workflows/comfyui-ltx23-i2v.api.json",
    goodAt:
      "Distilled image-to-video for a longer clip than the Wan 81-frame cap, at a smaller compute budget than the full LTX checkpoint. One short clip. The downloaded file is silent video.",
    memory:
      "Lightricks' ComfyUI-LTXVideo README lists a CUDA GPU with 32 GB+ VRAM for the full setup. This graph loads the distilled FP8 checkpoint instead of that full BF16 file. That is the smaller official distilled file, not a claim that it fits in 8 GB. Community reports, including r/comfyui threads, describe 8 GB VRAM claims that still need on the order of 32–64 GB of system RAM when the weights spill out of VRAM. Treat that as a warning, not a number Star Dust measured. A GGUF UNet via ComfyUI-GGUF is a separate, optional swap and is not what this file loads.",
    defaults:
      "The still fitted inside 960×544. 24 fps, length snapped to 8n+1, capped at 121 frames (about five seconds).",
    lowMemory:
      "Start here: the still fitted inside 832×480 (about 480p) and the frame count capped at 25 (about one second).",
    detail:
      "Reads the prompt. Star Dust injects the start image, prompt, frame count, size, and seed. Distilled FP8 checkpoint on core ComfyUI nodes. Not an 8 GB guarantee.",
  },
};

export function comfyModelName(workflow: ComfyWorkflowId, lowMemory: boolean): string {
  const base =
    workflow === "ltx" ? LTX_MODEL_NAME : workflow === "wan" ? WAN_MODEL_NAME : COMFY_MODEL_NAME;
  return lowMemory ? `${base}${LOW_MEMORY_MARK}` : base;
}

export function comfyWorkflowFromModelName(modelName?: string): ComfyWorkflowId | null {
  if (!modelName) return null;
  if (modelName.includes("LTX-2.3")) return "ltx";
  if (modelName.includes("Wan 2.2")) return "wan";
  if (modelName.includes("SVD")) return "svd";
  return null;
}

export const CHARACTER_SHEET_HONESTY =
  "A pinned sheet is sent only when the provider call has a reference-image input. Mock (ffmpeg Ken Burns), the shipped ComfyUI workflows, and the default fal and Replicate image-to-video calls do not. The face will not match the sheet.";

/** Shown before a fal or Replicate job is created. No vendor price is included. */
export const CLOUD_RISK_NOTE =
  "A key is required. Some vendors bill failed generations, and unused credits can expire. Star Dust does not fetch a vendor price. A total appears only when you set a per-second rate, and that total is your own estimate.";

export const CAPABILITY: Record<
  ProviderId,
  { title: string; label: string }
> = {
  mock: {
    title: "Mock",
    label: "Camera motion only (ffmpeg Ken Burns). Not AI motion. No key.",
  },
  fal: {
    title: "fal",
    label: "Cloud image-to-video. Needs FAL_KEY.",
  },
  replicate: {
    title: "Replicate",
    label: "Cloud image-to-video. Needs REPLICATE_API_TOKEN.",
  },
  comfyui: {
    title: "ComfyUI",
    label:
      "Needs a reachable ComfyUI server, on this machine or at COMFYUI_BASE_URL. Ships SVD, Wan 2.2 TI2V-5B, and LTX-2.3 distilled FP8 graphs. Not a node editor.",
  },
};

export function isPaidProvider(provider: ProviderId): boolean {
  return provider === "fal" || provider === "replicate";
}

export function modelNameFor(
  provider: ProviderId,
  settings: AppSettings,
  comfy?: { workflow: ComfyWorkflowId; lowMemory: boolean }
): string {
  switch (provider) {
    case "mock":
      return "ffmpeg Ken Burns (mock)";
    case "fal":
      return settings.falModel.trim() || "fal-ai/minimax/video-01/image-to-video";
    case "replicate":
      return settings.replicateModel.trim() || "stability-ai/stable-video-diffusion";
    case "comfyui":
      return comfyModelName(
        comfy?.workflow ?? settings.comfyuiWorkflow,
        comfy?.lowMemory ?? settings.comfyLowMemory
      );
    default:
      return provider;
  }
}

export function missingKeyMessage(
  provider: ProviderId,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (provider === "fal" && !env.FAL_KEY) {
    return "Missing FAL_KEY. Add it to .env.local (see .env.example). The job was not started.";
  }
  if (provider === "replicate" && !env.REPLICATE_API_TOKEN) {
    return "Missing REPLICATE_API_TOKEN. Add it to .env.local (see .env.example). The job was not started.";
  }
  return null;
}

const COMFY_SERVER_NOTE =
  "The server is COMFYUI_BASE_URL when that environment variable is set, otherwise the URL saved in Providers. An optional Authorization value comes from COMFYUI_AUTH_HEADER and is not stored.";

export function describeProviderUse(opts: {
  provider: ProviderId;
  settings: AppSettings;
  hasCharacterSheet: boolean;
  hasEndImage: boolean;
  comfy?: { workflow: ComfyWorkflowId; lowMemory: boolean };
}): { modelName: string; characterNote?: string; providerNote: string } {
  const comfy = opts.comfy ?? {
    workflow: opts.settings.comfyuiWorkflow,
    lowMemory: opts.settings.comfyLowMemory,
  };
  const modelName = modelNameFor(opts.provider, opts.settings, opts.provider === "comfyui" ? comfy : undefined);
  const parts: string[] = [];
  let characterNote: string | undefined;

  if (opts.provider === "mock") {
    parts.push(
      opts.hasEndImage
        ? "Camera motion only. Mock crossfades the start still into the end still with ffmpeg Ken Burns. Not AI motion."
        : "Camera motion only. Mock animates the start still with ffmpeg Ken Burns. Not AI motion. No API key and no GPU."
    );
    if (opts.hasCharacterSheet) {
      characterNote =
        "Character sheet was not applied. Mock only transforms the start still with ffmpeg, so the face will not match the sheet.";
    }
  } else if (opts.provider === "comfyui" && comfy.workflow === "ltx") {
    parts.push(
      `${modelName} posts workflows/comfyui-ltx23-i2v.api.json, polls history, and downloads the video. The graph reads the text prompt. Star Dust sends the start image, the prompt, a frame count from the shot duration (24 fps, snapped to 8n+1, capped at 121 frames, about five seconds), the output size (the still fitted inside 960×544), and the seed. The clip is silent: the graph builds the audio latent LTX-2.3 expects, then does not write that audio into the file. It is one short clip. ${COMFY_SERVER_NOTE}`
    );
    if (comfy.lowMemory) {
      parts.push(
        "The low-memory preset is on: the still is fitted inside 832×480 (about 480p) and the frame count is capped at 25."
      );
    }
    if (opts.hasEndImage) {
      parts.push("The end image was not sent. This LTX workflow has a single start image.");
    }
    if (opts.hasCharacterSheet) {
      characterNote =
        "Character sheet was not sent. This LTX workflow has no reference-image input, so the face will not match the sheet.";
    }
  } else if (opts.provider === "comfyui" && comfy.workflow === "wan") {
    parts.push(
      `${modelName} posts workflows/comfyui-wan22-ti2v-5b.api.json, polls history, and downloads the video. The graph reads the text prompt. Star Dust sends the start image, the prompt, a frame count from the shot duration, and the output size (the still fitted inside 832×480). ${COMFY_SERVER_NOTE}`
    );
    if (comfy.lowMemory) {
      parts.push("The low-memory preset is on: the same 832×480 box, with the frame count capped at 17.");
    }
    if (opts.hasEndImage) {
      parts.push("The end image was not sent. This Wan workflow has a single start image.");
    }
    if (opts.hasCharacterSheet) {
      characterNote =
        "Character sheet was not sent. This Wan workflow has no reference-image input, so the face will not match the sheet.";
    }
  } else if (opts.provider === "comfyui") {
    parts.push(
      `${modelName} queues the shipped workflow, polls history, and downloads the video. The graph does not read the text prompt. Duration is mapped to an SVD frame count, not sent as its own field. ${COMFY_SERVER_NOTE}`
    );
    if (comfy.lowMemory) {
      parts.push("The low-memory preset is on: 768×448 and 14 frames.");
    }
    if (opts.hasEndImage) {
      parts.push("The end image was not sent. This SVD workflow has a single LoadImage input.");
    }
    if (opts.hasCharacterSheet) {
      characterNote =
        "Character sheet was not sent. The shipped SVD workflow has no reference-image input, so the face will not match the sheet.";
    }
  } else {
    parts.push(
      `Cloud image-to-video on ${modelName}. Star Dust sends the start image and the prompt. ${CLOUD_RISK_NOTE}`
    );
    parts.push(
      "Shot duration is stored on the job. This call does not send a duration, because the model schema is not known and Star Dust does not invent one."
    );
    if (opts.hasEndImage) {
      parts.push("The end image was not sent. This call does not include an end-frame field.");
    }
    if (opts.hasCharacterSheet) {
      characterNote = `Character sheet was not sent. ${modelName} is called with the start image and prompt only, so the face will not match the sheet.`;
    }
  }

  return { modelName, characterNote, providerNote: parts.join(" ") };
}
