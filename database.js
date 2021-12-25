import {open} from 'sqlite';
import sqlite3 from 'sqlite3';


async function init_databases() {
  const discord_db = await open({
    filename: 'discord.db',
    driver: sqlite3.cached.Database,
  });

  await discord_db.exec(`CREATE TABLE IF NOT EXISTS ranked_lobby (
    osu_lobby_id INTEGER,
    discord_channel_id TEXT,
    discord_msg_id TEXT,
    creator TEXT,
    creator_discord_id TEXT,
    min_stars REAL,
    max_stars REAL,
    dt BOOLEAN NOT NULL,
    scorev2 BOOLEAN NOT NULL
  )`);

  await discord_db.exec(`CREATE TABLE IF NOT EXISTS auth_tokens (
    discord_user_id TEXT,
    ephemeral_token TEXT
  )`);

  await discord_db.exec(`CREATE TABLE IF NOT EXISTS user (
    discord_id TEXT,
    osu_id INTEGER,
    osu_access_token TEXT,
    osu_refresh_token TEXT,
    discord_rank TEXT
  )`);

  const ranks_db = await open({
    filename: 'ranks.db',
    driver: sqlite3.cached.Database,
  });

  await ranks_db.exec(`CREATE TABLE IF NOT EXISTS user (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    elo REAL,
    approx_mu REAL,
    approx_sig REAL,
    normal_mu REAL,
    normal_sig REAL,
    aim_pp REAL,
    acc_pp REAL,
    speed_pp REAL,
    overall_pp REAL,
    avg_ar REAL,
    avg_sr REAL,
    last_top_score_tms INTEGER,
    last_update_tms INTEGER,
    games_played INTEGER NOT NULL,
    last_contest_tms INTEGER,
    rank_text TEXT
  )`);

  await ranks_db.exec(`CREATE TABLE IF NOT EXISTS contest (
    lobby_id INTEGER,
    map_id INTEGER,
    scoring_system INTEGER,
    mods INTEGER,
    tms INTEGER,
    lobby_creator TEXT,
    weight REAL
  )`);

  await ranks_db.exec(`CREATE TABLE IF NOT EXISTS score (
    user_id INTEGER,
    contest_id INTEGER,
    score INTEGER,
    logistic_mu REAL,
    logistic_sig REAL,
    mods INTEGER,
    tms INTEGER,
    ignored INTEGER NOT NULL DEFAULT 0
  )`);
}

export {init_databases};
