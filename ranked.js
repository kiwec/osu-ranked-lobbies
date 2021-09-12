import fs from 'fs';
import {init_db as init_ranking_db, update_mmr, get_rank_text} from './elo_mmr.js';
import {update_lobby_filters} from './casual.js';

// fuck you, es6 modules, for making this inconvenient
const CURRENT_VERSION = JSON.parse(fs.readFileSync('./package.json')).version;

let ranking_db = null;
let joined_lobbies = [];


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
    // Lobby is empty, but we still want to switch a map to keep it around.
    // Switch to a 120pp map, everyone likes 120pp maps.
    avg_pps.push(120.0);
  }

  let new_map = null;
  const pp = median(avg_pps);
  let pp_variance = pp / 20;

  const filters = lobby.filters || 'from pp inner join map on map.id = pp.map_id where mods = (1<<15) AND length < 240';
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

async function open_new_lobby_if_needed(client, lobby_db, map_db) {
  let empty_slots = 0;
  for(let jl of joined_lobbies) {
    let nb_players = jl.slots.reduce((total, slot) => total+slot);
    empty_slots += 16 - nb_players;
  }

  if(empty_slots == 0) {
    const channel = await client.createLobby(`RANKED LOBBY | Auto map select`);
    joined_lobbies.push(channel.lobby);
    channel.lobby.filters = '';
    await join_lobby(channel.lobby, lobby_db, map_db, client);
    await lobby_db.run('INSERT INTO ranked_lobby (lobby_id, filters) VALUES (?, "")', channel.lobby.id);
    await channel.sendMessage('!mp mods freemod');
    console.log('Created new ranked lobby #' + channel.lobby.id);
  }
}

async function close_or_idle_in_lobby(lobby, lobby_db, map_db) {
  // 1. Check if the lobby is empty
  let lobby_empty = lobby.slots.every((s) => s == null);
  if(!lobby_empty) {
    return;
  }

  // 2. Check if other lobbies have room
  let empty_slots = 0;
  for(let jl of joined_lobbies) {
    if(jl == lobby) continue;
    let nb_players = jl.slots.reduce((total, slot) => total+slot);
    empty_slots += 16 - nb_players;
  }
  if(empty_slots > 4) {
    joined_lobbies.splice(joined_lobbies.indexOf(lobby), 1);
    await lobby_db.run(`DELETE FROM ranked_lobby WHERE lobby_id = ?`, lobby.id);
    await lobby.closeLobby();
    console.log('Closed ranked lobby ' + lobby.id);
    return;
  }

  // 3. Other lobbies are (almost) full, let's keep it around for a bit longer.
  await select_next_map(lobby, map_db);
  setTimeout(() => close_or_idle_in_lobby(lobby, lobby_db, map_db), 30000);
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
      let strings = [];
      for(let update of rank_updates) {
        if(update.rank_before > update.rank_after) {
          strings.push(update.username + ' [https://osu.kiwec.net/u/' + update.username + '/ ▼' + get_rank_text(update.rank_after) + ']');
        } else {
          strings.push(update.username + ' [https://osu.kiwec.net/u/' + update.username + '/ ▲' + get_rank_text(update.rank_after) + ']');
        }
      }

      await lobby.channel.sendMessage('Rank updates: ' + strings.join(' | '));
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

    await open_new_lobby_if_needed(client, lobby_db, map_db);
  });

  lobby.on('playerLeft', async (obj) => {
    // TODO: add 0pp score if the player was currently playing?

    // Check if we should close the lobby
    let nb_players = lobby.slots.reduce((total, slot) => total+slot);
    if(nb_players == 0) {
      await close_or_idle_in_lobby(lobby, lobby_db, map_db);
      return;
    }

    // Remove user from voteskip list, if they voted to skip
    if(lobby.voteskips.includes(obj.player.user.ircUsername)) {
      lobby.voteskips.splice(lobby.voteskips.indexOf(obj.player.user.ircUsername), 1);
    }

    // Check if we should skip
    if (lobby.voteskips.length >= nb_players / 2) {
        lobby.voteskips = [];
        await select_next_map(lobby, map_db);
        return;
      }

    // Check if all players are ready
    let all_ready = lobby.slots.every((s) => s == null || s.state == 'Ready');
    if(all_ready) {
      lobby.emit('allPlayersReady');
      return;
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
      const res = await ranking_db.get('select elo from user where username = ?', msg.user.ircUsername);
      const better_users = await ranking_db.get('SELECT COUNT(*) AS nb FROM user WHERE elo > ?', res.elo);
      const all_users = await ranking_db.get('SELECT COUNT(*) AS nb FROM user');
      await lobby.channel.sendMessage(msg.user.ircUsername + ': You are ' + get_rank_text(1.0 - (better_users.nb / all_users.nb)) + '.');
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

    if (msg.message == '!start' && lobby.countdown == -1) {
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

  await open_new_lobby_if_needed(client, lobby_db, map_db);

  client.on('PM', async (msg) => {
    if (msg.user.isClient() && msg.message == '!makerankedlobby') {
      const channel = await client.createLobby(`RANKED LOBBY | Auto map select`);
      channel.lobby.filters = '';
      await join_lobby(channel.lobby, lobby_db, map_db, client);
      joined_lobbies.push(channel.lobby);
      await lobby_db.run('INSERT INTO ranked_lobby (lobby_id, filters) VALUES (?, "")', channel.lobby.id);
      await channel.sendMessage('!mp mods freemod');
      console.log('Created ranked lobby.');
      await channel.lobby.invitePlayer(msg.user.ircUsername);
    }

    if (msg.message == '!rank') {
      const res = await ranking_db.get('select elo from user where username = ?', user.username);
      const better_users = await ranking_db.get('SELECT COUNT(*) AS nb FROM user WHERE elo > ?', res.elo);
      const all_users = await ranking_db.get('SELECT COUNT(*) AS nb FROM user');
      await msg.user.sendMessage('You are ' + get_rank_text(1.0 - (better_users.nb / all_users.nb)) + '.');
    }
  });
}

export {
  start_ranked,
};
