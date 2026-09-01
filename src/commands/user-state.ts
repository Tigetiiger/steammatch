/**
 * Small per-user process state shared between command modules.
 *
 * Lives in its own module so `/privacy` can clear a user's consent without
 * importing `/steam` (which would deepen the existing import cycle), and so both
 * maps get a TTL sweep instead of growing for the lifetime of the process.
 */

/** Consent is re-asked after this long anyway, so entries need not live forever. */
const CONSENT_TTL_MS = 24 * 60 * 60_000;
/** Manual /steam refresh cooldown. */
export const REFRESH_COOLDOWN_MS = 15 * 60_000;

const consentedAt = new Map<string, number>();
const refreshedAt = new Map<string, number>();

export function hasConsented(userId: string): boolean {
  const at = consentedAt.get(userId);
  if (at === undefined) return false;
  if (Date.now() - at > CONSENT_TTL_MS) {
    consentedAt.delete(userId);
    return false;
  }
  return true;
}

export function recordConsent(userId: string): void {
  consentedAt.set(userId, Date.now());
}

/**
 * Called by /steam unlink AND by /privacy "delete everything". The deletion
 * confirmation promises the consent prompt comes back; without clearing this
 * the very next /games add sync in the same process would skip it.
 */
export function clearConsent(userId: string): void {
  consentedAt.delete(userId);
  // Deliberately does NOT clear the refresh cooldown. Doing so made the
  // 15-minute limit bypassable with unlink -> link, or by looping /steam
  // refresh on a profile that always fails.
}

/** Milliseconds remaining on the refresh cooldown, or 0 when ready. */
export function refreshCooldownLeft(userId: string): number {
  const last = refreshedAt.get(userId) ?? 0;
  return Math.max(0, REFRESH_COOLDOWN_MS - (Date.now() - last));
}

export function markRefreshed(userId: string): void {
  refreshedAt.set(userId, Date.now());
}

export function clearRefreshMark(userId: string): void {
  refreshedAt.delete(userId);
}

/**
 * Shorten the cooldown after a failed refresh instead of removing it. The user
 * should not be punished a full 15 minutes for a Steam outage, but an
 * always-failing profile must not become an unlimited retry loop either.
 */
export const SOFT_REFRESH_COOLDOWN_MS = 60_000;
export function softenRefreshMark(userId: string): void {
  refreshedAt.set(userId, Date.now() - (REFRESH_COOLDOWN_MS - SOFT_REFRESH_COOLDOWN_MS));
}

/** Drop entries no longer capable of affecting a decision. */
export function sweepUserState(now = Date.now()): void {
  for (const [k, at] of consentedAt) if (now - at > CONSENT_TTL_MS) consentedAt.delete(k);
  for (const [k, at] of refreshedAt) if (now - at > REFRESH_COOLDOWN_MS) refreshedAt.delete(k);
}

const sweeper = setInterval(() => sweepUserState(), 5 * 60_000);
sweeper.unref?.();

/** Test hook. */
export function _reset(): void {
  consentedAt.clear();
  refreshedAt.clear();
}
