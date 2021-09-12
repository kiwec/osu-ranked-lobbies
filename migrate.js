import {open} from 'sqlite';
import fs from 'fs';
import sqlite3 from 'sqlite3';
import Bancho from 'bancho.js';
const Config = JSON.parse(fs.readFileSync('./config.json'));


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
    lobby_id INTEGER,
    filters TEXT
  )`);

  await lobby_db.exec(`CREATE TABLE IF NOT EXISTS user (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    last_version TEXT
  )`);

  const updates = await lobby_db.all('SELECT * FROM updates');
  for (const update of updates) {
    console.log('Migrating ' + update.username + '...');
    const user = client.getUser(update.username);
    await user.fetchFromAPI();
    await lobby_db.run(
        'INSERT INTO user (user_id, username, last_version) VALUES (?, ?, ?)',
        user.id, user.username, update.last_version,
    );
  }

  // then drop the updates table manually
  console.log('done');
}

main();
