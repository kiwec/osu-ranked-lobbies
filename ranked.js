import fs from 'fs';

// fuck you, es6 modules, for making this inconvenient
const CURRENT_VERSION = JSON.parse(fs.readFileSync('./package.json')).version;
const Config = JSON.parse(fs.readFileSync('./config.json'));


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
    if(player && player.user.avg_pp) {
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
    for (const player of lobby.slots) {
      if (!player) continue;
      // TODO: compare player scores
    }

    for(let result of lobby_results) {
      const foo = await lobby_db.get('SELECT rank, username FROM user WHERE user_id = ?', result.user_id);
      // TODO: recalculate user ranks using glicko-2
      const {rank_text} = await recalculate_user_rank(result.user_id, lobby_db);
      if (rank_text != foo.rank) {
        rank_updates[foo.username] = rank_text;
      }
    }

    await select_next_map(lobby, map_db);

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

    // EXTREMELY ACCURATE PP GUESSTIMATING
    obj.player.user.avg_pp = (obj.player.user.ppRaw * obj.player.user.accuracy) / 3000;

    let user = await lobby_db.get('select * from user where user_id = ?', obj.player.user.id);
    if (!user) {
      await lobby.channel.sendMessage(`Welcome, ${obj.player.user.ircUsername}! This is a ranked lobby, play one game to find out what your rank is :)`);
      await lobby_db.run(
          'INSERT INTO user (user_id, username, rank, last_version) VALUES (?, ?, ?, ?, ?)',
          obj.player.user.id, obj.player.user.username, 'Unranked', CURRENT_VERSION,
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
        let lobby_info = {};
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
    const channel = await client.createLobby(`RANKED LOBBY - automatic map selection`);
    channel.lobby.filters = '';
    await join_lobby(channel.lobby, lobby_db, map_db, client);
    joined_lobbies.push(channel.lobby);
    await lobby_db.run('INSERT INTO ranked_lobby (lobby_id, filters) VALUES (?, "")', channel.lobby.id);
    console.log('Created ranked lobby.');
  }

  client.on('PM', async (msg) => {
    if(msg.user.isClient() && msg.message == '!makerankedlobby') {
      const channel = await client.createLobby(`RANKED LOBBY - automatic map selection`);
      channel.lobby.filters = '';
      await join_lobby(channel.lobby, lobby_db, map_db, client);
      joined_lobbies.push(channel.lobby);
      await lobby_db.run('INSERT INTO ranked_lobby (lobby_id, filters) VALUES (?, "")', channel.lobby.id);
      console.log('Created ranked lobby.');
      await channel.lobby.invitePlayer(msg.user.ircUsername);
    }
  })

  // TODO: automatically create/close lobbies on demand
}

export {
  start_ranked,
};
