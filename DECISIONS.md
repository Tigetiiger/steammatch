# Decisions

Why the code is the way it is. Each entry is a choice that had a real
alternative — if there was only ever one sensible option, it is not in here.

The README says *what* the bot does and lists the traps. This says *why*, and
what we gave up. When you are about to change something and it looks arbitrary,
look for it here first.

---

## 1. Nothing is stored about a refusal; the ticked list *is* the filter

**Was.** Unticked appids went to an `excluded_games` table, and `syncLibrary()`
read that table itself so no call site could forget to apply it.

**Decision.** The table is gone and `migrate()` drops it, rows and all.
`reviewAndSync()` hands `syncLibrary()` a library containing **only the ticked
games**, and sync writes what it is given and deletes every other Steam-sourced
row. An unticked game is never written; an unticked game that was imported
before is deleted because it is absent from the list.

**Why this is still safe from the failure the old design guarded against.** That
guard existed because a *filter parameter* is a rule every future call site has
to remember, and the one that forgets silently re-imports refused data. There is
no filter parameter here either: the data itself is the filter, and there is
nothing to forget because there is nothing left to consult.

**What replaces the memory.** `/steam update` pre-ticks exactly the appids
already in the library (`steamAppids()`), so a game you declined arrives
unticked next time — because you do not own it here, not because anything was
recorded. The screen says so: *"N uut mängu on valimata."*

**Gave up.** A declined game is now indistinguishable from a game Steam only
just started reporting. Both are "new", both arrive unticked. Requested, and the
honest trade for storing nothing.

**Also gave up.** The ability to list back what was excluded — that was the only
reason `excluded_games.name` was denormalised.

**One knock-on.** An empty list needed a meaning. Empty from Steam is a
suspected glitch and is ignored (a malformed response once wiped a real
library); empty from the checklist is a deliberate "store nothing". So
`syncLibrary` takes `{ curated: true }`, which does nothing except tell those
two cases apart.

---

## 2. The checklist runs *before* `linkSteam()`, not after

**Context.** The first import both claims a Steam identity and writes a library.

**Decision.** Show the checklist first; claim the identity in an `accept()`
callback that fires only after the user presses **Impordi valitud**.

**Why.** Closing the checklist has to leave the database exactly as it was. If
the link were taken first, a cancel would leave a linked account with no games
— and on a *relink* it would already have wiped the previous library, which is
not recoverable.

**Gave up.** A slightly more convoluted control flow (the callback) instead of
straight-line code.

---

## 3. "Excluded" and "hidden" are two different things, deliberately

| | Not ticked | Hidden |
|---|---|---|
| Set by | the import checklist | `/steam change` |
| Stored? | no row at all, and no record of the refusal | row exists |
| Your own `/games list` | absent | present, marked 🔒 |
| Everyone else | absent | absent |

**Why not one flag.** They answer different questions — "do you want this in a
database" versus "do you want this on your profile" — and collapsing them means
the only way to hide a game from the server is to delete the evidence you own
it, which breaks your own library view.

**Consequence.** Two tables, two commands, and a test file whose main job is
proving they never bleed into each other.

---

## 4. Per-game visibility is a SQL view, not a predicate in each query

**Decision.** `visible_user_games` (`WHERE hidden = 0`). Every guild-facing
query reads it; `user_games` is only touched by queries about *your own* rows.

**Why.** Exactly the argument that produced `eligible_members`. Nine queries
expose other people; nine hand-written `AND hidden = 0` clauses is eight chances
to forget one, and the failure is silent and privacy-relevant.

**Three deliberate exceptions**, all documented at the top of `db/queries.ts`:
`listGames()` and `userManualGames()` show you your own rows, and
`guildCatalog()`'s "do I already have this" probe must see hidden games so the
add panel does not offer them back to you.

**Consequence.** The view references a migrated column, so it lives in
`migrate()` and not `schema.sql` — which runs first. There is a test that opens
a pre-curation database to catch a regression here.

---

## 5. No background refresh at all

**Context.** There was a scheduler (`steam/refresher.ts`) re-syncing stale
libraries every 15 minutes.

**Decision.** Deleted. Steam is contacted when a person links an account and
when a person runs `/steam update`. Nothing else.

**Why.** Requested. It is also stricter than the Steam API Terms require — they
permit fetching a user's data "as requested by the end user", which a scheduler
arguably still satisfies, but demand-driven is unarguable.

**Gave up.** Freshness. Numbers are as current as the last time somebody asked,
which for an idle server means indefinitely stale. Accepted knowingly.

**Kept anyway.** `sync.ts` still maintains `stale_after` and `fail_count`. They
describe how old a snapshot is and are cheap; nothing reads them now, and a
future "your data is 3 weeks old" hint would want them.

**Also.** `/steam refresh` was renamed to `/steam update` rather than adding a
second command, because two commands doing an identical re-import is a menu
that makes users guess.

---

## 6. The checklist puts a toggle button on every game's own line

