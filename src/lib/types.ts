export type ProviderId = "mock" | "fal" | "replicate" | "comfyui";

export type SeamMode = "cut" | "crossfade";

/** Burn draws the SRT into the picture. Sidecar writes a .srt next to the mp4. */
export type CaptionMode = "burn" | "sidecar";

export type JobKind = "take" | "preview";

export const COMFY_WORKFLOW_IDS = ["svd", "wan", "wan-flf", "ltx"] as const;

export type ComfyWorkflowId = (typeof COMFY_WORKFLOW_IDS)[number];

export function isComfyWorkflowId(value: unknown): value is ComfyWorkflowId {
  return value === "svd" || value === "wan" || value === "wan-flf" || value === "ltx";
}

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface Project {
  id: string;
  name: string;
  description: string;
  characterSheetPath?: string;
  createdAt: string;
  updatedAt: string;
  shotCount?: number;
  completedCount?: number;
  isSample?: boolean;
  coverPath?: string;
  /** Null inherits the app default in Providers. */
  comfyuiWorkflow?: ComfyWorkflowId | null;
  /** Null inherits the project, then the app default. */
  comfyLowMemory?: boolean | null;
  /** How clips join in the stitch. Cut is the historical hard cut. */
  seamMode: SeamMode;
  /** Crossfade length when seamMode is crossfade. Ignored for a hard cut. */
  seamFadeSec: number;
  /**
   * Start frames trimmed from the next clip on a chained hard cut that used the
   * exact last frame. 0 keeps every frame. 1 matches the old one-frame drop.
   * 2–4 also trims early frames a model often re-enacts. Default 1.
   * A shot can override it. Crossfades, unchained shots, and stepped-back
   * chains ignore it.
   */
  chainTrimStartFrames: number;
  /**
   * Legacy mirror of chainTrimStartFrames > 0. Older rows and clients still
   * send this boolean: true means trim 1, false means trim 0.
   */
  dropDuplicateFrame: boolean;
  /**
   * Shared style / character text. Empty by default.
   * Prefixed onto each shot prompt when a take or preview job is created.
   * Text only — not a character lock.
   */
  styleBase: string;
  /**
   * Stitch frame rate. Null uses the majority rate of the clips in the cut.
   * An equal count uses the higher rate. This does not speed clips up.
   */
  outputFps: number | null;
  /** Stitch width. Null, with outputHeight, uses the majority size. */
  outputWidth: number | null;
  /** Stitch height. Set with outputWidth. */
  outputHeight: number | null;
  /**
   * EBU R128 on the final file. Null means on only when a clip has audio.
   * Off when every clip is silent, even if this is true.
   * A music bed masters to −14 LUFS instead when this is on or left at the default.
   */
  loudnessNormalize: boolean | null;
  /** Local audio file. Never sent to a provider. Unset means no music bed. */
  musicBedPath?: string;
  /** Bed level in dB before ducking and before the final master. Default −18. */
  musicLevelDb: number;
  /** Fade in at the start of the cut. 0 is no fade. */
  musicFadeInSec: number;
  /** Fade out at the end of the cut. 0 is no fade. */
  musicFadeOutSec: number;
  /** Local SRT. Never sent to a provider. Unset means no captions. */
  captionsPath?: string;
  /** Null until an SRT is imported. Burn-in or a sidecar file. */
  captionMode: CaptionMode | null;
}

