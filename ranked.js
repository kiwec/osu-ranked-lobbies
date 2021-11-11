import Sentry from '@sentry/node';
import {open} from 'sqlite';
import sqlite3 from 'sqlite3';
import SQL from 'sql-template-strings';
import BanchoLobbyPlayerStates from 'bancho.js/lib/Multiplayer/Enums/BanchoLobbyPlayerStates.js';

import {init_db as init_ranking_db, update_mmr, get_rank_text_from_id} from './elo_mmr.js';
import {load_user_info} from './map_selector.js';
import {
  update_ranked_lobby_on_discord,
  close_ranked_lobby_on_discord,
  update_discord_role,
  get_scoring_preference,
} from './discord_updates.js';


let deadlines = [];
let deadline_id = 0;
let creating_lobby = false;
let ranking_db = null;
let lobby_db = null;
let map_db = null;


function median(numbers) {
  if (numbers.length == 0) return 0;

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

  lobby.nb_players = nb_players;
  return nb_players;
}

async function select_next_map(lobby) {
  const MAP_TYPES = {
    1: 'graveyarded',
    2: 'wip',
    3: 'pending',
    4: 'ranked',
    5: 'approved',
    6: 'qualified',
    7: 'loved',
  };

  lobby.voteskips = [];

  // When the bot restarts, re-add the currently selected map to recent maps
  if (!lobby.recent_maps.includes(lobby.beatmapId)) {
    lobby.recent_maps.push(lobby.beatmapId);
  }

  if (lobby.recent_maps.length >= 25) {
    lobby.recent_maps.shift();
  }

  let meta = null;
  let new_map = null;
  let tries = 0;
  const is_dt = lobby.median_ar >= 10.0;
  do {
    if (is_dt) {
      meta = await map_db.get(SQL`
        SELECT MIN(pp_stars) AS min_stars, MAX(pp_stars) AS max_stars FROM (
          SELECT pp.stars AS pp_stars, (
            ABS(${lobby.median_aim} - dt_aim_pp)
            + ABS(${lobby.median_speed} - dt_speed_pp)
            + ABS(${lobby.median_acc} - dt_acc_pp)
            + 10*ABS(${lobby.median_ar} - pp.ar)
          ) AS match_accuracy FROM map
          INNER JOIN pp ON map.id = pp.map_id
          WHERE mods = 65600 AND length > 60 AND length < 420 AND ranked IN (4, 5, 7) AND match_accuracy IS NOT NULL
          ORDER BY match_accuracy LIMIT 1000
        )`,
      );
      new_map = await map_db.get(SQL`
        SELECT * FROM (
          SELECT *, pp.stars AS pp_stars, (
            ABS(${lobby.median_aim} - dt_aim_pp)
            + ABS(${lobby.median_speed} - dt_speed_pp)
            + ABS(${lobby.median_acc} - dt_acc_pp)
            + 10*ABS(${lobby.median_ar} - pp.ar)
          ) AS match_accuracy FROM map
          INNER JOIN pp ON map.id = pp.map_id
          WHERE mods = 65600 AND length > 60 AND length < 420 AND ranked IN (4, 5, 7) AND match_accuracy IS NOT NULL
          ORDER BY match_accuracy LIMIT 1000
        ) ORDER BY RANDOM() LIMIT 1`,
      );
    } else {
      meta = await map_db.get(SQL`
        SELECT MIN(pp_stars) AS min_stars, MAX(pp_stars) AS max_stars FROM (
          SELECT pp.stars AS pp_stars, (
            ABS(${lobby.median_aim} - aim_pp)
            + ABS(${lobby.median_speed} - speed_pp)
            + ABS(${lobby.median_acc} - acc_pp)
            + 10*ABS(${lobby.median_ar} - pp.ar)
          ) AS match_accuracy FROM map
          INNER JOIN pp ON map.id = pp.map_id
          WHERE mods = (1<<16) AND length > 60 AND length < 420 AND ranked IN (4, 5, 7) AND match_accuracy IS NOT NULL
          ORDER BY match_accuracy LIMIT 1000
        )`,
      );
      new_map = await map_db.get(SQL`
        SELECT * FROM (
          SELECT *, pp.stars AS pp_stars, (
            ABS(${lobby.median_aim} - aim_pp)
            + ABS(${lobby.median_speed} - speed_pp)
            + ABS(${lobby.median_acc} - acc_pp)
            + 10*ABS(${lobby.median_ar} - pp.ar)
          ) AS match_accuracy FROM map
          INNER JOIN pp ON map.id = pp.map_id
          WHERE mods = (1<<16) AND length > 60 AND length < 420 AND ranked IN (4, 5, 7) AND match_accuracy IS NOT NULL
          ORDER BY match_accuracy LIMIT 1000
        ) ORDER BY RANDOM() LIMIT 1`,
      );
    }
    tries++;

    if (!new_map) break;
  } while ((lobby.recent_maps.includes(new_map.id)) && tries < 10);
  if (!new_map) {
    console.error(`[Ranked #${lobby.id}] Could not find new map. Aborting.`);
    console.log(`aim: ${lobby.median_aim} speed: ${lobby.median_speed} acc: ${lobby.median_acc} ar: ${lobby.median_ar}`);
    return;
  }

  lobby.recent_maps.push(new_map.id);

  try {
    const flavor = `${MAP_TYPES[new_map.ranked]} ${new_map.pp_stars.toFixed(2)}*, ${Math.round(new_map.pp)}pp`;
    const map_name = `[https://osu.ppy.sh/beatmapsets/${new_map.set_id}#osu/${new_map.id} ${new_map.name}]`;
    const beatconnect_link = `[https://beatconnect.io/b/${new_map.set_id} [1]]`;
    const chimu_link = `[https://api.chimu.moe/v1/download/${new_map.set_id}?n=1 [2]]`;
    const nerina_link = `[https://nerina.pw/d/${new_map.set_id} [3]]`;
    const sayobot_link = `[https://osu.sayobot.cn/osu.php?s=${new_map.set_id} [4]]`;
    await lobby.channel.sendMessage(`!mp map ${new_map.id} 0 | ${map_name} (${flavor}) Alternate downloads: ${beatconnect_link} ${chimu_link} ${nerina_link} ${sayobot_link}`);

    if (lobby.is_dt != is_dt) {
      if (is_dt) {
        await lobby.channel.sendMessage('!mp mods DT freemod');
      } else {
        await lobby.channel.sendMessage('!mp mods freemod');
      }

      lobby.is_dt = is_dt;
    }

    const player_ids = [];
    for (const slot of lobby.slots) {
      if (slot) {
        player_ids.push(slot.user.id);
      }
    }
    const score_system = await get_scoring_preference(player_ids);
    const score_systems = ['ScoreV1', 'Accuracy', 'Combo', 'ScoreV2'];
    if (lobby.winCondition != score_system) {
      await lobby.channel.sendMessage(`!mp set 0 ${score_system} 16 | Now using ${score_systems[score_system]} as ranking criteria. [https://kiwec.net/discord Join the Discord] to vote for something else!`);
    }

    let title_modifiers = '';
    if (is_dt) title_modifiers += ' DT';
    if (score_system == 3) title_modifiers += ' ScoreV2';
    const new_title = `${meta.min_stars.toFixed(1)}-${meta.max_stars.toFixed(1)}*${title_modifiers} | o!RL | Auto map select (!about)`;

    if (lobby.name != new_title) {
      await lobby.channel.sendMessage(`!mp name ${new_title}`);
      lobby.name = new_title; // not sure bancho emits a roomName event on !mp name?
    }
  } catch (e) {
    console.error(`[Ranked #${lobby.id}] Failed to switch to map ${new_map.id} ${new_map.name}:`, e);
  }

  await update_ranked_lobby_on_discord(lobby);
}

