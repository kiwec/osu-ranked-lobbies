import fs from 'fs';
import Bancho from 'bancho.js';
import Sentry from '@sentry/node';
import {open} from 'sqlite';
import sqlite3 from 'sqlite3';

import {init as init_discord_interactions} from './discord_interactions.js';
import {init as init_discord_updates} from './discord_updates.js';
import {listen as website_listen} from './website.js';
import {start_ranked} from './ranked.js';


// fuck you, es6 modules, for making this inconvenient
const Config = JSON.parse(fs.readFileSync('./config.json'));

Sentry.init({
  dsn: Config.sentry_dsn,
});


async function main() {
  console.log('Starting...');

  const client = new Bancho.BanchoClient(Config);
  client.on('error', (err) => Sentry.captureException(err));

  try {
    const discord_client = await init_discord_interactions(client);
    await init_discord_updates(discord_client);

    website_listen();

    await client.connect();
    console.log('Connected to bancho.');

    const map_db = await open({
      filename: 'maps.db',
      driver: sqlite3.cached.Database,
    });

    await start_ranked(client, map_db);

    client.on('PM', async (msg) => {
      console.log(`[PM] ${msg.user.ircUsername}: ${msg.message}`);

      if (msg.message == '!discord') {
        await msg.user.sendMessage('https://kiwec.net/discord');
        return;
      }

      if (msg.message == '!about' || msg.message == '!help' || msg.message == '!commands') {
        await msg.user.sendMessage('All bot commands and answers to your questions are [https://kiwec.net/discord in the Discord.]');
        return;
      }

      if (msg.message.indexOf('!makelobby') == 0 || msg.message.indexOf('!createlobby') == 0) {
        await msg.user.sendMessage('Sorry, that command was removed. Instead, you can create a ranked lobby with a custom star range.');
        return;
      }

      const lobby_only_commands = ['!skip', '!start', '!kick', '!wait'];
      for (const cmd of lobby_only_commands) {
        if (msg.message.indexOf(cmd) == 0) {
          await msg.user.sendMessage('Sorry, you should send that command in #multiplayer.');
          return;
        }
      }
    });

    console.log('All ready and fired up!');
  } catch (e) {
    Sentry.captureException(e);
  }
}

main();
