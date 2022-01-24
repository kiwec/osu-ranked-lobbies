// Required reading:
// - https://en.wikipedia.org/wiki/Glicko_rating_system
// - http://www.glicko.net/glicko/glicko2.pdf

import databases from './database.js';
import {update_discord_role} from './discord_updates.js';
import Config from './util/config.js';
import {capture_sentry_exception} from './util/helpers.js';


const stmts = {
  create_contest: databases.ranks.prepare(`
    INSERT INTO contest (lobby_id, map_id, mods, tms, lobby_creator)
    VALUES (?, ?, ?, ?, ?)`,
  ),
  insert_score: databases.ranks.prepare(`
    INSERT INTO score (
      user_id, contest_id, score, tms,
      map_id, old_elo, new_elo, new_deviation
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  update_user: databases.ranks.prepare(`
    UPDATE user
    SET
      elo = ?,
      approx_mu = ?,
      approx_sig = ?,
      games_played = ?,
      last_contest_tms = ?
    WHERE user_id = ?`,
  ),
  elo_from_id: databases.ranks.prepare(`
    SELECT elo, games_played FROM user
    WHERE user_id = ?`,
  ),
  ranked_user_count: databases.ranks.prepare(`
    SELECT COUNT(*) AS nb FROM user
    WHERE games_played > 4 AND last_contest_tms > ?`,
  ),
  better_users_count: databases.ranks.prepare(`
    SELECT COUNT(*) AS nb FROM user
    WHERE elo > ? AND games_played > 4 AND last_contest_tms > ?`,
  ),
};


const RANK_DIVISIONS = [
  'Cardboard',
  'Wood',
  'Wood+',
  'Wood++',
  'Bronze',
  'Bronze+',
  'Bronze++',
  'Silver',
  'Silver+',
  'Silver++',
  'Gold',
  'Gold+',
  'Gold++',
  'Platinum',
  'Platinum+',
  'Platinum++',
  'Diamond',
  'Diamond+',
  'Diamond++',
  'Legendary',
];


function get_new_deviation(player, contest_tms) {
  if (player.last_contest_tms == 0) return 350.0;

  // While the Glicko-2 paper says it works best if there are 10-15 games
  // per player in a rating period, we choose to make a rating period per
  // second. But since we don't use Glicko-2's volatility system (it can be
  // gamed for gaining ranks, and we use "importance" instead), this
  // doesn't matter.
  const SECONDS_PER_MONTH = 2592000;
  const C = Math.sqrt((350 * 350 - 50 * 50) / SECONDS_PER_MONTH);

  const time_since_last_play = (contest_tms - player.last_contest_tms) / 1000;
  return Math.min(
      350.0,
      Math.sqrt((player.approx_sig * player.approx_sig) + ((C * C) * time_since_last_play)),
  );
}


// This is used to let the bot work while we're running some synchronous task,
// like recomputing a lot of ranks. Without this, the bot would get timed out
// for not replying to pings.
function event_loop_hack() {
  return new Promise((resolve, reject) => {
    setTimeout(resolve, 100);
  });
}


// This method does not actually change any player's elo or derivation, but
// still updates their rank as if they played a game of 0 importance. We call
// this method hourly to make the rank decay mechanism visible, NOT to
// actually decay rank. (and yes, we use "elo" as a "display rank" in the
// database, which is confusing)
async function apply_rank_decay() {
  try {
    console.info('[Decay] Applying rank decay');
    const month_ago_tms = Date.now() - (30 * 24 * 3600 * 1000);
    const active_players_stmt = databases.ranks.prepare(`
      SELECT user_id, approx_mu, approx_sig, last_contest_tms FROM user
      WHERE games_played > 4 AND last_contest_tms > ?`,
    );
    let players = active_players_stmt.all(month_ago_tms);

    const update_elo_stmt = databases.ranks.prepare('UPDATE user SET elo = ? WHERE user_id = ?');
    let i = 1;
    const now = Date.now();
    for (const player of players) {
      if (i == 1 || i % 1000 == 0) {
        console.info(`[Decay] Updating player elos (${i}/${players.length})`);
        await event_loop_hack();
      }

      player.elo = player.approx_mu - (2 * get_new_deviation(player, now));
      update_elo_stmt.run(player.elo, player.user_id);
      i++;
    }

    i = 1;
    const players_by_elo_stmt = databases.ranks.prepare(`
      SELECT user_id FROM user
      WHERE games_played > 4 AND last_contest_tms > ?
      ORDER BY elo ASC`,
    );
    players = players_by_elo_stmt.all(month_ago_tms);

    for (const player of players) {
      if (i == 1 || i % 1000 == 0) {
        console.info(`[Decay] Updating discord roles (${i}/${players.length})`);
      }

      const new_rank_text = get_rank_text(i / players.length);
      await update_discord_role(player.user_id, new_rank_text);
      i++;
    }

    console.info('[Decay] Done applying rank decay');
  } catch (err) {
    console.error('Failed to apply rank decay:', err);
    capture_sentry_exception(err);
  }
}

async function update_mmr(lobby, contest_tms) {
  // Usually, we're in a live lobby, but sometimes we want to recompute all
  // scores (like after updating the ranking algorithm), so this boolean is
  // used to avoid extra database calls.
  let is_live_lobby = false;
  if (typeof contest_tms === 'undefined') {
    contest_tms = Date.now();
    is_live_lobby = true;
  }

  const res = stmts.create_contest.run(
      lobby.id, lobby.beatmap_id, lobby.is_dt ? 64 : 0, contest_tms, lobby.creator,
  );
  const contest_id = res.lastInsertRowid;

  const players = [];
  for (const username in lobby.scores) {
    if (lobby.scores.hasOwnProperty(username)) {
      const player = lobby.match_participants[username];
      player.old_approx_mu = player.approx_mu;
      player.score = lobby.scores[username];

      if (is_live_lobby) {
        player.rank_float = get_rank(player.elo).ratio;
      }

      players.push(player);
    }
  }

  // Step 2.
  for (const player of players) {
    player.approx_mu = (player.approx_mu - 1500.0) / 173.7178;
    player.approx_sig = get_new_deviation(player, contest_tms) / 173.7178;
  }

  const MAX_PP_DIFFERENCE = Math.log(500);
  for (const player of players) {
    // Steps 3. and 4.
    let outcomes = 0.0;
    let variance = 0.0;
    for (const opponent of players) {
      let score = 0.5;
      if (player.score > opponent.score) score = 1.0;
      if (player.score < opponent.score) score = 0.0;

      // Being far from the map's pp increases the opponent's volatility,
      // which means their play impacts the player's rank less.
      const opponent_pp = Config.difficulty * (opponent.overall_pp || 0);
      const opponent_sig = opponent.approx_sig + Math.abs(lobby.current_map_pp - opponent_pp);

      const fval = 1.0 / Math.sqrt(1.0 + 3.0 * opponent_sig * opponent_sig / (Math.PI * Math.PI));
      const gval = 1.0 / (1.0 + Math.exp(-fval * (player.approx_mu - opponent.approx_mu)));
      variance += fval * fval * gval * (1.0 - gval);
      outcomes += fval * (score - gval);
    }

    // Similarly, if the player's skill is more than 500pp from the map's
    // estimated difficulty, their rank won't change much (even though their
    // volatility will).
    const player_pp = Config.difficulty * (player.overall_pp || 0);
    let importance = MAX_PP_DIFFERENCE - Math.max(0, Math.log(Math.abs(lobby.current_map_pp - player_pp)));
    if (importance < 0) importance = 0;
    importance /= MAX_PP_DIFFERENCE;
    outcomes *= importance;

    // Step 6. and 7.
    player.new_approx_sig = 1.0 / Math.sqrt((1.0 / (player.approx_sig * player.approx_sig)) + (1.0 / Math.pow(variance, -1.0)));
    player.change = player.new_approx_sig * player.new_approx_sig * outcomes;
    player.new_approx_mu = player.approx_mu + player.change;
  }

  // Step 8.
  for (const player of players) {
    player.approx_mu = player.new_approx_mu * 173.7178 + 1500.0;
    player.approx_sig = Math.min(350.0, player.new_approx_sig * 173.7178);
    player.last_contest_tms = contest_tms;
    player.elo = player.approx_mu - (2 * player.approx_sig);
    player.games_played++;

    stmts.insert_score.run(
        player.user_id, contest_id, player.score, player.last_contest_tms,
        lobby.beatmap_id, player.old_approx_mu, player.approx_mu, player.approx_sig,
    );
    stmts.update_user.run(
        player.elo, player.approx_mu, player.approx_sig,
        player.games_played, player.last_contest_tms, player.user_id,
    );
  }

  // Return the users whose rank's display text changed
  const rank_changes = [];
  if (!is_live_lobby) return rank_changes;

  const division_to_index = (text) => {
    if (text == 'Unranked') {
      return -1;
    } else if (text == 'The One') {
      return RANK_DIVISIONS.length;
    } else {
      return RANK_DIVISIONS.indexOf(text);
    }
  };

  const update_rank_text_stmt = databases.ranks.prepare(`
    UPDATE user SET rank_text = ?
    WHERE user_id = ?`,
  );
  for (const player of players) {
    if (player.games_played < 5) continue;

    const new_rank = get_rank(player.elo);
    if (new_rank.text != player.rank_text) {
      const old_index = division_to_index(player.rank_text);
      const new_index = division_to_index(new_rank.text);

      if (new_index > old_index) {
        rank_changes.push(`${player.username} [${Config.website_base_url}/u/${player.user_id}/ ▲ ${new_rank.text} ]`);
      } else {
        rank_changes.push(`${player.username} [${Config.website_base_url}/u/${player.user_id}/ ▼ ${new_rank.text} ]`);
      }

      await update_discord_role(player.user_id, new_rank.text);

      player.rank_float = new_rank.ratio;
      player.rank_text = new_rank.text;
      update_rank_text_stmt.run(new_rank.text, player.user_id);
    }
  }

  return rank_changes;
}


function get_rank_text(rank_float) {
  if (rank_float == null || typeof rank_float === 'undefined') {
    return 'Unranked';
  }
  if (rank_float == 1.0) {
    return 'The One';
  }

  // Epic rank distribution algorithm
  for (let i = 0; i < RANK_DIVISIONS.length; i++) {
    // Turn current 'Cardboard' rank into a value between 0 and 1
    const rank_nb = (i + 1) / RANK_DIVISIONS.length;

    // To make climbing ranks more satisfying, we make lower ranks more common.
    // Visual representation: https://graphtoy.com/?f1(x,t)=1-((cos(x%5E0.8*%F0%9D%9C%8B)/2)+0.5)&v1=true&f2(x,t)=&v2=true&f3(x,t)=&v3=false&f4(x,t)=&v4=false&f5(x,t)=&v5=false&f6(x,t)=&v6=false&grid=true&coords=0.3918011117299855,0.3722110561434862,1.0068654346588846
    const cutoff = 1 - ((Math.cos(Math.pow(rank_nb, 0.8) * Math.PI) / 2) + 0.5);
    if (rank_float < cutoff) {
      return RANK_DIVISIONS[i];
    }
  }

  // Ok, floating point errors, who cares
  return RANK_DIVISIONS[RANK_DIVISIONS.length - 1];
}

function get_rank(elo) {
  const month_ago_tms = Date.now() - (30 * 24 * 3600 * 1000);
  const all_users = stmts.ranked_user_count.get(month_ago_tms);
  const better_users = stmts.better_users_count.get(elo, month_ago_tms);
  const ratio = 1.0 - (better_users.nb / all_users.nb);

  return {
    elo: elo,
    ratio: ratio,
    total_nb: all_users.nb,
    rank_nb: better_users.nb + 1,
    text: get_rank_text(ratio),
  };
}

function get_rank_text_from_id(osu_user_id) {
  const res = elo_from_id.get(osu_user_id);
  if (!res || !res.elo || res.games_played < 5) {
    return 'Unranked';
  }

  return get_rank(res.elo).text;
}

export {update_mmr, get_rank, get_rank_text_from_id, apply_rank_decay};
