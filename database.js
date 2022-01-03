import {open} from 'sqlite';
import sqlite3 from 'sqlite3';


let discord_db = null;
let ranks_db = null;
let maps_db = null;


async function init_databases(recomputing_ranks) {
  if (!discord_db) {
    discord_db = await open({
      filename: 'discord.db',
      driver: sqlite3.cached.Database,
    });

    await discord_db.exec(`CREATE TABLE IF NOT EXISTS ranked_lobby (
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
  }

  if (!ranks_db) {
    if (recomputing_ranks) {
      ranks_db = await open({
        filename: 'new_ranks.db',
        driver: sqlite3.cached.Database,
      });

      await ranks_db.run('PRAGMA TEMP_STORE=MEMORY');
      await ranks_db.run('PRAGMA JOURNAL_MODE=OFF');
      await ranks_db.run('PRAGMA SYNCHRONOUS=OFF');
      await ranks_db.run('PRAGMA LOCKING_MODE=EXCLUSIVE');
    } else {
      ranks_db = await open({
        filename: 'ranks.db',
        driver: sqlite3.cached.Database,
      });
    }

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
      ignored INTEGER NOT NULL DEFAULT 0,
      difference REAL NOT NULL DEFAULT 0
    )`);

    await ranks_db.exec(`CREATE TABLE IF NOT EXISTS website_tokens (
      user_id INTEGER,
      token TEXT,
      expires_tms INTEGER,
      osu_access_token TEXT,
      osu_refresh_token TEXT
    )`);
  }

  if (!maps_db) {
    maps_db = await open({
      filename: 'maps.db',
      driver: sqlite3.cached.Database,
    });
  }

  return {
    discord: discord_db,
    ranks: ranks_db,
    maps: maps_db,
  };
}

export {init_databases};
