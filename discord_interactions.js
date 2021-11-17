import crypto from 'crypto';
import fs from 'fs';
import Sentry from '@sentry/node';
import {open} from 'sqlite';
import sqlite3 from 'sqlite3';
import SQL from 'sql-template-strings';
import {Client, Intents, MessageActionRow, MessageButton, MessageEmbed} from 'discord.js';

import {join_lobby} from './ranked.js';

const Config = JSON.parse(fs.readFileSync('./config.json'));
let client = null;
let bancho_client = null;
let db = null;
let ranks_db = null;


function init(_bancho_client) {
  bancho_client = _bancho_client;

  return new Promise(async (resolve, reject) => {
    try {
      db = await open({
        filename: 'discord.db',
        driver: sqlite3.cached.Database,
      });

      await db.exec(`CREATE TABLE IF NOT EXISTS ranked_lobby (
        osu_lobby_id INTEGER,
        discord_channel_id TEXT,
        discord_msg_id TEXT,
        creator TEXT,
        creator_discord_id TEXT,
        min_stars REAL,
        max_stars REAL
      )`);

      await db.exec(`CREATE TABLE IF NOT EXISTS auth_tokens (
        discord_user_id TEXT,
        ephemeral_token TEXT
      )`);

      await db.exec(`CREATE TABLE IF NOT EXISTS user (
        discord_id TEXT,
        osu_id INTEGER,
        osu_access_token TEXT,
        osu_refresh_token TEXT,
        discord_rank TEXT,
        score_preference INTEGER
      )`);

      client = new Client({intents: [Intents.FLAGS.GUILDS]});

      client.once('ready', async () => {
        client.on('interactionCreate', (interaction) => on_interaction(interaction).catch(Sentry.captureException));
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

  if (interaction.isSelectMenu()) {
    if (interaction.customId == 'orl_set_scoring') {
      await on_set_preferred_scoring_system(user, interaction);
      return;
    }
  }

  if (interaction.isCommand()) {
    if (interaction.commandName == 'make-lobby') {
      await on_make_ranked_command(user, interaction);
      return;
    }

    if (interaction.commandName == 'profile') {
      await on_profile_command(user, interaction);
      return;
    }
  }

  if (interaction.customId && interaction.customId.indexOf('orl_get_lobby_invite_') == 0) {
    await on_lobby_invite_button_press(user, interaction);
    return;
  }

  if (interaction.customId == 'orl_link_osu_account') {
    await on_link_osu_account_press(user, interaction);
    return;
  }
}

async function on_make_ranked_command(user, interaction) {
  if (!user) {
    const welcome = await client.channels.cache.get('892880734526795826');
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
    const channel = await bancho_client.getChannel('#mp_' + interaction.options.getInteger('lobby-id'));
    await channel.join();
    await channel.lobby.updateSettings();

    let host_user = null;
    for (const player of channel.lobby.slots) {
      if (player == null) continue;
      if (player.isHost) {
        await player.user.fetchFromAPI();
        if (player.user.id == user.osu_id) {
          host_user = player.user;
          break;
        }
      }
    }
    if (host_user == null) {
      throw new Error('you need to be the lobby host.');
    }

    channel.lobby.on('refereeRemoved', async (username) => {
      if (username != 'kiwec') return;

      await channel.sendMessage('Looks like we\'re done here.');
      channel.lobby.removeAllListeners();
      await channel.leave();
    });

    await channel.lobby.clearHost();
    await join_lobby(channel.lobby, bancho_client, host_user.ircUsername, user.discord_id, true, min_stars, max_stars);
    console.log(`[Ranked #${channel.lobby.id}] Created by ${host_user.ircUsername}.`);

    await interaction.editReply({content: 'Lobby initialized ✅ Enjoy!'});
  } catch (err) {
    if (err.message == 'No such channel') {
      await interaction.editReply({content: 'Failed to join lobby. Are you sure you ran **!mp addref kiwec**, and that the lobby id is correct?'});
    } else {
      await interaction.editReply({content: 'Failed to join lobby: ' + err});
      Sentry.captureException(err);
    }
  }
}

async function on_set_preferred_scoring_system(user, interaction) {
  if (!user) {
    await interaction.reply({
      content: `Before setting your preferred scoring system, you first need to link your account by clicking on the "Link account" button ☝️`,
      ephemeral: true,
    });
    return;
  }

  if (interaction.values[0] == '0') {
    await db.run(SQL`UPDATE user SET score_preference = 0 WHERE discord_id = ${interaction.user.id}`);
    await interaction.reply({
      content: `Ranked lobbies will now use ScoreV1 as the scoring system if the majority votes for it.`,
      ephemeral: true,
    });
  } else if (interaction.values[0] == '3') {
    await db.run(SQL`UPDATE user SET score_preference = 3 WHERE discord_id = ${interaction.user.id}`);
    await interaction.reply({
      content: `Ranked lobbies will now use ScoreV2 as the scoring system if the majority votes for it.`,
      ephemeral: true,
    });
  } else {
    await db.run(SQL`UPDATE user SET score_preference = NULL WHERE discord_id = ${interaction.user.id}`);
    await interaction.reply({
      content: `Ranked lobbies will use the scoring system voted by the majority.`,
      ephemeral: true,
    });
  }

  console.log(`[Discord] ${interaction.user} selected '${interaction.values[0]}' as their preferred scoring system.`);
}

async function on_profile_command(user, interaction) {
  if (!ranks_db) {
    ranks_db = await open({
      filename: 'ranks.db',
      driver: sqlite3.cached.Database,
    });
  }

  if (!user) {
    const welcome = await client.channels.cache.get('892880734526795826');
    await interaction.reply({
      content: `To check your profile, you first need to click the button in ${welcome} to link your osu! account.`,
      ephemeral: true,
    });
    return;
  }

  let rank = '-';
  const profile = await ranks_db.get(SQL`SELECT * FROM user WHERE user_id = ${user.osu_id}`);
  if (profile.elo && profile.games_played > 4) {
    const better_users = await ranks_db.get(SQL`
      SELECT COUNT(*) AS nb FROM user
      WHERE elo > ${profile.elo} AND games_played > 4`,
    );
    rank = '#' + (better_users.nb + 1);
  }

  await interaction.reply({
    embeds: [
      new MessageEmbed({
        title: 'Your profile',
        fields: [
          {
            name: 'Rank',
            value: rank,
            inline: true,
          },
          {
            name: 'Division',
            value: profile.rank_text,
          },
          {
            name: 'Aim',
            value: Math.round(profile.aim_pp) + 'pp',
            inline: true,
          },
          {
            name: 'Speed',
            value: Math.round(profile.speed_pp) + 'pp',
            inline: true,
          },
          {
            name: 'Accuracy',
            value: Math.round(profile.acc_pp) + 'pp',
            inline: true,
          },
          {
            name: 'Approach Rate',
            value: (profile.avg_ar || 0).toFixed(1),
            inline: true,
          },
        ],
      }),
    ],
    ephemeral: true,
  });
}

async function on_lobby_invite_button_press(user, interaction) {
  const parts = interaction.customId.split('_');
  const lobby_id = parseInt(parts[parts.length - 1], 10);

  if (!user) {
    const welcome = await client.channels.cache.get('892880734526795826');
    await interaction.reply({
      content: `Before getting an invite, you need to click the button in ${welcome} to link your osu! account.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ephemeral: true});

  const player = await bancho_client.getUserById(user.osu_id);
  for (const lobby of bancho_client.joined_lobbies) {
    if (lobby.id == lobby_id) {
      const lobby_invite_id = lobby.channel.topic.split('#')[1];
      await player.sendMessage(`Here's your invite: [http://osump://${lobby_invite_id}/ ${lobby.name}]`);
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
          url: `https://osu.ppy.sh/oauth/authorize?client_id=${Config.client_id}&response_type=code&scope=identify&state=${ephemeral_token}&redirect_uri=https://osu.kiwec.net/auth`,
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
