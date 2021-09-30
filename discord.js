import crypto from 'crypto';
import fs from 'fs';
import {open} from 'sqlite';
import sqlite3 from 'sqlite3';
import {Client, Intents, MessageActionRow, MessageButton, MessageEmbed} from 'discord.js';

const Config = JSON.parse(fs.readFileSync('./config.json'));
let client = null;
let db = null;


function init_discord_bot() {
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
        if (interaction.customId == 'orl_link_osu_account') {
          // Check if user already linked their account
          const user = await db.get(
              'SELECT * FROM user WHERE discord_id = ?', interaction.user.id,
          );
          if (user) {
            await interaction.reply({
              content: 'You already linked your account 👉 https://osu.ppy.sh/users/' + user.osu_id,
              ephemeral: true,
            });
            return;
          }

          // Create ephemeral token
          await db.run(
              'DELETE from auth_tokens WHERE discord_user_id = ?',
              interaction.user.id,
          );
          const ephemeral_token = crypto.randomBytes(16).toString('hex');
          await db.run(
              'INSERT INTO auth_tokens (discord_user_id, ephemeral_token) VALUES (?, ?)',
              interaction.user.id,
              ephemeral_token,
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
      });

      // await create_account_linking_button();
      console.log('Discord bot is ready.');
      resolve();
    });

    const {discord_token} = JSON.parse(fs.readFileSync('./config.json'));
    client.login(discord_token);
  });
}

function get_sr_color(sr) {
  if (sr < 2.0) {
    // Easy
    return '#76b000';
  } else if (sr < 2.7) {
    // Normal
    return '#58d6ff';
  } else if (sr < 4) {
    // Hard
    return '#ffd60a';
  } else if (sr < 5.3) {
    // Insane
    return '#ff58ac';
  } else if (sr < 6.5) {
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
      },
    ];
    if (lobby.nb_players > 0) {
      fields.push({
        name: 'Star Rating',
        value: lobby.map_sr + '*',
        inline: true,
      });
      fields.push({
        name: 'Difficulty',
        value: lobby.map_pp + 'pp',
        inline: true,
      });
    }

    msg = {
      embeds: [
        new MessageEmbed({
          title: lobby.name,
          fields: fields,
          color: lobby.nb_players > 0 ? get_sr_color(lobby.map_sr) : null,
        }),
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
      console.log('debug: edited msg', ranked_lobby.discord_msg_id, 'for lobby', lobby.id);
    } catch (err) {
      console.error(`[Ranked lobby #${lobby.id}] Could not edit Discord message: ${err}`);
      return;
    }
  } else {
    try {
      const discord_channel = client.channels.cache.get('892789885335924786');
      const discord_msg = await discord_channel.send(msg);

      await db.run(
          'INSERT INTO ranked_lobby (osu_lobby_id, discord_channel_id, discord_msg_id) VALUES (?, ?, ?)',
          lobby.id,
          discord_channel.id,
          discord_msg.id,
      );

      console.log('debug: created msg', discord_msg.id, 'for lobby', lobby.id);
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
    console.log('debug: deleted msg', ranked_lobby.discord_msg_id, 'for lobby', lobby.id);
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
    try {
      const guild = await client.guilds.fetch('891781932067749948');
      const member = await guild.members.fetch(user.discord_id);

      if (rank_text == 'The One') {
        const role = await guild.roles.fetch(DISCORD_ROLES['The One']);
        role.members.each((member) => {
          member.roles.remove(DISCORD_ROLES['The One']);
        });
      }
      if (user.discord_rank) {
        await member.roles.remove(DISCORD_ROLES[user.discord_rank]);
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
