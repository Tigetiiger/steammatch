/** Shared contract types. Every module imports from here; nothing else is cross-imported. */

/** Playtime is ALWAYS minutes, exactly as Steam reports it. Never seconds, never hours. */
export type Minutes = number;

/** Default matching threshold: strictly MORE than 30 minutes. */
export const DEFAULT_MIN_PLAYTIME: Minutes = 30;

export interface OwnedGame {
  appid: number;
  name: string;
  playtimeForever: Minutes;
  playtime2Weeks: Minutes;
  /** Bare SHA1 hash from Steam, or '' when the app has no icon. Not a URL. */
  iconHash: string;
}

/**
 * Why a library fetch did not produce games. These are genuinely different
 * problems with different user-facing fixes -- do not collapse them.
 */
export type ProfileState =
  | 'public'            // games visible
  | 'private'           // whole profile is private
  | 'game_details_private' // profile public, "Game details" setting is not
  | 'playtime_hidden'   // games visible but every playtime is 0
  | 'empty'             // genuinely owns nothing
  | 'error';

export interface LibraryResult {
  state: ProfileState;
  personaName: string | null;
  avatarUrl: string | null;
  games: OwnedGame[];
}

export class SteamUserError extends Error {}

export interface GameRow {
  appid: number;
  name: string;
  playtime: Minutes;
  /** False for manually added games, where no playtime exists. */
  tracked: boolean;
  /** True when the owner has hidden this game from everyone else in the server. */
  hidden: boolean;
}

/** A game the user unchecked at the import checklist, so it was never stored. */

export interface SharedRow {
  appid: number;
  name: string;
  mine: Minutes;
  theirs: Minutes;
  tracked: boolean;
}
export interface OwnerRow {
  userId: string;
  playtime: Minutes;
  /** Steam persona, so a listing can show which account is attached to whom. */
  personaName: string | null;
  /** Set when a moderator registered this account for them, rather than them linking it. */
  addedBy: string | null;
}
export interface LeaderRow { appid: number; name: string; owners: number; guildMinutes: number }
export interface MatchRow {
  userId: string;
  personaName: string | null;
  addedBy: string | null;
  overlap: number;
  theirTotal: number;
  /** overlap / (mine + theirs - overlap) */
  jaccard: number;
}
