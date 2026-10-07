import { AppSettings, ComfyWorkflowId, Project, Shot } from "./types";

export function resolveComfyChoice(input: {
  settings: Pick<AppSettings, "comfyuiWorkflow" | "comfyLowMemory">;
  project?: Pick<Project, "comfyuiWorkflow" | "comfyLowMemory"> | null;
  shot?: Pick<Shot, "comfyuiWorkflow" | "comfyLowMemory"> | null;
}): { workflow: ComfyWorkflowId; lowMemory: boolean } {
  const workflow =
    input.shot?.comfyuiWorkflow ?? input.project?.comfyuiWorkflow ?? input.settings.comfyuiWorkflow;
  const lowMemory =
    input.shot?.comfyLowMemory ?? input.project?.comfyLowMemory ?? input.settings.comfyLowMemory;
  return { workflow, lowMemory };
}
