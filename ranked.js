import Sentry from '@sentry/node';
import {open} from 'sqlite';
import sqlite3 from 'sqlite3';
import SQL from 'sql-template-strings';

import bancho from './bancho.js';
import BanchoLobby from './lobby.js';
import {init_db as init_ranking_db, update_mmr, get_rank_text_from_id} from './elo_mmr.js';
import {
  update_ranked_lobby_on_discord,
  close_ranked_lobby_on_discord,
} from './discord_updates.js';

import {capture_sentry_exception} from './util/helpers.js';
import Config from './util/config.js';

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
    await lobby.send(`!mp name ${new_title}`);
    lobby.name = new_title;
    await update_ranked_lobby_on_discord(lobby);
  }
}

function median(numbers) {
  if (numbers.length == 0) return 0;

  const middle = Math.floor(numbers.length / 2);
  if (numbers.length % 2 === 0) {
    return (numbers[middle - 1] + numbers[middle]) / 2;
  }
  return numbers[middle];
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
    await lobby.send(`I couldn't find a map. Either the star range is too small or the bot was too slow to scan your profile (and you may !skip in a few seconds).`);
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
    await lobby.send(`!mp map ${new_map.id} 0 | ${map_name} (${flavor}) Alternate downloads: ${beatconnect_link} ${chimu_link} ${nerina_link} ${sayobot_link}`);
    await set_new_title(lobby);
  } catch (e) {
    console.error(`${lobby.channel} Failed to switch to map ${new_map.id} ${new_map.name}:`, e);
  }

  await update_ranked_lobby_on_discord(lobby);
}


// Updates the lobby's median_pp value.
async function update_median_pp(lobby) {
  const aims = [];
  const accs = [];
  const speeds = [];
  const overalls = [];
  const ars = [];

  for (const username in lobby.players) {
    if (lobby.players.hasOwnProperty(username)) {
      aims.push(lobby.players[username].aim_pp);
      accs.push(lobby.players[username].acc_pp);
      speeds.push(lobby.players[username].speed_pp);
      overalls.push(lobby.players[username].overall_pp);
      ars.push(lobby.players[username].avg_ar);
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

async function init_lobby(lobby, settings) {
  lobby.recent_maps = [];
  lobby.voteaborts = [];
  lobby.votekicks = [];
  lobby.voteskips = [];
  lobby.countdown = -1;
  lobby.median_overall = 0;
  lobby.last_ready_msg = 0;
  lobby.creator = settings.creator || Config.osu_username;
  lobby.creator_discord_id = settings.creator_discord_id || Config.discord_bot_id;
  lobby.min_stars = settings.min_stars || 0.0;
  lobby.max_stars = settings.max_stars || 11.0;
  lobby.fixed_star_range = (settings.min_stars || settings.max_stars);
  lobby.is_dt = settings.dt;
  lobby.is_scorev2 = settings.scorev2;

  if (settings.created_just_now) {
    await lobby.send(`!mp settings ${Math.random().toString(36).substring(2, 6)}`);
    await lobby.send('!mp password');
    await lobby.send(`!mp set 0 ${scorev2 ? '3': '0'} 16`);
    if (dt) await lobby.send('!mp mods dt freemod');
    else await lobby.send('!mp mods freemod');
  } else {
    await lobby.send(`!mp settings (restarted) ${Math.random().toString(36).substring(2, 6)}`);
  }

  lobby.on('message', (msg) => on_lobby_msg(lobby, msg).catch(capture_sentry_exception));

  lobby.on('refereeRemoved', async (username) => {
    if (username != Config.osu_username) return;

    await lobby.send('Looks like we\'re done here.');
    await lobby.leave();
  });

  lobby.on('settings', async () => {
    set_sentry_context(lobby, 'settings');

    try {
      await update_median_pp(lobby);
    } catch (err) {
      capture_sentry_exception(err);
    }
  });

  lobby.on('playerJoined', async (player) => {
    set_sentry_context(lobby, 'playerJoined');
    Sentry.setUser(player);

    try {
      if (player.user_id) {
        await update_median_pp(lobby);
        if (lobby.nb_players == 1) {
          await select_next_map(lobby);
        } else {
          await update_ranked_lobby_on_discord(lobby);
        }
      }
    } catch (err) {
      capture_sentry_exception(err);
    }
  });

  lobby.on('playerLeft', async (player) => {
    set_sentry_context(lobby, 'playerLeft');
    Sentry.setUser(player);

    try {
      await update_median_pp(lobby);

      if (lobby.nb_players == 0) {
        if (!lobby.fixed_star_range) {
          lobby.min_stars = 0.0;
          lobby.max_stars = 11.0;
          await set_new_title(lobby);
        }
        return;
      }
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
            await lobby.send('Rank updates: ' + updates.join(' | '));
          } else {
            await lobby.send(updates.join(' | '));
          }
        }
      }
    } catch (err) {
      capture_sentry_exception(err);
    }
  });

  lobby.on('close', async () => {
    set_sentry_context(lobby, 'channel_part');

    try {
      // Lobby closed (intentionally or not), clean up
      bancho.joined_lobbies.splice(bancho.joined_lobbies.indexOf(lobby), 1);
      await close_ranked_lobby_on_discord(lobby);
      console.info(`${lobby.channel} Closed.`);
    } catch (err) {
      capture_sentry_exception(err);
    }
  });

  lobby.on('allPlayersReady', async () => {
    set_sentry_context(lobby, 'allPlayersReady');

    try {
      if (lobby.nb_players < 2) {
        if (lobby.last_ready_msg && lobby.last_ready_msg + 10 > Date.now()) {
          // We already sent that message recently. Don't send it again, since
          // people can spam the Ready button and we don't want to spam that
          // error message ourselves.
          return;
        }

        await lobby.send('With less than 2 players in the lobby, your rank will not change. Type !start to start anyway.');
        lobby.last_ready_msg = Date.now();
        return;
      }

      await lobby.send(`!mp start ${Math.random().toString(36).substring(2, 6)}`);
    } catch (err) {
      capture_sentry_exception(err);
    }
  });

  lobby.on('matchStarted', async () => {
    set_sentry_context(lobby, 'matchStarted');

    try {
      lobby.voteaborts = [];
      lobby.voteskips = [];
      clearTimeout(lobby.countdown);
      lobby.countdown = -1;

      await update_ranked_lobby_on_discord(lobby);
    } catch (err) {
      capture_sentry_exception(err);
    }
  });

  bancho.joined_lobbies.push(lobby);
  if (settings.created_just_now) {
    await select_next_map(lobby);
  }
}

