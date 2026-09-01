/**
 * Fill a database with plausible-looking test data.
 *
 *   node --import tsx scripts/seed.mjs                 -> ./data/seed.sqlite
 *   node --import tsx scripts/seed.mjs ./data/dev.sqlite
 *
 * REFUSES to write to a database that already has users, unless --force is
 * passed. The point is a throwaway file to click around in, not a way to
 * quietly overwrite a real library.
 *
 * Everything is shaped like the real thing: 17-digit Discord snowflakes,
 * SteamID64s in the 7656119... range, real appids and names, playtimes that
 * look like somebody's actual account rather than round numbers. Every state
 * the bot can be in is represented -- see the summary it prints.
 */
import { openDb } from '../src/db/index.ts';
import {
  addUserGame,
  ensureUser,
  linkSteam,
  setDiscoverable,
  setGuildVisible,
  setHiddenGames,
  setOptedIn,
  touchGuildMember,
  upsertManualGame,
} from '../src/db/queries.ts';
import { syncLibrary } from '../src/steam/sync.ts';

const path = process.argv.find((a) => !a.startsWith('-') && a.endsWith('.sqlite')) ?? './data/seed.sqlite';
const force = process.argv.includes('--force');

const db = openDb(path);
const existing = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (existing > 0 && !force) {
  console.error(`${path} already has ${existing} users. Pass --force to overwrite it anyway.`);
  process.exit(1);
}

const GUILD = '1544412436205928550';
const GUILD_2 = '1102938475610293847';

/*
 * Real appids and names, each with the share of people expected to own it.
 * Without the weight everybody ends up owning everything -- the first version of
 * this file had all seven members owning Europa Universalis IV, which is not
 * what a server looks like. Mainstream multiplayer is common, long single-player
 * RPGs and grand strategy are not.
 */
const CATALOG = [
  [730,     'Counter-Strike 2',            0.85],
  [570,     'Dota 2',                      0.55],
  [440,     'Team Fortress 2',             0.70],
  [945360,  'Among Us',                    0.45],
  [550,     'Left 4 Dead 2',               0.50],
  [620,     'Portal 2',                    0.55],
  [220,     'Half-Life 2',                 0.40],
  [4000,    "Garry's Mod",                 0.45],
  [105600,  'Terraria',                    0.45],
  [1966720, 'Lethal Company',              0.40],
  [252490,  'Rust',                        0.30],
  [892970,  'Valheim',                     0.30],
  [548430,  'Deep Rock Galactic',          0.30],
  [553850,  'HELLDIVERS 2',                0.30],
  [413150,  'Stardew Valley',              0.35],
  [427520,  'Factorio',                    0.25],
  [526870,  'Satisfactory',                0.20],
  [108600,  'Project Zomboid',             0.20],
  [322330,  "Don't Starve Together",       0.25],
  [632360,  'Risk of Rain 2',              0.25],
  [1794680, 'Vampire Survivors',           0.30],
  [646570,  'Slay the Spire',              0.20],
  [1145360, 'Hades',                       0.25],
  [367520,  'Hollow Knight',               0.25],
  [588650,  'Dead Cells',                  0.15],
  [504230,  'Celeste',                     0.20],
  [322500,  'SUPERHOT',                    0.15],
  [304430,  'INSIDE',                      0.12],
  [383870,  'Firewatch',                   0.10],
  [391540,  'Undertale',                   0.15],
  [239030,  'Papers, Please',              0.12],
  [1245620, 'ELDEN RING',                  0.25],
  [1086940, "Baldur's Gate 3",             0.25],
  [1091500, 'Cyberpunk 2077',              0.25],
  [292030,  'The Witcher 3: Wild Hunt',    0.30],
  [264710,  'Subnautica',                  0.20],
  [275850,  "No Man's Sky",                0.15],
  [753640,  'Outer Wilds',                 0.10],
  [632470,  'Disco Elysium',               0.12],
  [294100,  'RimWorld',                    0.15],
  [255710,  'Cities: Skylines',            0.15],
  [220200,  'Kerbal Space Program',        0.15],
  [244850,  'Space Engineers',             0.10],
  [227300,  'Euro Truck Simulator 2',      0.12],
  [1237970, 'Titanfall 2',                 0.15],
  [8930,    "Sid Meier's Civilization V",  0.20],
  [289070,  "Sid Meier's Civilization VI", 0.15],
  [236850,  'Europa Universalis IV',       0.08],
  [281990,  'Stellaris',                   0.10],
  [394360,  'Hearts of Iron IV',           0.10],
];
const NAME_OF = new Map(CATALOG.map(([id, name]) => [id, name]));

/** Deterministic, so re-seeding twice produces the same database. */
function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

/**
 * One person's library. `appetite` scales every weight, which is what makes one
 * member a 40-game collector and another a five-game casual without changing
 * WHICH games are the popular ones.
 */
function libraryFor(seed, appetite) {
  const r = rng(seed);
  const games = [];
  for (const [appid, name, weight] of CATALOG) {
    if (r() > Math.min(0.95, weight * appetite)) continue;
    // A long tail of small numbers with a few big ones -- what an account
    // actually looks like. Never a round number.
    const roll = r();
    const mins =
      roll > 0.95
        ? 1200 + Math.floor(r() * 58000)
        : roll > 0.7
          ? 180 + Math.floor(r() * 1500)
          : roll > 0.25
            ? 12 + Math.floor(r() * 400)
            : Math.floor(r() * 45);
    games.push({
      appid,
      name,
      playtimeForever: mins,
      // Only a couple of games are in anyone's last two weeks.
      playtime2Weeks: r() > 0.9 ? Math.floor(r() * 600) : 0,
      iconHash: Math.floor(r() * 2 ** 52).toString(16).padStart(40, '3').slice(0, 40),
    });
  }
  return games;
}

