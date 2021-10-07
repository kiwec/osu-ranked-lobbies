import crypto from 'crypto';
import fs from 'fs';
import {open} from 'sqlite';
import sqlite3 from 'sqlite3';
import {Client, Intents, MessageActionRow, MessageButton, MessageEmbed} from 'discord.js';

const Config = JSON.parse(fs.readFileSync('./config.json'));
let client = null;
let bancho_client = null;
let db = null;
let ranks_db = null;

import {get_rank_text_from_id} from './elo_mmr.js';
async function fix_ranks_once(client) {
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

  const guild = await client.guilds.fetch('891781932067749948');
  const users = await db.all('SELECT osu_id, discord_id FROM user');
  for (const user of users) {
    try {
      const member = await guild.members.fetch(user.discord_id);
      console.log('Fixing roles for ' + member.displayName);

      let rank_text = await get_rank_text_from_id(user.osu_id);
      rank_text = rank_text.split('+')[0];

      for (const role of member.roles.cache) {
        if (Object.values(DISCORD_ROLES).includes(role.id) && role.id != DISCORD_ROLES[rank_text]) {
          await member.roles.remove(role);
          console.log('- Removed ' + role.name);
        }
      }

      try {
        await member.roles.add(DISCORD_ROLES[rank_text]);
        console.log('+ Added ' + rank_text);
      } catch (err) {
        console.error('! Could not add role ' + rank_text);
      }

      await db.run('UPDATE user SET discord_rank = ? WHERE discord_id = ?', rank_text, member.id);
    } catch (err) {
      console.error(`Failed to fix roles for ${user.discord_id}: ${err}`);
    }
  }
}

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

        if (interaction.isCommand()) {
          if (interaction.commandName == 'profile') {
            if (!ranks_db) {
              ranks_db = await open({
                filename: 'ranks.db',
                driver: sqlite3.Database,
              });
            }

            if (!user) {
              await interaction.reply({
                content: `To check your profile, you first need to click the button in ${welcome} to link your osu! account.`,
                ephemeral: true,
              });
              return;
            }

            let division = 'Unranked';
            const profile = await ranks_db.get('SELECT * FROM user WHERE user_id = ?', user.osu_id);
            if (profile.elo) {
              const better_users = await db.get('SELECT COUNT(*) AS nb FROM user WHERE elo > ?', profile.elo);
              const all_users = await db.get('SELECT COUNT(*) AS nb FROM user');
              division = get_rank_text(1.0 - (better_users.nb / all_users.nb));
            }

            await interaction.reply({
              embeds: [
                new MessageEmbed({
                  title: 'Your profile',
                  fields: [
                    {
                      name: 'Rank',
                      value: profile.elo ? ('#' + (better_users.nb + 1)) : '-',
                    },
                    {
                      name: 'Division',
                      value: division,
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
                      value: profile.avg_ar.toFixed(1),
                      inline: true,
                    },
                  ],
                }),
              ],
              ephemeral: true,
            });
          }
        }

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

        if (interaction.customId == 'orl_link_osu_account') {
          // Check if user already linked their account
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
      setTimeout(() => fix_ranks_once(client), 5000);
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
        name: 'Difficulty',
        value: Math.round(lobby.median_overall) + 'pp',
        inline: true,
      });
      fields.push({
        name: 'Aim',
        value: Math.round(lobby.median_aim) + 'pp',
        inline: true,
      });
      fields.push({
        name: 'Speed',
        value: Math.round(lobby.median_speed) + 'pp',
        inline: true,
      });
      fields.push({
        name: 'Accuracy',
        value: Math.round(lobby.median_acc) + 'pp',
        inline: true,
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
            disabled: lobby.nb_players == 16,
          }),
        ]),
      ],
    };
  } catch (err) {
    console.error(`[Ranked #${lobby.id}] Failed to generate Discord message: ${err}`);
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
      console.error(`[Ranked #${lobby.id}] Failed to edit Discord message: ${err}`);
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
    } catch (err) {
      console.error(`[Ranked #${lobby.id}] Failed to create Discord message: ${err}`);
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
    console.error(`[Ranked #${lobby.id}] Failed to remove Discord message: ${err}`);
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
    console.log('debug:', rank_text, DISCORD_ROLES[rank_text]);

    try {
      const guild = await client.guilds.fetch('891781932067749948');
      const member = await guild.members.fetch(user.discord_id);

      if (rank_text == 'The One') {
        const role = await guild.roles.fetch(DISCORD_ROLES[rank_text]);
        role.members.each(async (member) => {
          console.log('debug: removing The One from', member);
          try {
            await member.roles.remove(DISCORD_ROLES['The One']);
            await member.roles.add(DISCORD_ROLES['Legendary']);
          } catch (err) {
            console.error('Failed to remove the one/add legendary to ' + member + ': ' + err);
          }
        });
      }
      if (user.discord_rank) {
        try {
          await member.roles.remove(DISCORD_ROLES[user.discord_rank]);
        } catch (err) {
          console.log('[Discord] Failed to remove rank ' + user.discord_rank + ' from discord user ' + member.displayName);
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
      console.error(`[Discord] Failed to update role for user ${osu_user_id}: ${err}`);
    }
  }
}

export {
  init_discord_bot,
  update_ranked_lobby_on_discord,
  close_ranked_lobby_on_discord,
  update_discord_role,
};
