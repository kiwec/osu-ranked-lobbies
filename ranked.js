import fs from 'fs';
import {init_db as init_ranking_db, update_mmr, get_rank_text} from './elo_mmr.js';
import {update_lobby_filters} from './casual.js';

// fuck you, es6 modules, for making this inconvenient
const CURRENT_VERSION = JSON.parse(fs.readFileSync('./package.json')).version;

let ranking_db = null;


function median(numbers) {
  const sorted = numbers.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }

  return sorted[middle];
}

async function select_next_map(lobby, map_db) {
  // When the bot restarts, re-add the currently selected map to recent maps
  if (!lobby.recent_maps.includes(lobby.beatmapId)) {
    lobby.recent_maps.push(lobby.beatmapId);
  }

  if (lobby.recent_maps.length >= 25) {
    lobby.recent_maps.shift();
  }

  const avg_pps = [];
  for (const player of lobby.slots) {
    if (player && player.user.avg_pp) {
      avg_pps.push(player.user.avg_pp);
    }
  }

  if (avg_pps.length == 0) {
    console.error(`[Ranked lobby ${lobby.id}] No users in the lobby, cannot select map. Aborting.`);
    return;
  }

  let new_map = null;
  const pp = median(avg_pps);
  let pp_variance = pp / 20;

  const filters = lobby.filters || 'from pp inner join map on map.id = pp.map_id where mods = (1<<15) AND length < 200';
  let tries = 0;
  do {
    new_map = await map_db.get(
        `SELECT * ${filters} AND pp < ? AND pp > ?
      ORDER BY RANDOM() LIMIT 1`,
        pp + pp_variance, pp - pp_variance,
    );
    if (!new_map) {
      pp_variance *= 2;
    }

    tries++;
  } while ((!new_map || lobby.recent_maps.includes(new_map.id)) && tries < 10);

  if (!new_map) {
    console.error(`[Ranked lobby ${lobby.id}] Could not find new map. Aborting.`);
    return;
  }

  console.log(`[Ranked lobby ${lobby.id}] New map: ${new_map.id}`);
  lobby.recent_maps.push(new_map.id);

  try {
    const flavor = `${new_map.stars.toFixed(2)}*, ${Math.floor(new_map.pp)}pp`;
    const map_name = `[https://osu.ppy.sh/beatmapsets/${new_map.set_id}#osu/${new_map.id} ${new_map.name}]`;
    const download_link = `[https://api.chimu.moe/v1/download/${new_map.set_id}?n=1&r=${lobby.randomString()} Direct download]`;
    await lobby.channel.sendMessage(`!mp map ${new_map.id} 0 | ${map_name} (${flavor}) ${download_link}`);
  } catch (e) {
    console.error(`[Ranked lobby ${lobby.id}] Failed to switch to map ${new_map.id} ${new_map.file}:`, e);
  }
}

