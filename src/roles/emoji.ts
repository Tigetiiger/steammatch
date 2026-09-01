/**
 * Emoji identity.
 *
 * THE ONE RULE: the key computed from a gateway reaction event and the key
 * computed from what a moderator typed into a slash command must be identical,
 * or the panel silently does nothing. Both sides call `emojiKey`.
 *
 * Two ways they drift if you do it by hand:
 *  - A custom emoji arrives as `{ id: '123', name: 'pepe' }` from the gateway
 *    but as the literal text `<:pepe:123>` from a command option.
 *  - Unicode emoji carry an optional VARIATION SELECTOR-16 (U+FE0F) that
 *    requests the colour rendering. Discord's picker inserts it, keyboards
 *    often do not, and the gateway echoes back whatever was sent -- so '❤️'
 *    and '❤' are the same emoji with two different byte sequences.
 */

/** `<:name:id>` or `<a:name:id>` for animated. */
const CUSTOM_RE = /^<(a?):([A-Za-z0-9_]{2,32}):(\d{15,25})>$/;
/** Variation selectors: VS16 requests emoji presentation, VS15 text presentation. */
const VARIATION_SELECTORS = /[\uFE0E\uFE0F]/g;

export interface ParsedEmoji {
  /** Stable identity, stored in reaction_roles.emoji_key. */
  key: string;
  /** Display / what to pass to message.react(). */
  raw: string;
  animated: boolean;
}

/**
 * Identity for an emoji as the gateway describes it.
 *
 * Returns null for the shapes that cannot address a reaction: no id AND no
 * name. That happens for a deleted custom emoji, which the gateway still
 * reports reactions for.
 */
export function emojiKey(e: { id?: string | null; name?: string | null }): string | null {
  if (e.id) return e.id;
  if (!e.name) return null;
  return normalizeUnicode(e.name);
}

/** Strip variation selectors so the two spellings of one emoji share a key. */
export function normalizeUnicode(s: string): string {
  return s.normalize('NFC').replace(VARIATION_SELECTORS, '');
}

/**
 * Parse what a person typed into the `emoji` command option.
 *
 * Returns null for anything that is not a single emoji: plain words, several
 * emoji at once, an emoji plus text. Being strict here is what stops a
 * moderator from binding a role to something no one can ever react with.
 */
export function parseEmojiInput(raw: string): ParsedEmoji | null {
  const input = (raw ?? '').trim();
  if (input === '') return null;

  const custom = CUSTOM_RE.exec(input);
  if (custom) {
    const animated = custom[1] === 'a';
    const name = custom[2] ?? '';
    const id = custom[3] ?? '';
    return { key: id, raw: `<${animated ? 'a' : ''}:${name}:${id}>`, animated };
  }

  // A bare snowflake is almost certainly a custom emoji id pasted without its
  // wrapper. We cannot render it (the name is part of the syntax), so refuse
  // rather than store something that will display as a broken image.
  if (/^\d{15,25}$/.test(input)) return null;

  const normalized = normalizeUnicode(input);
  // Validate BEFORE stripping, not after. \p{RGI_Emoji} only accepts a
  // text-default character such as U+26CF (pickaxe) when it carries the
  // variation selector, so testing the stripped form rejects '⛏️' -- a
  // perfectly ordinary emoji -- while accepting '🚀'. Try all three spellings:
  // as typed, stripped, and stripped-plus-VS16.
  const presented = `${normalized}\uFE0F`;
  const display = isSingleEmoji(input)
    ? input
    : isSingleEmoji(presented)
      ? presented
      : isSingleEmoji(normalized)
        ? normalized
        : null;
  if (display === null) return null;
  // `raw` is what gets rendered and reacted with; `key` is the stripped form,
  // which is the only spelling both sides can agree on.
  return { key: normalized, raw: display, animated: false };
}

/**
 * True when `s` is exactly one emoji.
 *
 * Uses the Unicode property escapes rather than a hand-rolled range list:
 * \p{RGI_Emoji} covers ZWJ sequences (👨‍👩‍👧), flags, keycaps and skin-tone
 * modifiers as single units, which a naive [\u{1F300}-\u{1FAFF}] test splits
 * apart. Node 20 supports the `v` flag this needs.
 */
function isSingleEmoji(s: string): boolean {
  try {
    return new RegExp('^\\p{RGI_Emoji}$', 'v').test(s);
  } catch {
    // Older engine without the `v` flag: fall back to "one grapheme that is
    // not ASCII and contains at least one Extended_Pictographic code point".
    const chars = [...s];
    if (chars.length === 0 || chars.length > 8) return false;
    return /\p{Extended_Pictographic}/u.test(s) && !/[\w\s]/.test(s);
  }
}
