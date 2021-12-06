import Bancho from 'bancho.js';
import Sentry from '@sentry/node';
import {open} from 'sqlite';
import sqlite3 from 'sqlite3';
import SQL from 'sql-template-strings';
import Nodesu from 'nodesu';

import {init as init_discord_interactions} from './discord_interactions.js';
import {init as init_discord_updates, update_discord_username} from './discord_updates.js';
import {listen as website_listen} from './website.js';
import {start_ranked, join_lobby} from './ranked.js';
import {capture_sentry_exception} from './util/helpers.js';
import Config from './util/config.js';

if (Config.ENABLE_SENTRY) {
  Sentry.init({
    dsn: Config.sentry_dsn
  });
}


let ranking_db = null;


// Monkey-patch bancho.js so we get user data from our own database when
// possible. This is here to remove load from the osu!api, and to hopefully
// fail less often.
// Not contributed to bancho.js itself since most people don't want to run a
// database in order to run a simple osu bot.
import BanchoUser from 'bancho.js/lib/BanchoUser.js';
BanchoUser.prototype.fetchFromAPI = async function() {
  // NOTE: Right now, we only care about id. So we only set that.
  const res = await ranking_db.get(SQL`SELECT * FROM user WHERE username = ${this.ircUsername}`);
  if (res) {
    this.id = res.user_id;
    this.username = res.username;
  } else {
    console.log('Fetching user info for ' + this.ircUsername);
    const user = await this.banchojs.osuApi.user.get(this.ircUsername, null, null, Nodesu.LookupType.string);
    if (!user) {
      throw new Error('nodesu returned undefined. idk what to do.');
    }

    const existing_user = await ranking_db.get(SQL`SELECT * FROM user WHERE user_id = ${user.id}`);
    if (existing_user) {
      console.log(`User #${user.id} (${existing_user.username}) is now known as ${this.ircUsername}`);
      await ranking_db.run(SQL`UPDATE user SET username = ${this.ircUsername} WHERE user_id = ${user.id}`);
      await update_discord_username(user.id, user.username, 'Changed their osu! username');
    } else {
      await ranking_db.run(SQL`
        INSERT INTO user (
          user_id, username, approx_mu, approx_sig, normal_mu, normal_sig, games_played,
          aim_pp, acc_pp, speed_pp, overall_pp, avg_ar, avg_sr
        )
        VALUES (
          ${user.id}, ${this.ircUsername}, 1500, 350, 1500, 350, 0,
          10.0, 1.0, 1.0, 1.0, 8.0, 2.0
        )`,
      );
    }

    this.id = user.id;
    this.username = this.ircUsername;
  }
};


async function main() {
  console.log('Starting...');

  // Used in the BanchoUser.fetchFromAPI monkey-patch above.
  ranking_db = await open({
    filename: 'ranks.db',
    driver: sqlite3.cached.Database,
  });

  const client = new Bancho.BanchoClient({
    username: Config.osu_username,
    password: Config.osu_irc_password,
    apiKey: Config.osu_v1api_key,
  });
  client.joined_lobbies = [];

  client.on('error', (err) => {
    console.error('bancho.js error: ', err);
    capture_sentry_exception(err);
  });

  client.on('PM', async (msg) => {
    console.log(`[PM] ${msg.user.ircUsername}: ${msg.message}`);

    if (msg.message == '!discord') {
      await msg.user.sendMessage(Config.discord_invite_link);
      return;
    }

    if (msg.message == '!about' || msg.message == '!help' || msg.message == '!commands') {
      await msg.user.sendMessage(`All bot commands and answers to your questions are [${Config.discord_invite_link} in the Discord.]`);
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

  let discord_client = null;
  if (Config.CONNECT_TO_DISCORD) {
    discord_client = await init_discord_interactions(client);
  }

  // We still want to call this even without connecting to discord, since this
  // initalizes discord.db which is used for tracking ranked lobbies.
  await init_discord_updates(discord_client);

  if (Config.HOST_WEBSITE) {
    website_listen();
  }

  if (Config.CONNECT_TO_BANCHO) {
    await client.connect();
    console.log('Connected to bancho.');

    const map_db = await open({
      filename: 'maps.db',
      driver: sqlite3.cached.Database,
    });

    await start_ranked(client, map_db);

    if (Config.CREATE_LOBBIES) {
      // Check for lobby creation every 10 minutes
      setInterval(() => create_lobby_if_needed(client), 10 * 60 * 1000);
      await create_lobby_if_needed(client);
    }
  }

  console.log('All ready and fired up!');
}


async function create_lobby_if_needed(client) {
  const db = await open({
    filename: 'discord.db',
    driver: sqlite3.cached.Database,
  });

  const lobbies = await db.all(SQL`SELECT * FROM ranked_lobby WHERE creator = ${Config.osu_username}`);
  if (!lobbies || lobbies.length >= 4) return;

  console.log(`Creating ${4 - lobbies.length} missing lobbies...`);

  if (!lobbies.some((lobby) => lobby.min_stars == 3.0)) {
    const channel = await client.createLobby(`3-3.99* | o!RL | Auto map select (!about)`);
    await join_lobby(
        channel.lobby,
        client,
        Config.osu_username,
        Config.discord_bot_id,
        false,
        3.0,
        4.0,
        false,
        false,
    );
    console.log(`Created 3-3.99* lobby #mp_${channel.lobby.id}.`);
  }
  if (!lobbies.some((lobby) => lobby.min_stars == 4.0)) {
    const channel = await client.createLobby(`4-4.99* | o!RL | Auto map select (!about)`);
    await join_lobby(
        channel.lobby,
        client,
        Config.osu_username,
        Config.discord_bot_id,
        false,
        4.0,
        5.0,
        false,
        false,
    );
    console.log(`Created 4-4.99* lobby #mp_${channel.lobby.id}.`);
  }
  if (!lobbies.some((lobby) => lobby.min_stars == 5.0)) {
    const channel = await client.createLobby(`5-5.99* | o!RL | Auto map select (!about)`);
    await join_lobby(
        channel.lobby,
        client,
        Config.osu_username,
        Config.discord_bot_id,
        false,
        5.0,
        6.0,
        false,
        false,
    );
    console.log(`Created 5-5.99* lobby #mp_${channel.lobby.id}.`);
  }
  if (!lobbies.some((lobby) => lobby.min_stars == 0.0)) {
    const channel = await client.createLobby(`6-6.99* | o!RL | Auto map select (!about)`);
    await join_lobby(
        channel.lobby,
        client,
        Config.osu_username,
        Config.discord_bot_id,
        false,
        6.0,
        7.0,
        false,
        false,
    );
    console.log(`Created 6-6.99* lobby #mp_${channel.lobby.id}.`);
  }

  console.log('Done creating missing lobbies.');
}

main();
