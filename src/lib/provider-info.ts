import { formatCustomProviderNote, type CustomGraphNote } from "./custom-workflow";
import { AppSettings, ComfyGraphId, ComfyWorkflowId, isComfyWorkflowId, isCustomGraphId, ProviderId } from "./types";

export const LOW_MEMORY_MARK = " · low-memory preset";

/** Frame the Mock Ken Burns filter writes. The historic stitch default is the same 1280×720. */
export const MOCK_FRAME = { width: 1280, height: 720 } as const;

/** Frame written in workflows/comfyui-svd-i2v.api.json. */
export const SVD_FRAME = { width: 1024, height: 576 } as const;

/** Low-memory size passed into that SVD graph. */
export const SVD_LOW_FRAME = { width: 768, height: 448 } as const;

/** Checkpoint name inside the shipped SVD ComfyUI API workflow. */
export const COMFY_CHECKPOINT = "svd_xt_1_1.safetensors";

export const COMFY_MODEL_NAME = `ComfyUI SVD image-to-video (${COMFY_CHECKPOINT})`;

/** Files the Wan 2.2 TI2V-5B graph expects on the ComfyUI server. */
export const WAN_DIFFUSION = "wan2.2_ti2v_5B_fp16.safetensors";
export const WAN_TEXT_ENCODER = "umt5_xxl_fp8_e4m3fn_scaled.safetensors";
export const WAN_VAE = "wan2.2_vae.safetensors";

export const WAN_MODEL_NAME = "ComfyUI Wan 2.2 TI2V-5B";

/** Files the Wan 2.2 14B first-last-frame graph expects. Same names as the official FLF template. */
export const WAN_FLF_HIGH_NOISE = "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors";
export const WAN_FLF_LOW_NOISE = "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors";
export const WAN_FLF_VAE = "wan_2.1_vae.safetensors";

export const WAN_FLF_MODEL_NAME = "ComfyUI Wan 2.2 14B FLF2V";

/** Returned before a job is queued when FLF2V is selected and the shot has no end still. */
export const WAN_FLF_MISSING_END =
  "Wan 2.2 14B first-last frame needs an end still. This shot has no end image, so the job was not started. Star Dust does not switch this graph to TI2V-5B.";

/** Distilled FP8 checkpoint the shipped LTX graph writes into the loaders. */
export const LTX_CHECKPOINT = "ltx-2.3-22b-distilled-fp8.safetensors";
/** Gemma file the shipped LTX graph writes into the text encoder loader. */
export const LTX_TEXT_ENCODER = "gemma_3_12B_it_fp4_mixed.safetensors";

export const LTX_MODEL_NAME = "ComfyUI LTX-2.3 distilled FP8";

/** Files the LTX-2.5 graph writes. Same names as the current official I2V template's INT8 path. */
export const LTX25_DIFFUSION = "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors";
export const LTX25_TEXT_ENCODER = "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors";
export const LTX25_VIDEO_VAE = "ltx-2.5-video-vae-bf16.safetensors";
export const LTX25_AUDIO_VAE = "ltx-2.5-audio-vae-bf16.safetensors";
export const LTX25_UPSCALER = "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors";

export const LTX25_MODEL_NAME = "ComfyUI LTX-2.5";

/** Shown when LTX-2.5 is selected. The end still is optional. The job still runs without one. */
export const LTX25_END_NOTE =
  "An end still is sent as a last-frame guide when this shot has one. That path is a single stage and does not load the spatial upscaler. A shot with no end still still runs, as two-stage image-to-video. This is not a character lock.";

/** Files the MiniMax H3 graph writes. Same names as the current official I2V template. */
export const H3_DIFFUSION = "minimax_h3_fl2va_pruned_int8_convrot.safetensors";
export const H3_TEXT_ENCODER = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors";
export const H3_VIDEO_VAE = "minimax_h3_video_vae_int8_convrot.safetensors";
export const H3_AUDIO_VAE = "minimax_h3_audio_vae_fp32.safetensors";

export const H3_MODEL_NAME = "ComfyUI MiniMax H3";

/** Shown when MiniMax H3 is selected. The end still is optional. The job still runs without one. */
export const H3_END_NOTE =
  "An end still is sent as the last frame when this shot has one. A shot with no end still still runs.";