**Was.** A select menu plus a rendered `☑`/`☐` list, 25 per page. The menu was
the input device and the list was the display, because a select shows its
selection only while the dropdown is open. It worked, but the checkmark you
clicked and the checkmark you read were two different things in two places.

**Decision.** Components V2: one `Section` per game, its text on the left and a
`Button` accessory on the right. You click the mark that is on the row.

**What it cost: 25 per page became 10.** A V2 message allows 40 components
counting nested ones, and an inline row costs three — Section, TextDisplay,
Button:

```
1 header + 1 container + (10 × 3) + 1 action row + 5 buttons = 38 of 40
```

Eleven is the arithmetic ceiling (40 exactly, no Container and so no accent
bar). Twenty is not reachable in this shape at all: 20 × 3 = 60. A 412-game
import is now 42 pages instead of 17. `countComponents()` and a test in
`curation.test.ts` hold the budget; raising `CHECKLIST_PAGE` fails them.

**Also lost.** The select menu could toggle a whole page in one interaction;
buttons are one round trip each. `Märgi kõik` / `Eemalda kõik` survive as a
single button whose meaning flips, because five is the row's cap and the page
counter had to move into the header text to free a slot.

**Considered and rejected:** 20 per page with five names in a TextDisplay and a
row of five numbered buttons beneath them (35 components, 5 rows). It keeps the
page size, but the mark is under the name rather than on it, which is the thing
this change was for.

**Consequence: the list is a follow-up message, not the deferred reply.**
`IS_COMPONENTS_V2` must be set when a message is *created* — it cannot be added
by an edit, and cannot be removed once set. The callers must defer before
talking to Steam, and that reply has to stay a normal message: it carries the
private-profile embeds and the final import summary. So the instructions stay on
the parent reply and the interactive list arrives beside it as its own ephemeral
follow-up.

---

## 7. Estonian for users, English for code

**Decision.** Every string a user can see is Estonian. Code, comments, tests,
README, commit messages and operator/console output stay English.

**Why.** The audience for each is different. Console output is read by whoever
runs the bot, alongside stack traces and library messages.

**Three carve-outs:**

- **Command names stay English** (`/games`, `/steam update`). They are an API
  surface — docs, tests and muscle memory all reference them, and renaming buys
  nothing a translated *description* does not.
- **Steam's own setting names stay English** inside the fix-it instructions
  ("Game details", "Always keep my total playtime private"). Translating them
  sends the user hunting for a label that does not exist in the Steam UI. There
  is a test asserting this.
- **`prototype/ui.html` stays English.** It is the layout reference — hierarchy
  and which numbers go on which screen. Half-translating it was worse than
  either extreme. It also predates the checklist and `/steam change`.

**Consequence.** Numbers are formatted `et-EE`: decimal comma, space-grouped
thousands, and four-digit numbers ungrouped (`1234 h` but `12 345 h`) — that is
CLDR being correct for Estonian, not a bug.

---

## 8. Explanatory prose was cut; instructions were kept

**Decision.** Removed the recurring "…more than 30 minutes played — those are
the ones used for matching" commentary and similar asides from five screens.
Kept the compact filter labels (`üle 30 min`, `30 min+`) and the full
step-by-step Steam privacy walkthroughs.

**Why.** The threshold is already on screen next to every filter. Restating it
mid-instruction is noise. The privacy walkthroughs are the opposite case — they
are the most common support burden and the user is stuck without them.

**Consequence.** One test was inverted: it used to assert the game-details
message *reports* the threshold; it now asserts it does not.

---

## 9. Reaction roles are a separate feature sharing only a database file

**Decision.** `src/roles/` with its own SQL (`store.ts`). No foreign key into
`users`, no `eligible_members`, no consent record, no playtime.

**Why.** `users.opted_in` is a record of consent to store *Steam* data. Handing
someone a Discord role has nothing to do with that, and a role panel must keep
working for a member who never touches `/games`. Putting role SQL in
`db/queries.ts` would also invite someone to reach for a Steam predicate from a
role query — or, worse, to skip one over there because "the roles code does not
need it".

**Gave up.** The "every SQL statement lives in one file" invariant. That rule
existed to protect the *privacy* predicates; the roles domain has none, so the
rule does not buy anything there.

---

## 10. Reactions, not buttons

**Decision.** Emoji reactions, per the request.

