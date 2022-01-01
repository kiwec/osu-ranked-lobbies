import Sentry from '@sentry/node';
import {open} from 'sqlite';
import sqlite3 from 'sqlite3';
import SQL from 'sql-template-strings';

import bancho from './bancho.js';
import {init_databases} from './database.js';
import {init_db as init_ranking_db, apply_rank_decay} from './elo_mmr.js';
import {init as init_discord_interactions} from './discord_interactions.js';
import {init as init_discord_updates} from './discord_updates.js';
import {listen as website_listen} from './website.js';
import {init_lobby, start_ranked} from './ranked.js';
import Config from './util/config.js';


async function main() {
  console.log('Starting...');

  if (Config.ENABLE_SENTRY) {
    Sentry.init({
      dsn: Config.sentry_dsn,
    });
  }

  await init_databases();

  bancho.on('pm', async (msg) => {
    if (msg.message.indexOf('!') == 0) {
      await bancho.privmsg(msg.from, `I'm a real person. If you want to send a command, you probably want to send it in #multiplayer or [${Config.discord_invite_link} in the Discord server].`);
    }
  });

  let discord_client = null;
  if (Config.CONNECT_TO_DISCORD) {
    discord_client = await init_discord_interactions();
  }

  // We still want to call this even without connecting to discord, since this
  // initalizes discord.db which is used for tracking ranked lobbies.
  await init_discord_updates(discord_client);

  if (Config.HOST_WEBSITE) {
    website_listen();
  }

  if (Config.CONNECT_TO_BANCHO) {
    await bancho.connect();
    bancho.on('disconnect', () => {
      // TODO: reconnect and rejoin lobbies
      process.exit();
    });
    console.log('Connected to bancho.');

    const map_db = await open({
      filename: 'maps.db',
      driver: sqlite3.cached.Database,
    });

    await start_ranked(map_db);

    if (Config.CREATE_LOBBIES) {
      // Check for lobby creation every 10 minutes
      setInterval(() => create_lobby_if_needed(), 10 * 60 * 1000);
      await create_lobby_if_needed();
    }
  }

  if (Config.APPLY_RANK_DECAY) {
    await init_ranking_db();

    // This is pretty database intensive, so run it hourly
    setInterval(apply_rank_decay, 3600 * 1000);
    await apply_rank_decay();
  }

  console.log('All ready and fired up!');
}


async function create_lobby_if_needed() {
  const db = await open({
    filename: 'discord.db',
    driver: sqlite3.cached.Database,
  });

  const lobbies = await db.all(SQL`SELECT * FROM ranked_lobby WHERE creator = ${Config.osu_username}`);
  if (!lobbies || lobbies.length >= 4) return;

  console.log(`Creating ${4 - lobbies.length} missing lobbies...`);

  try {
    if (!lobbies.some((lobby) => lobby.min_stars == 3.0)) {
      const lobby = await bancho.make(`3-3.99* | o!RL | Auto map select (!about)`);
      await init_lobby(lobby, {
        creator: Config.osu_username,
        creator_osu_id: Config.osu_id,
        creator_discord_id: Config.discord_bot_id,
        created_just_now: true,
        min_stars: 3,
        max_stars: 4,
        dt: false,
        scorev2: false,
      });
    }
    if (!lobbies.some((lobby) => lobby.min_stars == 4.0)) {
      const lobby = await bancho.make(`4-4.99* | o!RL | Auto map select (!about)`);
      await init_lobby(lobby, {
        creator: Config.osu_username,
        creator_osu_id: Config.osu_id,
        creator_discord_id: Config.discord_bot_id,
        created_just_now: true,
        min_stars: 4,
        max_stars: 5,
        dt: false,
        scorev2: false,
      });
    }
    if (!lobbies.some((lobby) => lobby.min_stars == 5.0)) {
      const lobby = await bancho.make(`5-5.5* | o!RL | Auto map select (!about)`);
      await init_lobby(lobby, {
        creator: Config.osu_username,
        creator_osu_id: Config.osu_id,
        creator_discord_id: Config.discord_bot_id,
        created_just_now: true,
        min_stars: 5,
        max_stars: 5.5,
        dt: false,
        scorev2: false,
      });
    }
    if (!lobbies.some((lobby) => lobby.min_stars == 0.0)) {
      const lobby = await bancho.make(`5.5-5.99* | o!RL | Auto map select (!about)`);
      await init_lobby(lobby, {
        creator: Config.osu_username,
        creator_osu_id: Config.osu_id,
        creator_discord_id: Config.discord_bot_id,
        created_just_now: true,
        min_stars: 5.5,
        max_stars: 6,
        dt: false,
        scorev2: false,
      });
    }
  } catch (err) {
    // Don't care about errors here.
    console.error(err);
  }

  console.log('Done creating missing lobbies.');
}

main();
