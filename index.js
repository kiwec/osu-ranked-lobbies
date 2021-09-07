import fs from 'fs';
import Bancho from 'bancho.js';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';

// fuck you, es6 modules, for making this inconvenient
const CURRENT_VERSION = JSON.parse(fs.readFileSync('./package.json')).version;
const Config = JSON.parse(fs.readFileSync('./config.json'));

import start_casual from './casual.js';
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

  await lobby_db.exec(`CREATE TABLE IF NOT EXISTS user (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    rank REAL,
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

  // await start_casual(client, lobby_db, map_db);
  await start_ranked(client, lobby_db, map_db);

  // client.on('PM', async (msg) => {
  //   console.log(`[PM] ${msg.user.ircUsername}: ${msg.message}`);

  //   // Check for updates
  //   if (msg.message.indexOf('!') == 0) {
  //     const user = await lobby_db.get('select * from user where username = ?', msg.user.ircUsername);
  //     if (user && user.last_version != CURRENT_VERSION) {
  //       await lobby_db.run(
  //           'update user set last_version = ? where username = ?',
  //           CURRENT_VERSION, msg.user.ircUsername,
  //       );
  //       await msg.user.sendMessage(`The bot has been updated to version ${CURRENT_VERSION}. For more details, [https://kiwec.net/blog/posts/osu-bot-update-2021-09-05 check out the changelog.]`);
  //     }
  //   }

  //   if (msg.message.indexOf('!help') == 0) {
  //     await msg.user.sendMessage('The full command list is on my profile. :)');
  //     return;
  //   }
  // });

  // await client.emit('PM', {
  //   message: '!makelobby stars>4.8 stars<5.2 +HDDT',
  //   user: client.getSelf(),
  // });

  console.log('All ready and fired up!');
}

main();
