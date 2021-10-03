import crypto from 'crypto';
import fs from 'fs';
import {open} from 'sqlite';
import sqlite3 from 'sqlite3';
import {Client, Intents, MessageActionRow, MessageButton, MessageEmbed} from 'discord.js';

const Config = JSON.parse(fs.readFileSync('./config.json'));
let client = null;
let bancho_client = null;
let db = null;


function init_discord_bot(_bancho_client) {
  bancho_client = _bancho_client;

  return new Promise(async (resolve, reject) => {
    db = await open({
      filename: 'discord.db',
      driver: sqlite3.Database,
    });

    await db.exec(`CREATE TABLE IF NOT EXISTS ranked_lobby (
      osu_lobby_id INTEGER,
      discord_channel_id TEXT,
      discord_msg_id TEXT
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
      discord_rank TEXT
    )`);

    client = new Client({intents: [Intents.FLAGS.GUILDS]});

    client.once('ready', async () => {
      client.on('interactionCreate', async (interaction) => {
        const user = await db.get(
            'SELECT * FROM user WHERE discord_id = ?', interaction.user.id,
        );

        if (interaction.customId.indexOf('orl_get_lobby_invite_') == 0) {
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

          const player = await bancho_client.getUserById(user.osu_id);
          for (const lobby of bancho_client.joined_lobbies) {
            if (lobby.id == lobby_id) {
              const lobby_invite_id = lobby.channel.topic.split('#')[1];
              await player.sendMessage(`Here's your invite: [http://osump://${lobby_invite_id}/ ${lobby.name}]`);
              await interaction.reply({
                content: 'An invite to the lobby has been sent. Check your in-game messages. 😌',
                ephemeral: true,
              });
              return;
            }
          }
        }
      });

      // await create_account_linking_button();
      console.log('Discord bot is ready.');
      resolve();
    });

    const {discord_token} = JSON.parse(fs.readFileSync('./config.json'));
    client.login(discord_token);
  });
}

function get_pp_color(pp) {
  if (typeof pp === 'undefined' || !pp) {
    return null;
  }

  // TODO: set better colors & brackets based on actual ranks
  if (pp < 50) {
    // Easy
    return '#76b000';
  } else if (pp < 100) {
    // Normal
    return '#58d6ff';
  } else if (pp < 150) {
    // Hard
    return '#ffd60a';
  } else if (pp < 250) {
    // Insane
    return '#ff58ac';
  } else if (pp < 400) {
    // Expert
    return '#8158fe';
  } else {
    // God
    return '#000000';
  }
}

// Updates the lobby information on Discord.
// Creates the message in the o!rl #lobbies channel if it doesn't exist.
async function update_ranked_lobby_on_discord(lobby) {
  let msg = null;

  try {
    const fields = [
      {
        name: 'Players',
        value: lobby.nb_players + '/' + lobby.size,
        inline: true,
      },
      {
        name: 'Status',
        value: lobby.playing ? 'Playing' : 'Waiting',
        inline: true,
      },
    ];
    if (lobby.nb_players > 0 && lobby.median_overall > 0) {
      fields.push({
        name: 'Aim',
        value: lobby.median_aim + 'pp',
        inline: true,
      });
      fields.push({
        name: 'Speed',
        value: lobby.median_speed + 'pp',
        inline: true,
      });
      fields.push({
        name: 'Accuracy',
        value: lobby.median_acc + 'pp',
        inline: true,
      });
      fields.push({
        name: 'Overall',
        value: lobby.median_overall + 'pp',
      });
    }

    msg = {
      embeds: [
        new MessageEmbed({
          title: lobby.name,
          fields: fields,
          color: get_pp_color(lobby.median_overall),
        }),
      ],
      components: [
        new MessageActionRow().addComponents([
          new MessageButton({
            custom_id: 'orl_get_lobby_invite_' + lobby.id,
            label: 'Get invite',
            style: 'PRIMARY',
          }),
        ]),
      ],
    };
  } catch (err) {
    console.error(`[Ranked lobby #${lobby.id}] Could not generate Discord message: ${err}`);
    return;
  }

  const ranked_lobby = await db.get(
      `SELECT * FROM ranked_lobby WHERE osu_lobby_id = ?`,
      lobby.id,
  );
  if (ranked_lobby) {
    try {
      const discord_channel = client.channels.cache.get(ranked_lobby.discord_channel_id);
      await discord_channel.messages.edit(ranked_lobby.discord_msg_id, msg);
    } catch (err) {
      console.error(`[Ranked lobby #${lobby.id}] Could not edit Discord message: ${err}`);
      return;
    }
  } else {
    try {
      const discord_channel = client.channels.cache.get('893207661225594880');
      const discord_msg = await discord_channel.send(msg);

      await db.run(
          'INSERT INTO ranked_lobby (osu_lobby_id, discord_channel_id, discord_msg_id) VALUES (?, ?, ?)',
          lobby.id,
          discord_channel.id,
          discord_msg.id,
      );
    } catch (err) {
      console.error(`[Ranked lobby #${lobby.id}] Could not create Discord message: ${err}`);
      return;
    }
  }
}

