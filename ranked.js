import bancho from './bancho.js';
import databases from './database.js';
import {update_mmr} from './elo_mmr.js';
import {remove_lobby_listing} from './discord_updates.js';

import {scan_user_profile} from './profile_scanner.js';
import Config from './util/config.js';


const stmts = {
  star_range_from_pp: databases.ranks.prepare(`
    SELECT MIN(stars) AS min_stars, MAX(stars) AS max_stars FROM (
      SELECT stars, (
        ABS(? - aim_pp)
        + ABS(? - speed_pp)
      ) AS match_accuracy FROM map
      WHERE length > 60 AND ranked IN (4, 5, 7) AND match_accuracy IS NOT NULL AND dmca = 0 AND mode = 0
      ORDER BY match_accuracy LIMIT 1000
    )`,
  ),

  select_map: databases.ranks.prepare(`
    SELECT * FROM (
      SELECT *, (
        ABS(? - aim_pp)
        + ABS(? - speed_pp)
      ) AS match_accuracy FROM map
      WHERE
        stars >= ? AND stars <= ?
        AND length > 60
        AND ranked IN (4, 5, 7)
        AND match_accuracy IS NOT NULL
        AND dmca = 0
        AND mode = 0
      ORDER BY match_accuracy LIMIT 1000
    ) ORDER BY RANDOM() LIMIT 1`,
  ),

  dmca_map: databases.ranks.prepare('UPDATE map SET dmca = 1 WHERE id = ?'),
};


