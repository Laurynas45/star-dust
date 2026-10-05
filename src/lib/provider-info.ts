import { AppSettings, ProviderId } from "./types";

/** Checkpoint name inside the shipped ComfyUI API workflow. */
export const COMFY_CHECKPOINT = "svd_xt_1_1.safetensors";

export const COMFY_MODEL_NAME = `ComfyUI SVD image-to-video (${COMFY_CHECKPOINT})`;

export const CHARACTER_SHEET_HONESTY =
  "A pinned sheet is sent only when the provider call has a reference-image input. Mock (ffmpeg Ken Burns), the shipped ComfyUI workflow, and the default fal and Replicate image-to-video calls do not. The face will not match the sheet.";

/** Shown before a fal or Replicate job is created. No price is included. */
export const CLOUD_RISK_NOTE =
  "A key is required. Some vendors bill failed generations, and unused credits can expire. Star Dust is not showing a price because this provider did not return one.";

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
      "Needs a reachable ComfyUI server and the shipped image-to-video workflow. Not a node editor.",
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
      return COMFY_MODEL_NAME;
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
