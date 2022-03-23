import {MessageActionRow, MessageButton, MessageEmbed} from 'discord.js';

import bancho from './bancho.js';
import databases from './database.js';
import {capture_sentry_exception} from './util/helpers.js';
import Config from './util/config.js';

let discord_client = null;
const stmts = {
  create_listing: databases.ranks.prepare(`
    INSERT INTO discord_lobby_listing (osu_lobby_id, discord_channel_id, discord_message_id)
    VALUES (?, ?, ?)`,
  ),
  listing_from_id: databases.ranks.prepare('SELECT * FROM discord_lobby_listing WHERE osu_lobby_id = ?'),
  delete_listing: databases.ranks.prepare('DELETE FROM discord_lobby_listing WHERE osu_lobby_id = ?'),
  user_from_osu_id: databases.discord.prepare('SELECT * FROM user WHERE osu_id = ?'),
  delete_user: databases.discord.prepare('DELETE FROM user WHERE osu_id = ?'),
};

// Array of lobby info as displayed on discord
const discord_lobbies = [];

async function init(discord_client_) {
  discord_client = discord_client_;
  discord_update_loop();
}


// Returns the color of a given star rating, matching osu!web's color scheme.
function stars_to_color(sr) {
  if (sr <= 0.1) {
    return '#4290FB';
  } else if (sr >= 9) {
    return '#000000';
  }

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


function get_pp_color(lobby) {
  if (!lobby || lobby.nb_players == 0) {
    return null;
  }

  const sr = (lobby.data.min_stars + lobby.data.max_stars) / 2.0;
  return stars_to_color(sr);
}

// Dumb loop to update discord lobbies when their info changes.
async function discord_update_loop() {
  for (const lobby of bancho.joined_lobbies) {
    if (lobby.data.mode == 'ranked') {
      const new_val = lobby.name + lobby.nb_players + lobby.playing;
      if (discord_lobbies[lobby.id] != new_val) {
        await update_ranked_lobby_on_discord(lobby);
        discord_lobbies[lobby.id] = new_val;
      }
    } else if (lobby.data.mode == 'collection') {
      const new_val = lobby.name + lobby.nb_players + lobby.playing + lobby.passworded + lobby.beatmap_id;
      if (discord_lobbies[lobby.id] != new_val) {
        await update_collection_lobby_on_discord(lobby);
        discord_lobbies[lobby.id] = new_val;
      }
    }
  }

  setTimeout(discord_update_loop, 1000);
}

async function update_collection_lobby_on_discord(lobby) {
  if (!discord_client) return;
  const discord_channel = discord_client.channels.cache.get(Config.discord_collection_lobbies_channel_id);

  // Lobby not initialized yet
  if (!lobby.map) return;

  const listing = stmts.listing_from_id.get(lobby.id);
  if (!listing) {
    try {
      const discord_msg = await discord_channel.send({
        embeds: [
          new MessageEmbed({
            title: '*Creating new lobby...*',
          }),
        ],
      });
      stmts.create_listing.run(lobby.id, discord_channel.id, discord_msg.id);
    } catch (err) {
      console.error(`${lobby.channel} Failed to create Discord listing: ${err}`);
      capture_sentry_exception(err);
      return;
    }

    return await update_collection_lobby_on_discord(lobby);
  }

  try {
    const discord_msg = await discord_channel.messages.fetch(listing.discord_message_id + '');
    await discord_msg.edit({
      embeds: [
        new MessageEmbed({
          title: lobby.name,
          description: `**▸ Collection:** https://osucollector.com/collections/${lobby.data.collection_id}
**▸ Map:** [${lobby.map.title} (${lobby.map.stars}\*)](https://osu.ppy.sh/beatmaps/${lobby.map.id})
**▸ Ruleset:** ${lobby.map.mode}`,
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
              value: lobby.data.creator,
              inline: true,
            },
          ],
          color: stars_to_color(lobby.map.stars),
          thumbnail: {
            url: `https://assets.ppy.sh/beatmaps/${lobby.map.set_id}/covers/list.jpg`,
          },
        }),
      ],
      components: [
        new MessageActionRow().addComponents([
          new MessageButton({
            custom_id: 'orl_get_lobby_invite_' + lobby.id,
            label: 'Get invite',
            style: 'PRIMARY',
            disabled: lobby.nb_players == 16 || lobby.passworded,
          }),
        ]),
      ],
    });
  } catch (err) {
    if (err.message == 'Unknown Message') {
      // Message was deleted, try again
      stmts.delete_listing.run(lobby.id);
      delete discord_lobbies[lobby.id];
      return await update_collection_lobby_on_discord(lobby);
    }

    console.error(`${lobby.channel} Failed to update Discord message: ${err}`);
    capture_sentry_exception(err);
  }
}

// Creates/Updates the lobby information on Discord.
async function update_ranked_lobby_on_discord(lobby) {
  if (!discord_client) return;
  const discord_channel = discord_client.channels.cache.get(Config.discord_ranked_lobbies_channel_id);

  const listing = stmts.listing_from_id.get(lobby.id);
  if (!listing) {
    try {
      const discord_msg = await discord_channel.send('*Creating new lobby...*');
      stmts.create_listing.run(lobby.id, discord_channel.id, discord_msg.id);
    } catch (err) {
      console.error(`${lobby.channel} Failed to create Discord listing: ${err}`);
      capture_sentry_exception(err);
      return;
    }

    return await update_ranked_lobby_on_discord(lobby);
  }

  try {
    const discord_msg = await discord_channel.messages.fetch(listing.discord_message_id + '');
    await discord_msg.edit({
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
              value: `[${lobby.data.creator}](${Config.website_base_url}/u/${lobby.data.creator_osu_id})`,
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
            disabled: lobby.nb_players == 16,
          }),
        ]),
      ],
    });
  } catch (err) {
    if (err.message == 'Unknown Message') {
      // Message was deleted, try again
      stmts.delete_listing.run(lobby.id);
      delete discord_lobbies[lobby.id];
      return await update_ranked_lobby_on_discord(lobby);
    }

    console.error(`${lobby.channel} Failed to update Discord message: ${err}`);
    capture_sentry_exception(err);
  }
}

async function remove_discord_lobby_listing(osu_lobby_id) {
  if (!discord_client) return;

  const listing = stmts.listing_from_id.get(osu_lobby_id);
  if (!listing) return;

  try {
    const discord_channel = discord_client.channels.cache.get(listing.discord_channel_id);
    await discord_channel.messages.delete(listing.discord_message_id);
    stmts.delete_listing.run(osu_lobby_id);
    console.info(`Removed Discord listing for lobby #mp_${osu_lobby_id}`);
  } catch (err) {
    console.error(`#mp_${osu_lobby_id}: Failed to remove Discord listing: ${err}`);
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
        if (err.message == 'Unknown Member') {
          stmts.delete_user.run(osu_user_id);
        } else {
          console.error(err);
        }
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
  remove_discord_lobby_listing,
  update_discord_role,
  update_discord_username,
};
