import fs from "fs";
import path from "path";
import { missingKeyMessage } from "../provider-info";
import {
  absoluteOutputPath,
  getJob,
  getSettings,
  resolveDataPath,
  updateJob,
} from "../storage";

/**
 * Cloud image-to-video. Refuses before the job is marked running when
 * REPLICATE_API_TOKEN is missing. Does not invent a price.
 */
export async function runReplicateGenerate(jobId: string): Promise<void> {
  const existing = getJob(jobId);
  if (!existing || existing.status === "cancelled" || existing.status === "failed") return;

  const missing = missingKeyMessage("replicate");
  if (missing) {
    updateJob(jobId, { status: "failed", error: missing, progress: 0 });
    throw new Error("Missing REPLICATE_API_TOKEN");
  }

  const token = process.env.REPLICATE_API_TOKEN as string;
  const job = updateJob(jobId, { status: "running", progress: 10 });
  if (!job) throw new Error("Job not found");

  const settings = getSettings();
  const model = settings.replicateModel || job.modelName || "stability-ai/stable-video-diffusion";
  const inputAbs = resolveDataPath(job.imagePath);
  if (!fs.existsSync(inputAbs)) {
    updateJob(jobId, { status: "failed", error: "Image not found", progress: 0 });
    throw new Error("Image not found");
  }

  const imageBytes = fs.readFileSync(inputAbs);
  const ext = path.extname(inputAbs).slice(1).toLowerCase() || "png";
  const mime = ext === "jpg" ? "jpeg" : ext;
  const dataUri = `data:image/${mime};base64,${imageBytes.toString("base64")}`;
  updateJob(jobId, { progress: 25, modelName: model });

  const headers = {
    Authorization: `Token ${token}`,
    "Content-Type": "application/json",
  };
  const input = {
    input_image: dataUri,
    image: dataUri,
    prompt: job.prompt,
  };

  let prediction: {
    id?: string;
    status?: string;
    output?: string | string[] | { url?: string };
    error?: string;
    urls?: { get?: string };
  };

  const createRes = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers,
    body: JSON.stringify({ model, input }),
  });

  if (!createRes.ok) {
    const modelRes = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input }),
    });
    if (!modelRes.ok) {
      const t1 = await createRes.text();
      const t2 = await modelRes.text();
      const err = `Replicate submit failed. predictions: ${createRes.status} ${t1.slice(0, 200)}; models: ${modelRes.status} ${t2.slice(0, 200)}`;
      updateJob(jobId, { status: "failed", error: err });
      throw new Error(err);
    }
    prediction = (await modelRes.json()) as typeof prediction;
  } else {
    prediction = (await createRes.json()) as typeof prediction;
  }

  const getUrl =
    prediction.urls?.get ||
    (prediction.id ? `https://api.replicate.com/v1/predictions/${prediction.id}` : null);
  if (!getUrl) {
    updateJob(jobId, { status: "failed", error: "Replicate response missing prediction id" });
    throw new Error("Invalid Replicate response");
  }
  if (prediction.id) updateJob(jobId, { remoteId: prediction.id });

  for (let i = 0; i < 120; i++) {
    if (getJob(jobId)?.status === "cancelled") return;
    const st = await fetch(getUrl, { headers: { Authorization: `Token ${token}` } });
    prediction = (await st.json()) as typeof prediction;
    updateJob(jobId, { progress: Math.min(90, 30 + i * 2) });
    if (prediction.status === "succeeded") break;
    if (prediction.status === "failed" || prediction.status === "canceled") {
      updateJob(jobId, {
        status: "failed",
        error: prediction.error || `Replicate ${prediction.status}`,
      });
      throw new Error(prediction.error || "Replicate failed");
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  if (getJob(jobId)?.status === "cancelled") return;
  let videoUrl: string | undefined;
  const out = prediction.output;
  if (typeof out === "string") videoUrl = out;
  else if (Array.isArray(out)) videoUrl = out[out.length - 1];
  else if (out && typeof out === "object" && out.url) videoUrl = out.url;
  if (!videoUrl) {
    updateJob(jobId, { status: "failed", error: "Replicate completed but no video URL" });
    throw new Error("No video URL");
  }

  const videoRes = await fetch(videoUrl);
  const buf = Buffer.from(await videoRes.arrayBuffer());
  const { abs, rel } = absoluteOutputPath(job.projectId, `${jobId}.mp4`);
  fs.writeFileSync(abs, buf);
  updateJob(jobId, {
    status: "completed",
    progress: 100,
    outputPath: rel.split(path.sep).join("/"),
  });
}
