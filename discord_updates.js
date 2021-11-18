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


function get_pp_color(lobby) {
  if (!lobby || !lobby.median_overall) {
    return null;
  }

  const sr = (lobby.min_stars + lobby.max_stars) / 2.0;
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
    msg = {
      embeds: [
        new MessageEmbed({
          title: lobby.name,
          fields: [
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
            {
              name: 'Creator',
              value: `<@${lobby.creator_discord_id}>`,
              inline: true,
            },
          ],
          color: get_pp_color(lobby),
        }),
      ],
      components: [
        new MessageActionRow().addComponents([
          new MessageButton({
            custom_id: 'orl_get_lobby_invite_' + lobby.id,
            label: 'Get invite',
            style: 'PRIMARY',
            disabled: lobby.nb_players == lobby.size,
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

      let min_stars = null;
      let max_stars = null;
      if (lobby.fixed_star_range) {
        min_stars = lobby.min_stars;
        max_stars = lobby.max_stars;
      }

      await db.run(SQL`
        INSERT INTO ranked_lobby (osu_lobby_id, discord_channel_id, discord_msg_id, creator, creator_discord_id, min_stars, max_stars, dt, scorev2)
        VALUES (${lobby.id}, ${discord_channel.id}, ${discord_msg.id}, ${lobby.creator}, ${lobby.creator_discord_id}, ${min_stars}, ${max_stars}, ${lobby.is_dt}, ${lobby.is_scorev2})`,
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
    await db.run(SQL`DELETE FROM ranked_lobby WHERE osu_lobby_id = ${lobby.id}`);
    const discord_channel = client.channels.cache.get(ranked_lobby.discord_channel_id);
    await discord_channel.messages.delete(ranked_lobby.discord_msg_id);
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

  const user = await db.get(SQL`
    SELECT * FROM user WHERE osu_id = ${osu_user_id}`,
  );
  if (!user) {
    // User hasn't linked their discord account yet.
    return;
  }

  if (user.discord_rank != rank_text) {
    console.log('[Discord] Updating role for user ' + osu_user_id + ': ' + user.discord_rank + ' -> ' + rank_text);

    try {
      const guild = await client.guilds.fetch('891781932067749948');
      let member;
      try {
        member = await guild.members.fetch(user.discord_id);
      } catch (err) {
        console.error('[Discord] <@' + user.discord_id + '> left the discord server?');
        return;
      }

      // Add 'Linked account' role
      await member.roles.add('909777665223966750');

      if (rank_text == 'The One') {
        const role = await guild.roles.fetch(DISCORD_ROLES[rank_text]);
        role.members.each(async (member) => {
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

export {
  init,
  update_ranked_lobby_on_discord,
  close_ranked_lobby_on_discord,
  update_discord_role,
};
