import Sentry from '@sentry/node';

import bancho from './bancho.js';
import commands from './commands.js';
import databases from './database.js';
import {apply_rank_decay} from './elo_mmr.js';
import {init as init_discord_interactions} from './discord_interactions.js';
import {remove_lobby_listing, init as init_discord_updates} from './discord_updates.js';
import {listen as website_listen} from './website.js';
import {init_lobby as init_ranked_lobby} from './ranked.js';
import {init_lobby as init_collection_lobby} from './collection.js';
import Config from './util/config.js';


async function rejoin_lobbies() {
  const rejoin_lobby = async (lobby) => {
    console.info(`Rejoining lobby #${lobby.id} (${lobby.data.mode})`);

    try {
      const bancho_lobby = await bancho.join('#mp_' + lobby.id);
      if (bancho_lobby.data.mode == 'ranked') {
        await init_ranked_lobby(bancho_lobby);
      } else if (bancho_lobby.data.mode == 'collection') {
        await init_collection_lobby(bancho_lobby);
      }
    } catch (err) {
      console.error(`Failed to rejoin lobby #${lobby.id}: ${err}`);
      await remove_lobby_listing(lobby.id);
    }
  };

  const lobbies_stmt = databases.ranks.prepare('SELECT * FROM lobby');
  const lobbies = lobbies_stmt.all();
  const promises = [];
  for (const lobby of lobbies) {
    promises.push(rejoin_lobby(lobby));
  }
  await Promise.all(promises);
}


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
        if (!cmd.modes.includes('pm')) {
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
    bancho.on('disconnect', () => process.exit());
    await bancho.connect();
    await rejoin_lobbies();
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
    {min: 0, max: 3},
    {min: 3, max: 4},
    {min: 4, max: 5},
    {min: 5, max: 5.5},
    {min: 5.5, max: 6},
  ];
  for (const to_create of lobbies_to_create) {
    let exists = false;
    for (const lobby of bancho.joined_lobbies) {
      if (lobby.data.creator == Config.osu_username && lobby.data.min_stars == to_create.min && lobby.data.max_stars == to_create.max) {
        exists = true;
        break;
      }
    }

    if (!exists) {
      try {
        console.log('Creating new lobby...');
        const lobby = await bancho.make(`${to_create.min}-${to_create.max-0.01}* | o!RL | Auto map select (!about)`);
        lobby.created_just_now = true;
        lobby.data.creator = Config.osu_username;
        lobby.data.creator_osu_id = Config.osu_id;
        lobby.data.min_stars = to_create.min;
        lobby.data.max_stars = to_create.max;
        lobby.data.fixed_star_range = true;
        await init_ranked_lobby(lobby);
      } catch (err) {
        // Don't care about errors here.
        console.error(err);
      }
    }
  }
}

main();
