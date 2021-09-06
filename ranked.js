import fs from 'fs';

// fuck you, es6 modules, for making this inconvenient
const CURRENT_VERSION = JSON.parse(fs.readFileSync('./package.json')).version;
const Config = JSON.parse(fs.readFileSync('./config.json'));

import fetch from 'node-fetch';


let oauth_token = null;

// JAVASCRIPT IS SUCH AN ELEGANT LANGUAGE
function fucking_wait(ms) {
  return new Promise((resolve, reject) => {
    setTimeout(resolve, ms);
  })
}
function median(numbers) {
    const sorted = numbers.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
        return (sorted[middle - 1] + sorted[middle]) / 2;
    }

    return sorted[middle];
}

async function osu_fetch(url, options) {
  if (!oauth_token) {
    const res = await fetch('https://osu.ppy.sh/oauth/token', {
      method: 'post',
      body: JSON.stringify({
        client_id: Config.client_id,
        client_secret: Config.client_secret,
        grant_type: 'client_credentials',
        scope: 'public',
      }),
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
    });
    let foo = await res.json();
    oauth_token = foo.access_token;
  }

  if (!options.headers) {
    options.headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };
  }

  options.headers['Authorization'] = 'Bearer ' + oauth_token;

  const res = await fetch(url, options);
  if (res.status == 401) {
    console.log('OAuth token expired, fetching a new one...');
    oauth_token = null;
    await fucking_wait(1000);
    return await osu_fetch(url, options);
  } else {
    return res;
  }
}

