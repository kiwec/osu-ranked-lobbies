import Sentry from '@sentry/node';
import {open} from 'sqlite';
import sqlite3 from 'sqlite3';
import SQL from 'sql-template-strings';
import BanchoLobbyPlayerStates from 'bancho.js/lib/Multiplayer/Enums/BanchoLobbyPlayerStates.js';

import {init_db as init_ranking_db, update_mmr, get_rank_text_from_id} from './elo_mmr.js';
import {load_user_info} from './profile_scanner.js';
import {
  update_ranked_lobby_on_discord,
  close_ranked_lobby_on_discord,
} from './discord_updates.js';

import {capture_sentry_exception} from './util/helpers.js';
import Config from './util/config.js';

let deadlines = [];
let leave_deadlines = [];
let deadline_id = 0;
let ranking_db = null;
let map_db = null;
const DIFFICULTY_MODIFIER = 1.1;
const DT_DIFFICULTY_MODIFIER = 0.7;

function set_sentry_context(lobby, current_task) {
  if (Config.ENABLE_SENTRY) {
    Sentry.setContext('lobby', {
      id: lobby.id,
      median_pp: lobby.median_overall,
      nb_players: lobby.nb_players,
      creator: lobby.creator,
      creator_discord_id: lobby.creator_discord_id,
      min_stars: lobby.min_stars,
      max_stars: lobby.max_stars,
      task: current_task,
    });
  }
}

async function set_new_title(lobby) {
  let title_modifiers = '';
  if (lobby.is_dt) title_modifiers += ' DT';
  if (lobby.is_scorev2) title_modifiers += ' ScoreV2';

  // Min stars: we prefer not displaying the decimals whenever possible
  let fancy_min_stars;
  if (Math.abs(lobby.min_stars - Math.round(lobby.min_stars)) <= 0.1) {
    fancy_min_stars = lobby.min_stars.toFixed(0);
  } else {
    fancy_min_stars = lobby.min_stars.toFixed(1);
  }

  // Max stars: we prefer displaying .99 whenever possible
  let fancy_max_stars;
  if (Math.abs(lobby.max_stars - Math.round(lobby.max_stars)) <= 0.1) {
    fancy_max_stars = (Math.round(lobby.max_stars) - 0.01).toFixed(2);
  } else {
    fancy_max_stars = lobby.max_stars.toFixed(1);
  }

  const new_title = `${fancy_min_stars}-${fancy_max_stars}*${title_modifiers} | o!RL | Auto map select (!about)`;
  if (lobby.name != new_title) {
    await lobby.channel.sendMessage(`!mp name ${new_title}`);
    lobby.name = new_title;
    await update_ranked_lobby_on_discord(lobby);
  }
}