export const COMFY_WORKFLOW_ORDER: ComfyWorkflowId[] = ["svd", "wan", "wan-flf", "ltx", "ltx25", "minimax-h3"];

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
    goodAt: "Short motion from one still. It does not read the prompt. Lightest of the shipped graphs.",
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
      "Reads the prompt. Star Dust injects the start image, prompt, frame count, and size. ComfyUI's notes target about 8 GB VRAM with offloading. System RAM is separate and not measured here. This graph does not take the end image.",
  },
  "wan-flf": {
    title: "Wan 2.2 14B FLF2V",
    file: "workflows/comfyui-wan22-14b-flf2v.api.json",
    goodAt:
      "Steers one short clip between a start still and an end still. Not a character lock. Identity can still drift. TI2V-5B stays the low-VRAM Wan path.",
    memory:
      "No core 5B first-last graph exists. This is the official 14B FLF path, and it is heavier than TI2V-5B's about 8 GB VRAM note. ComfyUI's FLF template note, for the fp8 graph at 640×640 on an RTX 4090D 24GB, is about 84% VRAM. That note is guidance from the template, not a measurement Star Dust ran. System RAM is separate and not measured here.",
    defaults:
      "Both stills fitted inside 640×640, the official template's small size. 16 fps, length snapped to 4n+1, capped at 81 frames. Two-stage 20-step sample. No lightx2v LoRA.",
    lowMemory:
      "Both stills fitted inside 480×480 and the frame count capped at 17, about one second. The 14B weights are still loaded. This is not the 5B graph.",
    detail:
      "Reads the prompt. Star Dust injects the start image, the end image, the prompt, the frame count, and the size. A shot with no end still does not run, and this graph does not fall back to TI2V-5B. One short clip. Not a character lock.",
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
  ltx25: {
    title: "LTX-2.5",
    file: "workflows/comfyui-ltx25-i2v.api.json",
    goodAt:
      "Image-to-video from one still, with an optional end still as a last-frame guide. Lighter than the Wan 14B first-last graph. One short clip. The downloaded file is silent video.",
    memory:
      "Lightricks' ComfyUI page lists a CUDA GPU with 32 GB+ VRAM for the full setup. This graph loads the INT8 ConvRot distilled transformer and the INT8 ConvRot Gemma text encoder, which that page calls the lower-VRAM files, plus the BF16 video and audio VAEs. That is a smaller official stack, not a measurement Star Dust ran. The low-memory preset still loads these weights. The x2 latent upscaler is an extra file, and only the two-stage path loads it.",
    defaults:
      "The still fitted inside 960×512. 24 fps, length snapped to 8n+1, capped at 121 frames (about five seconds). Without an end still, the first stage is half of that size and the x2 latent upscaler brings it back. With an end still, one stage at the fitted size.",
    lowMemory:
      "The still fitted inside 832×448 (about 480p) and the frame count capped at 25 (about one second). The same weights are still loaded.",
    detail:
      "Reads the prompt. Star Dust injects the start image, the prompt, the frame count, the size, and the seed. An end still is a last-frame guide. Core nodes. The prompt enhancer is not in the graph. Not a character lock. Not an 8 GB guarantee.",
  },
  "minimax-h3": {
    title: "MiniMax H3",
    file: "workflows/comfyui-minimax-h3-i2v.api.json",
    goodAt:
      "Image-to-video from one still, with an optional end still as the last frame. One short clip. The graph writes audio into the mp4.",
    memory:
      "The official I2V template lists the four files at about 19.53 GB (diffusion), 14.61 GB (text encoder), 2.62 GB (video VAE), and 577.2 MB (audio VAE). That is a large download for a big or rented GPU. Star Dust did not measure VRAM or system RAM. The low-memory preset still loads these weights.",
    defaults:
      "The still fitted inside 1344×768, the node's default and the template's official 768p. 24 fps, length snapped up to 17k+5, capped at 124 frames (about five seconds). 20 steps, res_multistep, simple. The optional turbo LoRA is not loaded.",
    lowMemory:
      "The still fitted inside 864×480 (the template's 0.4 megapixel 16:9 size, about 480p) and the frame count capped at 22, just under one second. The same weights are still loaded.",
    detail:
      "Reads the prompt. Star Dust injects the start image, the prompt, the frame count, the size, and the seed. An end still is sent as the last frame when the shot has one. The graph writes audio into the mp4. The stitch keeps that audio when the file has an audio stream. Core nodes. ComfyUI 0.31.0 or later.",
  },
};