**What it costs.** The `GuildMessageReactions` intent (not privileged, but it
ends the bot's Guilds-only stance), mandatory `partials` handling, no way to
reply to a user when something fails, and members can pile junk emoji onto a
panel.

**Buttons would have been** zero new intents, reuse of the existing interaction
router, and a private reply explaining any failure — at the cost of only working
on messages the bot posts. Since the chosen model is "bot posts the panel"
anyway, that cost would have been nil. Recorded here in case it is revisited.

---

## 11. Which roles a panel may offer

**Decision.** Refuse `@everyone`, managed roles, any role carrying a moderator
permission (Administrator, `Manage*`, Ban/Kick/Moderate Members, Mention
Everyone), anything at or above the **bot's** highest role, and anything at or
above the **invoking moderator's** highest role unless they own the guild.

**Why the last one.** Without it, Manage Roles becomes a hierarchy climb: build
a panel granting a role you could not assign by hand, then click it yourself.

**Why moderator permissions are refused for everyone, owner included.** A
reaction role is taken by whoever clicks it, with nobody vetting them. There is
no tier at which self-service Administrator is intended.

**Consequence.** The hierarchy check runs *again* at grant time, because roles
get dragged around in server settings long after a panel is built. That is the
most common way a working panel stops working.

---

## 12. Manual games use negative appids — and that has bitten us

**Decision (pre-existing).** Steam apps keep their real positive appid; hand-added
games get a synthetic negative one, so the id spaces cannot collide and
`appid > 0` reliably means "this is a Steam app".

**What went wrong.** `/games who` tested the option value with `/^\d{1,10}$/`,
which rejects `-1`. Picking a manual game from autocomplete fell through to a
name search for the literal text `-1` and reported that nobody owned the game it
had just suggested. The same oversight built `store.steampowered.com/app/-1` — a
404 wearing the game's name.

**Rule.** Anything parsing an appid needs `-?`. Anything building a Steam URL
from one needs an `appid > 0` guard. Four regression tests cover it.

**Kept the design** rather than switching to a separate `source` column check:
the sign *is* the discriminator, it is cheap, and it makes the invariant visible
in every query.

---

## 13. The leaderboard takes a person, not a `mine` flag

**Context.** `/games leaderboard mine: true` ranked *your* games by how many
people here share them. Useful, but only about yourself.

**Decision.** Replaced with `user:@someone`. Empty is the whole-server board;
naming a person gives their point of view, and anyone can name anyone.

**The catch.** When the subject could only ever be the caller, the query never
needed to ask whether the subject was allowed to be looked at — you are always
allowed to look at yourself. Opening it to any member turns the board into a way
to read a library, so the subject now has to pass `eligible_members` for this
guild.

**Where the check lives.** In the SQL, not the command. The command *also*
checks, but only to choose a better message — an empty board cannot say whether
that is "they are hidden here" or "you share nothing". The enforcement is the
one that cannot be forgotten by a future caller.

**Carve-out.** You can always see your own board, even while hidden in that
guild — the same rule `listGames()` follows: hiding yourself from other people
must not hide you from yourself. It is keyed on the viewer, so
`leaderboard(..., subject)` with no viewer argument returns the *safe* answer
rather than the leaky one.

**Falls out for free.** `minOwners = 2` means a game only appears once two
eligible members have it, so a person's solo games never surface on their board.

---

## 14. `/steam unlink` keeps hand-added games; `/privacy → forget me` does not

**Context.** `unlink()` ran `DELETE FROM user_games WHERE user_id = ?`, which took
manual rows with it. Those never came from Steam, and a person can own them
without ever having linked a Steam account at all — so unlinking Steam was
deleting data Steam had nothing to do with. The same `DELETE` also ran on a
relink, so switching Steam accounts silently cost you your Minecraft.

**Decision.** Both paths now delete `WHERE user_id = ? AND playtime_tracked = 1`.
`forget()` keeps the unscoped delete: an erasure request means everything.

**The follow-on.** `unlinkSub` also called `setOptedIn(false)` unconditionally.
With manual rows now surviving, that leaves them stored and hidden from
everyone — the same disappearance, one layer down. It is now conditional on
nothing being left.

**Consequence.** "Unlink deletes everything" is no longer true, so the command
description and the README say what it actually removes.

---

## 15. The `/games list` threshold filter exists twice, and only one copy had the rule

**Context.** `/games list` pulls the library once and re-filters it in memory
when a threshold button is pressed. The SQL said
`(playtime_tracked = 0 OR playtime_forever > @min)`; the in-memory twin said
`g.playtime > m`. So hand-added games survived the query and were dropped by the
default 30-minute filter before anything rendered — the games were in the
database, and the one screen meant to show them never did.

**Also.** `listSub` checked `getLinkInfo() === null` *before* checking whether
there were any rows, so somebody who had only ever used the panel's "add another
game" button was told they had no library at all. Games are checked first now.

**Decision.** The predicate is `passesPlaytimeFilter()` in `commands/games.ts`,
exported so a test can hold it to the SQL's rule.

**Why not one copy.** Re-querying on every button press is the alternative, and
the whole reason the list is pulled unfiltered is that a filter click must not
touch the database. Two copies is the cost; a named, tested function is the
guard rail.

---

## Known open item

`askConsent()` / `consentEmbed()` in `src/commands/steam.ts` are a consent
prompt that **is not wired to any call site**. It predates the move of linking
from `/steam link` into the `/games add` panel.

Writes are genuinely gated today — by the import checklist (decision 1), which
stores nothing until the user confirms a concrete list — so the privacy promise
holds by a different mechanism. But the old prompt is dead code and the README
says so explicitly rather than pretending otherwise. Either wire it back in
ahead of the checklist, or delete it; leaving it is the worst of the three.
