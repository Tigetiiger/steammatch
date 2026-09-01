# SteamMatch

A Discord bot for finding people in your server who own — and actually play — the same games you do.

**The bot speaks Estonian.** Every string a user sees — embeds, buttons, modals, command
descriptions, autocomplete, error messages — is Estonian; the code, its comments and this
README are English. Command *names* stay English (`/games`, `/steam update`) so they match the
docs and do not churn. Steam's own setting names ("Game details", "Always keep my total
playtime private") are deliberately left in English inside the fix-it instructions, because
that is the label the user has to find in the Steam UI.

Numbers are formatted for `et-EE`: decimal comma (`1,5 h`), space-grouped thousands
(`12 345 h`, and four-digit numbers ungrouped, which is correct Estonian).

Members link a Steam profile, **pick from a checklist which of their games get stored at
all**, and the bot keeps the ones with **more than 30 minutes** played. Everyone can then ask
who else plays a game, what they share with a specific person, and who their closest match in
the server is.

Steam is contacted only when a person asks: once at import, and thereafter only when they run
`/steam update`. Nothing refreshes in the background.

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
| `/steam update` | Re-read the profile and go through the import checklist again (15-minute cooldown) |
| `/steam change` | Checklist of your games — untick the ones other people should not see |
| `/steam unlink` | Delete the Steam link and everything imported from it. Hand-added games stay — they never came from Steam |

All user-facing copy lives in `src/ui/embeds.ts`; that is the file to open to change wording.
| `/games list [min_playtime] [public]` | Your library, filterable and paginated |
| `/games shared <user> [min_playtime]` | What you and one other person both play |
| `/games who <game> [min_playtime]` | Who else in this server plays it. **Pingi neid** notifies them; **Kopeeri pingid** hands you the mention list privately, to paste wherever you like |
| `/games leaderboard [user] [min_playtime]` | The server's most commonly owned games. `user:@someone` switches to **their** point of view: their games, ranked by how many people here share them |
| `/match [min_playtime] [sort]` | Members ranked by overlap with you |
| `/privacy` | Hide yourself, or delete everything |
| `/roles …` | **Unrelated to games.** Self-service reaction roles — see below |

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

## Choosing what gets stored, and who sees it

Two separate decisions, deliberately kept apart:

**The import checklist** runs after every Steam read and before anything is written. It lists
every game Steam returned, most-played first, **10 to a page**, all ticked, each with its own
toggle button on its own line. Ten, not twenty-five, is a hard Discord limit and not a taste
call: a Components V2 message allows 40 components counting nested ones, and an inline row
costs three of them (Section + TextDisplay + Button). Eleven is the ceiling; the budget is
pinned by a test.

Untick a game and it is **never written to the database at all** — not the playtime, not the
row, and **not a record of the refusal either**. Nothing is stored about what you left out.
The ticked list is handed to `syncLibrary` as the library, and sync writes what it is given
and deletes every other Steam-sourced row, so unticking a game that was already imported
removes it immediately. Backing out of the checklist writes nothing, including on a first link
— the Steam identity is claimed only after the user has said yes to a concrete list.

**On `/steam update`, only games you already have are pre-ticked.** Everything else arrives
unticked and the screen says how many: *"3 uut mängu on valimata."* Tick the ones you want.
That is what replaces the old memory of exclusions — a game you declined comes back unticked
because you do not own it here, not because anything was written down. The cost is that a
declined game and a genuinely new one look identical, which is the intended trade.

**`/steam change`** is the same widget asking a different question: ticked means *other people
in this server can see this game*. An unticked game is still yours — it stays in your
`/games list`, marked 🔒 — but it is dropped from `/match`, `/games who`, `/games shared`, both
leaderboards and autocomplete. That is enforced by the `visible_user_games` view, which is to
per-game visibility what `eligible_members` is to per-user visibility: the one place the
`hidden = 0` predicate is written, so no query can forget it.

Hidden ≠ excluded. A hidden game is stored and withheld; an excluded game was never stored.

## No background refresh

