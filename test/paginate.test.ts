/**
 * Coverage for src/ui/paginate.ts.
 *
 * Only the parts that are reachable without a live Discord gateway are tested:
 * the module-global session store, the exported component builders, and the
 * FILTERS table. `paginate()` itself needs a real deferred interaction plus a
 * message with `createMessageComponentCollector`, so its internals are exercised
 * only through the pieces it delegates to.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ButtonStyle } from 'discord.js';
import {
  FILTERS,
  PAGE_SIZE,
  SESSION_TTL_MS,
  claimSessionId,
  filterRow,
  hasSession,
  navRow,
  releaseSession,
  sessionCount,
  sweepSessions,
} from '../src/ui/paginate.js';

interface ButtonJSON {
  custom_id: string;
  label?: string;
  style: number;
  disabled?: boolean;
}

const buttons = (row: { toJSON(): unknown }): ButtonJSON[] =>
  (row.toJSON() as { components: ButtonJSON[] }).components;

/** The sessions map is module-global; start every test from a clean one. */
beforeEach(() => {
  sweepSessions(Date.now() + SESSION_TTL_MS * 10);
  expect(sessionCount()).toBe(0);
});

describe('FILTERS', () => {
  it('is exactly the 30m/1h/5h/10h/all row, in that order', () => {
    expect(FILTERS.map((f) => f.label)).toEqual(['30 min+', '1 h+', '5 h+', '10 h+', 'Kõik']);
    expect(FILTERS.map((f) => f.min)).toEqual([30, 60, 300, 600, -1]);
  });

  it('uses -1 for All, never 0, because filters apply a strict >', () => {
    const all = FILTERS.at(-1)!;
    expect(all.label).toBe('Kõik');
    expect(all.min).toBe(-1);
    // The exact predicate the callers use: a 0-minute game must survive "All".
    expect(0 > all.min).toBe(true);
    // ...and must be excluded by every other filter.
    for (const f of FILTERS.slice(0, -1)) expect(0 > f.min).toBe(false);
  });

  it('is monotonically increasing over the real thresholds', () => {
    const mins = FILTERS.filter((f) => f.min >= 0).map((f) => f.min);
    expect([...mins].sort((a, b) => a - b)).toEqual(mins);
  });

  it('fits Discord\'s 5-buttons-per-row limit', () => {
    expect(FILTERS.length).toBeLessThanOrEqual(5);
  });
});

describe('session store', () => {
  it('claims a session that is immediately visible to the global button router', () => {
    const id = claimSessionId('owner-1');
    expect(hasSession(id)).toBe(true);
    expect(sessionCount()).toBe(1);
  });

  it('mints a distinct id per claim', () => {
    const ids = new Set(Array.from({ length: 50 }, () => claimSessionId('owner-1')));
    expect(ids.size).toBe(50);
    expect(sessionCount()).toBe(50);
  });

  it("mints ids with no ':' in them, since the router reads customId.split(':')[1]", () => {
    for (let i = 0; i < 20; i++) {
      const id = claimSessionId('owner-1');
      expect(id).toMatch(/^[0-9a-f-]+$/);
      expect(id).not.toContain(':');
    }
  });

  it('releases only the session asked for', () => {
    const a = claimSessionId('owner-1');
    const b = claimSessionId('owner-2');
    releaseSession(a);

    expect(hasSession(a)).toBe(false);
    expect(hasSession(b)).toBe(true);
  });

  it('is a no-op when releasing an unknown id', () => {
    const a = claimSessionId('owner-1');
    releaseSession('not-a-session');
    expect(hasSession(a)).toBe(true);
    expect(sessionCount()).toBe(1);
  });

  it('reports no session for an id that was never claimed', () => {
    expect(hasSession('deadbeef')).toBe(false);
  });
});