export function comfyModelName(workflow: ComfyGraphId, lowMemory: boolean): string {
  const base = isCustomGraphId(workflow)
    ? `ComfyUI ${workflow}`
    : workflow === "minimax-h3"
      ? H3_MODEL_NAME
      : workflow === "ltx25"
        ? LTX25_MODEL_NAME
        : workflow === "ltx"
          ? LTX_MODEL_NAME
          : workflow === "wan-flf"
            ? WAN_FLF_MODEL_NAME
            : workflow === "wan"
              ? WAN_MODEL_NAME
              : COMFY_MODEL_NAME;
  return lowMemory ? `${base}${LOW_MEMORY_MARK}` : base;
}

/** Title written into a shot list. The internal id is not the file's name. */
export function comfyWorkflowTitle(id: ComfyWorkflowId): string {
  return COMFY_WORKFLOWS[id].title;
}

export function comfyWorkflowIdByTitle(title: string): ComfyWorkflowId | null {
  const found = COMFY_WORKFLOW_ORDER.find((id) => COMFY_WORKFLOWS[id].title === title);
  return found ?? null;
}

export const COMFY_WORKFLOW_TITLES = COMFY_WORKFLOW_ORDER.map((id) => COMFY_WORKFLOWS[id].title);

export function compareGraphIds(a: ComfyGraphId, b: ComfyGraphId): number {
  const rank = (id: ComfyGraphId) =>
    isComfyWorkflowId(id) ? COMFY_WORKFLOW_ORDER.indexOf(id) : COMFY_WORKFLOW_ORDER.length;
  const diff = rank(a) - rank(b);
  if (diff !== 0) return diff;
  return a.localeCompare(b);
}

export function comfyWorkflowFromModelName(modelName?: string): ComfyGraphId | null {
  if (!modelName) return null;
  const custom = /^ComfyUI (custom:[a-z][a-z0-9-]{0,47})(?: · low-memory preset)?$/.exec(modelName);
  if (custom && isCustomGraphId(custom[1])) return custom[1];
  if (modelName.includes("MiniMax H3")) return "minimax-h3";
  if (modelName.includes("FLF2V")) return "wan-flf";
  if (modelName.includes("LTX-2.5")) return "ltx25";
  if (modelName.includes("LTX-2.3")) return "ltx";
  if (modelName.includes("Wan 2.2")) return "wan";
  if (modelName.includes("SVD")) return "svd";
  return null;
}

export const CHARACTER_SHEET_HONESTY =
  "A pinned sheet is sent only when the provider call has a reference-image input. Mock (ffmpeg Ken Burns), the shipped ComfyUI workflows, and the default fal and Replicate image-to-video calls do not. The face will not match the sheet.";

/** Shown before a fal or Replicate job is created. No vendor price is included. */
export const CLOUD_RISK_NOTE =
  "A key is required. Some vendors bill failed generations, and unused credits can expire. Star Dust does not fetch a vendor price and has no vendor price table. A total appears only from the rate and billing unit you enter, and that total is your own estimate.";

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
      "Needs a reachable ComfyUI server, on this machine or at COMFYUI_BASE_URL. Ships SVD, Wan 2.2 TI2V-5B, Wan 2.2 14B first-last frame, LTX-2.3 distilled FP8, LTX-2.5, and MiniMax H3 graphs. A graph you export can be added as a pair of files. Not a node editor.",
  },
};

export function isPaidProvider(provider: ProviderId): boolean {
  return provider === "fal" || provider === "replicate";
}

