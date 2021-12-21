import crypto from 'crypto';
import fs from 'fs';
import Sentry from '@sentry/node';
import {open} from 'sqlite';
import sqlite3 from 'sqlite3';
import SQL from 'sql-template-strings';
import {Client, Intents, MessageActionRow, MessageButton} from 'discord.js';

import bancho from './bancho.js';
import BanchoLobby from './lobby.js';
import {init_lobby} from './ranked.js';
import {capture_sentry_exception} from './util/helpers.js';
import Config from './util/config.js';

let client = null;
let db = null;
let ranks_db = null;


function init() {
  return new Promise(async (resolve, reject) => {
    try {
      db = await open({
        filename: 'discord.db',
        driver: sqlite3.cached.Database,
      });

      ranks_db = await open({
        filename: 'ranks.db',
        driver: sqlite3.cached.Database,
      });

      client = new Client({intents: [Intents.FLAGS.GUILDS]});

      client.once('ready', async () => {
        client.on('interactionCreate', (interaction) => on_interaction(interaction).catch(capture_sentry_exception));
        console.log('Discord bot is ready.');
        resolve(client);
      });

      const {discord_token} = JSON.parse(fs.readFileSync('./config.json'));
      client.login(discord_token);
    } catch (e) {
      reject(e);
    }
  });
}

async function on_interaction(interaction) {
  const user = await db.get(
      SQL`SELECT * FROM user WHERE discord_id = ${interaction.user.id}`,
  );
  if (Config.ENABLE_SENTRY) {
    if (user) {
      Sentry.setUser({
        osu_id: user.osu_id,
        discord_id: user.discord_id,
        discord_rank: user.discord_rank,
        username: interaction.user.username,
      });
    } else {
      Sentry.setUser({
        discord_id: interaction.user.id,
        username: interaction.user.username,
      });
    }
  }

  if (interaction.isContextMenu()) {
    if (interaction.commandName == 'Display o!RL profile') {
      const target = await db.get(
          SQL`SELECT * FROM user WHERE discord_id = ${interaction.targetId}`,
      );

      if (target) {
        await interaction.reply(`${Config.website_base_url}/u/${target.osu_id}`);
      } else {
        await interaction.reply({
          content: 'That user hasn\'t linked their osu! account yet.',
          ephemeral: true,
        });
      }

      return;
    }
  }

  if (interaction.isCommand()) {
    if (interaction.commandName == 'make-lobby') {
      await on_make_ranked_command(user, interaction);
      return;
    }
  }

  try {
    if (interaction.customId && interaction.customId.indexOf('orl_get_lobby_invite_') == 0) {
      await on_lobby_invite_button_press(user, interaction);
      return;
    }

    if (interaction.customId == 'orl_link_osu_account') {
      await on_link_osu_account_press(user, interaction);
      return;
    }
  } catch (err) {
    // Discord API likes to fail.
    if (err.message != 'Unknown interaction') {
      capture_sentry_exception(err);
    }
  }
}

async function on_make_ranked_command(user, interaction) {
  if (!user) {
    const welcome = await client.channels.cache.get(Config.discord_welcome_channel_id);
    await interaction.reply({
      content: `To create a ranked lobby, you first need to click the button in ${welcome} to link your osu! account.`,
      ephemeral: true,
    });
    return;
  }

  let min_stars = interaction.options.getNumber('min-stars');
  let max_stars = interaction.options.getNumber('max-stars');
  if (min_stars != null || max_stars != null) {
    if (min_stars == null) {
      min_stars = max_stars - 1.0;
    }
    if (max_stars == null) {
      max_stars = min_stars + 1.0;
    }
  }

  await interaction.deferReply({ephemeral: true});

  try {
    const osu_user = await ranks_db.get(SQL`SELECT * FROM user WHERE user_id = ${user.osu_id}`);
    if (!osu_user) {
      await interaction.editReply({content: `Please at least join an o!RL lobby once before attempting to create one.`});
      return;
    }

    const lobby = await new BanchoLobby('#mp_' + interaction.options.getInteger('lobby-id'));
    await lobby.join();
    await lobby.send('!mp clearhost');
    await init_lobby(lobby, {
      creator: osu_user.username,
      creator_discord_id: user.discord_id,
      created_just_now: true,
      min_stars: min_stars,
      max_stars: max_stars,
      dt: interaction.options.getBoolean('dt'),
      scorev2: interaction.options.getBoolean('scorev2'),
    });

    console.log(`Lobby ${lobby.channel} created by ${osu_user.username}.`);
    await interaction.editReply({content: 'Lobby initialized ✅ Enjoy!'});
  } catch (err) {
    if (err.message == 'No such channel') {
      await interaction.editReply({content: `Failed to join lobby. Are you sure you ran **!mp addref ${Config.osu_username}**, and that the lobby id is correct?`});
    } else {
      await interaction.editReply({content: 'Failed to join lobby: ' + err});
      capture_sentry_exception(err);
    }
  }
}

async function on_lobby_invite_button_press(user, interaction) {
  const parts = interaction.customId.split('_');
  const lobby_id = parseInt(parts[parts.length - 1], 10);

  if (!user) {
    const welcome = await client.channels.cache.get(Config.discord_welcome_channel_id);
    await interaction.reply({
      content: `Before getting an invite, you need to click the button in ${welcome} to link your osu! account.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ephemeral: true});

  const player = await ranks_db.get(SQL`SELECT username FROM user WHERE user_id = ${user.osu_id}`);
  if (!player) {
    await interaction.editReply({
      content: 'Sorry, but you need to join your first lobby from in-game. Search for "o!RL".',
      ephemeral: true,
    });
    return;
  }

  for (const lobby of bancho.joined_lobbies) {
    if (lobby.channel == '#mp_' + lobby_id) {
      await bancho.privmsg(player.username, `${player.username}, here's your invite: [http://osump://${lobby.invite_id}/ ${lobby.name}]`);
      await interaction.editReply({
        content: 'An invite to the lobby has been sent. Check your in-game messages. 😌',
        ephemeral: true,
      });
      return;
    }
  }

  await interaction.editReply({
    content: 'Sorry, looks like that lobby just closed. <:tf:900417849179389992>',
    ephemeral: true,
  });
  await interaction.message.delete();
}

async function on_link_osu_account_press(user, interaction) {
  // Check if user already linked their account
  if (user) {
    await interaction.reply({
      content: 'You already linked your account 👉 https://osu.ppy.sh/users/' + user.osu_id,
      ephemeral: true,
    });
    return;
  }

  // Create ephemeral token
  await db.run(SQL`
    DELETE from auth_tokens
    WHERE discord_user_id = ${interaction.user.id}`,
  );
  const ephemeral_token = crypto.randomBytes(16).toString('hex');
  await db.run(SQL`
    INSERT INTO auth_tokens (discord_user_id, ephemeral_token)
    VALUES (${interaction.user.id}, ${ephemeral_token})`,
  );

  // Send authorization link
  await interaction.reply({
    content: `Hello ${interaction.user}, let's get your account linked!`,
    ephemeral: true,
    components: [
      new MessageActionRow().addComponents([
        new MessageButton({
          url: `https://osu.ppy.sh/oauth/authorize?client_id=${Config.osu_v2api_client_id}&response_type=code&scope=identify&state=${ephemeral_token}&redirect_uri=${Config.website_base_url}/auth`,
          label: 'Verify using osu!web',
          style: 'LINK',
        }),
      ]),
    ],
  });
}

export {
  init,
};
