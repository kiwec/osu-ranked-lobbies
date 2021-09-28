import fs from 'fs';
import {init_db as init_ranking_db, update_mmr, get_rank_text} from './elo_mmr.js';
import {update_lobby_filters} from './casual.js';

// "ranked" column values
// 1 = ranked but without ranked symbol?
// 2 = graveyard
// 3 = deleted?
// 4 = ranked
// 5 = approved
// 6 = approved symbol but in graveyard?
// 7 = loved


// fuck you, es6 modules, for making this inconvenient
const CURRENT_VERSION = JSON.parse(fs.readFileSync('./package.json')).version;

let ranking_db = null;
const joined_lobbies = [];


function median(numbers) {
  const middle = Math.floor(numbers.length / 2);
  if (numbers.length % 2 === 0) {
    return (numbers[middle - 1] + numbers[middle]) / 2;
  }
  return numbers[middle];
}

function get_nb_players(lobby) {
  let nb_players = 0;
  for (const player of lobby.slots) {
    if (player != null) nb_players++;
  }

  return nb_players;
}

async function select_next_map(lobby, map_db) {
  lobby.voteskips = [];

  // When the bot restarts, re-add the currently selected map to recent maps
  if (!lobby.recent_maps.includes(lobby.beatmapId)) {
    lobby.recent_maps.push(lobby.beatmapId);
  }

  if (lobby.recent_maps.length >= 25) {
    lobby.recent_maps.shift();
  }

  let pp_variance = lobby.median_pp / 20;
  let new_map = null;
  const filters = lobby.filters || 'from pp inner join map on map.id = pp.map_id where mods = (1<<16) AND length < 240';
  let tries = 0;
  do {
    new_map = await map_db.get(
        `SELECT * ${filters} AND pp < ? AND pp > ? AND ranked NOT IN (2, 3)
      ORDER BY RANDOM() LIMIT 1`,
        lobby.median_pp + pp_variance, lobby.median_pp - pp_variance,
    );
    if (!new_map) {
      pp_variance *= 2;
    }

    tries++;
  } while ((!new_map || lobby.recent_maps.includes(new_map.id)) && tries < 10);

  if (!new_map) {
    console.error(`[Ranked lobby #${lobby.id}] Could not find new map. Aborting.`);
    return;
  }

  lobby.recent_maps.push(new_map.id);

  try {
    const flavor = `${new_map.stars.toFixed(2)}*, ${Math.floor(new_map.pp)}pp`;
    const map_name = `[https://osu.ppy.sh/beatmapsets/${new_map.set_id}#osu/${new_map.id} ${new_map.name}]`;
    const download_link = `[https://api.chimu.moe/v1/download/${new_map.set_id}?n=1&r=${lobby.randomString()} Direct download]`;
    await lobby.channel.sendMessage(`!mp map ${new_map.id} 0 | ${map_name} (${flavor}) ${download_link}`);
  } catch (e) {
    console.error(`[Ranked lobby #${lobby.id}] Failed to switch to map ${new_map.id} ${new_map.file}:`, e);
  }
}

async function open_new_lobby_if_needed(client, lobby_db, map_db) {
  let empty_slots = 0;
  for (const jl of joined_lobbies) {
    let nb_players = 0;
    for (const s of jl.slots) {
      if (s) nb_players++;
    }
    empty_slots += 16 - nb_players;
  }

  if (empty_slots == 0) {
    // Feel free to suggest more. lol
    const clickbaits = ['(0-∞*)', '(1-11*)', '(real)', '(NOT SUS)', '(pog)', '(uwu)', '(owo)', '(ADSADSAFDDFSFDASD)'];
    const clickbait = clickbaits[Math.floor(Math.random()*clickbaits.length)];
    const channel = await client.createLobby(`RANKED LOBBY | Auto map select ${clickbait}`);
    channel.lobby.filters = '';
    await join_lobby(channel.lobby, lobby_db, map_db, client);
    await lobby_db.run('INSERT INTO ranked_lobby (lobby_id, filters) VALUES (?, "")', channel.lobby.id);
    await channel.sendMessage('!mp mods freemod');
    console.log(`[Ranked lobby #${channel.lobby.id}] Created.`);
  }
}