async function set_new_title(lobby) {
  let new_title = '';

  // Min stars: we prefer not displaying the decimals whenever possible
  let fancy_min_stars;
  if (Math.abs(lobby.data.min_stars - Math.round(lobby.data.min_stars)) <= 0.1) {
    fancy_min_stars = Math.round(lobby.data.min_stars);
  } else {
    fancy_min_stars = Math.round(lobby.data.min_stars * 100) / 100;
  }

  // Max stars: we prefer displaying .99 whenever possible
  let fancy_max_stars;
  if (lobby.data.max_stars > 11) {
    // ...unless it's a ridiculously big number
    fancy_max_stars = Math.round(Math.min(lobby.data.max_stars, 999));
  } else {
    if (Math.abs(lobby.data.max_stars - Math.round(lobby.data.max_stars)) <= 0.1) {
      fancy_max_stars = (Math.round(lobby.data.max_stars) - 0.01).toFixed(2);
    } else {
      fancy_max_stars = Math.round(lobby.data.max_stars * 100) / 100;
    }
  }

  if (lobby.data.max_stars - lobby.data.min_stars == 1 && lobby.data.min_stars % 1 == 0) {
    // Simplify "4-4.99*" lobbies as "4*"
    new_title = `${lobby.data.min_stars}*`;
  } else {
    new_title += `${fancy_min_stars}-${fancy_max_stars}*`;
  }

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

async function select_next_map() {
  const MAP_TYPES = {
    1: 'graveyarded',
    2: 'wip',
    3: 'pending',
    4: 'ranked',
    5: 'approved',
    6: 'qualified',
    7: 'loved',
  };

  this.voteskips = [];
  clearTimeout(this.countdown);
  this.countdown = -1;

  if (this.recent_maps.length >= 25) {
    this.recent_maps.shift();
  }

  let new_map = null;
  let tries = 0;

  // If we have a variable star range, get it from the current lobby pp
  if (!this.data.fixed_star_range) {
    const meta = stmts.star_range_from_pp.get(
        this.median_aim,
        this.median_speed,
    );

    this.data.min_stars = meta.min_stars;
    this.data.max_stars = meta.max_stars;
  }

  do {
    new_map = stmts.select_map.get(
        this.median_aim,
        this.median_speed,
        this.data.min_stars,
        this.data.max_stars,
    );
    tries++;

    if (!new_map) break;
  } while ((this.recent_maps.includes(new_map.id)) && tries < 10);
  if (!new_map) {
    await this.send(`I couldn't find a map. Either the star range is too small or the bot was too slow to scan your profile (and you may !skip in a few seconds).`);
    return;
  }

  this.recent_maps.push(new_map.id);
  const pp = new_map.overall_pp;

  try {
    const sr = new_map.stars;
    const flavor = `${MAP_TYPES[new_map.ranked]} ${sr.toFixed(2)}*, ${Math.round(pp)}pp`;
    const map_name = `[https://osu.ppy.sh/beatmaps/${new_map.id} ${new_map.name}]`;
    const beatconnect_link = `[https://beatconnect.io/b/${new_map.set_id} [1]]`;
    const chimu_link = `[https://chimu.moe/d/${new_map.set_id} [2]]`;
    const nerina_link = `[https://api.nerinyan.moe/d/${new_map.set_id} [3]]`;
    const sayobot_link = `[https://osu.sayobot.cn/osu.php?s=${new_map.set_id} [4]]`;
    await this.send(`!mp map ${new_map.id} * | ${map_name} (${flavor}) Alternate downloads: ${beatconnect_link} ${chimu_link} ${nerina_link} ${sayobot_link}`);
    this.map = new_map;
    await set_new_title(this);
  } catch (e) {
    console.error(`${this.channel} Failed to switch to map ${new_map.id} ${new_map.name}:`, e);
  }
}


// Updates the lobby's median_pp value.
function update_median_pp(lobby) {
  const aims = [];
  const speeds = [];
  const overalls = [];
  const ars = [];
  const elos = [];

  for (const player of lobby.players) {
    let aim_pp = player.aim_pp;
    let speed_pp = player.speed_pp;
    let overall_pp = player.overall_pp;

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

    ars.push(player.avg_ar);
    elos.push(player.elo);
  }

  aims.sort((a, b) => a - b);
  speeds.sort((a, b) => a - b);
  overalls.sort((a, b) => a - b);
  ars.sort((a, b) => a - b);

  lobby.median_aim = median(aims) * Config.difficulty;
  lobby.median_speed = median(speeds) * Config.difficulty;
  lobby.median_overall = median(overalls) * Config.difficulty;
  lobby.median_ar = median(ars);
  lobby.median_elo = median(elos);

  return false;
}

async function init_lobby(lobby) {
  lobby.match_participants = [];
  lobby.recent_maps = [];
  lobby.votekicks = [];
  lobby.countdown = -1;
  lobby.median_overall = 0;
  lobby.select_next_map = select_next_map;
  lobby.data.mode = 'ranked';
  lobby.match_end_timeout = -1;

  lobby.on('password', async () => {
    // Ranked lobbies never should have a password
    if (lobby.passworded) {
      await lobby.send('!mp password');
    }
  });

  lobby.on('settings', async () => {
    for (const player of lobby.players) {
      // Have not scanned the player's profile in the last 24 hours
      if (player.last_update_tms + (3600 * 24 * 1000) <= Date.now()) {
        await scan_user_profile(player);
      }

      if (lobby.playing && player.state != 'No Map') {
        lobby.match_participants[player.username] = player;
      }
    }

    update_median_pp(lobby);

    // Cannot select a map until we fetched the player IDs via !mp settings.
    if (lobby.created_just_now) {
      await lobby.select_next_map();
      lobby.created_just_now = false;
    }
  });

  lobby.on('playerJoined', async (player) => {
    if (player.user_id) {
      update_median_pp(lobby);
      if (lobby.nb_players == 1) {
        await lobby.select_next_map();
      }
    }
  });

  lobby.on('playerLeft', async (player) => {
    // Dodgers get 0 score
    if (player.username in lobby.match_participants) {
      const score = {
        username: player.username,
        score: 0,
        state: 'FAILED',
      };

      lobby.scores.push(score);
      lobby.emit('score', score);
    }

    update_median_pp(lobby);

    if (lobby.nb_players == 0) {
      if (!lobby.data.fixed_star_range) {
        lobby.data.min_stars = 0.0;
        lobby.data.max_stars = 11.0;
        await set_new_title(lobby);
      }
      return;
    }
  });

  const kick_afk_players = async () => {
    const players_to_kick = [];
    for (const username in lobby.match_participants) {
      // If the player hasn't scored after 10 seconds, they should get kicked
      if (!lobby.scores.some((s) => s.username == username)) {
        players_to_kick.push(username);
      }
    }

    // It never is more than 1 player who is causing issues. To make sure we
    // don't kick the whole lobby, let's wait a bit more.
    if (players_to_kick.length > 1) {
      lobby.match_end_timeout = setTimeout(kick_afk_players, 10000);
      return;
    }

    for (const username of players_to_kick) {
      await lobby.send(`!mp kick ${username}`);
    }
  };

  lobby.on('score', (score) => {
    // Sometimes players prevent the match from ending. Bancho will only end
    // the match after ~2 minutes of players waiting, which is very
    // frustrating. To avoid having to close the game or wait an eternity, we
    // kick the offending player.
    if (score.score > 0 && lobby.match_end_timeout == -1) {
      lobby.match_end_timeout = setTimeout(kick_afk_players, 10000);
    }
  });

  lobby.on('matchFinished', async (scores) => {
    clearTimeout(lobby.match_end_timeout);
    lobby.match_end_timeout = -1;

    const rank_updates = update_mmr(lobby);
    await lobby.select_next_map();

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
  });

  lobby.on('close', async () => {
    // Lobby closed (intentionally or not), clean up
    bancho.joined_lobbies.splice(bancho.joined_lobbies.indexOf(lobby), 1);
    await remove_lobby_listing(lobby.id);
  });

  lobby.on('allPlayersReady', async () => {
    // Players can spam the Ready button and due to lag, this command could
    // be spammed before the match actually got started.
    if (!lobby.playing) {
      lobby.playing = true;
      await lobby.send(`!mp start .${Math.random().toString(36).substring(2, 6)}`);
    }
  });

  lobby.on('matchStarted', async () => {
    clearTimeout(lobby.countdown);
    lobby.countdown = -1;

    lobby.match_participants = [];
    await lobby.send(`!mp settings ${Math.random().toString(36).substring(2, 6)}`);
  });

  if (lobby.created_just_now) {
    await lobby.send(`!mp settings ${Math.random().toString(36).substring(2, 6)}`);
    await lobby.send('!mp clearhost');
    await lobby.send('!mp password');
    if (lobby.data.is_scorev2) {
      await lobby.send(`!mp set 0 3 16`);
    } else {
      await lobby.send(`!mp set 0 0 16`);
    }

    await lobby.send('!mp mods freemod');
  } else {
    await lobby.send(`!mp settings (restarted) ${Math.random().toString(36).substring(2, 6)}`);
  }

  bancho.joined_lobbies.push(lobby);
}

export {
  init_lobby,
};
