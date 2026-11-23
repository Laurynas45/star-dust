import { AppSettings, ComfyGraphId, Project, Shot } from "./types";

/** Generated audio is an LTX-2.3 and LTX-2.5 option. Other graphs ignore it. */
export function ltxGraphSupportsGeneratedAudio(workflow: ComfyGraphId): workflow is "ltx" | "ltx25" {
  return workflow === "ltx" || workflow === "ltx25";
}

/**
 * Shot, then project, then on.
 * A non-LTX graph is always off, even when the stored flag is true.
 */
export function resolveGeneratedAudio(input: {
  workflow: ComfyGraphId;
  project?: Pick<Project, "generatedAudio"> | null;
  shot?: Pick<Shot, "generatedAudio"> | null;
}): boolean {
  if (!ltxGraphSupportsGeneratedAudio(input.workflow)) return false;
  if (input.shot?.generatedAudio != null) return input.shot.generatedAudio;
  if (input.project?.generatedAudio != null) return input.project.generatedAudio;
  return true;
}

export function resolveComfyChoice(input: {
  settings: Pick<AppSettings, "comfyuiWorkflow" | "comfyLowMemory">;
  project?: Pick<Project, "comfyuiWorkflow" | "comfyLowMemory" | "generatedAudio"> | null;
  shot?: Pick<Shot, "comfyuiWorkflow" | "comfyLowMemory" | "generatedAudio"> | null;
}): { workflow: ComfyGraphId; lowMemory: boolean; generatedAudio: boolean } {
  const workflow =
    input.shot?.comfyuiWorkflow ?? input.project?.comfyuiWorkflow ?? input.settings.comfyuiWorkflow;
  const lowMemory =
    input.shot?.comfyLowMemory ?? input.project?.comfyLowMemory ?? input.settings.comfyLowMemory;
  return {
    workflow,
    lowMemory,
    generatedAudio: resolveGeneratedAudio({ workflow, project: input.project, shot: input.shot }),
  };
}
