# SteamMatch

A Discord bot for finding people in your server who own — and actually play — the same games you do.

Members link a Steam profile, the bot imports their purchased games with playtime, and keeps
the ones with **more than 30 minutes** played. Everyone can then ask who else plays a game,
what they share with a specific person, and who their closest match in the server is.

## Setup

### 1. Steam API key
Get one at <https://steamcommunity.com/dev/apikey>. Requires a non-limited Steam account:
at least $5 spent directly (gifted funds do not lift limited status) and Steam Guard Mobile
Authenticator enabled.

### 2. Discord application
Create an app at <https://discord.com/developers/applications>, add a bot, copy the token
and the application ID. **No privileged intents are needed** — this bot is slash-command only.

Invite it with:

```
https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot%20applications.commands&permissions=0&integration_type=0
```

`permissions=0` is correct: interaction responses need no channel permissions.

### 3. Configure and run

```bash
cp .env.example .env    # fill in DISCORD_TOKEN, APP_ID, STEAM_API_KEY
npm install
npm run deploy          # register slash commands
npm start
```

Set `GUILD_ID` in `.env` during development — guild commands register instantly, whereas
global commands are eventually consistent. Leave it unset to deploy globally.

## Commands

| Command | What it does |
|---|---|
| `/games add [user]` | **The panel.** Sync a Steam library, claim games other people here already added, add any other game, or quick-add Minecraft. `user` does it **for someone else** (needs Manage Server) |
| `/steam unlink` | Delete the Steam link and all stored playtime |
| `/steam refresh` | Force a re-import (15-minute cooldown) |
| `/games list [min_playtime] [public]` | Your library, filterable and paginated |
| `/games shared <user> [min_playtime]` | What you and one other person both play |
| `/games who <game> [min_playtime]` | Who else in this server plays it |
| `/games leaderboard [mine] [min_playtime]` | The server's most commonly owned games. `mine: true` ranks **your** games by how many people here share them |
| `/match [min_playtime] [sort]` | Members ranked by overlap with you |
| `/privacy` | Hide yourself, or delete everything |

The Steam sync in the panel accepts any of: a profile URL (`steamcommunity.com/id/name`
or `/profiles/7656…`), a raw 17-digit SteamID64, `[U:1:12345]`, or `STEAM_0:1:12345`.

## Games that are not on Steam

Not everything lives on Steam, so the panel also takes games by hand — Minecraft has a
quick-add button, and anything else can be typed in. Those entries are **shared across the
server**: once one person adds a game it becomes a one-click option for everyone else,
which is what the "pick from what people here already have" menu offers.

**Playtime is shown in `/games list` only.** Every other screen ranks by playtime but
prints just the game and the people — `/games shared`, `/games who`, `/match` and the
leaderboards are about *who overlaps with whom*, and hours were noise there. A hand-added
game in `/games list` reads `added by hand` rather than `0m`, because 0 there means
unknown, not never-played.

Manual games carry **no playtime** — Steam is the only source of that. A `0` in their
playtime column means *unknown*, not *never played*, so they deliberately pass every
playtime filter instead of being hidden by one. In the schema that is
`user_games.playtime_tracked = 0`, and every filter predicate honours it.

To add another quick-add button, append to `QUICK_ADD_GAMES` in
`src/commands/add-panel.ts` — that list is the whole feature.

## Privacy model

- **Opt-in.** Nothing is stored until the user explicitly agrees at a consent prompt.
- **Adding someone else** (`/steam link ... user:@them`) is the one exception, and is
  gated on the **Manage Server** permission — without that gate any member could
  attach any Steam account to any other member. The person added has not consented,
  so the link records who added them, every listing marks the entry `✎ added by a
  moderator, not self-linked`, and they can remove it themselves with `/privacy`.
  A moderator still cannot take over a Steam ID another user has already claimed.
- **Per-server.** You link once, but you are only ever matched against members of the guild
  where the command runs. All public queries go through the `eligible_members` SQL view,
  which encodes opted-in + discoverable + visible-here + not-deleted in one place so that
  no query can accidentally omit the filter.
- **Two hide levels.** Globally undiscoverable, or hidden in one specific server. Your own
  `/games list` keeps working either way.
- `/unlink` removes the link and all playtime; `/privacy → forget me` also drops guild
  membership rows.
- A raw SteamID64 is never shown in server-visible output.

**Known limitation:** anyone can type anyone else's public Steam ID. Real ownership proof
would need Steam OpenID login; that is deliberately not implemented. It cannot be escalated —
an ID already claimed by another Discord user cannot be stolen.

## Family-shared games are not supported, on purpose

Steam's `GetOwnedGames` only returns games the account actually **purchased**. Family-shared
titles are licensed to the lender and never appear, and no parameter changes that. For a heavy
family-sharing user this can be the large majority of what they can play.

