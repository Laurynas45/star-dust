import { getCreditBalance, hostedCreditsEnabled, publicCreditPacks } from "./credits";
import { packUnlocked, visiblePackWorkflows } from "./pack";
import { StudioEnv } from "./types";

/** Safe settings payload. Keys and price ids are not included. */
export function studioEnv(): StudioEnv {
  const hosted = hostedCreditsEnabled();
  return {
    hasFalKey: Boolean(process.env.FAL_KEY),
    hasReplicateToken: Boolean(process.env.REPLICATE_API_TOKEN),
    hostedCredits: hosted,
    creditBalance: hosted ? getCreditBalance() : null,
    creditPacks: hosted ? publicCreditPacks() : [],
    packUnlocked: packUnlocked(),
    packWorkflows: visiblePackWorkflows(),
  };
}