const source = (games) => ({
  async fetchLibrary() {
    return { state: 'public', personaName: null, avatarUrl: null, games };
  },
});

const PEOPLE = [
  { id: '318220364795248640', steam: '76561198042318877', persona: 'tigetiger',   appetite: 2.2, seed: 11 },
  { id: '204558623017533440', steam: '76561198091234501', persona: 'mrtn',        appetite: 1.4, seed: 29 },
  { id: '881204773901234176', steam: '76561198277654321', persona: 'kabujutsu',   appetite: 1.8, seed: 47 },
  { id: '449102847362819072', steam: '76561198110293847', persona: 'Sass',        appetite: 0.9, seed: 63 },
  { id: '736451029384756224', steam: '76561198399887766', persona: 'karu_pojake', appetite: 0.6, seed: 81 },
  { id: '512983746152839168', steam: '76561198455667788', persona: 'Villem',      appetite: 1.2, seed: 97 },
  { id: '667281940273645056', steam: '76561198501122334', persona: 'nihilist_99', appetite: 0.4, seed: 113 },
];

const MOD = '318220364795248640';

for (const p of PEOPLE) {
  ensureUser(db, p.id);
  setOptedIn(db, p.id, true);
  touchGuildMember(db, GUILD, p.id);
  // One person was added by a moderator rather than linking themselves.
  linkSteam(db, p.id, p.steam, p.persona === 'nihilist_99' ? MOD : null);
  await syncLibrary(db, p.id, p.steam, source(libraryFor(p.seed, p.appetite)), undefined, {
    curated: true,
  });
  db.prepare('UPDATE steam_accounts SET persona_name = ? WHERE user_id = ?').run(p.persona, p.id);
}

/* Games that are not on Steam. Shared across the server once one person adds one. */
const MINECRAFT = upsertManualGame(db, 'Minecraft').appid;
const LEAGUE = upsertManualGame(db, 'League of Legends').appid;
const FORTNITE = upsertManualGame(db, 'Fortnite').appid;
for (const id of [PEOPLE[0].id, PEOPLE[1].id, PEOPLE[3].id, PEOPLE[4].id]) addUserGame(db, id, MINECRAFT);
for (const id of [PEOPLE[2].id, PEOPLE[5].id]) addUserGame(db, id, LEAGUE);
addUserGame(db, PEOPLE[4].id, FORTNITE);

/* Every privacy state the bot can be in, so the views can be seen working. */
// Hidden a couple of games from the server, but keeps them in their own list.
const hide = db
  .prepare('SELECT appid FROM user_games WHERE user_id = ? AND playtime_tracked = 1 LIMIT 3')
  .all(PEOPLE[1].id)
  .map((r) => r.appid);
setHiddenGames(db, PEOPLE[1].id, hide);
// Globally undiscoverable.
setDiscoverable(db, PEOPLE[5].id, false);
// In the guild but hidden here specifically; still visible in the other guild.
touchGuildMember(db, GUILD_2, PEOPLE[3].id);
setGuildVisible(db, GUILD, PEOPLE[3].id, false);
// Linked but never opted in -- present in the tables, absent from every result.
const LURKER = '990817263544332211';
ensureUser(db, LURKER);
touchGuildMember(db, GUILD, LURKER);
linkSteam(db, LURKER, '76561198600011223');
db.prepare('UPDATE steam_accounts SET persona_name = ? WHERE user_id = ?').run('lurker', LURKER);

/* A role panel, which shares nothing with any of the above but the file. */
db.prepare(
  `INSERT OR REPLACE INTO role_panels (message_id, guild_id, channel_id, title, description, exclusive, created_by)
   VALUES (?, ?, ?, ?, ?, 0, ?)`,
).run('1544500112233445566', GUILD, '1544412436205928551', 'Vali oma mängud', 'Klõpsa emojit, et saada roll.', MOD);
for (const [key, raw, role] of [
  ['⛏️', '⛏️', '1544412436205928600'],
  ['🔫', '🔫', '1544412436205928601'],
  ['🚀', '🚀', '1544412436205928602'],
]) {
  db.prepare(
    `INSERT OR REPLACE INTO reaction_roles (message_id, emoji_key, emoji_raw, role_id, position)
     VALUES (?, ?, ?, ?, 0)`,
  ).run('1544500112233445566', key, raw, role);
}

const count = (sql) => db.prepare(sql).get().n;
console.log(`seeded ${path}\n`);
console.log(`  users            ${count('SELECT COUNT(*) n FROM users')}`);
console.log(`  steam_accounts   ${count('SELECT COUNT(*) n FROM steam_accounts')}`);
console.log(`  games            ${count('SELECT COUNT(*) n FROM games')}  (${count("SELECT COUNT(*) n FROM games WHERE source='manual'")} hand-added)`);
console.log(`  user_games       ${count('SELECT COUNT(*) n FROM user_games')}  (${count('SELECT COUNT(*) n FROM user_games WHERE hidden=1')} hidden)`);
console.log(`  eligible here    ${db.prepare('SELECT COUNT(*) n FROM eligible_members WHERE guild_id = ?').get(GUILD).n} of ${count('SELECT COUNT(*) n FROM users')}`);
console.log(`  role bindings    ${count('SELECT COUNT(*) n FROM reaction_roles')}`);

// Fold the WAL back into the main file so this is ONE self-contained .sqlite.
// A flatpak GUI is handed only the file you pick through the portal, never the
// -wal and -shm beside it, and without this it opens something nearly empty.
db.pragma('wal_checkpoint(TRUNCATE)');
db.close();
console.log(`\nOpen it directly: ${path}`);