The bot has no scheduler. It reads a Steam profile when someone links it and when someone runs
`/steam update` (15-minute cooldown, shortened to 1 minute after a failure so a Steam outage is
not punished for a full quarter of an hour). This is stricter than the Steam API Terms require
— they allow fetching a user's data "as requested by the end user" — and it means the numbers
you see are as fresh as the last time somebody asked for them, not fresher.

## Reaction roles (`/roles`)

A **separate feature that happens to live in the same bot.** It shares the database file, the
embed helpers and nothing else: no opt-in, no consent record, no `eligible_members`, no
playtime, no foreign key into `users`. A role panel works for a member who has never touched
`/games` and never will. Code lives in `src/roles/`; `src/db/queries.ts` stays Steam-only.

```
/roles panel <title> [description] [exclusive]   post a panel here
/roles add <role> <emoji> [message]              bind, and react on the panel
/roles remove <role> [message]                   unbind, and clear the reaction
/roles list                                      every panel in this server
/roles delete [message]                          stop a panel handing out roles
```

`message` defaults to the newest panel in the guild, and takes an id or a message link.
`exclusive` makes a panel a pick-one: taking a role drops the others in that panel, in a
single `roles.set()` so two can never be held at once.

**Intents.** This adds `GuildMessageReactions`. It is **not privileged** — nothing to enable
in the Developer Portal — but it does end the bot's Guilds-only stance, and it forces
`partials: [Message, Reaction, User]`. A reaction on a message the bot has not cached since it
started arrives with only an id, and that is *every* message written before the last restart.
Omit the partials and panels work in testing and die on the first deploy.

**Which roles may be offered** (`src/roles/guard.ts`). A reaction role is taken by whoever
clicks it, with nobody vetting them, so the bar is higher than "may this moderator assign it":

- never `@everyone`, never a managed (bot/booster/integration) role — the API refuses both;
- never a role carrying a moderator permission (Administrator, Manage*, Ban/Kick/Moderate
  Members, Mention Everyone), for anyone, including the guild owner;
- never at or above the **bot's** highest role — it could not assign it anyway;
- never at or above the **invoking moderator's** highest role, unless they own the guild.
  Without that last rule, Manage Roles becomes a way to climb the hierarchy: build a panel
  granting a role you cannot assign by hand, then click it yourself.

The hierarchy check runs again at grant time, because roles get dragged around in the server
settings long after a panel is built, and the bot losing its position is the most common way a
working panel stops working.

## Privacy model

- **Opt-in, per game.** Nothing is written until the user has seen the import checklist and
  pressed **Import checked** — closing it stores nothing and claims no Steam link.
  (`consentEmbed`/`askConsent` in `src/commands/steam.ts` are a separate, older prompt that
  is **not currently wired to any call site**; the checklist is what actually gates writes.)
- **Adding someone else** (`/games add user:@them`) is the one exception, and is
  gated on the **Manage Server** permission — without that gate any member could
  attach any Steam account to any other member. The person added has not consented,
  so the link records who added them, every listing marks the entry `✎ added by a
  moderator, not self-linked`, and they can remove it themselves with `/privacy`.
  A moderator still cannot take over a Steam ID another user has already claimed.
- **Per-server.** You link once, but you are only ever matched against members of the guild
  where the command runs. All public queries go through the `eligible_members` SQL view,
  which encodes opted-in + discoverable + visible-here + not-deleted in one place so that
  no query can accidentally omit the filter.
- **Three hide levels.** Globally undiscoverable (`/privacy`), hidden in one specific server
  (`/privacy`), or hidden game-by-game (`/steam change`). Your own `/games list` keeps working
  in all three cases.
- `/steam unlink` removes the link, the imported library and the playtime.
  It deliberately keeps **hand-added games**, which did not come from Steam, and only opts the
  person out if nothing survived — otherwise the surviving rows would be stored and invisible,
  which is the same disappearance one layer down. `/privacy → forget me` is the unconditional
  one: it deletes everything, manual games included, and drops guild membership rows.
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

See [DECISIONS.md](DECISIONS.md) for why the non-obvious choices were made, and what
was given up for each, and [PERMISSIONS.md](PERMISSIONS.md) for who can run what and
which permissions the bot itself needs.

