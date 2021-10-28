import Sentry from '@sentry/node';
import {open} from 'sqlite';
import sqlite3 from 'sqlite3';
import SQL from 'sql-template-strings';
import {MessageActionRow, MessageButton, MessageEmbed} from 'discord.js';

let client = null;
let db = null;


async function init(discord_client) {
  client = discord_client;

  db = await open({
    filename: 'discord.db',
    driver: sqlite3.cached.Database,
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
    Sentry.captureException(err);
    return;
  }

  const ranked_lobby = await db.get(
      SQL`SELECT * FROM ranked_lobby WHERE osu_lobby_id = ${lobby.id}`,
  );
  if (ranked_lobby) {
    try {
      const discord_channel = client.channels.cache.get(ranked_lobby.discord_channel_id);
      const discord_msg = await discord_channel.messages.fetch(ranked_lobby.discord_msg_id + '');
      await discord_msg.edit(msg);
    } catch (err) {
      console.error(`[Ranked #${lobby.id}] Failed to edit Discord message:`, err);
      await db.run(SQL`DELETE FROM ranked_lobby WHERE osu_lobby_id = ${lobby.id}`);
      Sentry.captureException(err);
      return;
    }
  } else {
    try {
      const discord_channel = client.channels.cache.get('892789885335924786');
      const discord_msg = await discord_channel.send(msg);

      await db.run(SQL`
        INSERT INTO ranked_lobby (osu_lobby_id, discord_channel_id, discord_msg_id) 
        VALUES (${lobby.id}, ${discord_channel.id}, ${discord_msg.id})`,
      );
    } catch (err) {
      console.error(`[Ranked #${lobby.id}] Failed to create Discord message: ${err}`);
      Sentry.captureException(err);
      return;
    }
  }
}

// Removes the lobby information from the o!rl #lobbies channel.
async function close_ranked_lobby_on_discord(lobby) {
  const ranked_lobby = await db.get(SQL`
    SELECT * FROM ranked_lobby WHERE osu_lobby_id = ${lobby.id}`,
  );
  if (!ranked_lobby) return;

  try {
    const discord_channel = client.channels.cache.get(ranked_lobby.discord_channel_id);
    await discord_channel.messages.delete(ranked_lobby.discord_msg_id);
    await db.run(SQL`DELETE FROM ranked_lobby WHERE osu_lobby_id = ${lobby.id}`);
  } catch (err) {
    console.error(`[Ranked #${lobby.id}] Failed to remove Discord message: ${err}`);
    Sentry.captureException(err);
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

  const user = await db.get(SQL`
    SELECT * FROM user WHERE osu_id = ${osu_user_id}`,
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
            Sentry.captureException(err);
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

      await db.run(SQL`
        UPDATE user
        SET discord_rank = ${rank_text}
        WHERE osu_id = ${osu_user_id}`,
      );
    } catch (err) {
      console.error(`[Discord] Failed to update role for user ${osu_user_id}: ${err}`);
      Sentry.captureException(err);
    }
  }
}

async function get_scoring_preference(osu_id_list) {
  // 0: ScoreV1
  // 1: Accuracy
  // 2: Combo
  // 3: ScoreV2
  const placeholders = osu_id_list.map(() => '?').join(',');
  const res = await db.get(`
    SELECT score_preference, COUNT(*) AS nb FROM user
    WHERE osu_id IN (${placeholders}) AND score_preference IS NOT NULL
    GROUP BY score_preference ORDER BY nb DESC LIMIT 1`,
  osu_id_list,
  );
  if (!res) return 0;
  return res.score_preference || 0;
}

export {
  init,
  update_ranked_lobby_on_discord,
  close_ranked_lobby_on_discord,
  update_discord_role,
  get_scoring_preference,
};
