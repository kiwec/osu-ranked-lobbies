import Database from 'better-sqlite3';


const discord = new Database('discord.db');
discord.exec(`
  CREATE TABLE IF NOT EXISTS auth_tokens (
    discord_user_id TEXT,
    ephemeral_token TEXT
  );

  CREATE TABLE IF NOT EXISTS user (
    discord_id TEXT,
    osu_id INTEGER,
    osu_access_token TEXT,
    osu_refresh_token TEXT,
    discord_rank TEXT
  )`,
);

const ranks = new Database('ranks.db');
ranks.pragma('JOURNAL_MODE = WAL');

if (process.argv[1].endsWith('recompute_ranks.js')) {
  ranks.pragma('count_changes = OFF');
  ranks.pragma('TEMP_STORE = MEMORY');
  ranks.pragma('JOURNAL_MODE = OFF');
  ranks.pragma('SYNCHRONOUS = OFF');
  ranks.pragma('LOCKING_MODE = EXCLUSIVE');
}

ranks.exec(`
  CREATE TABLE IF NOT EXISTS lobby (
    id INTEGER PRIMARY KEY,
    data TEXT
  );

  CREATE TABLE IF NOT EXISTS discord_lobby_listing (
    osu_lobby_id INTEGER PRIMARY KEY,
    discord_channel_id TEXT NOT NULL,
    discord_message_id TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    elo REAL,
    approx_mu REAL,
    approx_sig REAL,
    aim_pp REAL,
    acc_pp REAL,
    speed_pp REAL,
    overall_pp REAL,
    avg_ar REAL,
    avg_sr REAL,
    last_top_score_tms INTEGER,
    last_update_tms INTEGER,
    games_played INTEGER,
    last_contest_tms INTEGER,
    rank_text TEXT
  );

  CREATE TABLE IF NOT EXISTS map (
    id INTEGER PRIMARY KEY,
    set_id INTEGER NOT NULL,
    mode INTEGER DEFAULT 0,
    name TEXT NOT NULL,

    length REAL NOT NULL,
    ranked INT NOT NULL,
    dmca INTEGER NOT NULL,

    stars REAL NOT NULL,
    aim_pp REAL,
    speed_pp REAL,
    acc_pp REAL,
    overall_pp REAL,
    ar REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contest (
    lobby_id INTEGER NOT NULL,
    map_id INTEGER NOT NULL,
    tms INTEGER NOT NULL,
    lobby_creator TEXT NOT NULL,
    mods INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS score (
    user_id INTEGER NOT NULL,
    contest_id INTEGER NOT NULL,

    -- Used for elo calculations
    score INTEGER,
    tms INTEGER NOT NULL,

    -- Used for website display
    map_id INTEGER NOT NULL,
    old_elo REAL,
    new_elo REAL,
    new_deviation REAL
  );
  CREATE INDEX IF NOT EXISTS contest_id_idx ON score (contest_id);
  CREATE INDEX IF NOT EXISTS score_user_idx ON score (user_id);

  CREATE TABLE IF NOT EXISTS website_tokens (
    user_id INTEGER,
    token TEXT,
    expires_tms INTEGER,
    osu_access_token TEXT,
    osu_refresh_token TEXT
  )`);

export default {discord, ranks};
