import Database from 'better-sqlite3';


const discord = new Database('discord.db');
discord.exec(`CREATE TABLE IF NOT EXISTS ranked_lobby (
    osu_lobby_id INTEGER,
    discord_channel_id TEXT,
    discord_msg_id TEXT,
    creator TEXT,
    creator_osu_id INTEGER,
    creator_discord_id TEXT,
    min_stars REAL,
    max_stars REAL,
    dt BOOLEAN NOT NULL,
    scorev2 BOOLEAN NOT NULL
  );

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
  )`);

let ranks;
if (process.argv[1].endsWith('recompute_ranks.js')) {
  ranks = new Database('new_ranks.db');
  ranks.pragma('count_changes = OFF');
  ranks.pragma('TEMP_STORE = MEMORY');
  ranks.pragma('JOURNAL_MODE = OFF');
  ranks.pragma('SYNCHRONOUS = OFF');
  ranks.pragma('LOCKING_MODE = EXCLUSIVE');
} else {
  ranks = new Database('ranks.db');
}

ranks.exec(`CREATE TABLE IF NOT EXISTS user (
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

  CREATE TABLE IF NOT EXISTS contest (
    lobby_id INTEGER NOT NULL,
    map_id INTEGER NOT NULL,
    mods INTEGER,
    tms INTEGER NOT NULL,
    lobby_creator TEXT NOT NULL
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

  CREATE TABLE IF NOT EXISTS website_tokens (
    user_id INTEGER,
    token TEXT,
    expires_tms INTEGER,
    osu_access_token TEXT,
    osu_refresh_token TEXT
  )`);

const maps = new Database('maps.db');
// Initialize your maps.db with https://github.com/kiwec/orl-maps-db-generator

export default {discord, ranks, maps};
