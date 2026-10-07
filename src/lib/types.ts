export type ProviderId = "mock" | "fal" | "replicate" | "comfyui";

export type JobKind = "take" | "preview";

export type ComfyWorkflowId = "svd" | "wan" | "ltx";

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
  /** Null inherits the project, then the app default. */
  comfyuiWorkflow?: ComfyWorkflowId | null;
  /** Null inherits the project, then the app default. */
  comfyLowMemory?: boolean | null;
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

export function clampDuration(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_SHOT_SECONDS, Math.max(MIN_SHOT_SECONDS, value));
}

export function presetById(id: string): MotionPreset {
  return MOTION_PRESETS.find((preset) => preset.id === id) ?? MOTION_PRESETS[0];
}
