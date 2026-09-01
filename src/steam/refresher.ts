/**
 * Background library refresh.
 *
 * The consent screen and every link confirmation promise that libraries refresh
 * roughly every 6 hours. `sync.ts` has always written `stale_after` and the
 * failure backoff, but nothing read them, so that promise was not kept and the
 * whole backoff path was unreachable. This is the missing reader.
 *
 * Deliberately gentle: one account at a time, spaced out, and only for users
 * who opted in and are still in a guild. Steam's terms allow fetching a user's
 * data because that user asked -- not a standing licence to crawl.
 */

import type { Database } from 'better-sqlite3';
import { dueForRefresh } from '../db/queries.js';
import { syncLibrary, type LibrarySource } from './sync.js';

export interface RefresherOptions {
  /** How often to look for stale accounts. */
  intervalMs?: number;
  /** Most accounts refreshed per tick. Keeps us far below the Steam quota. */
  batchSize?: number;
  /** Pause between accounts within a batch. */
  spacingMs?: number;
}

const DEFAULTS = { intervalMs: 15 * 60_000, batchSize: 10, spacingMs: 3_000 };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Refresh one batch of stale accounts. Exported separately from the timer so it
 * can be tested and so a caller can trigger a sweep on startup.
 */
export async function refreshDue(
  db: Database,
  client: LibrarySource,
  opts: RefresherOptions = {},
): Promise<{ attempted: number; failed: number }> {
  const { batchSize, spacingMs } = { ...DEFAULTS, ...opts };
  const due = dueForRefresh(db, batchSize);
  let failed = 0;

  for (const [i, row] of due.entries()) {
    if (i > 0) await sleep(spacingMs);
    try {
      await syncLibrary(db, row.userId, row.id64, client);
    } catch (err) {
      // syncLibrary records the failure and backs off `stale_after` itself, so
      // one bad account must not abort the rest of the batch.
      failed++;
      console.error('[refresher] sync failed for a user', err);
    }
  }
  return { attempted: due.length, failed };
}

export interface StopHandle {
  stop(): void;
}

export function startRefresher(
  db: Database,
  client: LibrarySource,
  opts: RefresherOptions = {},
): StopHandle {
  const { intervalMs } = { ...DEFAULTS, ...opts };
  let running = false;

  const tick = async () => {
    if (running) return; // never overlap batches
    running = true;
    try {
      const { attempted, failed } = await refreshDue(db, client, opts);
      if (attempted > 0) {
        console.log(`[refresher] refreshed ${attempted - failed}/${attempted} stale libraries`);
      }
    } catch (err) {
      console.error('[refresher] batch failed', err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick(); // sweep once at startup

  return { stop: () => clearInterval(timer) };
}
