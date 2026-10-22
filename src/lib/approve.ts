import { imageStamp } from "./storage";
import { APPROVED_MISMATCH_NOTE, Job, Shot, effectivePrompt } from "./types";

type ApprovedShot = Pick<
  Shot,
  | "approvedJobId"
  | "approvedStartStamp"
  | "approvedEndStamp"
  | "prompt"
  | "startImagePath"
  | "endImagePath"
>;

type ApprovedJob = Pick<Job, "id" | "prompt" | "kind" | "status" | "outputPath">;

/** True when an approved take is still the clip the stitch should keep. */
export function approvedTakeHeld(
  shot: Pick<Shot, "approvedJobId">,
  takes: readonly { id: string }[]
): boolean {
  return Boolean(shot.approvedJobId && takes.some((take) => take.id === shot.approvedJobId));
}

/**
 * The approved take was saved against a prompt and image that this shot no longer has.
 * A missing approved take counts too: Render all will not invent a replacement.
 */
export function approvedTakeMismatch(
  shot: ApprovedShot,
  job: ApprovedJob | undefined,
  styleBase: string
): boolean {
  if (!shot.approvedJobId) return false;
  if (
    !job ||
    job.id !== shot.approvedJobId ||
    job.kind === "preview" ||
    job.status !== "completed" ||
    !job.outputPath
  ) {
    return true;
  }
  if (job.prompt !== effectivePrompt(styleBase, shot.prompt)) return true;
  if ((shot.approvedStartStamp ?? "") !== imageStamp(shot.startImagePath)) return true;
  if ((shot.approvedEndStamp ?? "") !== imageStamp(shot.endImagePath)) return true;
  return false;
}

export function approvalConfirmError(
  shot: ApprovedShot,
  job: ApprovedJob | undefined,
  styleBase: string
): string {
  if (approvedTakeMismatch(shot, job, styleBase)) return APPROVED_MISMATCH_NOTE;
  return "This shot is approved. Confirm to render it again. The stitch keeps the approved take until you do.";
}