describe('sweepSessions', () => {
  it('keeps a session until its deadline and drops it at the deadline', () => {
    const before = Date.now();
    const id = claimSessionId('owner-1');
    const deadline = before + SESSION_TTL_MS;

    // One millisecond short of the earliest possible expiry: still alive.
    expect(sweepSessions(deadline - 1)).toBe(0);
    expect(hasSession(id)).toBe(true);

    // Comfortably past it: gone, and reported as one removal.
    expect(sweepSessions(Date.now() + SESSION_TTL_MS + 1)).toBe(1);
    expect(hasSession(id)).toBe(false);
  });

  it('drops only the sessions past their own deadline', () => {
    // Fake the clock rather than the timers: advancing timers would also fire
    // the module's own 60s sweeper and confuse the counts.
    vi.useFakeTimers();
    try {
      const base = 1_700_000_000_000;
      vi.setSystemTime(base);
      const old = claimSessionId('owner-1');
      vi.setSystemTime(base + 60_000);
      const fresh = claimSessionId('owner-2');

      // `old` expires at base + TTL; `fresh` a minute later.
      expect(sweepSessions(base + SESSION_TTL_MS)).toBe(1);
      expect(hasSession(old)).toBe(false);
      expect(hasSession(fresh)).toBe(true);

      expect(sweepSessions(base + 60_000 + SESSION_TTL_MS)).toBe(1);
      expect(sessionCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns 0 on an empty store', () => {
    expect(sweepSessions(Date.now() + SESSION_TTL_MS * 10)).toBe(0);
  });

  it('outlives the 14-minute collector so buttons never outlive their session', () => {
    expect(SESSION_TTL_MS).toBeGreaterThan(14 * 60_000);
  });
});

describe('navRow', () => {
  it('encodes prev/next as pg:<id>:<page> and labels the middle button 1-based', () => {
    const b = buttons(navRow('abc12345', 2, 5));

    expect(b.map((x) => x.custom_id)).toEqual([
      'pg:abc12345:1',
      'pg:abc12345:noop',
      'pg:abc12345:3',
    ]);
    expect(b[1]!.label).toBe('3/5');
    expect(b[1]!.disabled).toBe(true);
    expect(b[0]!.disabled).toBeFalsy();
    expect(b[2]!.disabled).toBeFalsy();
  });

  it('clamps prev to page 0 and disables it on the first page', () => {
    const b = buttons(navRow('abc12345', 0, 5));
    expect(b[0]!.custom_id).toBe('pg:abc12345:0');
    expect(b[0]!.disabled).toBe(true);
    expect(b[2]!.custom_id).toBe('pg:abc12345:1');
    expect(b[2]!.disabled).toBeFalsy();
  });

  it('clamps next to the last page and disables it on the last page', () => {
    const b = buttons(navRow('abc12345', 4, 5));
    expect(b[2]!.custom_id).toBe('pg:abc12345:4');
    expect(b[2]!.disabled).toBe(true);
    expect(b[0]!.custom_id).toBe('pg:abc12345:3');
  });

  it('disables both arrows on a single-page result', () => {
    const b = buttons(navRow('abc12345', 0, 1));
    expect(b[0]!.disabled).toBe(true);
    expect(b[2]!.disabled).toBe(true);
    expect(b[1]!.label).toBe('1/1');
  });

  it('leaves room for two extra buttons inside the 5-per-row limit', () => {
    expect(buttons(navRow('abc12345', 0, 3))).toHaveLength(3);
  });
});

describe('filterRow', () => {
  it('renders one button per filter, encoded as pf:<id>:<minutes>', () => {
    const b = buttons(filterRow('abc12345', 30));

    expect(b).toHaveLength(FILTERS.length);
    expect(b.map((x) => x.custom_id)).toEqual([
      'pf:abc12345:30',
      'pf:abc12345:60',
      'pf:abc12345:300',
      'pf:abc12345:600',
      'pf:abc12345:-1',
    ]);
    expect(b).toHaveLength(5);
  });

  it('highlights exactly the active filter', () => {
    const b = buttons(filterRow('abc12345', 300));
    const primaries = b.filter((x) => x.style === ButtonStyle.Primary);

    expect(primaries.map((x) => x.label)).toEqual(['5 h+']);
    expect(b.filter((x) => x.style === ButtonStyle.Secondary)).toHaveLength(4);
  });

  it('highlights Kõik when the active filter is -1', () => {
    const b = buttons(filterRow('abc12345', -1));
    expect(b.filter((x) => x.style === ButtonStyle.Primary).map((x) => x.label)).toEqual(['Kõik']);
  });

  it('highlights nothing for a filter value that is not in the row', () => {
    const b = buttons(filterRow('abc12345', 0));
    expect(b.every((x) => x.style === ButtonStyle.Secondary)).toBe(true);
  });
});

describe('custom_id round-trip against the global router', () => {
  /** Exactly what src/index.ts and the collector do to a clicked customId. */
  const parse = (customId: string): { kind: string; sid: string; arg: string } => {
    const parts = customId.split(':');
    return { kind: parts[0] ?? '', sid: parts[1] ?? '', arg: parts.slice(2).join(':') };
  };

  it('round-trips a real minted session id through a nav button', () => {
    const id = claimSessionId('owner-1');
    const b = buttons(navRow(id, 3, 9));

    expect(parse(b[0]!.custom_id)).toEqual({ kind: 'pg', sid: id, arg: '2' });
    expect(parse(b[2]!.custom_id)).toEqual({ kind: 'pg', sid: id, arg: '4' });
    expect(Number.parseInt(parse(b[2]!.custom_id).arg, 10)).toBe(4);
    // The router only forwards clicks whose session is still live.
    expect(hasSession(parse(b[0]!.custom_id).sid)).toBe(true);
  });

  it('round-trips every filter, including the negative All threshold', () => {
    const id = claimSessionId('owner-1');
    const parsed = buttons(filterRow(id, -1)).map((b) => {
      const p = parse(b.custom_id);
      return { kind: p.kind, sid: p.sid, min: Number.parseInt(p.arg, 10) };
    });

    expect(parsed.map((p) => p.min)).toEqual(FILTERS.map((f) => f.min));
    expect(parsed.every((p) => p.kind === 'pf' && p.sid === id)).toBe(true);
  });

  it('produces prefixes the router recognises and ids under the 100-char cap', () => {
    const id = claimSessionId('owner-1');
    const ids = [
      ...buttons(navRow(id, 0, 2)).map((b) => b.custom_id),
      ...buttons(filterRow(id, 30)).map((b) => b.custom_id),
    ];

    for (const c of ids) {
      expect(c.length).toBeLessThanOrEqual(100);
      expect(/^(pg|pf|px|consent):/.test(c)).toBe(true);
    }
  });
});

describe('page maths', () => {
  it('PAGE_SIZE drives a 1-based page count that never drops below 1', () => {
    const pages = (n: number): number => Math.max(1, Math.ceil(n / PAGE_SIZE));
    expect(PAGE_SIZE).toBe(10);
    expect([pages(0), pages(1), pages(10), pages(11)]).toEqual([1, 1, 1, 2]);
  });
});