The family data exists behind an undocumented `IFamilyGroupsService`, but reaching it requires
a **per-user session JWT** that expires in ~24 hours, cannot be refreshed non-interactively,
and also authorises destructive writes (`DeleteFamilyGroup`, `RemoveFromFamilyGroup`,
`RequestPurchase`). Asking users to paste one is exactly the pattern Steam phishing kits use,
and it would expose the lenders' data without their consent.

So the bot uses only its own API key and public data, says so plainly in `/steam link`, and
**refuses** any session token a user sends it.

## Steam API limits

100,000 calls/day per key, plus undocumented per-IP throttling that bites much earlier. The
client holds sustained traffic near 1 req/sec with at most 2 in flight and backs off
exponentially on 429/5xx. Libraries are cached for 6 hours; private profiles are not retried
for 24. Refreshes are demand-driven — the bot never background-crawls a guild, which the
Steam API Terms require ("you will only retrieve Steam Data about a Steam end user as
requested by the end user").

## Development

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit
```

`prototype/ui.html` is the signed-off UI design — a self-contained mockup of every bot
screen. Open it in a browser. The embed builders in `src/ui/embeds.ts` mirror it; change
the prototype first when you want to change the output.

### Layout

```
src/
  types.ts        shared contract: units, row shapes, ProfileState
  text.ts         canonical name folding, used by BOTH ingest and query sides
  steam/          resolve.ts (any ID format -> SteamID64), client.ts (API + rate limit),
                  sync.ts (library -> DB transaction)
  db/             schema.sql, index.ts (open/migrate), queries.ts (all SQL)
  steam/refresher.ts  background job that re-syncs stale libraries
  ui/             embeds.ts (every user-facing string), paginate.ts (session store)
  commands/       one file per command, plus add-panel.ts (the /games add UI),
                  registry.ts (the command list) and user-state.ts (per-process
                  consent + refresh cooldown)
test/             steam, sync, queries, embeds, paginate, text, refresher,
                  security, on-behalf, manual-games, and end-to-end
                  integration — 256 tests
```

### Things that will bite you if you forget them

- **Playtime is always minutes**, exactly as Steam reports it. Never seconds, never hours.
- **The threshold is strictly `>`** — a 30-minute game does not pass a 30-minute filter.
- **A private Steam library returns HTTP 200 with `{"response":{}}`** — no error, no code.
- **A public profile does not mean visible games.** "Game details" is a separate Steam
  setting, and this is the single most common support complaint. The two cases have
  different messages and different fixes; do not merge them.
- **SteamID64 needs BigInt.** 76561197960265728 exceeds `Number.MAX_SAFE_INTEGER`.
- **Steam returns HTML, not JSON, on errors.** Check content-type before parsing.
- **Both sides must fold names identically** (`src/text.ts`). They once didn't, and titles
  containing zero-width characters became silently unsearchable.
- **Relinking a different Steam account must wipe `user_games` in the same transaction**,
  because that table is keyed by Discord user ID, not Steam ID.
- **Never trust a Steam response that disagrees with itself.** If `games.length <
  game_count`, it is an `error`, not a smaller library — treating it as truth
  deletes rows the user still owns. Sync additionally refuses to empty a
  non-empty library until two consecutive syncs agree it is empty.
- **A `playtime_hidden` response is not authoritative.** It lists the games with
  every playtime zeroed; writing it would destroy known playtimes.
- **`src/commands/registry.ts` exists to break an import cycle.** Building the
  command array inside `commands/index.ts` made every leaf module crash on a
  direct import (a temporal-dead-zone error `tsc` does not catch). Keep the
  registry separate from the shared helpers.
- **Untrusted names go through `safeName()`, not just `escapeMd()`.** Steam
  persona names, guild names and Discord display names can carry RTL overrides
  and bare URLs, which Discord autolinks even when markdown is escaped.
- **The Steam API key is in every request URL.** Anything that logs a URL or an
  upstream error body must redact it (`redactUrl`).
- **Manual games have no playtime and must never be filtered out.** Anything that
  filters on `playtime_forever` needs the `playtime_tracked = 0 OR ...` escape, and
  a Steam sync's delete must be scoped to `playtime_tracked = 1` or it wipes them.
- **Anything in `schema.sql` that references a migrated column breaks old databases.**
  `schema.sql` runs *before* `migrate()`, so an index on `games.source` belongs in
  `migrate()`, not the schema file. A test covers exactly this.
- **Schema changes need a migration.** `schema.sql` is `CREATE TABLE IF NOT
  EXISTS`, so it does nothing to an existing table — add the column in
  `migrate()` in `src/db/index.ts` as well, idempotently.