async function get_matching_lobby_for_user(client, user) {
  // 1. Get the list of lobbies that the player can join
  const available_lobbies = [];
  for (const lobby of client.joined_lobbies) {
    if (user.pp.sr * DIFFICULTY_MODIFIER < lobby.min_stars) continue;
    if (user.pp.sr * DIFFICULTY_MODIFIER > lobby.max_stars) continue;

    const nb_players = get_nb_players(lobby);
    if (nb_players > 0 && nb_players < parseInt(lobby.size, 10)) {
      available_lobbies.push(lobby);
    }
  }

  // How far is the player from the lobby pp level?
  const distance = (player, lobby) => {
    if (!player.pp) return 0;
    return Math.abs(player.pp.aim - lobby.median_aim) + Math.abs(player.pp.acc - lobby.median_acc) + Math.abs(player.pp.speed - lobby.median_speed) + 10.0 * Math.abs(player.pp.ar - lobby.median_ar);
  };

  // 2. Sort by closest pp level
  available_lobbies.sort((a, b) => distance(user, b) - distance(user, a));
  if (available_lobbies.length > 0) {
    return available_lobbies[0];
  }

  // 3. Unlucky.
  return null;
}

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
  clearTimeout(lobby.countdown);
  lobby.countdown = -1;

  // When the bot restarts, re-add the currently selected map to recent maps
  if (!lobby.recent_maps.includes(lobby.beatmapId)) {
    lobby.recent_maps.push(lobby.beatmapId);
  }

  if (lobby.recent_maps.length >= 25) {
    lobby.recent_maps.shift();
  }

  let new_map = null;
  let tries = 0;

  // If we have a variable star range, get it from the current lobby pp
  if (!lobby.fixed_star_range) {
    let meta = null;

    if (lobby.is_dt) {
      meta = await map_db.get(SQL`
        SELECT MIN(pp_stars) AS min_stars, MAX(pp_stars) AS max_stars FROM (
          SELECT pp.stars AS pp_stars, (
            ABS(${lobby.median_aim * DT_DIFFICULTY_MODIFIER} - dt_aim_pp)
            + ABS(${lobby.median_speed * DT_DIFFICULTY_MODIFIER} - dt_speed_pp)
            + ABS(${lobby.median_acc * DT_DIFFICULTY_MODIFIER} - dt_acc_pp)
            + 10*ABS(${lobby.median_ar} - pp.ar)
          ) AS match_accuracy FROM map
          INNER JOIN pp ON map.id = pp.map_id
          WHERE mods = 65600 AND length > 60 AND ranked IN (4, 5, 7) AND match_accuracy IS NOT NULL
          ORDER BY match_accuracy LIMIT 1000
        )`,
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
          WHERE mods = (1<<16) AND length > 60 AND ranked IN (4, 5, 7) AND match_accuracy IS NOT NULL
          ORDER BY match_accuracy LIMIT 1000
        )`,
      );
    }

    lobby.min_stars = meta.min_stars;
    lobby.max_stars = meta.max_stars;
  }

  do {
    if (lobby.is_dt) {
      new_map = await map_db.get(SQL`
        SELECT * FROM (
          SELECT *, pp.stars AS pp_stars, (
            ABS(${lobby.median_aim * DT_DIFFICULTY_MODIFIER} - dt_aim_pp)
            + ABS(${lobby.median_speed * DT_DIFFICULTY_MODIFIER} - dt_speed_pp)
            + ABS(${lobby.median_acc * DT_DIFFICULTY_MODIFIER} - dt_acc_pp)
            + 10*ABS(${lobby.median_ar} - pp.ar)
          ) AS match_accuracy FROM map
          INNER JOIN pp ON map.id = pp.map_id
          WHERE mods = 65600
            AND pp.stars >= ${lobby.min_stars} AND pp.stars <= ${lobby.max_stars}
            AND length > 60
            AND ranked IN (4, 5, 7)
            AND match_accuracy IS NOT NULL
          ORDER BY match_accuracy LIMIT 1000
        ) ORDER BY RANDOM() LIMIT 1`,
      );
    } else {
      new_map = await map_db.get(SQL`
        SELECT * FROM (
          SELECT *, pp.stars AS pp_stars, (
            ABS(${lobby.median_aim} - aim_pp)
            + ABS(${lobby.median_speed} - speed_pp)
            + ABS(${lobby.median_acc} - acc_pp)
            + 10*ABS(${lobby.median_ar} - pp.ar)
          ) AS match_accuracy FROM map
          INNER JOIN pp ON map.id = pp.map_id
          WHERE mods = (1<<16)
            AND pp.stars >= ${lobby.min_stars} AND pp.stars <= ${lobby.max_stars}
            AND length > 60
            AND ranked IN (4, 5, 7)
            AND match_accuracy IS NOT NULL
          ORDER BY match_accuracy LIMIT 1000
        ) ORDER BY RANDOM() LIMIT 1`,
      );
    }
    tries++;

    if (!new_map) break;
  } while ((lobby.recent_maps.includes(new_map.id)) && tries < 10);
  if (!new_map) {
    await lobby.channel.sendMessage(`Uh, I couldn't find a map. Something went terribly wrong.`);
    return;
  }

  lobby.recent_maps.push(new_map.id);
  lobby.current_map_pp = new_map.pp;

  try {
    const flavor = `${MAP_TYPES[new_map.ranked]} ${new_map.pp_stars.toFixed(2)}*, ${Math.round(new_map.pp)}pp`;
    const map_name = `[https://osu.ppy.sh/beatmapsets/${new_map.set_id}#osu/${new_map.id} ${new_map.name}]`;
    const beatconnect_link = `[https://beatconnect.io/b/${new_map.set_id} [1]]`;
    const chimu_link = `[https://api.chimu.moe/v1/download/${new_map.set_id}?n=1 [2]]`;
    const nerina_link = `[https://nerina.pw/d/${new_map.set_id} [3]]`;
    const sayobot_link = `[https://osu.sayobot.cn/osu.php?s=${new_map.set_id} [4]]`;
    await lobby.channel.sendMessage(`!mp map ${new_map.id} 0 | ${map_name} (${flavor}) Alternate downloads: ${beatconnect_link} ${chimu_link} ${nerina_link} ${sayobot_link}`);

    const player_ids = [];
    for (const slot of lobby.slots) {
      if (slot) {
        player_ids.push(slot.user.id);
      }
    }
    await set_new_title(lobby);
  } catch (e) {
    console.error(`#mp_${lobby.id} Failed to switch to map ${new_map.id} ${new_map.name}:`, e);
  }

  await update_ranked_lobby_on_discord(lobby);
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

  lobby.median_aim = median(aims) * DIFFICULTY_MODIFIER;
  lobby.median_acc = median(accs) * DIFFICULTY_MODIFIER;
  lobby.median_speed = median(speeds) * DIFFICULTY_MODIFIER;
  lobby.median_overall = median(overalls) * DIFFICULTY_MODIFIER;
  lobby.median_ar = median(ars);

  return false;
}

