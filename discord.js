import fs from 'fs';
import {open} from 'sqlite';
import sqlite3 from 'sqlite3';
import {Client, Intents, MessageActionRow, MessageButton, MessageEmbed} from 'discord.js';

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

    client = new Client({intents: [Intents.FLAGS.GUILDS]});

    client.once('ready', () => {
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
      // components: [
      //   new MessageActionRow().addComponents([
      //     new MessageButton({
      //       label: 'Join lobby',
      //       url: lobby.invite_link,
      //       style: 'LINK',
      //       disabled: lobby.nb_players == 16 || !lobby.invite_link,
      //     }),
      //   ]),
      // ],
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

export {
  init_discord_bot,
  update_ranked_lobby_on_discord,
  close_ranked_lobby_on_discord,
};
