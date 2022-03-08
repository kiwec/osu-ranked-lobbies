import Sentry from '@sentry/node';

import bancho from './bancho.js';
import databases from './database.js';
import {update_mmr, get_rank} from './elo_mmr.js';
import {
  close_ranked_lobby_on_discord,
} from './discord_updates.js';
import {get_map_data} from './profile_scanner.js';

import {capture_sentry_exception} from './util/helpers.js';
import Config from './util/config.js';

const DIFFICULTY_MODIFIER = 1.2;
const DT_DIFFICULTY_MODIFIER = 0.7;

const stmts = {
  star_range_from_pp: databases.ranks.prepare(`
    SELECT MIN(stars) AS min_stars, MAX(stars) AS max_stars FROM (
      SELECT stars, (
        ABS(? - aim_pp)
        + ABS(? - speed_pp)
        + 10*ABS(? - ar)
      ) AS match_accuracy FROM map
      WHERE length > 60 AND ranked IN (4, 5, 7) AND match_accuracy IS NOT NULL AND dmca = 0
      ORDER BY match_accuracy LIMIT 1000
    )`,
  ),
  dt_star_range_from_pp: databases.ranks.prepare(`
    SELECT MIN(dt_stars) AS min_stars, MAX(dt_stars) AS max_stars FROM (
      SELECT dt_stars, (
        ABS(? - dt_aim_pp)
        + ABS(? - dt_speed_pp)
        + 10*ABS(? - dt_ar)
      ) AS match_accuracy FROM map
      WHERE length > 90 AND ranked IN (4, 5, 7) AND match_accuracy IS NOT NULL AND dmca = 0
      ORDER BY match_accuracy LIMIT 1000
    )`,
  ),

  select_map: databases.ranks.prepare(`
    SELECT * FROM (
      SELECT *, (
        ABS(? - aim_pp)
        + ABS(? - speed_pp)
        + 10*ABS(? - ar)
      ) AS match_accuracy FROM map
      WHERE
        stars >= ? AND stars <= ?
        AND length > 60
        AND ranked IN (4, 5, 7)
        AND match_accuracy IS NOT NULL
        AND dmca = 0
      ORDER BY match_accuracy LIMIT 1000
    ) ORDER BY RANDOM() LIMIT 1`,
  ),
  select_dt_map: databases.ranks.prepare(`
    SELECT * FROM (
      SELECT *, (
        ABS(? - dt_aim_pp)
        + ABS(? - dt_speed_pp)
        + 10*ABS(? - dt_ar)
      ) AS match_accuracy FROM map
      WHERE
        dt_stars >= ? AND dt_stars <= ?
        AND length > 90
        AND ranked IN (4, 5, 7)
        AND match_accuracy IS NOT NULL
        AND dmca = 0
      ORDER BY match_accuracy LIMIT 1000
    ) ORDER BY RANDOM() LIMIT 1`,
  ),

  dmca_map: databases.ranks.prepare('UPDATE map SET dmca = 1 WHERE id = ?'),
};


function set_sentry_context(lobby, current_task) {
  if (Config.ENABLE_SENTRY) {
    Sentry.setContext('lobby', {
      id: lobby.id,
      median_pp: lobby.median_overall,
      nb_players: lobby.nb_players,
      creator: lobby.creator,
      creator_osu_id: lobby.osu_id,
      creator_discord_id: lobby.creator_discord_id,
      min_stars: lobby.min_stars,
      max_stars: lobby.max_stars,
      task: current_task,
    });
  }
}