async function join_lobby(lobby, lobby_db, map_db, client) {
  lobby.recent_maps = [];
  lobby.voteskips = [];
  lobby.countdown = -1;
  await lobby.setPassword('');

  const get_nb_players = () => {
    let nb_players = 0;
    for (const player of lobby.slots) {
      if (player != null) nb_players++;
    }

    return nb_players;
  };

  lobby.on('allPlayersReady', async () => {
    console.log(`[Lobby ${lobby.id}] Starting match.`);

    if (lobby.countdown) {
      clearTimeout(lobby.countdown);
    }

    lobby.startMatch();
    lobby.voteskips = [];
    lobby.countdown = -1;
  });

  lobby.on('matchFinished', async (scores) => {
    console.log(`[Lobby ${lobby.id}] Finished match.`);

    const rank_updates = await update_mmr(ranking_db, lobby);
    await select_next_map(lobby, map_db);

    if (rank_updates.length > 0) {
      let outstr = 'Rank updates: ';

      for (const i in rank_updates) {
        if (!rank_updates.hasOwnProperty(i)) continue;
        const player = rank_updates[i];

        if (i == 0) {
          outstr += player.username + ' is now ' + player.rank_text;
        } else if (i == rank_updates.length - 1) {
          outstr += ' and ' + player.username + ' is now ' + player.rank_text;
        } else {
          outstr += ', ' + player.username + ' is now ' + player.rank_text;
        }
      }

      outstr += '.';
      await lobby.channel.sendMessage(outstr);
    }
  });

  lobby.on('playerJoined', async (obj) => {
    await obj.player.user.fetchFromAPI();

    // EXTREMELY ACCURATE PP GUESSTIMATING
    obj.player.user.avg_pp = (obj.player.user.ppRaw * obj.player.user.accuracy) / 3000;

    const user = await lobby_db.get('select * from user where user_id = ?', obj.player.user.id);
    if (!user) {
      await lobby.channel.sendMessage(`Welcome, ${obj.player.user.ircUsername}! This is a ranked lobby, play one game to find out what your rank is :)`);
      await lobby_db.run(
          'INSERT INTO user (user_id, username, last_version) VALUES (?, ?, ?)',
          obj.player.user.id, obj.player.user.username, CURRENT_VERSION,
      );
    }


    if (get_nb_players() == 1) {
      await select_next_map(lobby, map_db);
    }
  });

  lobby.on('playerLeft', async (obj) => {
    // TODO: add 0pp score if the player was currently playing?
    // TODO: keep the lobby open if it's the last one by idling in it?
    if (get_nb_players() == 0) {
      await lobby_db.run(`DELETE FROM ranked_lobby WHERE lobby_id = ?`, lobby.id);
      await lobby.closeLobby();
      console.log('Closed ranked lobby ' + lobby.id);
    }
  });

  lobby.channel.on('message', async (msg) => {
    console.log(`[Ranked lobby ${lobby.id}] ${msg.user.ircUsername}: ${msg.message}`);

    if (msg.user.isClient() && msg.message.indexOf('!setfilter') == 0) {
      try {
        const lobby_info = {};
        await update_lobby_filters(lobby_info, msg.message);
        lobby.filters = lobby_info.query;
        await lobby_db.run(
            'update ranked_lobby set filters = ? where lobby_id = ?',
            lobby.filters, lobby.id,
        );
        await select_next_map(lobby, map_db);
      } catch (e) {
        console.error(`[Lobby ${lobby.id}] ${e}`);
        await lobby.channel.sendMessage(e.toString());
      }
    }

    if (msg.message == '!rank') {
      await lobby.channel.sendMessage(msg.user.ircUsername + ': You are ' + get_rank_text(msg.user.elo) + '.');
    }

    if (msg.message == '!skip' && !lobby.voteskips.includes(msg.user.ircUsername)) {
      lobby.voteskips.push(msg.user.ircUsername);
      if (lobby.voteskips.length >= get_nb_players() / 2) {
        lobby.voteskips = [];
        await select_next_map(lobby, map_db);
      } else {
        await lobby.channel.sendMessage(`${lobby.voteskips.length}/${get_nb_players() / 2} players voted to switch to another map.`);
      }
    }

    if (msg.message == '!start' && !lobby.countdown) {
      lobby.countdown = setTimeout(async () => {
        lobby.countdown = setTimeout(async () => {
          lobby.startMatch();
          lobby.voteskips = [];
          lobby.countdown = -1;
        }, 10000);
        await lobby.channel.sendMessage('Starting the match in 10 seconds... Ready up to start sooner.');
      }, 20000);
      await lobby.channel.sendMessage('Starting the match in 30 seconds... Ready up to start sooner.');
    }
  });
}

async function start_ranked(client, lobby_db, map_db) {
  ranking_db = await init_ranking_db();

  const joined_lobbies = [];

  const lobbies = await lobby_db.all('SELECT * from ranked_lobby');
  for (const lobby of lobbies) {
    try {
      const channel = await client.getChannel('#mp_' + lobby.lobby_id);
      await channel.join();
      channel.lobby.filters = lobby.filters;
      await join_lobby(channel.lobby, lobby_db, map_db, client);
      joined_lobbies.push(channel.lobby);
    } catch (e) {
      console.error('Could not rejoin lobby ' + lobby.lobby_id + ':', e);
      await lobby_db.run(`DELETE FROM ranked_lobby WHERE lobby_id = ?`, lobby.lobby_id);
    }
  }

  if (joined_lobbies.length == 0) {
    const channel = await client.createLobby(`RANKED LOBBY | Auto map select`);
    channel.lobby.filters = '';
    await join_lobby(channel.lobby, lobby_db, map_db, client);
    joined_lobbies.push(channel.lobby);
    await lobby_db.run('INSERT INTO ranked_lobby (lobby_id, filters) VALUES (?, "")', channel.lobby.id);
    console.log('Created ranked lobby.');
  }

  client.on('PM', async (msg) => {
    if (msg.user.isClient() && msg.message == '!makerankedlobby') {
      const channel = await client.createLobby(`RANKED LOBBY | Auto map select`);
      channel.lobby.filters = '';
      await join_lobby(channel.lobby, lobby_db, map_db, client);
      joined_lobbies.push(channel.lobby);
      await lobby_db.run('INSERT INTO ranked_lobby (lobby_id, filters) VALUES (?, "")', channel.lobby.id);
      console.log('Created ranked lobby.');
      await channel.lobby.invitePlayer(msg.user.ircUsername);
    }

    if (msg.message == '!rank') {
      const user = await ranking_db.get('select elo from user where username = ?', user.username);
      await msg.user.sendMessage('You are ' + get_rank_text(user.elo) + '.');
    }
  });

  // TODO: automatically create/close lobbies on demand
}

export {
  start_ranked,
};