async function open_new_lobby_if_needed(client) {
  if (creating_lobby) return;
  if (client.owned_lobbies.length > 3) return;

  let empty_slots = 0;
  for (const jl of client.owned_lobbies) {
    let nb_players = 0;
    for (const s of jl.slots) {
      if (s) nb_players++;
    }
    empty_slots += 16 - nb_players;
  }

  if (empty_slots == 0) {
    creating_lobby = true;
    const channel = await client.createLobby(`0-11* | o!RL | Auto map select (!about)`);
    await join_lobby(channel.lobby, client, 'kiwec');
    await lobby_db.run(SQL`INSERT INTO ranked_lobby (lobby_id, creator) VALUES (${channel.lobby.id}, 'kiwec')`);
    creating_lobby = false;
    console.log(`[Ranked #${channel.lobby.id}] Created.`);
  }
}


// Updates the lobby's median_pp value. Returns true if map changed.
async function update_median_pp(lobby) {
  const aims = [];
  const accs = [];
  const speeds = [];
  const overalls = [];
  const ars = [];

  for (const player of lobby.slots) {
    if (player != null && player.user.pp) {
      aims.push(player.user.pp.aim);
      accs.push(player.user.pp.acc);
      speeds.push(player.user.pp.speed);
      overalls.push(player.user.pp.overall);
      ars.push(player.user.pp.ar);
    }
  }

  aims.sort((a, b) => a - b);
  accs.sort((a, b) => a - b);
  speeds.sort((a, b) => a - b);
  overalls.sort((a, b) => a - b);
  ars.sort((a, b) => a - b);

  lobby.median_aim = median(aims) * lobby.difficulty_modifier;
  lobby.median_acc = median(accs) * lobby.difficulty_modifier;
  lobby.median_speed = median(speeds) * lobby.difficulty_modifier;
  lobby.median_overall = median(overalls) * lobby.difficulty_modifier;
  lobby.median_ar = median(ars);

  return false;
}