async function set_new_title(lobby) {
  let new_title = '';

  // Min stars: we prefer not displaying the decimals whenever possible
  let fancy_min_stars;
  if (Math.abs(lobby.min_stars - Math.round(lobby.min_stars)) <= 0.1) {
    fancy_min_stars = Math.round(lobby.min_stars);
  } else {
    fancy_min_stars = Math.round(lobby.min_stars * 100) / 100;
  }

  // Max stars: we prefer displaying .99 whenever possible
  let fancy_max_stars;
  if (lobby.max_stars > 11) {
    // ...unless it's a ridiculously big number
    fancy_max_stars = Math.round(Math.min(lobby.max_stars, 999));
  } else {
    if (Math.abs(lobby.max_stars - Math.round(lobby.max_stars)) <= 0.1) {
      fancy_max_stars = (Math.round(lobby.max_stars) - 0.01).toFixed(2);
    } else {
      fancy_max_stars = Math.round(lobby.max_stars * 100) / 100;
    }
  }

  new_title += `${fancy_min_stars}-${fancy_max_stars}*`;

  if (lobby.median_elo > 0) {
    const median_rank = get_rank(lobby.median_elo);
    new_title += ' ' + median_rank.text;
  }

  if (lobby.is_dt) new_title += ' DT';
  if (lobby.is_scorev2) new_title += ' ScoreV2';

  // Title is limited to 50 characters, so only add extra stuff when able to
  new_title += ' | o!RL';
  if (new_title.length <= 39) new_title += ' | Auto map';
  if (new_title.length <= 43) new_title += ' select';
  if (new_title.length <= 41) new_title += ' (!about)';

  if (!Config.IS_PRODUCTION) {
    new_title = 'test lobby';
  }

  if (lobby.name != new_title) {
    await lobby.send(`!mp name ${new_title}`);
    lobby.name = new_title;
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
      meta = stmts.dt_star_range_from_pp.get(
          lobby.median_aim * DT_DIFFICULTY_MODIFIER,
          lobby.median_speed * DT_DIFFICULTY_MODIFIER,
          lobby.median_ar,
      );
    } else {
      meta = stmts.star_range_from_pp.get(
          lobby.median_aim,
          lobby.median_speed,
          lobby.median_ar,
      );
    }

    lobby.min_stars = meta.min_stars;
    lobby.max_stars = meta.max_stars;
  }

  do {
    if (lobby.is_dt) {
      new_map = stmts.select_dt_map.get(
          lobby.median_aim * DT_DIFFICULTY_MODIFIER,
          lobby.median_speed * DT_DIFFICULTY_MODIFIER,
          lobby.median_ar,
          lobby.min_stars,
          lobby.max_stars,
      );
    } else {
      new_map = stmts.select_map.get(
          lobby.median_aim,
          lobby.median_speed,
          lobby.median_ar,
          lobby.min_stars,
          lobby.max_stars,
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
  const pp = lobby.is_dt ? new_map.dt_overall_pp : new_map.overall_pp;
  lobby.current_map_pp = pp;

  try {
    lobby.map_data = null;
    const sr = lobby.is_dt ? new_map.dt_stars : new_map.stars;
    const flavor = `${MAP_TYPES[new_map.ranked]} ${sr.toFixed(2)}*, ${Math.round(pp)}pp`;
    const map_name = `[https://osu.ppy.sh/beatmapsets/${new_map.set_id}#osu/${new_map.id} ${new_map.name}]`;
    const beatconnect_link = `[https://beatconnect.io/b/${new_map.set_id} [1]]`;
    const chimu_link = `[https://chimu.moe/d/${new_map.set_id} [2]]`;
    const nerina_link = `[https://nerina.pw/d/${new_map.set_id} [3]]`;
    const sayobot_link = `[https://osu.sayobot.cn/osu.php?s=${new_map.set_id} [4]]`;
    await lobby.send(`!mp map ${new_map.id} 0 | ${map_name} (${flavor}) Alternate downloads: ${beatconnect_link} ${chimu_link} ${nerina_link} ${sayobot_link}`);
    await set_new_title(lobby);
  } catch (e) {
    console.error(`${lobby.channel} Failed to switch to map ${new_map.id} ${new_map.name}:`, e);
  }
}


// Updates the lobby's median_pp value.
function update_median_pp(lobby) {
  const aims = [];
  const speeds = [];
  const overalls = [];
  const ars = [];
  const elos = [];

  for (const username in lobby.players) {
    if (lobby.players.hasOwnProperty(username)) {
      let aim_pp = lobby.players[username].aim_pp;
      let speed_pp = lobby.players[username].speed_pp;
      let overall_pp = lobby.players[username].overall_pp;

      // Over 600pp, map selection is getting way too hard.
      if (overall_pp > 600.0) {
        const ratio = overall_pp / 600.0;
        aim_pp /= ratio;
        speed_pp /= ratio;
        overall_pp /= ratio;
      }

      aims.push(aim_pp);
      speeds.push(speed_pp);
      overalls.push(overall_pp);

      ars.push(lobby.players[username].avg_ar);
      elos.push(lobby.players[username].elo);
    }
  }

  aims.sort((a, b) => a - b);
  speeds.sort((a, b) => a - b);
  overalls.sort((a, b) => a - b);
  ars.sort((a, b) => a - b);

  lobby.median_aim = median(aims) * DIFFICULTY_MODIFIER;
  lobby.median_speed = median(speeds) * DIFFICULTY_MODIFIER;
  lobby.median_overall = median(overalls) * DIFFICULTY_MODIFIER;
  lobby.median_ar = median(ars);
  lobby.median_elo = median(elos);

  return false;
}

async function init_lobby(lobby, settings) {
  bancho.joined_lobbies.push(lobby);
  lobby.recent_maps = [];
  lobby.voteaborts = [];
  lobby.votekicks = [];
  lobby.voteskips = [];
  lobby.countdown = -1;
  lobby.median_overall = 0;
  lobby.last_ready_msg = 0;
  lobby.creator = settings.creator || Config.osu_username;
  lobby.creator_osu_id = settings.creator_osu_id || Config.osu_id;
  lobby.creator_discord_id = settings.creator_discord_id || Config.discord_bot_id;
  lobby.min_stars = settings.min_stars || 0.0;
  lobby.max_stars = settings.max_stars || 11.0;
  lobby.fixed_star_range = (settings.min_stars || settings.max_stars);
  lobby.is_dt = settings.dt;
  lobby.is_scorev2 = settings.scorev2;

  lobby.on('message', (msg) => on_lobby_msg(lobby, msg).catch((err) => {
    set_sentry_context(lobby, 'on_lobby_msg');
    Sentry.setUser({
      username: msg.from,
    });
    capture_sentry_exception(err);
  }));

  lobby.on('refereeRemoved', async (username) => {
    if (username != Config.osu_username) return;

    await lobby.send('Looks like we\'re done here.');
    await lobby.leave();
  });

  lobby.on('settings', async () => {
    try {
      update_median_pp(lobby);

      // Cannot select a map until we fetched the player IDs via !mp settings.
      if (settings.created_just_now) {
        await select_next_map(lobby);
        settings.created_just_now = false;
      }
    } catch (err) {
      set_sentry_context(lobby, 'settings');
      capture_sentry_exception(err);
    }
  });

  lobby.on('playerJoined', async (player) => {
    try {
      if (player.user_id) {
        update_median_pp(lobby);
        if (lobby.nb_players == 1) {
          await select_next_map(lobby);
        }
      }
    } catch (err) {
      set_sentry_context(lobby, 'playerJoined');
      Sentry.setUser(player);
      capture_sentry_exception(err);
    }
  });

  lobby.on('playerLeft', async (player) => {
    try {
      update_median_pp(lobby);

      if (lobby.nb_players == 0) {
        if (!lobby.fixed_star_range) {
          lobby.min_stars = 0.0;
          lobby.max_stars = 11.0;
          await set_new_title(lobby);
        }
        return;
      }
    } catch (err) {
      set_sentry_context(lobby, 'playerLeft');
      Sentry.setUser(player);
      capture_sentry_exception(err);
    }
  });

  lobby.on('matchFinished', async (scores) => {
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
      set_sentry_context(lobby, 'matchFinished');
      capture_sentry_exception(err);
    }
  });

  lobby.on('close', async () => {
    try {
      // Lobby closed (intentionally or not), clean up
      bancho.joined_lobbies.splice(bancho.joined_lobbies.indexOf(lobby), 1);
      await close_ranked_lobby_on_discord(lobby);
      console.info(`${lobby.channel} Closed.`);
    } catch (err) {
      set_sentry_context(lobby, 'channel_part');
      capture_sentry_exception(err);
    }
  });

  lobby.on('allPlayersReady', async () => {
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

      // Players can spam the Ready button and due to lag, this command could
      // be spammed before the match actually got started.
      if (!lobby.playing) {
        lobby.playing = true;
        await lobby.send(`!mp start .${Math.random().toString(36).substring(2, 6)}`);
      }
    } catch (err) {
      set_sentry_context(lobby, 'allPlayersReady');
      capture_sentry_exception(err);
    }
  });

  lobby.on('matchStarted', async () => {
    try {
      lobby.voteaborts = [];
      lobby.voteskips = [];
      clearTimeout(lobby.countdown);
      lobby.countdown = -1;
    } catch (err) {
      set_sentry_context(lobby, 'matchStarted');
      capture_sentry_exception(err);
    }
  });

  if (settings.created_just_now) {
    await lobby.send(`!mp settings ${Math.random().toString(36).substring(2, 6)}`);
    await lobby.send('!mp password');
    await lobby.send(`!mp set 0 ${lobby.is_scorev2 ? '3': '0'} 16`);

    if (lobby.is_dt) await lobby.send('!mp mods dt freemod');
    else await lobby.send('!mp mods freemod');
  } else {
    await lobby.send(`!mp settings (restarted) ${Math.random().toString(36).substring(2, 6)}`);
  }
}

