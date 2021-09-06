import { open } from 'sqlite';
import fs from 'fs';
import sqlite3 from 'sqlite3';
import Bancho from 'bancho.js';
import {recalculate_user_rank} from './ranked.js';
const Config = JSON.parse(fs.readFileSync('./config.json'));

import fetch from 'node-fetch';


let oauth_token = null;

// JAVASCRIPT IS SUCH AN ELEGANT LANGUAGE
function fucking_wait(ms) {
  return new Promise((resolve, reject) => {
    setTimeout(resolve, ms);
  })
}

async function osu_fetch(url, options) {
  console.log('fetching', url)
  if (!oauth_token) {
    const res = await fetch('https://osu.ppy.sh/oauth/token', {
      method: 'post',
      body: JSON.stringify({
        client_id: Config.client_id,
        client_secret: Config.client_secret,
        grant_type: 'client_credentials',
        scope: 'public',
      }),
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
    });
    let foo = await res.json();
    oauth_token = foo.access_token;
  }

  if (!options.headers) {
    options.headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };
  }

  options.headers['Authorization'] = 'Bearer ' + oauth_token;

  const res = await fetch(url, options);
  if (res.status == 401) {
    console.log('OAuth token expired, fetching a new one...');
    oauth_token = null;
    await fucking_wait(1000);
    return await osu_fetch(url, options);
  } else {
    return res;
  }
}

async function main() {
  const client = new Bancho.BanchoClient(Config);
  await client.connect();

  const lobby_db = await open({
    filename: 'lobbies.db',
    driver: sqlite3.Database,
  });

  await lobby_db.exec(`CREATE TABLE IF NOT EXISTS lobby (
    lobby_id INTEGER,
    creator TEXT,
    filters TEXT
  )`);

  await lobby_db.exec(`CREATE TABLE IF NOT EXISTS updates (
    username TEXT,
    last_version TEXT
  )`);

  await lobby_db.exec(`CREATE TABLE IF NOT EXISTS ranked_lobby (
    lobby_id INTEGER
  )`);

  await lobby_db.exec(`CREATE TABLE IF NOT EXISTS user (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    avg_pp REAL,
    rank REAL,
    last_version TEXT
  )`);

  await lobby_db.exec(`CREATE TABLE IF NOT EXISTS ranked_score (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    tms INTEGER,
    pp REAL
  )`);

  const updates = await lobby_db.all('SELECT * FROM updates');
  for (const update of updates) {
    console.log('Migrating ' + update.username + '...');
    const user = client.getUser(update.username);
    await user.fetchFromAPI();

    await lobby_db.run(
        'INSERT INTO user (user_id, username, avg_pp, rank, last_version) VALUES (?, ?, ?, ?, ?)',
        user.id, user.username, 0, 'Unranked', update.last_version,
    );

    const res = await osu_fetch(
        `https://osu.ppy.sh/api/v2/users/${user.id}/scores/best?key=id&mode=osu&limit=100&include_fails=0`,
        {method: 'get'},
    );
    const recent_scores = await res.json();
    for (const score of recent_scores) {
      await lobby_db.run(
          'INSERT OR IGNORE INTO ranked_score VALUES (?, ?, ?, ?)',
          score.id, user.id, Date.parse(score.created_at), score.pp,
      );
    }

    await recalculate_user_rank(user.id, lobby_db);
  }

  // then drop the updates table manually
  console.log('done')
}

main();