async function join_lobby(lobby, client, creator, creator_discord_id, created_just_now, min_stars, max_stars, dt, scorev2) {
  lobby.recent_maps = [];
  lobby.voteaborts = [];
  lobby.votekicks = [];
  lobby.voteskips = [];
  lobby.confirmed_players = [];
  lobby.countdown = -1;
  lobby.median_overall = 0;
  lobby.nb_players = 0;
  lobby.last_ready_msg = 0;
  lobby.creator = creator;
  lobby.creator_discord_id = creator_discord_id;
  lobby.min_stars = min_stars || 0.0;
  lobby.max_stars = max_stars || 11.0;
  lobby.fixed_star_range = (min_stars != null || max_stars != null);
  lobby.is_dt = dt;
  lobby.is_scorev2 = scorev2;

  await lobby.setPassword('');
  await lobby.channel.sendMessage(`!mp set 0 ${scorev2 ? '3': '0'} 16`);
  if (dt) await lobby.channel.sendMessage('!mp mods dt freemod');
  else await lobby.channel.sendMessage('!mp mods freemod');

  // Fetch user info
  await lobby.updateSettings();
  for (const player of lobby.slots) {
    if (player == null) continue;

    try {
      await player.user.fetchFromAPI();
      await load_user_info(player.user, lobby);
    } catch (err) {
      console.error(`#mp_${lobby.id} Failed to fetch user data for '${player.user.ircUsername}': ${err}`);
      await lobby.channel.sendMessage(`!mp ban ${player.user.ircUsername}`);
      if (err.message == 'Internal server error.') {
        await player.user.sendMessage('Sorry, osu!api is having issues at the moment, so you cannot join o!RL lobbies. See https://status.ppy.sh/ for more info.');
      } else {
        capture_sentry_exception(err);
      }
    }
  }
  await update_median_pp(lobby);
  await update_ranked_lobby_on_discord(lobby);

  lobby.channel.on('PART', async (member) => {
    set_sentry_context(lobby, 'channel_part');

    try {
      // Lobby closed (intentionally or not), clean up
      if (member.user.isClient()) {
        client.joined_lobbies.splice(client.joined_lobbies.indexOf(lobby), 1);
        await close_ranked_lobby_on_discord(lobby);
        console.log(`#mp_${lobby.id} Closed.`);
      }
    } catch (err) {
      capture_sentry_exception(err);
    }
  });

  lobby.on('playerJoined', async (evt) => {
    set_sentry_context(lobby, 'playerJoined');
    Sentry.setUser({username: evt.player.user.username});

    try {
      const joined_alone = get_nb_players(lobby) == 1;

      deadlines = deadlines.filter((deadline) => deadline.username != evt.player.user.username.replace(/ /g, '_'));

      const player = await client.getUser(evt.player.user.username);
      try {
        await player.fetchFromAPI();
      } catch (err) {
        console.error(`#mp_${lobby.id} Failed to fetch user data for '${evt.player.user.username}': ${err}`);
        await lobby.channel.sendMessage(`!mp ban ${evt.player.user.username}`);
        if (err.message == 'Internal server error.') {
          await evt.player.user.sendMessage('Sorry, osu!api is having issues at the moment, so you cannot join o!RL lobbies. See https://status.ppy.sh/ for more info.');
        } else {
          capture_sentry_exception(err);
        }
      }

      // Warning: load_user_info can be a slow call
      await load_user_info(player, lobby);
      await update_median_pp(lobby);
      if (joined_alone) {
        await select_next_map(lobby);
        if (player.games_played == 0) {
          await lobby.channel.sendMessage(`Welcome, ${player.ircUsername}! There is no host: use !start if the players aren't readying up, and !skip if the map is bad. [${Config.discord_invite_link} Join the Discord] for more info.`);
        }
      }
      await update_ranked_lobby_on_discord(lobby);
    } catch (err) {
      console.error(`#mp_${lobby.id} Error in playerJoined event handler:`, err);
      capture_sentry_exception(err);
    }
  });

  lobby.on('playerLeft', async (evt) => {
    set_sentry_context(lobby, 'playerLeft');
    Sentry.setUser({username: evt.user.ircUsername});

    try {
      leave_deadlines = leave_deadlines.filter((deadline) =>
        deadline.username != evt.user.ircUsername.replace(/ /g, '_'),
      );

      // Remove user's votekicks, and votekicks against the user
      delete lobby.votekicks[evt.user.ircUsername];
      for (const annoyed_players of lobby.votekicks) {
        if (annoyed_players && annoyed_players.includes(evt.user.ircUsername)) {
          annoyed_players.splice(annoyed_players.indexOf(evt.user.ircUsername), 1);
        }
      }

      // Remove user from abort list, if they voted to abort
      if (lobby.voteaborts.includes(evt.user.ircUsername)) {
        lobby.voteaborts.splice(lobby.voteaborts.indexOf(evt.user.ircUsername), 1);
      }

      // Remove user from voteskip list, if they voted to skip
      if (lobby.voteskips.includes(evt.user.ircUsername)) {
        lobby.voteskips.splice(lobby.voteskips.indexOf(evt.user.ircUsername), 1);
      }

      await update_median_pp(lobby);

      get_nb_players(lobby); // update lobby.nb_players
      if (lobby.nb_players == 0) {
        if (!lobby.fixed_star_range) {
          lobby.min_stars = 0.0;
          lobby.max_stars = 11.0;
          await set_new_title(lobby);
        }
        return;
      }

      // Check if we should abort
      if (lobby.voteaborts.length >= lobby.nb_players / 2) {
        await lobby.abortMatch();
        lobby.voteaborts = [];
        await select_next_map(lobby);
        return;
      }

      // Check if we should skip
      if (lobby.voteskips.length >= lobby.nb_players / 2) {
        await select_next_map(lobby);
        return;
      }
    } catch (err) {
      capture_sentry_exception(err);
    }
  });

  lobby.on('allPlayersReady', async () => {
    set_sentry_context(lobby, 'allPlayersReady');

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
    } catch (err) {
      capture_sentry_exception(err);
    }
  });

  lobby.on('matchStarted', async () => {
    set_sentry_context(lobby, 'matchStarted');

    try {
      lobby.voteaborts = [];
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
    } catch (err) {
      capture_sentry_exception(err);
    }
  });

  lobby.on('matchFinished', async (scores) => {
    set_sentry_context(lobby, 'matchFinished');

    try {
      const rank_updates = await update_mmr(lobby);
      await select_next_map(lobby);

      if (rank_updates.length > 0) {
        // Max 8 rank updates per message - or else it starts getting truncated
        const MAX_UPDATES_PER_MSG = 6;
        for (let i = 0, j = rank_updates.length; i < j; i += MAX_UPDATES_PER_MSG) {
          const updates = rank_updates.slice(i, i + MAX_UPDATES_PER_MSG);

          if (i == 0) {
            await lobby.channel.sendMessage('Rank updates: ' + updates.join(' | '));
          } else {
            await lobby.channel.sendMessage(updates.join(' | '));
          }
        }
      }
    } catch (err) {
      capture_sentry_exception(err);
    }
  });

  lobby.channel.on('message', (msg) => on_lobby_msg(lobby, msg).catch(Sentry.captureException));

  client.joined_lobbies.push(lobby);
  if (created_just_now) {
    await select_next_map(lobby);
  }
}