export interface Shot {
  id: string;
  projectId: string;
  position: number;
  prompt: string;
  presetId: string;
  durationSec: number;
  startImagePath?: string;
  endImagePath?: string;
  /** Take the stitch uses. When unset, the stitch uses the newest completed take. */
  selectedJobId?: string;
  /**
   * Approved take. The stitch keeps this clip. Render all, Retake, and
   * out-of-date updates do not replace it. Unset means the shot is not approved.
   */
  approvedJobId?: string;
  /** Hash of the start image at the moment the take was approved. */
  approvedStartStamp?: string;
  /** Hash of the end image at the moment the take was approved. Empty when there was none. */
  approvedEndStamp?: string;
  /**
   * Sequence seed. Unset rows use a stable seed derived from the shot id.
   * Retake stores a new seed here. Try seeds keeps its candidates on the takes.
   */
  seed?: number;
  /** Null inherits the project, then the app default. */
  comfyuiWorkflow?: ComfyWorkflowId | null;
  /** Null inherits the project, then the app default. */
  comfyLowMemory?: boolean | null;
  /** When true, the next take starts from a frame near the end of the previous shot. */
  chainFromPrevious: boolean;
  /**
   * How many frames before the end of the previous take to use as the start still.
   * 0 is the last frame. Bounded, because the very last frame is often soft.
   */
  chainFrameBack: number;
  /** Extracted still, stored like any other image. The user's start image stays put. */
  chainedStartImagePath?: string;
  /** Take id the chained still was extracted from. */
  chainedFromJobId?: string;
  /**
   * Frames back that the stored still actually is. 0 means it is the exact last frame.
   * Null until a still has been extracted. Older rows are null and were the last frame.
   */
  chainedFrameBack?: number;
  /** The chainFrameBack setting used when that still was extracted. */
  chainedFrameRequest?: number;
  /**
   * Null inherits the project. 0–4 trims that many start frames on a chained
   * hard cut that used the exact last frame.
   */
  chainTrimStartFrames?: number | null;
  /**
   * Legacy. Null inherits. Older rows: true means trim 1, false means trim 0.
   * Prefer chainTrimStartFrames.
   */
  dropDuplicateFrame?: boolean | null;
  /** Join into this shot. Null inherits the project seam. */
  seamMode?: SeamMode | null;
  /** Null inherits the project crossfade length. */
  seamFadeSec?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface MotionPreset {
  id: string;
  label: string;
  promptHint: string;
  zoom: number;
  durationSec: number;
}

export interface Job {
  id: string;
  projectId: string;
  shotId?: string;
  prompt: string;
  presetId: string;
  provider: ProviderId;
  /** Preview clips are Mock-only and never count as the shot's take. */
  kind: JobKind;
  status: JobStatus;
  imagePath: string;
  endImagePath?: string;
  characterSheetPath?: string;
  characterNote?: string;
  providerNote?: string;
  outputPath?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  progress?: number;
  modelName?: string;
  durationSec?: number;
  remoteId?: string;
  /** The worker must extract the previous shot's last frame before the provider runs. */
  awaitPreviousFrame?: boolean;
  /** Seed sent to the provider. Mock records it and does not resample pixels from it. */
  seed?: number;
  /** Content key of the inputs that produced this clip. Previews leave it unset. */
  inputKey?: string;
}

export interface RateTable {
  fal: Record<string, number>;
  replicate: Record<string, number>;
}

/** Hosted credit meter. Present only when Stripe or PayPal packs are configured. */
export interface CreditEstimate {
  hosted: true;
  required: number;
  balance: number;
  insufficient: boolean;
  perSecond: number;
  label: string;
}

/** User-entered arithmetic. Never a vendor quote. */
export interface CostEstimate {
  paid: boolean;
  seconds: number;
  ratePerSecond: number | null;
  total: number | null;
  unknown: boolean;
  budgetCap: number | null;
  overBudget: boolean;
  label: string;
  /** Omitted when Stripe and PayPal are unset, so the free studio stays on the Phase 1 shape. */
  credits?: CreditEstimate;
}

export interface PublicCreditPack {
  id: string;
  label: string;
  credits: number;
}

/** Price shown on the PayPal button. Client id and secret stay off this object. */
export interface PublicPayPalPack {
  id: string;
  label: string;
  credits: number;
  amount: string;
  currency: string;
}

export interface PackWorkflowInfo {
  id: string;
  title: string;
  detail: string;
}

export interface StudioEnv {
  hasFalKey: boolean;
  hasReplicateToken: boolean;
  /** True when COMFYUI_BASE_URL is set. The URL itself is not included. */
  comfyuiUrlFromEnv: boolean;
  /** True when COMFYUI_AUTH_HEADER is set. The header value is not included. */
  comfyuiAuthConfigured: boolean;
  hostedCredits: boolean;
  stripeCredits: boolean;
  paypalCredits: boolean;
  creditBalance: number | null;
  creditPacks: PublicCreditPack[];
  paypalPacks: PublicPayPalPack[];
  packUnlocked: boolean;
  packWorkflows: PackWorkflowInfo[];
}

export interface AppSettings {
  provider: ProviderId;
  comfyuiBaseUrl: string;
  falModel: string;
  replicateModel: string;
  comfyuiWorkflow: ComfyWorkflowId;
  /** App default for shots and projects that do not override it. */
  comfyLowMemory: boolean;
  rates: RateTable;
  budgetCap: number | null;
}

export const MOTION_PRESETS: MotionPreset[] = [
  {
    id: "slow-zoom-in",
    label: "Slow Zoom In",
    promptHint: "gentle cinematic push-in",
    zoom: 1.25,
    durationSec: 4,
  },
  {
    id: "slow-zoom-out",
    label: "Slow Zoom Out",
    promptHint: "gentle cinematic pull-back",
    zoom: 0.8,
    durationSec: 4,
  },
  {
    id: "pan-right",
    label: "Drift Right",
    promptHint: "slow horizontal drift to the right",
    zoom: 1.15,
    durationSec: 5,
  },
  {
    id: "dramatic-push",
    label: "Dramatic Push",
    promptHint: "dramatic accelerating zoom toward subject",
    zoom: 1.5,
    durationSec: 3,
  },
];

export const EMPTY_RATES: RateTable = { fal: {}, replicate: {} };

export const DEFAULT_SETTINGS: AppSettings = {
  provider: "mock",
  comfyuiBaseUrl: "http://127.0.0.1:8188",
  falModel: "fal-ai/minimax/video-01/image-to-video",
  replicateModel: "stability-ai/stable-video-diffusion",
  comfyuiWorkflow: "svd",
  comfyLowMemory: false,
  rates: { fal: {}, replicate: {} },
  budgetCap: null,
};

export const SAMPLE_PROJECT_ID = "sample-harbor-dusk";

export const MIN_SHOT_SECONDS = 1;
export const MAX_SHOT_SECONDS = 10;

export const MIN_SEAM_FADE_SEC = 0.25;
export const MAX_SEAM_FADE_SEC = 1;
export const DEFAULT_SEAM_FADE_SEC = 0.5;
export const SEAM_FADE_CHOICES = [0.25, 0.5, 0.75, 1] as const;

/** 0 is the last frame. Twelve is about half a second at 24 fps. */
export const MAX_CHAIN_FRAME_BACK = 12;
export const CHAIN_FRAME_BACK_CHOICES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

/** Incoming start frames removed on a qualifying chained hard cut. */
export const MIN_CHAIN_TRIM_START_FRAMES = 0;
export const MAX_CHAIN_TRIM_START_FRAMES = 4;
export const DEFAULT_CHAIN_TRIM_START_FRAMES = 1;
export const CHAIN_TRIM_START_CHOICES = [0, 1, 2, 3, 4] as const;

export const CHAIN_HONESTY =
  "Starting from the previous shot's last frame helps continuity of pose and framing. Identity and details still drift over many chained shots. Star Dust does not lock characters.";

export const CHAIN_STALE_NOTE =
  "Out of date. The previous shot's take changed since this one was rendered.";

export const REUSE_SKIP_REASON = "Reused an existing clip. No new spend.";

export const REUSE_LABEL = "Reused · no new spend";

export const REUSE_HONESTY =
  "Reuse loads a finished clip when the still, the effective prompt (including shared style text), the seed, the backend and model or workflow, the render settings, the start-frame trim when it applies, and the upstream clip are unchanged. That avoids paying again for an unchanged shot. It does not promise the same pixels from another backend, and it does not lock a character.";

export const RETAKE_NOTE =
  "Retake gives this shot a new seed and renders it again, plus every chained shot after it until an approved take. An approved take stays. Earlier takes stay. It does not lock a character.";

export const APPROVED_LABEL = "Approved";

export const APPROVED_MISMATCH_NOTE = "Approved take no longer matches this shot.";

export const APPROVED_HOLD_REASON = "Approved take kept. Not rendered again.";

export const APPROVE_HONESTY =
  "Approve keeps this take in the stitch. Render all, Retake, and out-of-date updates do not replace it. Only unapproved shots between approved takes are marked out of date. This does not lock a character, lip-sync, or build a long film.";

export const DEFAULT_MUSIC_LEVEL_DB = -18;
export const MIN_MUSIC_LEVEL_DB = -40;
export const MAX_MUSIC_LEVEL_DB = 0;
export const DEFAULT_MUSIC_FADE_IN_SEC = 0.25;
export const DEFAULT_MUSIC_FADE_OUT_SEC = 1;
export const MAX_MUSIC_FADE_SEC = 5;
export const MUSIC_LEVEL_CHOICES = [-12, -18, -24, -30] as const;
export const MUSIC_FADE_CHOICES = [0, 0.25, 0.5, 1, 2] as const;

export const FINISH_HONESTY =
  "The music file stays on this machine. It is not sent to a provider. Captions come from the SRT you import. Star Dust does not transcribe speech, does not lip-sync, and does not lock a character or build a long film.";

export interface FinishView {
  /** "music bed, ducked; 14 captions burned in" when that is what the cut will add. */
  line: string;
  music: "ducked" | "level" | null;
  captions: { count: number; mode: CaptionMode } | null;
  captionErrors: string[];
  loudnessNote: string | null;
  fitNote: string | null;
  /** Set when a sidecar .srt was written next to the mp4. */
  sidecarPath?: string;
}

export const CONFORM_HONESTY =
  "Frame rate changes by duplicating or dropping frames, not by speeding a clip up. Letterbox and pillarbox keep the picture from being stretched. This does not lock a character, lip-sync, or build a long film.";

export const EDIT_EXPORT_HONESTY =
  "Export for edit zips the chosen take of each shot: the approved take when one is set, otherwise the current take. Names look like SH010_v03.mp4, so a newer version does not overwrite an earlier file. The CMX3600 EDL follows the shot list, with the same hard cuts and crossfade lengths as the stitch, at the conformed frame rate. It carries cuts, dissolves, and in/out only. It is not a Premiere or Resolve project. The mp4 is a review codec, not a mastering codec. When the project has an SRT, the zip includes captions.srt with times snapped to that conformed frame rate. This does not lock a character, lip-sync, or build a long film.";

export const HUNT_NOTE =
  "Try 2, 3, or 4 seeds of this one shot and pick a winner. Each candidate stays as a take. The estimate is shown first. A paid run above your typed rate is blocked. It does not lock a character.";

export const HUNT_SEED_CHOICES = [2, 3, 4] as const;

export type HuntSeedCount = (typeof HUNT_SEED_CHOICES)[number];

export function huntSeedCount(value: unknown): HuntSeedCount | null {
  const count = typeof value === "number" ? value : Number(value);
  if (count === 2 || count === 3 || count === 4) return count;
  return null;
}

/** Tail of the previous take, and head of the next, in a seam preview. */
export const SEAM_PREVIEW_SEC = 1.5;

export const SEAM_PREVIEW_HONESTY =
  "Preview seam plays about the last 1.5 seconds of the previous take and the first 1.5 seconds of this one, using the same join as the stitch. It helps you spot the seam. It does not fix drift, lock a character, or guarantee continuity. It does not replace any take.";

export const SEAM_HONESTY =
  "Hard cut is the default. A short crossfade blends the pixels at the join. Star Dust does not match colour or brightness, does not lock a character, and does not lip-sync or build a long film.";

export const SEAM_FRAME_HONESTY =
  "On a chained hard cut from the previous shot's exact last frame, trim 0–4 frames from the start of the next clip. The default is 1, which drops that repeated frame. 2–4 also trims early frames a model often re-enacts, which softens that freeze at the seam. It does not fix identity or detail drift, and it does not keep identity continuous. A crossfade is left as-is, a shot that is not chained is left as-is, and stepping back from the last frame is left as-is. Star Dust does not lock a character, lip-sync, or build a long film.";

export const FRAME_BACK_HONESTY =
  "0 is the last frame. A few frames earlier skips a soft or blurred ending frame. The start-frame trim runs only for that exact last frame, because only then is the next clip starting on the same moment. Stepping back leaves the previous take whole, so the join can step backward by those frames. It does not fix identity or detail drift.";

export const DROPPED_FRAME_NOTE =
  "Dropped the repeated frame at this hard cut. That does not fix identity or detail drift.";

export const FRAME_BACK_SEAM_NOTE =
  "Started before the last frame, so the frames at the cut differ and nothing was dropped.";

/** Seam note for a trim of more than one start frame. One frame keeps DROPPED_FRAME_NOTE. */
export function startFrameTrimNote(count: number): string {
  if (count <= 1) return DROPPED_FRAME_NOTE;
  return `Trimmed ${count} start frames at this hard cut. That softens a re-enacted freeze at the seam. It does not fix identity or detail drift.`;
}

export const STYLE_BASE_HONESTY =
  "Text only — not a character lock. These words are added in front of every shot when a take or preview is queued. Identity can still drift across shots. Star Dust does not lock a face, lip-sync, or build a long film.";

/** Shared base with surrounding commas removed. Empty when the field is blank or only commas. */
export function styleBaseText(styleBase: string | null | undefined): string {
  return (styleBase ?? "").trim().replace(/^[,\s]+|[,\s]+$/g, "");
}

/**
 * Prompt a provider sees. An empty style base leaves the shot prompt unchanged.
 * A set base is joined as `styleBase, shot prompt`, without a double or dangling comma.
 */
export function effectivePrompt(styleBase: string | null | undefined, shotPrompt: string): string {
  const base = styleBaseText(styleBase);
  if (!base) return shotPrompt;
  const action = shotPrompt.trim().replace(/^[,\s]+/, "");
  if (!action) return base;
  return `${base}, ${action}`;
}

export function clampMusicLevelDb(value: number, fallback = DEFAULT_MUSIC_LEVEL_DB): number {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.round(value * 10) / 10;
  return Math.min(MAX_MUSIC_LEVEL_DB, Math.max(MIN_MUSIC_LEVEL_DB, rounded));
}

export function clampMusicFadeSec(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.round(value * 1000) / 1000;
  return Math.min(MAX_MUSIC_FADE_SEC, Math.max(0, rounded));
}

export function clampSeamFade(value: number, fallback = DEFAULT_SEAM_FADE_SEC): number {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.round(value * 1000) / 1000;
  return Math.min(MAX_SEAM_FADE_SEC, Math.max(MIN_SEAM_FADE_SEC, rounded));
}

export function clampChainFrameBack(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded)) return fallback;
  return Math.min(MAX_CHAIN_FRAME_BACK, Math.max(0, rounded));
}