## Development

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit
```

`prototype/ui.html` is the signed-off UI design — a self-contained mockup of every bot
screen. Open it in a browser. It is kept in **English** and describes layout, hierarchy and
which numbers belong on which screen; the Estonian wording lives in `src/ui/embeds.ts`. It
also predates the import checklist and `/steam change`, so those two screens are not in it
yet. Change the prototype first when you want to change a screen's *shape*; change
`embeds.ts` when you want to change its *words*.

### Layout

```
src/
  types.ts        shared contract: units, row shapes, ProfileState
  text.ts         canonical name folding, used by BOTH ingest and query sides
  steam/          resolve.ts (any ID format -> SteamID64), client.ts (API + rate limit),
                  sync.ts (library -> DB transaction)
  db/             schema.sql, index.ts (open/migrate), queries.ts (all SQL)
  roles/          the reaction-role feature, self-contained: emoji.ts (emoji
                  identity), store.ts (its own SQL), guard.ts (which roles may
                  be offered), handler.ts (reaction -> role)
  ui/             embeds.ts (every user-facing string), paginate.ts (session store),
                  checklist.ts (the paginated multi-select used by both the import
                  checklist and /steam change)
  commands/       one file per command, plus add-panel.ts (the /games add UI),
                  registry.ts (the command list) and user-state.ts (per-process
                  consent + refresh cooldown)
test/             steam, sync, queries, embeds, paginate, text, security,
                  on-behalf, manual-games, curation, roles, and end-to-end
                  integration — 312 tests
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
- **`/games leaderboard user:` can name anyone, so the subject needs a
  visibility check the old `mine:` flag never did.** When the subject was always
  the caller, `eligible_members` on the subject was redundant. It is not any
  more: without it, naming someone who has hidden themselves here reads their
  library back out through the board. The check is in the SQL, and the one
  carve-out — you can always see your own board — is keyed on the viewer, so
  a caller that omits the viewer gets the safe answer.
- **Anything guild-facing reads `visible_user_games`, never `user_games`.** The two
  deliberate exceptions both show a user their own rows (`listGames`,
  `userManualGames`) plus `guildCatalog`'s "do I already have this" probe, which
  must see a hidden game so the panel does not offer it back.
- **A manual game's appid is NEGATIVE, so `^\d+$` is never the right test for one.**
  Autocomplete hands `/games who` the appid as the option value; a digits-only
  predicate rejected `-1`, fell through to a name search for the literal text
  `-1`, and told the user nobody owned the game it had just suggested. Anything
  that parses or renders an appid needs `-?`, and anything that builds a Steam
  URL from one needs an `appid > 0` guard — `store.steampowered.com/app/-1` is a
  404 wearing the game's own name.
- **A reaction's emoji and a typed emoji must produce the same key.** Custom
  emoji arrive as `{id, name}` from the gateway but as `<:name:id>` text from a
  command option, and unicode emoji carry an optional variation selector
  (U+FE0F) that Discord's picker adds and keyboards do not — so `❤️` and `❤`
  are one emoji with two byte sequences. Both sides call `emojiKey()`.
- **Validate an emoji BEFORE stripping the variation selector, not after.**
  `\p{RGI_Emoji}` only accepts a text-default character like U+26CF (⛏️) when it
  carries the selector, so testing the stripped form rejects perfectly ordinary
  emoji while accepting `🚀`. A test covers exactly this.
- **An excluded game is not staged in `_sync_appids`.** That is what makes the
  sync delete a game the user unticked after it had already been imported. Add it
  to the staging table and unticking silently stops working on existing rows.
- **Exclusions are appids, so they are meaningless across accounts.** Relinking to
  a different SteamID64 must drop them in the same transaction that wipes
  `user_games`, or unrelated games in the new library are suppressed forever.
- **Anything in `schema.sql` that references a migrated column breaks old databases.**
  `schema.sql` runs *before* `migrate()`, so an index on `games.source` belongs in
  `migrate()`, not the schema file. A test covers exactly this.
- **Schema changes need a migration.** `schema.sql` is `CREATE TABLE IF NOT
  EXISTS`, so it does nothing to an existing table — add the column in
  `migrate()` in `src/db/index.ts` as well, idempotently.