async function on_lobby_msg(lobby, msg) {
  set_sentry_context(lobby, 'on_lobby_msg');
  Sentry.setUser({
    username: msg.user.ircUsername,
  });
  console.log(`#mp_${lobby.id} ${msg.user.ircUsername}: ${msg.message}`);

  // Temporary workaround for bancho.js bug with playerJoined/playerLeft events
  // Mostly copy/pasted from bancho.js itself.
  if (msg.user.ircUsername == 'BanchoBot') {
    const join_regex = /^(.+) joined in slot (\d+)( for team (red|blue))?\.$/;
    const leave_regex = /^(.+) left the game\.$/;

    if (join_regex.test(msg.message)) {
      const m = join_regex.exec(msg.message);
      const id = deadline_id++;
      deadlines.push({
        id: id,
        username: m[1].replace(/ /g, '_'),
      });
      setTimeout(() => {
        if (deadlines.some((deadline) => deadline.id == id)) {
          console.error('bancho.js didn\'t register ' + m[1].replace(/ /g, '_') + ' joining! Restarting.');
          Sentry.setContext('lobby', {
            slotUpdates: lobby.slotsUpdatesQueue.length,
            playerCreations: lobby.playerCreationQueue.length,
            updateSettingsPromise: lobby.updateSettingsPromise != null,
          });
          Sentry.captureException(new Error('A playerJoined event is missing.'));
          setTimeout(process.exit, 1000);
        }
      }, 30000);
    } else if (leave_regex.test(msg.message)) {
      const m = leave_regex.exec(msg.message);
      const id = deadline_id++;
      leave_deadlines.push({
        id: id,
        username: m[1].replace(/ /g, '_'),
      });
      setTimeout(() => {
        if (leave_deadlines.some((deadline) => deadline.id == id)) {
          console.error('bancho.js didn\'t register ' + m[1].replace(/ /g, '_') + ' leaving! Restarting.');
          Sentry.setContext('lobby', {
            slotUpdates: lobby.slotsUpdatesQueue.length,
            playerCreations: lobby.playerCreationQueue.length,
            updateSettingsPromise: lobby.updateSettingsPromise != null,
          });
          Sentry.captureException(new Error('A playerLeft event is missing.'));
          setTimeout(process.exit, 1000);
        }
      }, 30000);
    }

    return;
  }

  // NOTE: !start needs to be checked before !star (because we allow multiple spelling for !stars)
  if (msg.message.toLowerCase() == '!start' && lobby.countdown == -1 && !lobby.playing) {
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
    return;
  }

  if ((msg.message.toLowerCase() == '!wait' || msg.message.toLowerCase() == '!stop') && lobby.countdown != -1) {
    clearTimeout(lobby.countdown);
    lobby.countdown = -1;
    await lobby.channel.sendMessage('Match auto-start is cancelled. Type !start to restart it.');
    return;
  }

  if (msg.message == '!about') {
    await lobby.channel.sendMessage(`In this lobby, you get a rank based on how well you play compared to other players. All commands and answers to your questions are [${Config.discord_invite_link} in the Discord.]`);
    return;
  }

  if (msg.message == '!discord') {
    await lobby.channel.sendMessage(`[${Config.discord_invite_link} Come hang out in voice chat!] (or just text, no pressure)`);
    return;
  }

  if (msg.message.indexOf('!dt') == 0) {
    if (lobby.creator != msg.user.ircUsername) {
      await lobby.channel.sendMessage(msg.user.ircUsername + ': You need to be the lobby creator to use this command.');
      return;
    }

    lobby.is_dt = !lobby.is_dt;
    if (lobby.is_dt) await lobby.channel.sendMessage('!mp mods dt freemod');
    else await lobby.channel.sendMessage('!mp mods freemod');
    await select_next_map(lobby);
    return;
  }

  if (msg.message.indexOf('!scorev') == 0) {
    if (lobby.creator != msg.user.ircUsername) {
      await lobby.channel.sendMessage(msg.user.ircUsername + ': You need to be the lobby creator to use this command.');
      return;
    }

    lobby.is_scorev2 = !lobby.is_scorev2;
    await lobby.channel.sendMessage(`!mp set 0 ${lobby.is_scorev2 ? '3': '0'} 16`);
    await select_next_map(lobby);
    return;
  }

  if (msg.message.indexOf('!star') == 0 || msg.message.indexOf('!setstar') == 0) {
    if (lobby.creator != msg.user.ircUsername) {
      await lobby.channel.sendMessage(msg.user.ircUsername + ': You need to be the lobby creator to use this command.');
      return;
    }

    const args = msg.message.split(' ');

    // No arguments: remove star rating restrictions
    if (args.length == 1) {
      lobby.min_stars = 0.0;
      lobby.max_stars = 11.0;
      lobby.fixed_star_range = false;
      await select_next_map(lobby);
      return;
    }

    if (args.length < 3) {
      await lobby.channel.sendMessage(msg.user.ircUsername + ': You need to specify minimum and maximum star values.');
      return;
    }

    const min_stars = parseFloat(args[1]);
    const max_stars = parseFloat(args[2]);
    if (!isFinite(min_stars) || !isFinite(max_stars)) {
      await lobby.channel.sendMessage(msg.user.ircUsername + ': Please use valid star values.');
      return;
    }

    lobby.min_stars = min_stars;
    lobby.max_stars = max_stars;
    lobby.fixed_star_range = true;
    await select_next_map(lobby);
    return;
  }

  if (msg.message.toLowerCase() == '!abort') {
    if (!lobby.playing) {
      await lobby.channel.sendMessage('The match has not started, cannot abort.');
    }

    if (!lobby.voteaborts.includes(msg.user.ircUsername)) {
      lobby.voteaborts.push(msg.user.ircUsername);
      const nb_voted_to_abort = lobby.voteaborts.length;
      const nb_required_to_abort = Math.ceil(get_nb_players(lobby) / 2);
      if (lobby.voteaborts.length >= nb_required_to_abort) {
        await lobby.abortMatch();
        lobby.voteaborts = [];
        await select_next_map(lobby);
      } else {
        await lobby.channel.sendMessage(`${msg.user.ircUsername} voted to abort the match. ${nb_voted_to_abort}/${nb_required_to_abort} votes needed.`);
      }
    }

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
        await lobby.channel.sendMessage('!mp ban ' + bad_player);
      } else {
        await lobby.channel.sendMessage(`${msg.user.ircUsername} voted to kick ${bad_player}. ${nb_voted_to_kick}/${nb_required_to_kick} votes needed.`);
      }
    }

    return;
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
      await lobby.channel.sendMessage(`${msg.user.ircUsername}: You are [${Config.website_base_url}/u/${msg.user.id}/ ${rank_text}].`);
    }

    return;
  }

  if (msg.message == '!skip' && !lobby.voteskips.includes(msg.user.ircUsername)) {
    lobby.voteskips.push(msg.user.ircUsername);
    if (lobby.voteskips.length >= get_nb_players(lobby) / 2) {
      clearTimeout(lobby.countdown);
      lobby.countdown = -1;
      await update_median_pp(lobby);
      await select_next_map(lobby);
    } else {
      await lobby.channel.sendMessage(`${lobby.voteskips.length}/${Math.ceil(get_nb_players(lobby) / 2)} players voted to switch to another map.`);
    }

    return;
  }
}

