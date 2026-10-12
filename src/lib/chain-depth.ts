/**
 * Last-frame chain length for one shot.
 * The list is in shot order. Depth is the unbroken run of
 * `chainFromPrevious` that ends on this shot, including this shot.
 * Star Dust does not break that run.
 */
export type ChainDepthShot = {
  id: string;
  chainFromPrevious: boolean;
};

/**
 * 0 when the option is off or the shot is not in the list.
 * 1 when this shot chains and the previous shot does not.
 * A first shot with the option on is also 1: it cannot chain, and nothing before it counts.
 * Each consecutive earlier shot with the option on adds one.
 */
export function chainDepth(shots: readonly ChainDepthShot[], shotId: string): number {
  const index = shots.findIndex((shot) => shot.id === shotId);
  if (index < 0 || shots[index].chainFromPrevious !== true) return 0;
  let depth = 1;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (shots[i].chainFromPrevious !== true) break;
    depth += 1;
  }
  return depth;
}

export function chainDepthLabel(depth: number): string {
  return `Chain depth ${depth}`;
}

/** Short note for depth 2–3. No lock and no fix. */
export const CHAIN_DEPTH_SOFT =
  "A short chain. Pose and framing can carry from the previous frame. Identity and details can still drift.";

/**
 * Warning from depth 4. Pose may continue; identity usually drifts.
 * Points at the original still. Does not claim a character lock, a face lock, or a fix.
 */
export const CHAIN_DEPTH_WARN =
  'Pose and framing may continue, but identity and details usually drift after several chained shots. Turn off "Start from previous shot\'s last frame" so the next take uses this shot\'s original still again.';

/** Null at depth 0 and 1. Softer note at 2–3. Warning at 4 and above. */
export function chainDepthNote(depth: number): string | null {
  if (!Number.isFinite(depth) || depth < 2) return null;
  if (depth >= 4) return CHAIN_DEPTH_WARN;
  return CHAIN_DEPTH_SOFT;
}