// Removes the lobby information from the o!rl #lobbies channel.
async function close_ranked_lobby_on_discord(lobby) {
  const ranked_lobby = await db.get(
      `SELECT * FROM ranked_lobby WHERE osu_lobby_id = ?`,
      lobby.id,
  );
  if (!ranked_lobby) return;

  try {
    const discord_channel = client.channels.cache.get(ranked_lobby.discord_channel_id);
    await discord_channel.messages.delete(ranked_lobby.discord_msg_id);
    await db.run('DELETE FROM ranked_lobby WHERE osu_lobby_id = ?', lobby.id);
  } catch (err) {
    console.error(`[Ranked lobby #${lobby.id}] Could not remove Discord message: ${err}`);
  }
}

async function update_discord_role(osu_user_id, rank_text) {
  const DISCORD_ROLES = {
    'Cardboard': '893082878806732851',
    'Copper': '893083179601260574',
    'Bronze': '893083324673822771',
    'Silver': '893083428260556801',
    'Gold': '893083477531033613',
    'Platinum': '893083535907377152',
    'Diamond': '893083693244100608',
    'Legendary': '893083871309082645',
    'The One': '892966704991330364',
  };

  // Remove '++' suffix from the rank_text
  rank_text = rank_text.split('+')[0];

  const user = await db.get(
      'SELECT * FROM user WHERE osu_id = ?', osu_user_id,
  );
  if (!user) {
    // User hasn't linked their discord account yet.
    return;
  }

  if (user.discord_rank != rank_text) {
    console.log('[Discord] Updating role for user ' + osu_user_id + ': ' + user.discord_rank + ' -> ' + rank_text);

    try {
      const guild = await client.guilds.fetch('891781932067749948');
      const member = await guild.members.fetch(user.discord_id);

      console.log('debug:', rank_text, DISCORD_ROLES[rank_text]);

      if (rank_text == 'The One') {
        const role = await guild.roles.fetch(DISCORD_ROLES[rank_text]);
        role.members.each(async (member) => {
          console.log('debug: removing The One from', member);
          await member.roles.remove(DISCORD_ROLES['The One']);
          await member.roles.add(DISCORD_ROLES['Legendary']);
        });
      }
      if (user.discord_rank) {
        try {
          await member.roles.remove(DISCORD_ROLES[user.discord_rank]);
        } catch (err) {
          g;
          console.log('[Discord] Failed to remove rank ' + user.discord_rank + ' from discord user ' + member.nickname);
        }
      }
      if (rank_text != 'Unranked') {
        await member.roles.add(DISCORD_ROLES[rank_text]);
      }

      await db.run(
          'UPDATE user SET discord_rank = ? WHERE osu_id = ?',
          rank_text,
          osu_user_id,
      );
    } catch (err) {
      console.error(`Could not update Discord role for user ${osu_user_id}: ${err}`);
    }
  }
}

export {
  init_discord_bot,
  update_ranked_lobby_on_discord,
  close_ranked_lobby_on_discord,
  update_discord_role,
};
