# Permissions and access

Who can run what, what the bot itself needs, and what data each command can
reach. Two separate systems are in play and they are easy to confuse:

- **Discord permissions** gate who may *run* a command.
- **The two SQL views** gate what data a command may *return*, regardless of
  who ran it.

A user with every Discord permission in the server still cannot see a member
who has hidden themselves. The views are not a permission check and cannot be
overridden by one.

---

## What the bot needs

### Intents

| Intent | Privileged? | Why |
|---|---|---|
| `Guilds` | no | Baseline. Interactions are not intent-gated. |
| `GuildMessageReactions` | no | `/roles` only. |

**No privileged intents.** There is nothing to enable in the Developer Portal —
no `GuildMembers`, no `MessageContent`. That is also why the Steam-token
refusal is wired into the bot's own command options rather than a message
listener: reading arbitrary message content would need a privileged intent this
bot does not request.

`partials: [Message, Reaction, User]` is mandatory alongside the reaction
intent. A reaction on a message the bot has not cached since startup arrives
with only an id, and that is every message written before the last restart.
Omit the partials and role panels work in testing and die on the first deploy.

### Server permissions

The invite URL in the README uses `permissions=0`. That is still correct for
everything except `/roles` — interaction responses need no channel permissions.
Reaction roles do:

| Permission | Scope | Why |
|---|---|---|
| Manage Roles | server | Grant and remove roles. |
| Send Messages | panel channel | Post the panel. |
| Embed Links | panel channel | The panel is an embed. |
| Add Reactions | panel channel | Seed the panel's reactions. |
| Read Message History | panel channel | Fetch and edit the panel later. |

> **The README's invite link predates `/roles`.** Regenerate it with Manage
> Roles before using role panels, or re-grant the permission in the server's
> role settings.

**Role hierarchy is not a permission.** Manage Roles is necessary but not
sufficient: the bot's own highest role must sit *above* every role it hands
out, in the server settings list. This is checked when a role is bound to a
panel and again every time a role is granted, because roles get dragged around
long after a panel is built. It is the single most common way a working panel
stops working.

---

## Who can run what

### Open to every member

| Command | Acts on | Reply |
|---|---|---|
| `/games add` | your own list | private |
| `/games list` | your own library | private, or public with `public: true` |
| `/games shared <user>` | you + one other | public |
| `/games who <game>` | the server | public |
| `/games leaderboard` | the server | public |
| `/match` | the server | public |
| `/steam update` | your own account | private |
| `/steam change` | your own games | private |
| `/steam unlink` | your own account | private |
| `/privacy` | your own settings | private |

Everything under `/steam` and `/privacy` is private unconditionally — it is
account plumbing and nobody else needs to watch you do it. `/games add` is
private even when a moderator runs it for someone else.

`/steam update` carries a 15-minute per-user cooldown, shortened to 1 minute
after a failure so a Steam outage is not punished for a full quarter hour. The
cooldown deliberately survives `/steam unlink`, or it would be bypassable by
unlinking and relinking.

### Requires **Manage Server**

| Command | What it allows |
|---|---|
| `/games add user:@them` | Build someone else's game list for them |

The person added has not consented, so:

- the link records who added them (`steam_accounts.added_by`),
- every listing marks the entry `✎ lisas moderaator, mitte kasutaja ise`,
- they can remove it themselves with `/privacy`,
- a moderator **cannot** take over a Steam ID another Discord user has already
  claimed — the bot refuses rather than moving the claim.

Without this gate any member could attach any Steam account to any other
member.

### Requires **Manage Roles**

| Command |
|---|
| `/roles panel` · `/roles add` · `/roles remove` · `/roles list` · `/roles delete` |

Gated twice, on purpose:

- `setDefaultMemberPermissions(ManageRoles)` hides the command from members who
  cannot use it. This is a **UI convenience, not a security boundary** — a
  server admin can override it per-role in the Discord settings UI.
- A runtime `memberPermissions.has(ManageRoles)` check in `execute()`. This is
  the one that actually holds.

