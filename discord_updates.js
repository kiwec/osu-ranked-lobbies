import {MessageActionRow, MessageButton, MessageEmbed} from 'discord.js';

import bancho from './bancho.js';
import databases from './database.js';
import {capture_sentry_exception} from './util/helpers.js';
import Config from './util/config.js';

let discord_client = null;
const stmts = {
  lobby_from_id: databases.discord.prepare('SELECT * FROM ranked_lobby WHERE osu_lobby_id = ?'),
  delete_lobby: databases.discord.prepare('DELETE FROM ranked_lobby WHERE osu_lobby_id = ?'),
  user_from_osu_id: databases.discord.prepare('SELECT * FROM user WHERE osu_id = ?'),
};

// Array of lobby info as displayed on discord
const discord_lobbies = [];

async function init(discord_client_) {
  discord_client = discord_client_;
  discord_update_loop();
}


function get_pp_color(lobby) {
  if (!lobby || lobby.nb_players == 0) {
    return null;
  }

  const sr = (lobby.min_stars + lobby.max_stars) / 2.0;
  if (sr <= 0.1) {
    return '#4290FB';
  } else if (sr >= 9) {
    return '#000000';
  } else {
    const star_levels = [0.1, 1.25, 2, 2.5, 3.3, 4.2, 4.9, 5.8, 6.7, 7.7, 9];
    const star_colors = ['#4290FB', '#4FC0FF', '#4FFFD5', '#7CFF4F', '#F6F05C', '#FF8068', '#FF4E6F', '#C645B8', '#6563DE', '#18158E', '#000000'];
    for (const i in star_levels) {
      if (!star_levels.hasOwnProperty(i)) continue;
      if (star_levels[i] > sr && star_levels[i-1] < sr) {
        const lower = star_levels[i - 1];
        const upper = star_levels[i];
        const ratio = (sr - lower) / (upper - lower);
        const r = parseInt(star_colors[i-1].substr(1, 2), 16) * (1 - ratio) + parseInt(star_colors[i].substr(1, 2), 16) * ratio;
        const g = parseInt(star_colors[i-1].substr(3, 2), 16) * (1 - ratio) + parseInt(star_colors[i].substr(3, 2), 16) * ratio;
        const b = parseInt(star_colors[i-1].substr(5, 2), 16) * (1 - ratio) + parseInt(star_colors[i].substr(5, 2), 16) * ratio;
        return '#' + Math.round(r).toString(16).padStart(2, '0') + Math.round(g).toString(16).padStart(2, '0') + Math.round(b).toString(16).padStart(2, '0');
      }
    }
  }
}

// Dumb loop to update discord lobbies when their info changes.
async function discord_update_loop() {
  for (const lobby of bancho.joined_lobbies) {
    const new_val = lobby.name + lobby.nb_players + lobby.playing;
    if (discord_lobbies[lobby.id] != new_val) {
      await update_ranked_lobby_on_discord(lobby);
      discord_lobbies[lobby.id] = new_val;
    }
  }

  setTimeout(discord_update_loop, 1000);
}