async function on_lobby_msg(lobby, msg) {
  set_sentry_context(lobby, 'on_lobby_msg');
  Sentry.setUser({
    username: msg.from,
  });
  console.info(`${lobby.channel} ${msg.from}: ${msg.message}`);

  // NOTE: !start needs to be checked before !star (because we allow multiple spelling for !stars)
  if (msg.message.toLowerCase() == '!start') {
    if (lobby.countdown != -1 || lobby.playing) return;

    if (lobby.nb_players < 2) {
      await lobby.send(`!mp start ${Math.random().toString(36).substring(2, 6)}`);
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
          await lobby.send(`!mp start ${Math.random().toString(36).substring(2, 6)}`);
        }
      }, 10000);
      await lobby.send('Starting the match in 10 seconds... Ready up to start sooner.');
    }, 20000);
    await lobby.send('Starting the match in 30 seconds... Ready up to start sooner.');
    return;
  }

  if ((msg.message.toLowerCase() == '!wait' || msg.message.toLowerCase() == '!stop') && lobby.countdown != -1) {
    clearTimeout(lobby.countdown);
    lobby.countdown = -1;
    await lobby.send('Match auto-start is cancelled. Type !start to restart it.');
    return;
  }

  if (msg.message == '!about') {
    await lobby.send(`In this lobby, you get a rank based on how well you play compared to other players. All commands and answers to your questions are [${Config.discord_invite_link} in the Discord.]`);
    return;
  }

  if (msg.message == '!discord') {
    await lobby.send(`[${Config.discord_invite_link} Come hang out in voice chat!] (or just text, no pressure)`);
    return;
  }

  if (msg.message.indexOf('!dt') == 0) {
    if (lobby.creator != msg.from) {
      await lobby.send(msg.from + ': You need to be the lobby creator to use this command.');
      return;
    }

    lobby.is_dt = !lobby.is_dt;
    if (lobby.is_dt) await lobby.send('!mp mods dt freemod');
    else await lobby.send('!mp mods freemod');
    await select_next_map(lobby);
    return;
  }

  if (msg.message.indexOf('!scorev') == 0) {
    if (lobby.creator != msg.from) {
      await lobby.send(msg.from + ': You need to be the lobby creator to use this command.');
      return;
    }

    lobby.is_scorev2 = !lobby.is_scorev2;
    await lobby.send(`!mp set 0 ${lobby.is_scorev2 ? '3': '0'} 16`);
    await select_next_map(lobby);
    return;
  }

  if (msg.message.indexOf('!star') == 0 || msg.message.indexOf('!setstar') == 0) {
    if (lobby.creator != msg.from) {
      await lobby.send(msg.from + ': You need to be the lobby creator to use this command.');
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
      await lobby.send(msg.from + ': You need to specify minimum and maximum star values.');
      return;
    }

    const min_stars = parseFloat(args[1]);
    const max_stars = parseFloat(args[2]);
    if (!isFinite(min_stars) || !isFinite(max_stars)) {
      await lobby.send(msg.from + ': Please use valid star values.');
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
      await lobby.send('The match has not started, cannot abort.');
    }

    if (!lobby.voteaborts.includes(msg.from)) {
      lobby.voteaborts.push(msg.from);
      const nb_voted_to_abort = lobby.voteaborts.length;
      const nb_required_to_abort = Math.ceil(lobby.nb_players / 2);
      if (lobby.voteaborts.length >= nb_required_to_abort) {
        await lobby.send(`!mp abort ${Math.random().toString(36).substring(2, 6)}`);
        lobby.voteaborts = [];
        await select_next_map(lobby);
      } else {
        await lobby.send(`${msg.from} voted to abort the match. ${nb_voted_to_abort}/${nb_required_to_abort} votes needed.`);
      }
    }

    return;
  }

  if (msg.message.indexOf('!kick') == 0) {
    const args = msg.message.split(' ');
    if (args.length < 2) {
      await lobby.send(msg.from + ': You need to specify which player to kick.');
      return;
    }
    args.shift(); // remove '!kick'
    const bad_player = args.join(' ');

    // TODO: check if bad_player is in the room

    if (!lobby.votekicks[bad_player]) {
      lobby.votekicks[bad_player] = [];
    }
    if (!lobby.votekicks[bad_player].includes(msg.from)) {
      lobby.votekicks[bad_player].push(msg.from);

      const nb_voted_to_kick = lobby.votekicks[bad_player].length;
      let nb_required_to_kick = Math.ceil(lobby.nb_players / 2);
      if (nb_required_to_kick == 1) nb_required_to_kick = 2; // don't allow a player to hog the lobby

      if (nb_voted_to_kick >= nb_required_to_kick) {
        await lobby.send('!mp ban ' + bad_player);
      } else {
        await lobby.send(`${msg.from} voted to kick ${bad_player}. ${nb_voted_to_kick}/${nb_required_to_kick} votes needed.`);
      }
    }

    return;
  }

  if (msg.message == '!rank') {
    const user_id = await bancho.whois(msg.from);
    const rank_text = await get_rank_text_from_id(user_id);
    if (rank_text == 'Unranked') {
      const res = await ranking_db.get(SQL`
        SELECT games_played FROM user
        WHERE user_id = ${user_id}`,
      );
      const games_played = res ? res.games_played : 0;
      await lobby.send(`${msg.from}: You are unranked. Play ${5 - games_played} more games to get a rank!`);
    } else {
      await lobby.send(`${msg.from}: You are [${Config.website_base_url}/u/${user_id}/ ${rank_text}].`);
    }

    return;
  }

  if (msg.message == '!skip' && !lobby.voteskips.includes(msg.from)) {
    lobby.voteskips.push(msg.from);
    if (lobby.voteskips.length >= lobby.nb_players / 2) {
      clearTimeout(lobby.countdown);
      lobby.countdown = -1;
      await select_next_map(lobby);
    } else {
      await lobby.send(`${lobby.voteskips.length}/${Math.ceil(lobby.nb_players / 2)} players voted to switch to another map.`);
    }

    return;
  }
}