export function modelNameFor(
  provider: ProviderId,
  settings: AppSettings,
  comfy?: { workflow: ComfyGraphId; lowMemory: boolean }
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
  comfy?: { workflow: ComfyGraphId; lowMemory: boolean; custom?: CustomGraphNote };
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
  } else if (opts.provider === "comfyui" && comfy.workflow === "ltx25") {
    const box = comfy.lowMemory ? "832×448" : "960×512";
    parts.push(
      `${modelName} posts workflows/comfyui-ltx25-i2v.api.json, polls history, and downloads the video. The graph reads the text prompt. Star Dust sends the start image, the prompt, a frame count from the shot duration (24 fps, snapped to 8n+1, capped at 121 frames, about five seconds), the output size (the still fitted inside ${box}), and the seed. The clip is silent: the graph builds the audio latent LTX-2.5 expects, then does not write that audio into the file. It is one short clip. ${COMFY_SERVER_NOTE}`
    );
    if (comfy.lowMemory) {
      parts.push(
        "The low-memory preset is on: the still is fitted inside 832×448 (about 480p) and the frame count is capped at 25. The same weights are still loaded."
      );
    }
    if (opts.hasEndImage) {
      parts.push(
        "The end image is sent as a last-frame guide (frame index -1, strength 1). That path is one stage at the fitted size and does not load the spatial upscaler. This is not a character lock."
      );
    } else {
      parts.push(
        "This shot has no end still. The job runs as two-stage image-to-video. The first stage is half of the fitted size, then the x2 latent upscaler. The last-frame guide is left off."
      );
    }
    if (opts.hasCharacterSheet) {
      characterNote =
        "Character sheet was not sent. This LTX-2.5 workflow has no reference-image input, so the face will not match the sheet.";
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
  } else if (opts.provider === "comfyui" && comfy.workflow === "wan-flf") {
    if (!opts.hasEndImage) {
      parts.push(WAN_FLF_MISSING_END);
    } else {
      parts.push(
        `${modelName} posts workflows/comfyui-wan22-14b-flf2v.api.json, polls history, and downloads the video. The graph reads the text prompt. Star Dust sends the start image, the end image, the prompt, a frame count from the shot duration, and the output size (both stills fitted inside ${comfy.lowMemory ? "480×480" : "640×640"}). This steers motion between the two stills. It is not a character lock. Identity can still drift. One short clip is the unit. Wan 2.2 TI2V-5B stays the lower-VRAM path. ${COMFY_SERVER_NOTE}`
      );
      if (comfy.lowMemory) {
        parts.push(
          "The low-memory preset is on: both stills fitted inside 480×480, with the frame count capped at 17. The 14B weights are still loaded."
        );
      }
    }
    if (opts.hasCharacterSheet) {
      characterNote =
        "Character sheet was not sent. This first-last workflow has no reference-image input, so the face will not match the sheet.";
    }
  } else if (opts.provider === "comfyui" && comfy.workflow === "minimax-h3") {
    parts.push(
      `${modelName} posts workflows/comfyui-minimax-h3-i2v.api.json, polls history, and downloads the video. The graph reads the text prompt. Star Dust sends the start image, the prompt, a frame count from the shot duration (24 fps, snapped up to 17k+5, capped at 124 frames, about five seconds), the output size (the still fitted inside ${comfy.lowMemory ? "864×480" : "1344×768"}), and the seed. The graph decodes the audio latent and writes it into the mp4. The stitch keeps that audio when the file has an audio stream. It is one short clip. ${COMFY_SERVER_NOTE}`
    );
    if (comfy.lowMemory) {
      parts.push(
        "The low-memory preset is on: the still is fitted inside 864×480 (about 480p) and the frame count is capped at 22. The same weights are still loaded."
      );
    }
    if (opts.hasEndImage) {
      parts.push(
        "The end image is sent as the last frame. The node stretches the first frame to the canvas and center-crops the last frame. This is not a character lock."
      );
    } else {
      parts.push("This shot has no end still. The last-frame input is left off, and the job still runs.");
    }
    if (opts.hasCharacterSheet) {
      characterNote =
        "Character sheet was not sent. This MiniMax H3 workflow has no reference-image input, so the face will not match the sheet.";
    }
  } else if (opts.provider === "comfyui" && isCustomGraphId(comfy.workflow)) {
    const note =
      comfy.custom ??
      ({
        id: comfy.workflow,
        ok: false,
        title: comfy.workflow,
        file: `data/workflows/${comfy.workflow.slice("custom:".length)}.api.json`,
        errors: [`Custom graph ${comfy.workflow} was not loaded.`],
        readsPrompt: false,
        needsEndImage: false,
        sendsSeed: false,
        sendsFrames: false,
        sendsSize: false,
        frameSummary: "",
        sizeSummary: "",
        lowMemory: "The low-memory preset does nothing until the mapping is loaded.",
        lowMemoryChanges: false,
        outputNode: "",
      } satisfies CustomGraphNote);
    const written = formatCustomProviderNote(note, {
      modelName,
      lowMemory: comfy.lowMemory,
      hasEndImage: opts.hasEndImage,
      hasCharacterSheet: opts.hasCharacterSheet,
      serverNote: COMFY_SERVER_NOTE,
    });
    parts.push(written.providerNote);
    characterNote = written.characterNote;
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