async function start_ranked(client, _map_db) {
  map_db = _map_db;
  ranking_db = await init_ranking_db();

  const discord_db = await open({
    filename: 'discord.db',
    driver: sqlite3.cached.Database,
  });

  const lobbies = await discord_db.all('SELECT * from ranked_lobby');
  for (const lobby of lobbies) {
    console.log('Rejoining lobby #' + lobby.osu_lobby_id);

    try {
      const channel = await client.getChannel('#mp_' + lobby.osu_lobby_id);
      await channel.join();
      await join_lobby(
          channel.lobby,
          client,
          lobby.creator,
          lobby.creator_discord_id,
          false,
          lobby.min_stars,
          lobby.max_stars,
          lobby.dt,
          lobby.scorev2,
      );
    } catch (e) {
      console.error('Failed to rejoin lobby ' + lobby.osu_lobby_id + ':', e);
      await close_ranked_lobby_on_discord({id: lobby.osu_lobby_id});
    }
  }

  client.on('PM', async (msg) => {
    Sentry.setUser({
      username: msg.user.ircUsername,
    });

    try {
      await msg.user.fetchFromAPI();

      if (msg.message == '!ranked') {
        const suggested_lobby = await get_matching_lobby_for_user(client, msg.user);
        if (suggested_lobby != null) {
          await suggested_lobby.invitePlayer(msg.user.ircUsername);
        } else {
          await msg.user.sendMessage(`Looks like there are no open lobbies that match your skill level. [${Config.discord_invite_link} Join the Discord] to create a new one.`);
        }
      }

      if (msg.message == '!rank') {
        const rank_text = await get_rank_text_from_id(msg.user.id);
        if (rank_text == 'Unranked') {
          let res = await ranking_db.get(SQL`
            SELECT games_played FROM user
            WHERE user_id = ${msg.user.id}`,
          );
          // Wow, player never even played a game and is requesting their rank in PMs? Wtf?
          if (!res) {
            res = {
              games_played: 0,
            };
          }
          await msg.user.sendMessage(`You are unranked. Play ${5 - res.games_played} more games to get a rank!`);
        } else {
          await msg.user.sendMessage(`You are [${Config.website_base_url}/u/${msg.user.id}/ ${rank_text}].`);
        }
        return;
      }
    } catch (err) {
      console.log('Failed to process PM: ' + err);
      capture_sentry_exception(err);
    }
  });
}

export {
  start_ranked,
  join_lobby,
};