async function select_next_map(lobby, map_db, lobby_db) {
  // When the bot restarts, re-add the currently selected map to recent maps
  if (!lobby.recent_maps.includes(lobby.beatmapId)) {
    lobby.recent_maps.push(lobby.beatmapId);
  }

  if (lobby.recent_maps.length >= 25) {
    lobby.recent_maps.shift();
  }

  const user_ids = [];
  for (const player of lobby.slots) {
    if (!player) continue;
    user_ids.push(player.user.id);
  }

  if (user_ids.length == 0) {
    console.error(`[Ranked lobby ${lobby.id}] No users in the lobby, cannot select map. Aborting.`);
    return;
  }

  let new_map = null;
  try {
    const res = await lobby_db.get('SELECT AVG(avg_pp) AS avg_pp FROM user WHERE user_id IN (' + user_ids.join(', ') + ') AND avg_pp > 0');
    const pp = res.avg_pp;
    let pp_variance = res.avg_pp / 20;

    let tries = 0;
    do {
      new_map = await map_db.get(
          `SELECT * FROM pp
        INNER JOIN map ON map.id = pp.map_id
        WHERE mods = (1<<15) AND pp < ? AND pp > ? AND length < 200
        ORDER BY RANDOM() LIMIT 1`,
          pp + pp_variance,
          pp - pp_variance,
      );
      if (!new_map) {
        pp_variance *= 10;
      }

      tries++;
    } while ((!new_map || lobby.recent_maps.includes(new_map.id)) && tries < 10);
  } catch (e) {
    console.error(`[Ranked lobby ${lobby.id}] Failed to select a map:`, e);
  }

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

function get_rank_text(rank_float) {
  if (rank_float == 1.0) {
    return 'The One';
  }

  // Epic rank distribution algorithm
  const ranks = [
    'Cardboard', 
    'Copper I', 'Copper II', 'Copper III', 'Copper IV', 
    'Bronze I', 'Bronze II', 'Bronze III', 'Bronze IV', 
    'Silver I', 'Silver II', 'Silver III', 'Silver IV', 
    'Gold I', 'Gold II', 'Gold III', 'Gold IV', 
    'Platinum I', 'Platinum II', 'Platinum III', 'Platinum IV', 
    'Diamond I', 'Diamond II', 'Diamond III', 'Diamond IV', 
    'Legendary'
  ];
  for (let i in ranks) {
    if (!ranks.hasOwnProperty(i)) continue;

    i = parseInt(i, 10); // FUCK YOU FUCK YOU FUCK YOU FUCK YOU

    // Turn current 'Cardboard' rank into a value between 0 and 1
    const rank_nb = (i + 1) / ranks.length;

    // This turns a linear curve into a smoother curve (yeah I'm not good at maths)
    // Visual representation: https://www.wolframalpha.com/input/?i=1+-+%28%28cos%28x+*+PI%29+%2F+2%29+%2B+0.5%29+with+x+from+0+to+1
    const cutoff = 1 - ((Math.cos(rank_nb * Math.PI) / 2) + 0.5);
    if (rank_float < cutoff) {
      return ranks[i];
    }
  }

  // Ok, floating point errors, who cares
  return 'Super Legendary';
}

async function recalculate_user_rank(user_id, lobby_db) {
  const scores = await lobby_db.all('SELECT * FROM ranked_score WHERE user_id = ? ORDER BY tms DESC LIMIT 100', user_id);

  let total_weight = 0.0;
  let total_pp = 0.0;
  let current_weight = 1.0;
  for (const score of scores) {
    total_pp += score.pp * current_weight * score.weight;
    total_weight += current_weight * score.weight;
    current_weight *= 0.95;
  }

  // No division by 0 here
  if (total_weight == 0.0) total_weight = 1.0;
  const avg_pp = total_pp / total_weight;

  const better_users = await lobby_db.get('SELECT COUNT(*) AS nb FROM user WHERE avg_pp > ?', avg_pp);
  const all_users = await lobby_db.get('SELECT COUNT(*) AS nb FROM user');

  const rank_float = 1.0 - (better_users.nb / all_users.nb);
  const rank_text = get_rank_text(rank_float);
  await lobby_db.run('UPDATE user SET avg_pp = ?, rank = ? WHERE user_id = ?', avg_pp, rank_text, user_id);

  return {avg_pp, rank_text};
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

    const rank_updates = [];
    const lobby_results = [];
    let lobby_pp = [];
    const beatmap_id = lobby.recent_maps[lobby.recent_maps.length - 1];

    for (const slot of lobby.slots) {
      if (slot == null) continue;

      const res = await osu_fetch(
          `https://osu.ppy.sh/api/v2/users/${slot.user.id}/scores/recent?key=id&mode=osu&limit=1&include_fails=1`,
          {method: 'get'},
      );
      const scores = await res.json();
      for (const score of scores) {
        if(score.beatmap.id != lobby.beatmapId) {
          console.error(`Score fail: beatmap id ${score.beatmap.id} != ${lobby.beatmapId} for ${slot.user.ircUsername}`);
          continue;
        }

        lobby_results.push({
          user_id: slot.user.id,
          score_id: score.id,
          tms: Date.parse(score.created_at),
          pp: score.pp || 0
        });
        lobby_pp.push(score.pp);
      }
    }

    let res = await map_db.get('select pp from pp where map_id = ? and mods = (1<<15)', lobby.beatmapId);
    let empty_lobby_expected_pp = res.pp;
    let full_lobby_expected_pp = median(lobby_pp);
    let lobby_fullness = lobby_results.length / 16;

    // When the lobby is full, expected pp is based on player results
    // When the lobby is empty, expected pp is based on the map
    let expected_pp = full_lobby_expected_pp * lobby_fullness + empty_lobby_expected_pp * (1.0 - lobby_fullness);
    console.log('Expected pp:', expected_pp);

    for(let result of lobby_results) {
      // The farther you are from expected pp, the more the score weighs
      // If you think I'm stupid and bad at math, I am. Please send a patch.
      let weight = 1.0;
      if(result.pp > expected_pp) {
        weight = 1.0 - expected_pp / result.pp;
      } else if(result.pp < expected_pp) {
        weight = 1.0 - result.pp / expected_pp;
      } 
      console.log('Weight for user', result.user_id, ':', weight, '(with', result.pp, 'pp)');

      await lobby_db.run(
          'INSERT OR IGNORE INTO ranked_score (id, user_id, map_id, tms, pp, weight) VALUES (?, ?, ?, ?, ?, ?)',
          result.score_id, result.user_id, lobby.beatmapId, result.tms, result.pp, weight
      );
      const foo = await lobby_db.get('SELECT rank, username FROM user WHERE user_id = ?', result.user_id);
      const {rank_text} = await recalculate_user_rank(result.user_id, lobby_db);
      if (rank_text != foo.rank) {
        rank_updates[foo.username] = rank_text;
      }
    }

    await select_next_map(lobby, map_db, lobby_db);

    if (rank_updates.length > 0) {
      let outstr = 'Rank updates: ';

      let i = 0;
      for (const username in rank_updates) {
        if (!ranks.hasOwnProperty(i)) continue;

        if (i == 0) {
          outstr += username + ' is now ' + rank_updates[username];
        } else if (i == rank_updates.length - 1) {
          outstr += ' and ' + username + ' is now ' + rank_updates[username];
        } else {
          outstr += ', ' + username + ' is now ' + rank_updates[username];
        }

        i++;
      }

      outstr += '.';
      await lobby.channel.sendMessage(outstr);
    }
  });

  lobby.on('playerJoined', async (obj) => {
    await obj.player.user.fetchFromAPI();
    let user = await lobby_db.get('select * from user where username = ?', obj.player.user.ircUsername);
    if (!user) {
      await lobby.channel.sendMessage(`Welcome, ${obj.player.user.ircUsername}! This is a ranked lobby, play one game to find out what your rank is :)`);

      // Sneakily fetch their scores in advance
      await lobby_db.run(
          'INSERT INTO user (user_id, username, avg_pp, rank, last_version) VALUES (?, ?, ?, ?, ?)',
          obj.player.user.id, obj.player.user.username, 0.0, 'Unranked', CURRENT_VERSION,
      );
      user = await lobby_db.get('SELECT * FROM user WHERE user_id = ?', obj.player.user.id);

      const res = await osu_fetch(
          `https://osu.ppy.sh/api/v2/users/${obj.player.user.id}/scores/best?key=id&mode=osu&limit=100&include_fails=0`,
          {method: 'get'},
      );
      const recent_scores = await res.json();
      for (const score of recent_scores) {
        if (!score.pp) continue;
        await lobby_db.run(
            'INSERT OR IGNORE INTO ranked_score (id, user_id, map_id, tms, pp, weight) VALUES (?, ?, ?, ?, ?, 0.1)',
            score.id, obj.player.user.id, score.beatmap.id, Date.parse(score.created_at), score.pp,
        );
      }
    }

    if (get_nb_players() == 1) {
      // Edge case: if the player is alone in the lobby, we need them to have
      // a rank for the map selection to work.
      if (user.avg_pp == 0) {
        const {rank_text} = await recalculate_user_rank(obj.player.user.id, lobby_db);
        await lobby.channel.sendMessage(`Okay, since I need to select a map I made you ${rank_text}. Hope it's not too far off :p`);
      }

      await select_next_map(lobby, map_db, lobby_db);
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

    if (msg.message == '!skip' && !lobby.voteskips.includes(msg.user.ircUsername)) {
      lobby.voteskips.push(msg.user.ircUsername);
      if (lobby.voteskips.length >= get_nb_players() / 2) {
        lobby.voteskips = [];
        await select_next_map(lobby, map_db, lobby_db);
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
  const joined_lobbies = [];

  const lobbies = await lobby_db.all('SELECT * from ranked_lobby');
  for (const lobby of lobbies) {
    try {
      const channel = await client.getChannel('#mp_' + lobby.lobby_id);
      await channel.join();
      await join_lobby(channel.lobby, lobby_db, map_db, client);
      joined_lobbies.push(channel.lobby);
    } catch (e) {
      console.error('Could not rejoin lobby ' + lobby.lobby_id + ':', e);
      await lobby_db.run(`DELETE FROM ranked_lobby WHERE lobby_id = ?`, lobby.lobby_id);
    }
  }

  if (joined_lobbies.length == 0) {
    const channel = await client.createLobby(`RANKED LOBBY - automatic map selection`);
    await join_lobby(channel.lobby, lobby_db, map_db, client);
    joined_lobbies.push(channel.lobby);
    console.log('Created ranked lobby.');
  }

  // TODO: automatically create/close lobbies on demand
}

export {
  recalculate_user_rank,
  start_ranked,
};