---

## Which roles a panel may hand out

A reaction role is taken by whoever clicks it, with nobody vetting them. The
bar is therefore higher than "may this moderator assign it by hand".

Refused, always:

| Rule | Why |
|---|---|
| `@everyone` | Held by definition; shares the guild id. |
| Managed roles (bot, booster, integration) | The API refuses to assign them. |
| Any moderator permission | See below. |
| At or above the **bot's** highest role | Could not be assigned at all. |
| At or above the **invoking moderator's** highest role | Unless they own the guild. |

The moderator-permission list, from `src/roles/guard.ts`: Administrator, Manage
Guild, Manage Roles, Manage Channels, Manage Webhooks, Manage Guild
Expressions, Manage Messages, Manage Nicknames, Ban Members, Kick Members,
Moderate Members, Mention Everyone. Refused for **everyone, including the guild
owner** — there is no tier at which self-service Administrator is intended.

The "at or above the invoking moderator" rule is what stops Manage Roles being
a hierarchy climb: without it a moderator could build a panel granting a role
they could not assign by hand, then click it themselves. The guild owner is
exempt because they legitimately sit above the whole hierarchy.

---

## What data a command can return

### `eligible_members` — per-user visibility

One SQL view ANDs together: opted in **and** discoverable **and** visible in
this guild **and** not soft-deleted. Every query that exposes another person
reads it, so none of them can omit a condition.

Members control their own entry through `/privacy`:

| Setting | Effect |
|---|---|
| Nähtav kõikjal: väljas | Invisible in every server. |
| Nähtav siin: väljas | Invisible in this one server. |
| Unusta mind | Deletes everything and tombstones the account. |

### `visible_user_games` — per-game visibility

`WHERE hidden = 0`. Set through `/steam change`. A hidden game is still yours —
it stays in your own `/games list`, marked 🔒 — but is dropped from `/match`,
`/games who`, `/games shared`, both leaderboards and autocomplete.

Hidden is not the same as excluded. A game unticked at the import checklist was
never stored at all; a hidden game is stored and withheld. See DECISIONS.md §3.

### The three deliberate exceptions

Both views are bypassed in exactly three places, all documented at the top of
`src/db/queries.ts`:

- `listGames()` and `userManualGames()` — showing you your own rows. Hiding
  yourself from other people must never hide you from yourself.
- `guildCatalog()`'s "do I already have this" probe — it must see hidden games,
  or the add panel offers them back to you as new.

### Scoping and secrets

- **Per-server.** You link once, but you are only ever matched against members
  of the guild where the command runs. Being visible in one server reveals
  nothing in another.
- **A raw SteamID64 is never shown in server-visible output.** Persona names
  are; the id is not.
- **The Steam API key is in every request URL.** Anything logging a URL or an
  upstream error body redacts it (`redactUrl`), including the snippet read from
  a failed response body.
- **Untrusted names** — Steam personas, guild names, Discord display names — go
  through `safeName()`, which strips invisibles and defangs bare URLs on top of
  markdown escaping. Discord autolinks bare URLs inside embeds even when every
  markdown character is escaped.

---

## Interactive component ownership

Buttons, select menus and checklists belong to the person who ran the command.
Clicks from anyone else are rejected with an ephemeral message rather than a
silent failure, because a rejecting collector `filter` never acknowledges the
interaction and Discord shows the clicker a red error instead of an
explanation.

This applies to the paginator, the import checklist, `/steam change`, the
`/games add` panel, `/games who` and `/privacy`. It does **not** apply to
`/roles` panels, which are public by design — that is the entire point of them.

---

## Known limitation

Anyone can type anyone else's public Steam ID. Real ownership proof would need
Steam OpenID login, which is deliberately not implemented.

It cannot be escalated: a Steam ID already claimed by another Discord user
cannot be stolen, by a moderator or anyone else. The bot refuses rather than
moving the claim, because silently unlinking the real owner would leave their
frozen library being served to the server while they are told they have no
account linked.
