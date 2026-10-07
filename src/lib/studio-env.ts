import {
  getCreditBalance,
  hostedCreditsEnabled,
  paypalCreditsEnabled,
  publicCreditPacks,
  publicPayPalPacks,
  stripeCreditsEnabled,
} from "./credits";
import { packUnlocked, visiblePackWorkflows } from "./pack";
import { StudioEnv } from "./types";

/** Safe settings payload. Keys and price ids are not included. */
export function studioEnv(): StudioEnv {
  const hosted = hostedCreditsEnabled();
  const stripe = stripeCreditsEnabled();
  const paypal = paypalCreditsEnabled();
  return {
    hasFalKey: Boolean(process.env.FAL_KEY),
    hasReplicateToken: Boolean(process.env.REPLICATE_API_TOKEN),
    comfyuiUrlFromEnv: Boolean(process.env.COMFYUI_BASE_URL?.trim()),
    comfyuiAuthConfigured: Boolean(process.env.COMFYUI_AUTH_HEADER?.trim()),
    hostedCredits: hosted,
    stripeCredits: stripe,
    paypalCredits: paypal,
    creditBalance: hosted ? getCreditBalance() : null,
    creditPacks: stripe ? publicCreditPacks() : [],
    paypalPacks: paypal ? publicPayPalPacks() : [],
    packUnlocked: packUnlocked(),
    packWorkflows: visiblePackWorkflows(),
  };
}