export function clampChainTrimStartFrames(
  value: number,
  fallback = DEFAULT_CHAIN_TRIM_START_FRAMES
): number {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded)) return fallback;
  return Math.min(MAX_CHAIN_TRIM_START_FRAMES, Math.max(MIN_CHAIN_TRIM_START_FRAMES, rounded));
}

/** Older boolean: on dropped one frame, off kept every frame. */
export function chainTrimFromDropDuplicate(dropDuplicateFrame: boolean): number {
  return dropDuplicateFrame ? 1 : 0;
}

/**
 * Project trim from a stored row. A numeric value wins. When it is missing,
 * the old boolean still applies: true → 1, false → 0. Missing both is the default 1.
 */
export function projectChainTrimFromStored(
  chainTrimStartFrames: unknown,
  dropDuplicateFrame: unknown
): number {
  if (chainTrimStartFrames != null && chainTrimStartFrames !== "") {
    const numeric = Number(chainTrimStartFrames);
    if (Number.isFinite(numeric)) return clampChainTrimStartFrames(numeric);
  }
  if (dropDuplicateFrame == null || dropDuplicateFrame === "") return DEFAULT_CHAIN_TRIM_START_FRAMES;
  if (dropDuplicateFrame === false || Number(dropDuplicateFrame) === 0) return 0;
  return 1;
}