async function start_ranked(_map_db) {
  map_db = _map_db;
  ranking_db = await init_ranking_db();

  const rejoin_lobby = async (lobby) => {
    console.info('[Ranked] Rejoining lobby #' + lobby.osu_lobby_id);

    try {
      const bancho_lobby = new BanchoLobby('#mp_' + lobby.osu_lobby_id);
      await bancho_lobby.join();
      await init_lobby(bancho_lobby, {
        creator: lobby.creator,
        creator_discord_id: lobby.creator_discord_id,
        created_just_now: false,
        min_stars: lobby.min_stars,
        max_stars: lobby.max_stars,
        dt: lobby.dt,
        scorev2: lobby.scorev2,
      });
    } catch (e) {
      console.error('Failed to rejoin lobby ' + lobby.osu_lobby_id + ':', e);
      await close_ranked_lobby_on_discord({id: lobby.osu_lobby_id});
    }
  };

  const discord_db = await open({
    filename: 'discord.db',
    driver: sqlite3.cached.Database,
  });
  const lobbies = await discord_db.all('SELECT * from ranked_lobby');

  const promises = [];
  for (const lobby of lobbies) {
    promises.push(rejoin_lobby(lobby));
  }
  await Promise.all(promises);
}

export {
  start_ranked,
  init_lobby,
};
