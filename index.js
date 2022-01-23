import Sentry from '@sentry/node';

import bancho from './bancho.js';
import databases from './database.js';
import {apply_rank_decay} from './elo_mmr.js';
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

  if (Config.CREATE_LOBBIES) {
    // Check for lobby creation every minute
    setInterval(() => create_lobby_if_needed(), 60 * 1000);
  }
  if (Config.APPLY_RANK_DECAY) {
    // This is pretty database intensive, so run it hourly
    setInterval(apply_rank_decay, 3600 * 1000);
  }

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

    await start_ranked(databases.maps);
  }

  if (Config.APPLY_RANK_DECAY) {
    await apply_rank_decay();
  }

  console.log('All ready and fired up!');
}


async function create_lobby_if_needed() {
  const get_lobbies_stmt = databases.discord.prepare('SELECT * FROM ranked_lobby WHERE creator = ?');
  const lobbies = get_lobbies_stmt.all(Config.osu_username);
  if (!lobbies || lobbies.length >= Config.max_lobbies) return;

  let filled_lobbies = 0;
  for (const lobby of bancho.joined_lobbies) {
    if (lobby.creator == Config.osu_username && lobby.nb_players > 8) {
      filled_lobbies++;
    }
  }

  if (filled_lobbies < lobbies.length) {
    // We don't want to create a lobby if one of the bot-created lobbies isn't
    // filled enough.
    return;
  }

  try {
    console.log('Creating new lobby...');
    const lobby = await bancho.make(`o!RL | Auto map select (!about)`);
    await init_lobby(lobby, {
      creator: Config.osu_username,
      creator_osu_id: Config.osu_id,
      creator_discord_id: Config.discord_bot_id,
      created_just_now: true,
      dt: false,
      scorev2: false,
    });
  } catch (err) {
    // Don't care about errors here.
    console.error(err);
  }
}

main();
