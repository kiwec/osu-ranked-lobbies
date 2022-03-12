import Sentry from '@sentry/node';

import bancho from './bancho.js';
import commands from './commands.js';
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
    for (const cmd of commands) {
      const match = cmd.regex.exec(msg.message);
      if (match) {
        if (cmd.lobby_only) {
          await bancho.privmsg(msg.from, 'You should send that command in #multiplayer.');
          return;
        }

        try {
          await cmd.handler(msg, match, null);
        } catch (err) {
          capture_sentry_exception(err);
        }
        return;
      }
    }
  });

  let discord_client = null;
  if (Config.CONNECT_TO_DISCORD) {
    try {
      discord_client = await init_discord_interactions();
    } catch (err) {
      console.error('Failed to login to Discord:', err.message);
      process.exit();
    }
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

    await start_ranked();
  }

  if (Config.APPLY_RANK_DECAY) {
    await apply_rank_decay();
  }

  console.log('All ready and fired up!');
}


// Automatically create lobbies when they're not.
//
// Since newly created lobbies are added to the bottom of the lobby list, it's
// fine to create them optimistically, since players won't see them without
// searching.
async function create_lobby_if_needed() {
  const lobbies_to_create = [
    {min: 3, max: 4},
    {min: 4, max: 5},
    {min: 5, max: 6},
    {min: 6, max: 7},
  ];
  for (const to_create of lobbies_to_create) {
    let exists = false;
    for (const lobby of bancho.joined_lobbies) {
      if (lobby.creator == Config.osu_username && lobby.min_stars == to_create.min && lobby.max_stars == to_create.max) {
        exists = true;
        break;
      }
    }

    if (!exists) {
      try {
        console.log('Creating new lobby...');
        const lobby = await bancho.make(`${to_create.min}-${to_create.max-0.01}* | o!RL | Auto map select (!about)`);
        await init_lobby(lobby, {
          creator: Config.osu_username,
          creator_osu_id: Config.osu_id,
          creator_discord_id: Config.discord_bot_id,
          created_just_now: true,
          min_stars: to_create.min,
          max_stars: to_create.max,
          dt: false,
          scorev2: false,
        });
      } catch (err) {
        // Don't care about errors here.
        console.error(err);
      }
    }
  }
}

main();