// Updates the lobby information on Discord.
// Creates the message in the o!rl #lobbies channel if it doesn't exist.
async function update_ranked_lobby_on_discord(lobby) {
  const ranked_lobby = stmts.lobby_from_id.get(lobby.id);
  if (!ranked_lobby) {
    // If the lobby isn't yet in the database, create it here and call this
    // method again to create/update/delete the discord messages
    // in #lobbies.
    let min_stars = null;
    let max_stars = null;
    if (lobby.fixed_star_range) {
      min_stars = lobby.min_stars;
      max_stars = lobby.max_stars;
    }

    const insert_lobby_stmt = databases.discord.prepare(`
      INSERT INTO ranked_lobby (
        osu_lobby_id, creator, creator_osu_id, creator_discord_id,
        min_stars, max_stars, dt, scorev2
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert_lobby_stmt.run(
        lobby.id,
        lobby.creator,
        lobby.creator_osu_id,
        lobby.creator_discord_id,
        min_stars,
        max_stars,
        lobby.is_dt ? 1 : 0,
        lobby.is_scorev2 ? 1 : 0,
    );

    return await update_ranked_lobby_on_discord(lobby);
  }

  if (!discord_client) {
    // We're not connected to Discord; don't bother managing Discord messages.
    return;
  }

  // Lobby is full: delete existing #lobbies message
  if (lobby.nb_players == 16) {
    try {
      const discord_channel = discord_client.channels.cache.get(ranked_lobby.discord_channel_id);
      await discord_channel.messages.delete(ranked_lobby.discord_msg_id);
      const unlist_lobby_stmt = databases.discord.prepare(`
        UPDATE ranked_lobby
        SET discord_channel_id = NULL, discord_msg_id = NULL
        WHERE osu_lobby_id = ?`,
      );
      unlist_lobby_stmt.run(lobby.id);
    } catch (err) {
      // If it's already deleted, ignore the error. We don't want to
      // delete the actual lobby from the database.
    }

    return;
  }

  let msg = null;
  try {
    msg = {
      embeds: [
        new MessageEmbed({
          title: lobby.name,
          fields: [
            {
              name: 'Players',
              value: `${lobby.nb_players}/16`,
              inline: true,
            },
            {
              name: 'Status',
              value: lobby.playing ? 'Playing' : 'Waiting',
              inline: true,
            },
            {
              name: 'Creator',
              value: `[${lobby.creator}](${Config.website_base_url}/u/${lobby.creator_osu_id})`,
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
          }),
        ]),
      ],
    };
  } catch (err) {
    console.error(`${lobby.channel} Failed to generate Discord message: ${err}`);
    capture_sentry_exception(err);
    return;
  }

  // Try to update existing message
  if (ranked_lobby.discord_channel_id && ranked_lobby.discord_msg_id) {
    try {
      const discord_channel = discord_client.channels.cache.get(ranked_lobby.discord_channel_id);
      const discord_msg = await discord_channel.messages.fetch(ranked_lobby.discord_msg_id + '');
      await discord_msg.edit(msg);
    } catch (err) {
      if (err.message == 'Unknown Message') {
        // Message was deleted, try again
        stmts.delete_lobby.run(lobby.id);
        return await update_ranked_lobby_on_discord(lobby);
      }

      console.error(`${lobby.channel} Failed to update Discord message: ${err}`);
      capture_sentry_exception(err);
    }

    return;
  }

  // Try to create new message
  try {
    const discord_channel = discord_client.channels.cache.get(Config.discord_lobbies_channel_id);
    const discord_msg = await discord_channel.send(msg);

    const create_listing_stmt = databases.discord.prepare(`
      UPDATE ranked_lobby
      SET discord_channel_id = ?, discord_msg_id = ?
      WHERE osu_lobby_id = ?`,
    );
    create_listing_stmt.run(discord_channel.id, discord_msg.id, lobby.id);
  } catch (err) {
    console.error(`${lobby.channel} Failed to create Discord message: ${err}`);
    capture_sentry_exception(err);
  }
}

// Removes the lobby information from the o!rl #lobbies channel.
async function close_ranked_lobby_on_discord(lobby) {
  const ranked_lobby = stmts.lobby_from_id.get(lobby.id);
  if (!ranked_lobby) return;

  try {
    stmts.delete_lobby.run(lobby.id);

    if (discord_client) {
      const discord_channel = discord_client.channels.cache.get(ranked_lobby.discord_channel_id);
      await discord_channel.messages.delete(ranked_lobby.discord_msg_id);
    }
  } catch (err) {
    console.error(`${lobby.channel} Failed to remove Discord message: ${err}`);
  }
}

async function update_discord_username(osu_user_id, new_username, reason) {
  if (!discord_client) return;

  const user = stmts.user_from_osu_id.get(osu_user_id);
  try {
    if (!user) return;

    const guild = await discord_client.guilds.fetch(Config.discord_guild_id);
    let member;
    try {
      member = await guild.members.fetch(user.discord_id);
    } catch (err) {
      console.error('[Discord] <@' + user.discord_id + '> left the discord server?');
      return;
    }

    await member.setNickname(new_username, reason);
  } catch (err) {
    console.error(`[Discord] Failed to update nickname for <@${user.discord_id}>: ${err}`);
    capture_sentry_exception(err);
  }
}

async function update_discord_role(osu_user_id, rank_text) {
  if (!discord_client) return;

  const DISCORD_ROLES = {
    'Cardboard': Config.discord_cardboard_role_id,
    'Wood': Config.discord_wood_role_id,
    'Bronze': Config.discord_bronze_role_id,
    'Silver': Config.discord_silver_role_id,
    'Gold': Config.discord_gold_role_id,
    'Platinum': Config.discord_platinum_role_id,
    'Diamond': Config.discord_diamond_role_id,
    'Legendary': Config.discord_legendary_role_id,
    'The One': Config.discord_the_one_role_id,
  };

  // Remove '++' suffix from the rank_text
  rank_text = rank_text.split('+')[0];

  const user = stmts.user_from_osu_id.get(osu_user_id);
  if (!user) {
    // User hasn't linked their discord account yet.
    return;
  }

  if (user.discord_rank != rank_text) {
    console.log('[Discord] Updating role for user ' + osu_user_id + ': ' + user.discord_rank + ' -> ' + rank_text);

    try {
      const guild = await discord_client.guilds.fetch(Config.discord_guild_id);
      let member;
      try {
        member = await guild.members.fetch(user.discord_id);
      } catch (err) {
        console.error('[Discord] <@' + user.discord_id + '> left the discord server?');
        return;
      }

      // Add 'Linked account' role
      await member.roles.add(Config.discord_linked_account_role_id);

      if (rank_text == 'The One') {
        const role = await guild.roles.fetch(DISCORD_ROLES[rank_text]);
        role.members.each(async (member) => {
          try {
            await member.roles.remove(DISCORD_ROLES['The One']);
            await member.roles.add(DISCORD_ROLES['Legendary']);
          } catch (err) {
            console.error('Failed to remove the one/add legendary to ' + member + ': ' + err);
            capture_sentry_exception(err);
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

      const update_rank_stmt = databases.discord.prepare(`
        UPDATE user
        SET discord_rank = ?
        WHERE osu_id = ?`,
      );
      update_rank_stmt.run(rank_text, osu_user_id);
    } catch (err) {
      // User left the server
      if (err.message == 'Unknown Member') {
        return;
      }

      console.error(`[Discord] Failed to update role for user ${osu_user_id}: ${err}`);
      capture_sentry_exception(err);
    }
  }
}

export {
  init,
  close_ranked_lobby_on_discord,
  update_discord_role,
  update_discord_username,
};
