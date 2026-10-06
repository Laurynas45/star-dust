/**
 * Local license stub for the optional self-hosted pack.
 * A non-empty STAR_DUST_LICENSE_KEY unlocks pack features.
 * The value is never stored and never sent to a server.
 */
export function licenseKeyPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.STAR_DUST_LICENSE_KEY?.trim());
}