async function join_lobby(lobby, lobby_db, map_db, client) {
  const PP_GUESSTIMATING_CONSTANT = 1700;

  lobby.recent_maps = [];
  lobby.votekicks = [];
  lobby.voteskips = [];
  lobby.countdown = -1;
  lobby.median_pp = 190.0;
  lobby.last_ready_msg = 0;
  await lobby.setPassword('');

  // Updates the lobby's median_pp value. Returns true if map changed.
  const update_median_pp = async () => {
    let player_pps = [];
    for (const player of lobby.slots) {
      if (player != null && player.user.avg_pp) {
        player_pps.push(player.user.avg_pp);
      }
    }

    // Can't just .sort() because js is stupid
    player_pps = player_pps.sort((a, b) => Math.round(a) - Math.round(b));
    if (player_pps.length == 0) {
      // Lobby is empty, but we still want a median pp.
      player_pps.push(190.0);
    }

    const old_median_pp = lobby.median_pp;
    lobby.median_pp = median(player_pps);

    // If median pp changed by more than 50%, update map
    // (disabled because of a case where user's pp would be 0 on rejoining)
    //
    // if (Math.abs(old_median_pp - lobby.median_pp) > 0.5 * Math.max(old_median_pp, lobby.median_pp)) {
    //   await select_next_map(lobby, map_db);
    //   return true;
    // }

    return false;
  };

  // Fetch user info
  await lobby.updateSettings();
  for (const player of lobby.slots) {
    if (player == null) continue;

    await player.user.fetchFromAPI();

    // EXTREMELY ACCURATE PP GUESSTIMATING
    player.user.avg_pp = (player.user.ppRaw * player.user.accuracy) / PP_GUESSTIMATING_CONSTANT;
    console.log(`[Ranked lobby #${lobby.id}] Player '${player.user.ircUsername} should enjoy ${player.user.avg_pp}pp maps'`);
  }
  await update_median_pp();

  lobby.channel.on('PART', async (member) => {
    // Lobby closed (intentionally or not), clean up
    if (member.user.isClient()) {
      joined_lobbies.splice(joined_lobbies.indexOf(lobby), 1);
      await lobby_db.run(`DELETE FROM ranked_lobby WHERE lobby_id = ?`, lobby.id);
      console.log(`[Ranked lobby #${lobby.id}] Closed.`);

      await open_new_lobby_if_needed(client, lobby_db, map_db);
    }
  });

  lobby.on('allPlayersReady', async () => {
    if (get_nb_players(lobby) < 2) {
      if (lobby.last_ready_msg && lobby.last_ready_msg + 10 > Date.now()) {
        // We already sent that message recently. Don't send it again, since
        // people can spam the Ready button and we don't want to spam that
        // error message ourselves.
        return;
      }

      await lobby.channel.sendMessage('With less than 2 players in the lobby, your rank will not change. Type !start to start anyway.');
      lobby.last_ready_msg = Date.now();
      return;
    }

    await lobby.startMatch();
  });

  lobby.on('matchStarted', () => {
    lobby.voteskips = [];

    if (lobby.countdown != -1) {
      clearTimeout(lobby.countdown);
    }
    lobby.countdown = -1;
  });

  lobby.on('matchFinished', async (scores) => {
    const rank_updates = await update_mmr(ranking_db, lobby);
    await select_next_map(lobby, map_db);

    if (rank_updates.length > 0) {
      const strings = [];
      for (const update of rank_updates) {
        if (update.rank_before > update.rank_after) {
          strings.push(update.username + ' [https://osu.kiwec.net/u/' + update.user_id + '/ ▼' + get_rank_text(update.rank_after) + ' ]');
        } else {
          strings.push(update.username + ' [https://osu.kiwec.net/u/' + update.user_id + '/ ▲' + get_rank_text(update.rank_after) + ' ]');
        }
      }

      // Max 8 rank updates per message - or else it starts getting truncated
      const MAX_UPDATES_PER_MSG = 6;
      for (let i = 0, j = strings.length; i < j; i += MAX_UPDATES_PER_MSG) {
        const updates = strings.slice(i, i + MAX_UPDATES_PER_MSG);

        if (i == 0) {
          await lobby.channel.sendMessage('Rank updates: ' + updates.join(' | '));
        } else {
          await lobby.channel.sendMessage(updates.join(' | '));
        }
      }
    }
  });

  lobby.on('playerJoined', async (obj) => {
    lobby.votekicks[obj.player.user.username] = [];
    await obj.player.user.fetchFromAPI();

    // EXTREMELY ACCURATE PP GUESSTIMATING
    obj.player.user.avg_pp = (obj.player.user.ppRaw * obj.player.user.accuracy) / PP_GUESSTIMATING_CONSTANT;

    const user = await lobby_db.get('select * from user where user_id = ?', obj.player.user.id);
    if (!user) {
      const username = obj.player.user.username;
      await lobby_db.run(
          'INSERT INTO user (user_id, username, last_version) VALUES (?, ?, ?)',
          obj.player.user.id, username, CURRENT_VERSION,
      );

      // For some reason, a lot of players join the lobby and then
      // leave *immediately*. So, wait a bit before sending the welcome
      // message - or else they'll be confused a minute later as to which
      // lobby they received this from.
      setTimeout(async () => {
        for (const slot of lobby.slots) {
          if (slot == null) continue;
          if (slot.user.ircUsername == username) {
            await slot.user.sendMessage(`Welcome to your first ranked lobby, ${username}! There is no host: use !start if players aren't readying up, and !skip if the map is bad. [https://kiwec.net/discord Join the Discord] for more info.`);
            return;
          }
        }
      }, 5000);
    }

    if (get_nb_players(lobby) == 1) {
      await select_next_map(lobby, map_db);
    }

    await open_new_lobby_if_needed(client, lobby_db, map_db);
    await update_median_pp();
  });

  lobby.on('playerLeft', async (obj) => {
    // Remove user's votekicks, and votekicks against the user
    delete lobby.votekicks[obj.user.ircUsername];
    for (const annoyed_players of lobby.votekicks) {
      if (annoyed_players && annoyed_players.includes(obj.user.ircUsername)) {
        annoyed_players.splice(annoyed_players.indexOf(obj.user.ircUsername), 1);
      }
    }

    // Remove user from voteskip list, if they voted to skip
    if (lobby.voteskips.includes(obj.user.ircUsername)) {
      lobby.voteskips.splice(lobby.voteskips.indexOf(obj.user.ircUsername), 1);
    }

    if (await update_median_pp()) {
      return;
    }

    // Check if we should skip
    const nb_players = get_nb_players(lobby);
    if (lobby.voteskips.length >= nb_players / 2) {
      await select_next_map(lobby, map_db);
      return;
    }
  });

  lobby.channel.on('message', async (msg) => {
    console.log(`[Ranked lobby #${lobby.id}] ${msg.user.ircUsername}: ${msg.message}`);

    if (msg.message == '!discord') {
      await lobby.channel.sendMessage('https://kiwec.net/discord');
      return;
    }

    if (msg.message == '!help' || msg.message == '!commands') {
      await lobby.channel.sendMessage('All bot commands and answers to your questions are [https://kiwec.net/discord in the Discord.]');
      return;
    }

    if (msg.message.indexOf('!kick') == 0) {
      const args = msg.message.split(' ');
      if (args.length < 2) {
        await lobby.channel.sendMessage(msg.user.ircUsername + ': You need to specify which player to kick.');
        return;
      }
      args.shift(); // remove '!kick'
      const bad_player = args.join(' ');

      if (!lobby.votekicks[bad_player].includes(msg.user.ircUsername)) {
        lobby.votekicks[bad_player].push(msg.user.ircUsername);

        const nb_voted_to_kick = lobby.votekicks[bad_player].length;
        const nb_required_to_kick = Math.ceil(get_nb_players(lobby) / 2);
        if (nb_required_to_kick == 1) nb_required_to_kick = 2; // don't allow a player to hog the lobby

        if (nb_voted_to_kick >= nb_required_to_kick) {
          // I wonder what happens if people kick the bot?
          await lobby.kickPlayer(bad_player);
        } else {
          await lobby.channel.sendMessage(`${msg.user.ircUsername} voted to kick ${bad_player}. ${nb_voted_to_kick}/${nb_required_to_kick} votes needed.`);
        }
      }
    }

    if (msg.message.indexOf('!setfilter') == 0) {
      if (!msg.user.isClient()) {
        await lobby.channel.sendMessage(msg.user.ircUsername + ': That command only works in unranked lobbies.');
        return;
      }

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
      if (!res || !res.elo) {
        await lobby.channel.sendMessage(msg.user.ircUsername + ': You are Unranked.');
        return;
      }

      const better_users = await ranking_db.get('SELECT COUNT(*) AS nb FROM user WHERE elo > ?', res.elo);
      const all_users = await ranking_db.get('SELECT COUNT(*) AS nb FROM user');
      await lobby.channel.sendMessage(msg.user.ircUsername + ': You are [https://osu.kiwec.net/u/' + msg.user.id + '/ ' + get_rank_text(1.0 - (better_users.nb / all_users.nb)) + ' ].');
    }

    if (msg.message == '!skip' && !lobby.voteskips.includes(msg.user.ircUsername)) {
      lobby.voteskips.push(msg.user.ircUsername);
      if (lobby.voteskips.length >= get_nb_players(lobby) / 2) {
        await select_next_map(lobby, map_db);
      } else {
        await lobby.channel.sendMessage(`${lobby.voteskips.length}/${Math.ceil(get_nb_players(lobby) / 2)} players voted to switch to another map.`);
      }
    }

    if (msg.message == '!start' && lobby.countdown == -1) {
      if (get_nb_players(lobby) < 2) {
        await lobby.startMatch();
        return;
      }

      lobby.countdown = setTimeout(async () => {
        lobby.countdown = setTimeout(async () => {
          lobby.countdown = -1;
          await lobby.startMatch();
        }, 10000);
        await lobby.channel.sendMessage('Starting the match in 10 seconds... Ready up to start sooner.');
      }, 20000);
      await lobby.channel.sendMessage('Starting the match in 30 seconds... Ready up to start sooner.');
    }
  });

  joined_lobbies.push(lobby);
  console.log(`Joined ranked lobby #${lobby.id} - ${lobby.median_pp.toFixed(2)} median pp`);
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
      await lobby_db.run('INSERT INTO ranked_lobby (lobby_id, filters) VALUES (?, "")', channel.lobby.id);
      await channel.sendMessage('!mp mods freemod');
      await channel.lobby.invitePlayer(msg.user.ircUsername);
    }

    if (msg.message == '!ranked') {
      // 1. Get the list of non-empty, non-full lobbies
      const available_lobbies = [];
      for (const lobby of joined_lobbies) {
        const nb_players = get_nb_players(lobby);
        if (nb_players > 0 && nb_players < 16) {
          available_lobbies.push(lobby);
        }
      }

      // 2. Sort by closest pp level
      available_lobbies.sort((a, b) => Math.abs(msg.user.avg_pp - a.median_pp) - Math.abs(msg.user.avg_pp - b.median_pp));
      if (available_lobbies.length > 0) {
        await available_lobbies[0].invitePlayer(msg.user.ircUsername);
        return;
      }

      // 3. Fine, send them an empty lobby
      await open_new_lobby_if_needed(client, lobby_db, map_db);
      for (const lobby of joined_lobbies) {
        const nb_players = get_nb_players(lobby);
        if (nb_players < 16) {
          await lobby.invitePlayer(msg.user.ircUsername);
          return;
        }
      }
    }

    if (msg.message == '!rank') {
      const res = await ranking_db.get('select elo from user where username = ?', msg.user.ircUsername);
      if (!res || !res.elo) {
        await msg.user.sendMessage('You are Unranked.');
        return;
      }

      const better_users = await ranking_db.get('SELECT COUNT(*) AS nb FROM user WHERE elo > ?', res.elo);
      const all_users = await ranking_db.get('SELECT COUNT(*) AS nb FROM user');
      await msg.user.sendMessage('You are [https://osu.kiwec.net/u/' + msg.user.id + '/ ' + get_rank_text(1.0 - (better_users.nb / all_users.nb)) + ' ].');
    }
  });
}

export {
  start_ranked,
};