/**
 * Shot trim from a stored row. Null means inherit. A numeric value wins.
 * When it is missing, the old boolean still applies: true → 1, false → 0.
 */
export function shotChainTrimFromStored(
  chainTrimStartFrames: unknown,
  dropDuplicateFrame: unknown
): number | null {
  if (chainTrimStartFrames != null && chainTrimStartFrames !== "") {
    const numeric = Number(chainTrimStartFrames);
    if (Number.isFinite(numeric)) return clampChainTrimStartFrames(numeric);
  }
  if (dropDuplicateFrame == null || dropDuplicateFrame === "") return null;
  if (dropDuplicateFrame === false || Number(dropDuplicateFrame) === 0) return 0;
  return 1;
}

export function chainTrimChoiceLabel(frames: number): string {
  const n = clampChainTrimStartFrames(frames);
  if (n === 0) return "0 — keep every frame";
  if (n === 1) return "1 — drop the repeated frame";
  return `${n} — trim ${n} start frames`;
}

/** Plain words for the frame a chained shot starts from. 0 is the last frame. */
export function chainFramePhrase(framesBack: number): string {
  const n = clampChainFrameBack(framesBack);
  if (n === 0) return "last frame";
  if (n === 1) return "frame 1 before the end";
  return `frame ${n} before the end`;
}

/**
 * Index of the still to extract. `appliedBack` is 0 only when that still is the
 * exact last frame, including when a short clip cannot step back as far as asked.
 */
export function frameIndexFromEnd(
  frameCount: number,
  framesBack: number
): { index: number; appliedBack: number } {
  const requested = clampChainFrameBack(framesBack);
  const count = Number.isFinite(frameCount) ? Math.floor(frameCount) : 0;
  if (count < 1) return { index: 0, appliedBack: 0 };
  const index = Math.max(0, count - 1 - requested);
  return { index, appliedBack: count - 1 - index };
}

export function clampDuration(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_SHOT_SECONDS, Math.max(MIN_SHOT_SECONDS, value));
}

export function presetById(id: string): MotionPreset {
  return MOTION_PRESETS.find((preset) => preset.id === id) ?? MOTION_PRESETS[0];
}
