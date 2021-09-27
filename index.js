import fs from 'fs';
import Bancho from 'bancho.js';
import {open} from 'sqlite';
import sqlite3 from 'sqlite3';

// fuck you, es6 modules, for making this inconvenient
const Config = JSON.parse(fs.readFileSync('./config.json'));

import {start as start_casual} from './casual.js';
import {start_ranked} from './ranked.js';


async function init_lobby_db() {
  const lobby_db = await open({
    filename: 'lobbies.db',
    driver: sqlite3.Database,
  });

  await lobby_db.exec(`CREATE TABLE IF NOT EXISTS lobby (
    lobby_id INTEGER,
    creator TEXT,
    filters TEXT
  )`);

  await lobby_db.exec(`CREATE TABLE IF NOT EXISTS ranked_lobby (
    lobby_id INTEGER,
    filters TEXT
  )`);

  // NOTE: In `lobbies.db`, this table is only used for version checking.
  // For ranks, we use the `user` table from the `ranks.db` database.
  await lobby_db.exec(`CREATE TABLE IF NOT EXISTS user (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    last_version TEXT
  )`);

  return lobby_db;
}


async function main() {
  console.log('Starting...');

  const client = new Bancho.BanchoClient(Config);
  await client.connect();
  console.log('Connected to bancho.');

  const lobby_db = await init_lobby_db();
  const map_db = await open({
    filename: 'maps.db',
    driver: sqlite3.Database,
  });

  await start_casual(client, lobby_db, map_db);
  await start_ranked(client, lobby_db, map_db);

  client.on('PM', async (msg) => {
    console.log(`[PM] ${msg.user.ircUsername}: ${msg.message}`);

    if (msg.message == '!discord') {
      await msg.user.sendMessage('https://kiwec.net/discord');
      return;
    }

    if (msg.message == '!help' || msg.message == '!commands') {
      await msg.user.sendMessage('All bot commands and answers to your questions are [https://kiwec.net/discord in the Discord.]');
      return;
    }

    const lobby_only_commands = ['!skip', '!start', '!setfilter'];
    for (const cmd of lobby_only_commands) {
      if (msg.message.indexOf(cmd) == 0) {
        await msg.user.sendMessage('Sorry, you should send that command in #multiplayer.');
        return;
      }
    }
  });

  /*  await client.emit('PM', {
    message: '!makelobby stars>4.8 stars<5.2 +HDDT',
    user: client.getSelf(),
  });*/

  console.log('All ready and fired up!');
}

main();
