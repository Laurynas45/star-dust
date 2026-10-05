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
 * Cloud image-to-video. Refuses before the job is marked running when FAL_KEY is missing.
 * Sends the start image and prompt only. Does not invent a price.
 */
export async function runFalGenerate(jobId: string): Promise<void> {
  const existing = getJob(jobId);
  if (!existing || existing.status === "cancelled" || existing.status === "failed") return;

  const missing = missingKeyMessage("fal");
  if (missing) {
    updateJob(jobId, { status: "failed", error: missing, progress: 0 });
    throw new Error("Missing FAL_KEY");
  }

  const apiKey = process.env.FAL_KEY as string;
  const job = updateJob(jobId, { status: "running", progress: 10 });
  if (!job) throw new Error("Job not found");

  const settings = getSettings();
  const model = settings.falModel || job.modelName || "fal-ai/minimax/video-01/image-to-video";
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

  const submitUrl = `https://queue.fal.run/${model}`;
  const submitRes = await fetch(submitUrl, {
    method: "POST",
    headers: {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: job.prompt,
      image_url: dataUri,
    }),
  });

  if (!submitRes.ok) {
    const text = await submitRes.text();
    const err = `fal submit failed (${submitRes.status}): ${text.slice(0, 500)}`;
    updateJob(jobId, { status: "failed", error: err });
    throw new Error(err);
  }

  const submitted = (await submitRes.json()) as {
    request_id?: string;
    status_url?: string;
    response_url?: string;
  };
  const statusUrl =
    submitted.status_url ||
    (submitted.request_id
      ? `https://queue.fal.run/${model}/requests/${submitted.request_id}/status`
      : null);
  const responseUrl =
    submitted.response_url ||
    (submitted.request_id
      ? `https://queue.fal.run/${model}/requests/${submitted.request_id}`
      : null);
  if (!statusUrl || !responseUrl) {
    updateJob(jobId, { status: "failed", error: "fal response missing request_id / status URLs" });
    throw new Error("Invalid fal response");
  }
  if (submitted.request_id) updateJob(jobId, { remoteId: submitted.request_id });

  let finalStatus = "";
  for (let i = 0; i < 240; i++) {
    if (getJob(jobId)?.status === "cancelled") return;
    await new Promise((r) => setTimeout(r, 5000));
    const st = await fetch(statusUrl, { headers: { Authorization: `Key ${apiKey}` } });
    if (!st.ok) continue;
    const statusBody = (await st.json()) as { status?: string };
    finalStatus = statusBody.status || "";
    updateJob(jobId, { progress: Math.min(90, 30 + Math.floor(i / 2)) });
    if (finalStatus === "COMPLETED") break;
    if (finalStatus === "FAILED" || finalStatus === "ERROR") {
      updateJob(jobId, { status: "failed", error: `fal job ${finalStatus}` });
      throw new Error(`fal job ${finalStatus}`);
    }
  }
  if (getJob(jobId)?.status === "cancelled") return;
  if (finalStatus !== "COMPLETED") {
    updateJob(jobId, {
      status: "failed",
      error: `fal timed out waiting for result (last status: ${finalStatus || "unknown"})`,
    });
    throw new Error("fal timed out");
  }

  const resultRes = await fetch(responseUrl, { headers: { Authorization: `Key ${apiKey}` } });
  if (!resultRes.ok) {
    const text = await resultRes.text();
    updateJob(jobId, { status: "failed", error: `fal result failed: ${text.slice(0, 500)}` });
    throw new Error("fal result failed");
  }
  const result = (await resultRes.json()) as {
    video?: { url?: string };
    output?: { url?: string };
  };
  const videoUrl = result.video?.url || result.output?.url;
  if (!videoUrl) {
    updateJob(jobId, { status: "failed", error: "fal completed but no video URL in response" });
    throw new Error("No video URL");
  }
  const videoRes = await fetch(videoUrl);
  const buf = Buffer.from(await videoRes.arrayBuffer());
  const { abs, rel } = absoluteOutputPath(job.projectId, `${jobId}.mp4`);
  fs.writeFileSync(abs, buf);
  if (getJob(jobId)?.status === "cancelled") return;
  updateJob(jobId, {
    status: "completed",
    progress: 100,
    outputPath: rel.split(path.sep).join("/"),
  });
}