async function join_lobby(lobby, client, creator) {
  lobby.recent_maps = [];
  lobby.votekicks = [];
  lobby.voteskips = [];
  lobby.confirmed_players = [];
  lobby.countdown = -1;
  lobby.median_overall = 0;
  lobby.nb_players = 0;
  lobby.difficulty_modifier = 1.1;
  lobby.last_ready_msg = 0;
  lobby.is_dt = -1;
  lobby.creator = creator;
  await lobby.setPassword('');

  // Fetch user info
  await lobby.updateSettings();
  for (const player of lobby.slots) {
    if (player == null) continue;

    try {
      await player.user.fetchFromAPI();
      await load_user_info(player.user);
    } catch (err) {
      console.error(`[Ranked #${lobby.id}] Failed to fetch user data for '${player.user.ircUsername}'`);
      await lobby.channel.sendMessage(`!mp ban ${player.user.ircUsername}`);
    }
  }
  await update_median_pp(lobby);
  await update_ranked_lobby_on_discord(lobby);

  lobby.channel.on('PART', async (member) => {
    try {
      // Lobby closed (intentionally or not), clean up
      if (member.user.isClient()) {
        if (lobby.creator == 'kiwec') {
          client.owned_lobbies.splice(client.owned_lobbies.indexOf(lobby), 1);
        }
        client.joined_lobbies.splice(client.joined_lobbies.indexOf(lobby), 1);
        await lobby_db.run(SQL`DELETE FROM ranked_lobby WHERE lobby_id = ${lobby.id}`);
        await close_ranked_lobby_on_discord(lobby);
        console.log(`[Ranked #${lobby.id}] Closed.`);

        if (client.owned_lobbies.length == 0) {
          await open_new_lobby_if_needed(client);
        }
      }
    } catch (e) {
      Sentry.captureException(e);
    }
  });

  lobby.on('playerJoined', async (evt) => {
    try {
      console.log(evt.player.user.username + ' JOINED');
      const joined_alone = get_nb_players(lobby) == 1;

      deadlines = deadlines.filter((deadline) => deadline.username != evt.player.user.username);

      const player = await client.getUser(evt.player.user.username);
      try {
        await player.fetchFromAPI();
      } catch (err) {
        console.error(`[Ranked #${lobby.id}] Failed to fetch user data for '${evt.player.user.username}'`);
        await lobby.channel.sendMessage(`!mp ban ${evt.player.user.username}`);
      }

      const user = await lobby_db.get(SQL`SELECT * FROM user WHERE user_id = ${player.id}`);
      if (!user) {
        await lobby_db.run(SQL`
          INSERT INTO user (user_id, username, last_version)
          VALUES (${player.id}, ${player.ircUsername}, 'current commit')`,
        );
      }

      await open_new_lobby_if_needed(client);

      // Warning: load_user_info can be a slow call
      await load_user_info(player);
      await update_median_pp(lobby);
      if (joined_alone) {
        await select_next_map(lobby);
        if (player.games_played == 0) {
          await lobby.channel.sendMessage(`Welcome, ${player.ircUsername}! There is no host: use !start if the players aren't readying up, and !skip if the map is bad. [https://kiwec.net/discord Join the Discord] for more info.`);
        }
      }
      await update_ranked_lobby_on_discord(lobby);
    } catch (e) {
      Sentry.captureException(e);
    }
  });

  lobby.on('playerLeft', async (evt) => {
    try {
      console.log(evt.user.ircUsername + ' LEFT');

      // Remove user's votekicks, and votekicks against the user
      delete lobby.votekicks[evt.user.ircUsername];
      for (const annoyed_players of lobby.votekicks) {
        if (annoyed_players && annoyed_players.includes(evt.user.ircUsername)) {
          annoyed_players.splice(annoyed_players.indexOf(evt.user.ircUsername), 1);
        }
      }

      // Remove user from voteskip list, if they voted to skip
      if (lobby.voteskips.includes(evt.user.ircUsername)) {
        lobby.voteskips.splice(lobby.voteskips.indexOf(evt.user.ircUsername), 1);
      }

      await update_median_pp(lobby);

      get_nb_players(lobby); // update lobby.nb_players
      if (lobby.nb_players == 0) {
        await lobby.channel.sendMessage('!mp name 0-11* | o!RL | Auto map select (!about)');
        lobby.name = '0-11* | o!RL | Auto map select (!about)';
        await update_ranked_lobby_on_discord(lobby);
        return;
      }

      // Check if we should skip
      if (lobby.voteskips.length >= lobby.nb_players / 2) {
        await select_next_map(lobby);
        return;
      }
    } catch (e) {
      Sentry.captureException(e);
    }
  });

  lobby.on('allPlayersReady', async () => {
    try {
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
    } catch (e) {
      Sentry.captureException(e);
    }
  });

  lobby.on('matchStarted', async () => {
    try {
      lobby.voteskips = [];
      lobby.confirmed_players = [];
      for (const slot of lobby.slots) {
        if (slot && slot.state != BanchoLobbyPlayerStates['No Map']) {
          lobby.confirmed_players.push(slot.user);
        }
      }

      if (lobby.countdown != -1) {
        clearTimeout(lobby.countdown);
      }
      lobby.countdown = -1;

      await update_ranked_lobby_on_discord(lobby);
    } catch (e) {
      Sentry.captureException(e);
    }
  });

  lobby.on('matchFinished', async (scores) => {
    try {
      const rank_updates = await update_mmr(lobby);
      await select_next_map(lobby);

      if (rank_updates.length > 0) {
        const strings = [];
        for (const update of rank_updates) {
          await update_discord_role(update.user_id, update.rank_text);

          if (update.rank_before > update.rank_after) {
            strings.push(`${update.username} [https://osu.kiwec.net/u/${update.user_id}/ ▼ ${update.rank_text} ]`);
          } else {
            strings.push(`${update.username} [https://osu.kiwec.net/u/${update.user_id}/ ▲ ${update.rank_text} ]`);
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
    } catch (e) {
      Sentry.captureException(e);
    }
  });

  lobby.channel.on('message', (msg) => on_lobby_msg(lobby, msg).catch(Sentry.captureException));

  client.joined_lobbies.push(lobby);
  if (lobby.creator == 'kiwec') {
    client.owned_lobbies.push(lobby);
  }
  console.log(`Joined ranked lobby #${lobby.id}`);
}

async function on_lobby_msg(lobby, msg) {
  console.log(`[Ranked #${lobby.id}] ${msg.user.ircUsername}: ${msg.message}`);

  // Temporary workaround for bancho.js bug with playerJoined/playerLeft events
  // Mostly copy/pasted from bancho.js itself.
  if (msg.user.ircUsername == 'BanchoBot') {
    const join_regex = /^(.+) joined in slot (\d+)( for team (red|blue))?\.$/;

    if (join_regex.test(msg.message)) {
      const m = join_regex.exec(msg.message);
      const id = deadline_id++;
      deadlines.push({
        id: id,
        username: m[1],
      });
      setTimeout(() => {
        if (deadlines.some((deadline) => deadline.id == id)) {
          console.error('bancho.js didn\'t register ' + m[1] + ' joining, killing process.');
          process.exit();
        }
      }, 30000);
    }

    return;
  }

  if (msg.message == '!about') {
    await lobby.channel.sendMessage('In this lobby, you get a rank based on how well you play compared to other players. All commands and answers to your questions are [https://kiwec.net/discord in the Discord.]');
    return;
  }

  if (msg.message.indexOf('!diff') == 0 && msg.user.isClient()) {
    lobby.difficulty_modifier = parseFloat(msg.message.split(' ')[1]);
    const switched = await update_median_pp(lobby);
    if (!switched) {
      await select_next_map(lobby);
    }
  }

  if (msg.message == '!discord') {
    await lobby.channel.sendMessage('[https://kiwec.net/discord Come hang out in voice chat!] (or just text, no pressure)');
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

    // TODO: check if bad_player is in the room

    if (!lobby.votekicks[bad_player]) {
      lobby.votekicks[bad_player] = [];
    }
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

  if (msg.message == '!rank') {
    const rank_text = await get_rank_text_from_id(msg.user.id);
    if (rank_text == 'Unranked') {
      const res = await ranking_db.get(SQL`
        SELECT games_played FROM user
        WHERE user_id = ${msg.user.id}`,
      );
      await lobby.channel.sendMessage(`${msg.user.ircUsername}: You are unranked. Play ${5 - res.games_played} more games to get a rank!`);
    } else {
      await lobby.channel.sendMessage(`${msg.user.ircUsername}: You are [https://osu.kiwec.net/u/${msg.user.id}/ ${rank_text}].`);
    }
  }

  if (msg.message == '!skip' && !lobby.voteskips.includes(msg.user.ircUsername)) {
    lobby.voteskips.push(msg.user.ircUsername);
    if (lobby.voteskips.length >= get_nb_players(lobby) / 2) {
      await update_median_pp(lobby);
      await select_next_map(lobby);
    } else {
      await lobby.channel.sendMessage(`${lobby.voteskips.length}/${Math.ceil(get_nb_players(lobby) / 2)} players voted to switch to another map.`);
    }
  }

  if (msg.message == '!start' && lobby.countdown == -1 && !lobby.playing) {
    if (get_nb_players(lobby) < 2) {
      await lobby.startMatch();
      return;
    }

    lobby.countdown = setTimeout(async () => {
      if (lobby.playing) {
        lobby.countdown = -1;
        return;
      }

      lobby.countdown = setTimeout(async () => {
        lobby.countdown = -1;
        if (!lobby.playing) {
          await lobby.startMatch();
        }
      }, 10000);
      await lobby.channel.sendMessage('Starting the match in 10 seconds... Ready up to start sooner.');
    }, 20000);
    await lobby.channel.sendMessage('Starting the match in 30 seconds... Ready up to start sooner.');
  }

  if (msg.message == '!wait' && lobby.countdown != -1) {
    clearTimeout(lobby.countdown);
    lobby.countdown = -1;
    await lobby.channel.sendMessage('Match auto-start is cancelled. Type !start to restart it.');
  }
}

async function start_ranked(client, _lobby_db, _map_db) {
  lobby_db = _lobby_db;
  map_db = _map_db;

  client.joined_lobbies = [];
  client.owned_lobbies = [];

  await init_ranking_db();
  ranking_db = await open({
    filename: 'ranks.db',
    driver: sqlite3.cached.Database,
  });

  const lobbies = await lobby_db.all('SELECT * from ranked_lobby');
  for (const lobby of lobbies) {
    try {
      const channel = await client.getChannel('#mp_' + lobby.lobby_id);
      await channel.join();
      await join_lobby(channel.lobby, client, lobby.creator);
    } catch (e) {
      console.error('Failed to rejoin lobby ' + lobby.lobby_id + ':', e);
      await lobby_db.run(SQL`DELETE FROM ranked_lobby WHERE lobby_id = ${lobby.lobby_id}`);
      await close_ranked_lobby_on_discord({id: lobby.lobby_id});
    }
  }

  await open_new_lobby_if_needed(client);

  client.on('PM', async (msg) => {
    try {
      if (msg.message == '!ranked') {
        // 1. Get the list of non-empty, non-full lobbies
        const available_lobbies = [];
        for (const lobby of client.joined_lobbies) {
          const nb_players = get_nb_players(lobby);
          if (nb_players > 0 && nb_players < 16) {
            available_lobbies.push(lobby);
          }
        }

        // How far is the player from the lobby pp level?
        const distance = (player, lobby) => {
          if (!player.pp) return 0;
          return Math.abs(player.pp.aim - lobby.median_aim) + Math.abs(player.pp.acc - lobby.median_acc) + Math.abs(player.pp.speed - lobby.median_speed) + 10.0 * Math.abs(player.pp.ar - lobby.median_ar);
        };

        // 2. Sort by closest pp level
        available_lobbies.sort((a, b) => distance(msg.user, b) - distance(msg.user, a));
        if (available_lobbies.length > 0) {
          await available_lobbies[0].invitePlayer(msg.user.ircUsername);
          return;
        }

        // 3. Unlucky
        await msg.user.sendMessage(`Looks like all o!RL lobbies are full. [https://kiwec.net/discord Join the Discord] to create a new one.`);
      }

      if (msg.message == '!rank') {
        const rank_text = await get_rank_text_from_id(msg.user.id);
        if (rank_text == 'Unranked') {
          const res = await ranking_db.get(SQL`
            SELECT games_played FROM user
            WHERE user_id = ${msg.user.id}`,
          );
          await msg.user.sendMessage(`You are unranked. Play ${5 - res.games_played} more games to get a rank!`);
        } else {
          await msg.user.sendMessage(`You are [https://osu.kiwec.net/u/${msg.user.id}/ ${rank_text}].`);
        }
        return;
      }
    } catch (e) {
      Sentry.captureException(e);
    }
  });
}

export {
  start_ranked,
  join_lobby,
};
