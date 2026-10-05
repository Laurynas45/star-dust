import { spawn, type ChildProcess } from "child_process";

const processes = new Map<string, ChildProcess>();

export function killFfmpeg(jobId: string) {
  const proc = processes.get(jobId);
  if (proc && !proc.killed) proc.kill("SIGTERM");
}

export function runFfmpeg(args: string[], opts?: { jobId?: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    if (opts?.jobId) processes.set(opts.jobId, proc);
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => {
      if (opts?.jobId) processes.delete(opts.jobId);
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        reject(new Error("ffmpeg is not on PATH. Install ffmpeg and try again."));
        return;
      }
      reject(err);
    });
    proc.on("close", (code) => {
      if (opts?.jobId) processes.delete(opts.jobId);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-800)}`));
    });
  });
}
