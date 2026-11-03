import { measureStill } from "./cost";
import { buildPreflight, PreflightReport } from "./preflight";
import { AppSettings, Project, Shot } from "./types";

/**
 * Reads still sizes from disk and builds the advisory preflight report.
 * A chained shot with no extracted frame yet has no size to check.
 * The user's still is left out of that check, because the render does not use it.
 */
export function preflightStoredProject(
  project: Project,
  shots: readonly Shot[],
  settings: AppSettings
): PreflightReport {
  return buildPreflight({
    styleBase: project.styleBase,
    provider: settings.provider,
    outputWidth: project.outputWidth,
    outputHeight: project.outputHeight,
    settings,
    project,
    shots: shots.map((shot) => {
      const size = sizeForPreflight(shot);
      return {
        id: shot.id,
        position: shot.position,
        prompt: shot.prompt,
        presetId: shot.presetId,
        chainFromPrevious: shot.chainFromPrevious,
        comfyuiWorkflow: shot.comfyuiWorkflow,
        comfyLowMemory: shot.comfyLowMemory,
        width: size?.width ?? null,
        height: size?.height ?? null,
      };
    }),
  });
}

function sizeForPreflight(shot: Shot): { width: number; height: number } | null {
  if (shot.chainFromPrevious && !shot.chainedStartImagePath) return null;
  const measured = measureStill(shot);
  if (measured.width == null || measured.height == null) return null;
  return { width: measured.width, height: measured.height };
}
