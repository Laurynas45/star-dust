import { AppSettings, ComfyWorkflowId, ProviderId } from "./types";

/** Checkpoint name inside the shipped SVD ComfyUI API workflow. */
export const COMFY_CHECKPOINT = "svd_xt_1_1.safetensors";

export const COMFY_MODEL_NAME = `ComfyUI SVD image-to-video (${COMFY_CHECKPOINT})`;

/** Files the Wan 2.2 TI2V-5B graph expects on the ComfyUI server. */
export const WAN_DIFFUSION = "wan2.2_ti2v_5B_fp16.safetensors";
export const WAN_TEXT_ENCODER = "umt5_xxl_fp8_e4m3fn_scaled.safetensors";
export const WAN_VAE = "wan2.2_vae.safetensors";

export const WAN_MODEL_NAME = "ComfyUI Wan 2.2 TI2V-5B";

export const COMFY_WORKFLOWS: Record<
  ComfyWorkflowId,
  { title: string; file: string; detail: string }
> = {
  svd: {
    title: "Stable Video Diffusion",
    file: "workflows/comfyui-svd-i2v.api.json",
    detail:
      "Does not read the text prompt. One start image. Duration becomes an SVD frame count.",
  },
  wan: {
    title: "Wan 2.2 TI2V-5B",
    file: "workflows/comfyui-wan22-ti2v-5b.api.json",
    detail:
      "Reads the prompt. Star Dust injects the start image, prompt, frame count, and size. Targets about 8 GB VRAM with ComfyUI offloading.",
  },
};

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
      "Needs a reachable ComfyUI server. Ships an SVD graph and a Wan 2.2 TI2V-5B graph. Not a node editor.",
  },
};

export function isPaidProvider(provider: ProviderId): boolean {
  return provider === "fal" || provider === "replicate";
}

export function modelNameFor(provider: ProviderId, settings: AppSettings): string {
  switch (provider) {
    case "mock":
      return "ffmpeg Ken Burns (mock)";
    case "fal":
      return settings.falModel.trim() || "fal-ai/minimax/video-01/image-to-video";
    case "replicate":
      return settings.replicateModel.trim() || "stability-ai/stable-video-diffusion";
    case "comfyui":
      return settings.comfyuiWorkflow === "wan" ? WAN_MODEL_NAME : COMFY_MODEL_NAME;
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

export function describeProviderUse(opts: {
  provider: ProviderId;
  settings: AppSettings;
  hasCharacterSheet: boolean;
  hasEndImage: boolean;
}): { modelName: string; characterNote?: string; providerNote: string } {
  const modelName = modelNameFor(opts.provider, opts.settings);
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
  } else if (opts.provider === "comfyui" && opts.settings.comfyuiWorkflow === "wan") {
    parts.push(
      `${modelName} posts workflows/comfyui-wan22-ti2v-5b.api.json, polls history, and downloads the video. The graph reads the text prompt. Star Dust sends the start image, the prompt, a frame count from the shot duration, and the output size (the still fitted inside 832×480).`
    );
    if (opts.hasEndImage) {
      parts.push("The end image was not sent. This Wan workflow has a single start image.");
    }
    if (opts.hasCharacterSheet) {
      characterNote =
        "Character sheet was not sent. This Wan workflow has no reference-image input, so the face will not match the sheet.";
    }
  } else if (opts.provider === "comfyui") {
    parts.push(
      `${modelName} queues the shipped workflow, polls history, and downloads the video. The graph does not read the text prompt. Duration is mapped to an SVD frame count, not sent as its own field.`
    );
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