async function on_lobby_msg(lobby, msg) {
  // NOTE: !start needs to be checked before !star (because we allow multiple spelling for !stars)
  if (msg.message.toLowerCase() == '!start') {
    if (lobby.countdown != -1 || lobby.playing) return;

    if (lobby.nb_players < 2) {
      await lobby.send(`!mp start .${Math.random().toString(36).substring(2, 6)}`);
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
          await lobby.send(`!mp start .${Math.random().toString(36).substring(2, 6)}`);
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
    if (lobby.creator_osu_id != await bancho.whois(msg.from)) {
      await lobby.send(msg.from + ': You need to be the lobby creator to use this command.');
      return;
    }

    lobby.is_dt = !lobby.is_dt;
    const toggle_dt_stmt = databases.discord.prepare(`
      UPDATE ranked_lobby
      SET dt = ?
      WHERE osu_lobby_id = ?`,
    );
    toggle_dt_stmt.run(lobby.is_dt ? 1 : 0, lobby.id);
    if (lobby.is_dt) await lobby.send('!mp mods dt freemod');
    else await lobby.send('!mp mods freemod');
    await select_next_map(lobby);
    return;
  }

  if (msg.message.indexOf('!scorev') == 0) {
    if (lobby.creator_osu_id != await bancho.whois(msg.from)) {
      await lobby.send(msg.from + ': You need to be the lobby creator to use this command.');
      return;
    }

    lobby.is_scorev2 = !lobby.is_scorev2;
    const toggle_scorev2_stmt = databases.discord.prepare(`
      UPDATE ranked_lobby
      SET scorev2 = ?
      WHERE osu_lobby_id = ?`,
    );
    toggle_scorev2_stmt.run(lobby.is_scorev2 ? 1 : 0, lobby.id);
    await lobby.send(`!mp set 0 ${lobby.is_scorev2 ? '3': '0'} 16`);
    await select_next_map(lobby);
    return;
  }

  if (msg.message.indexOf('!star') == 0 || msg.message.indexOf('!setstar') == 0) {
    if (lobby.creator_osu_id != await bancho.whois(msg.from)) {
      await lobby.send(msg.from + ': You need to be the lobby creator to use this command.');
      return;
    }

    const args = msg.message.split(' ');

    // No arguments: remove star rating restrictions
    if (args.length == 1) {
      lobby.min_stars = 0.0;
      lobby.max_stars = 11.0;
      lobby.fixed_star_range = false;
      const remove_sr_restrictions_stmt = databases.discord.prepare(`
        UPDATE ranked_lobby
        SET min_stars = NULL, max_stars = NULL
        WHERE osu_lobby_id = ?`,
      );
      remove_sr_restrictions_stmt.run(lobby.id);
      await select_next_map(lobby);
      return;
    }

    if (args.length < 3) {
      await lobby.send(msg.from + ': You need to specify minimum and maximum star values.');
      return;
    }

    const min_stars = parseFloat(args[1]);
    const max_stars = parseFloat(args[2]);
    if (isNaN(min_stars) || isNaN(max_stars) || min_stars >= max_stars || min_stars < 0 || max_stars > 99) {
      await lobby.send(msg.from + ': Please use valid star values.');
      return;
    }

    lobby.min_stars = min_stars;
    lobby.max_stars = max_stars;
    lobby.fixed_star_range = true;
    const update_star_range_stmt = databases.discord.prepare(`
      UPDATE ranked_lobby
      SET min_stars = ?, max_stars = ?
      WHERE osu_lobby_id = ?`,
    );
    update_star_range_stmt.run(min_stars, max_stars, lobby.id);
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

  const rank_command_reg = /^!rank(.*)/g;
  let rank_command_reg_result;
  if (rank_command_reg_result = rank_command_reg.exec(msg.message)) {
    let rank_info = {};
    const requested_username = rank_command_reg_result[1].trim() || msg.from;

    let user;
    let user_id;
    const user_from_id_stmt = databases.ranks.prepare(`
      SELECT games_played, elo, user_id FROM user
      WHERE user_id = ?
    `);
    if (requested_username === msg.from) {
      user_id = await bancho.whois(requested_username);
      user = user_from_id_stmt.get(user_id);
    } else {
      const user_from_username_stmt = databases.ranks.prepare(`
        SELECT games_played, elo, user_id FROM user
        WHERE username = ?`,
      );
      user = user_from_username_stmt.get(requested_username);
      if (!user) {
        try {
          user_id = await bancho.whois(requested_username);
          user = user_from_id_stmt.get(user_id);
        } catch (err) {
          await lobby.send(`${msg.from}: Player ${requested_username} not found. Are they online?`);
          return;
        }
      }
    }

    if (!user || user.games_played < 5) {
      rank_info.text = 'Unranked';
    } else {
      rank_info = get_rank(user.elo);
    }

    if (rank_info.text == 'Unranked') {
      if (requested_username === msg.from) {
        const games_played = user ? user.games_played : 0;
        await lobby.send(`${msg.from}: You are unranked. Play ${5 - games_played} more games to get a rank!`);
      } else {
        await lobby.send(`${msg.from}: ${requested_username} is unranked.`);
      }
    } else {
      await lobby.send(`[${Config.website_base_url}/u/${user.user_id}/ ${requested_username}] | Rank: ${rank_info.text} (#${rank_info.rank_nb}) | Elo: ${Math.round(rank_info.elo)} | Games played: ${user.games_played}`);
    }

    return;
  }

  if (msg.message == '!skip' && !lobby.voteskips.includes(msg.from)) {
    // When bot just joined the lobby, beatmap_id is null.
    if (lobby.beatmap_id && !lobby.map_data) {
      try {
        lobby.map_data = await get_map_data(lobby.beatmap_id);
        if (lobby.map_data.beatmapset.availability.download_disabled) {
          clearTimeout(lobby.countdown);
          lobby.countdown = -1;

          await lobby.send(`Skipped map because download is unavailable [${lobby.map_data.beatmapset.availability.more_information} (more info)].`);
          stmts.dmca_map.run(lobby.beatmap_id);
          await select_next_map(lobby);
          return;
        }
      } catch (err) {
        console.error(`Failed to fetch map data for beatmap #${lobby.beatmap_id}: ${err}`);
      }
    }

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

async function start_ranked() {
  const rejoin_lobby = async (lobby) => {
    console.info('[Ranked] Rejoining lobby #' + lobby.osu_lobby_id);

    try {
      const bancho_lobby = await bancho.join('#mp_' + lobby.osu_lobby_id);
      await init_lobby(bancho_lobby, {
        creator: lobby.creator,
        creator_osu_id: lobby.creator_osu_id,
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

  const lobbies_stmt = databases.discord.prepare('SELECT * from ranked_lobby');
  const lobbies = lobbies_stmt.all();
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
