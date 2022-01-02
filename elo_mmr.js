// JavaScript port of https://github.com/EbTech/Elo-MMR (simple_elo_mmr.rs)
// Might be incorrect. I wish math people stopped using those weird runes.

import {strict as assert} from 'assert';
import {open} from 'sqlite';
import sqlite3 from 'sqlite3';
import SQL from 'sql-template-strings';

import {init_databases} from './database.js';
import {update_discord_role} from './discord_updates.js';
import Config from './util/config.js';

let db = null;
// let maps_db = null;


// Squared variation in individual performances
const BETA = 400.0;

// Each contest participation adds an amount of drift such that, in the
// absence of much time passing, the limiting skill uncertainty's square
// approaches this value
const SIG_LIMIT = 80.0;

// Additional drift
const DRIFT_PER_MILLISECOND = 0.000000001;

// Maximum number of opponents and recent events to use, as a compute-saving
// approximation
const TRANSFER_SPEED = 1.0;

// Limits the maximum number of contests to be included in the rating
// computation
const MAX_LOGISTIC_FACTORS = 1000;

const TANH_MULTIPLIER = Math.PI / 1.7320508075688772;

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

assert(BETA > SIG_LIMIT, 'beta must exceed sig_limit');


class Contest {
  constructor(lobby) {
    this.lobby_id = lobby.id;
    this.lobby_creator = lobby.creator;
    this.map_id = lobby.beatmap_id;
    this.tms = lobby.mock_tms || Date.now();
    this.win_condition = lobby.win_condition;
    this.mods = lobby.is_dt ? 64 : 0;

    // Reduce database calls when recomputing all ranks in simulated lobbies.
    // (mostly related to in-lobby rank change display)
    this.fast_recompute = (typeof lobby.mock_tms !== 'undefined');

    // `standings` is an array of objects of the following type:
    // {
    //   player: <Player object>,
    //   lo: <ranking of the player, with the best player having index 0>,
    //   hi: <tie discriminator. if there's no tie, this is == lo>
    // }
    //
    // Here, 'ranking' means the ranking of the player in the current round.
    // In a round of 16 players, 0 <= lo <= 15.
    //
    // When there's a tie, all the players in a tie have the same `hi` and `lo`
    // values. For example, if the 3 first players were tied, their values
    // would be `lo = 0` and `hi = 2`. The fourth player would then be
    // `lo = 3` and `hi = 3`, and so on.
    this.standings = [];
    for (const username in lobby.scores) {
      if (lobby.scores.hasOwnProperty(username)) {
        this.standings.push({
          player: lobby.match_participants[username],
          score: lobby.scores[username],
          mods: lobby.is_dt ? 64 : 0,
        });
      }
    }

    this.standings.sort((a, b) => a.score - b.score);
    this.standings.reverse();

    let last_score = -1;
    let last_tie = 0;
    this.standings.forEach((elm, i) => {
      if (elm.score == last_score) {
        // Tie: set `lo` to `last_tie`
        elm.lo = last_tie;
        elm.hi = i;

        // Update `hi` of tied players
        const ties = this.standings.filter((s) => s.lo == last_tie);
        for (const tie of ties) {
          tie.hi = i;
        }
      } else {
        // No tie
        elm.lo = i;
        elm.hi = i;
        last_tie = i;
      }

      last_score = elm.score;
    });
  }

  async init() {
    const res = await db.run(SQL`
      INSERT INTO contest (lobby_id, map_id, scoring_system, mods, tms, lobby_creator, weight)
      VALUES (${this.lobby_id}, ${this.map_id}, ${this.win_condition}, ${this.mods}, ${this.tms}, ${this.lobby_creator}, ${this.weight})`,
    );
    this.id = res.lastID;

    for (const standing of this.standings) {
      // Initialize player data, if not already done
      if (typeof standing.player.logistic_factors === 'undefined') {
        if (this.fast_recompute) {
          throw new Error('Player data should already be set for ' + standing.player.username);
        }

        standing.player.approx_posterior = new Rating(standing.player.approx_mu, standing.player.approx_sig);
        standing.player.normal_factor = new Rating(standing.player.normal_mu, standing.player.normal_sig);
        standing.player.logistic_factors = [];

        const scores = await db.all(SQL`
          SELECT logistic_mu, logistic_sig FROM score
          WHERE user_id = ${standing.player.user_id} AND ignored = 0
          ORDER BY tms DESC LIMIT ${MAX_LOGISTIC_FACTORS}`,
        );
        for (const score of scores) {
          standing.player.logistic_factors.push(new TanhTerm(new Rating(score.logistic_mu, score.logistic_sig)));
        }

        // Not used for computing new rank - but for knowing when the display text changed
        const rank = await get_rank(standing.player.approx_posterior.toFloat());
        standing.player.rank_float = rank.ratio;
      }
    }
  }
}


class Rating {
  constructor(mu, sig) {
    this.mu = mu;
    this.sig = sig;
  }

  with_noise(sig_noise) {
    return new Rating(this.mu, Math.min(350.0, Math.hypot(this.sig, sig_noise)));
  }

  toFloat() {
    return this.mu - 3.0 * (this.sig - SIG_LIMIT);
  }

  toInt() {
    return Math.round(this.toFloat());
  }
};

class TanhTerm {
  constructor(rating) {
    const w = TANH_MULTIPLIER / rating.sig;
    this.mu = rating.mu;
    this.w_arg = w * 0.5;
    this.w_out = w;
  }

  base_values(x) {
    const z = (x - this.mu) * this.w_arg;
    const val = -Math.tanh(z) * this.w_out;
    const val_prime = -Math.pow(Math.cosh(z), -2) * this.w_arg * this.w_out;
    return [val, val_prime];
  }

  get_weight() {
    return this.w_arg * this.w_out * 2.0 / Math.pow(TANH_MULTIPLIER, 2);
  }
};


function solve_newton(f) {
  let lo = -6000.0;
  let hi = 9000.0;
  let guess = 0.5 * (lo + hi);

  do {
    const [sum, sum_prime] = f(guess);
    const extrapolate = guess - sum / sum_prime;
    if (extrapolate < guess) {
      hi = guess;
      guess = Math.min(Math.max(extrapolate, hi - 0.75 * (hi - lo)), hi);
    } else {
      lo = guess;
      guess = Math.min(Math.max(extrapolate, lo), lo + 0.75 * (hi - lo));
    }
  } while (lo < guess && hi > guess);

  return guess;
}

async function apply_rank_decay() {
  try {
    console.info('[Decay] Applying rank decay');
    const excess_beta_sq = (BETA * BETA - SIG_LIMIT * SIG_LIMIT);
    const discrete_drift = Math.pow(SIG_LIMIT, 4) / excess_beta_sq;
    const continuous_drift = DRIFT_PER_MILLISECOND * Date.now();
    const sig_drift = Math.sqrt(discrete_drift + continuous_drift);

    const month_ago_tms = Date.now() - (30 * 24 * 3600 * 1000);
    let players = await db.all(SQL`
      SELECT user_id, approx_mu, approx_sig FROM user
      WHERE games_played > 4 AND last_contest_tms > ${month_ago_tms}`,
    );

    let i = 1;
    for (const player of players) {
      if (i == 1 || i % 1000 == 0) {
        console.info(`[Decay] Updating player elos (${i}/${players.length})`);
      }

      const rating = new Rating(player.approx_mu, player.approx_sig);
      const new_rating = rating.with_noise(sig_drift);
      const new_elo = new_rating.toFloat();
      player.new_elo = new_elo;
      await db.run(SQL`UPDATE user SET elo = ${new_elo} WHERE user_id = ${player.user_id}`);
      i++;
    }

    i = 1;
    players = await db.all(SQL`
      SELECT user_id FROM user
      WHERE games_played > 4 AND last_contest_tms > ${month_ago_tms}
      ORDER BY elo ASC`,
    );
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

async function update_mmr(lobby) {
  if (!db) {
    await init_db();
  }

  const contest = new Contest(lobby);
  if (contest.standings.length < 2) return [];

  // // Bot restarted, fetch how much the map weighs.
  // if (!lobby.current_map_pp) {
  //   const pp = await maps_db.get(SQL`
  //     SELECT pp FROM pp
  //     WHERE map_id = ${contest.map_id} AND mods = ${contest.mods | (1<<16)}`,
  //   );
  //   if (!pp) {
  //     console.error('Failed to fetch pp for map', contest.map_id, 'with mods', contest.mods);
  //     return [];
  //   }

  //   lobby.current_map_pp = pp.pp;
  // }

  // contest.weight = Math.min(lobby.current_map_pp / 500.0, 1.0);
  // contest.weight = 1.0 - Math.pow(1.0 - contest.weight, 4.0);
  await contest.init();

  // Compute sig_perf and discrete_drift
  const excess_beta_sq = (BETA * BETA - SIG_LIMIT * SIG_LIMIT);
  const sig_perf = Math.sqrt(SIG_LIMIT * SIG_LIMIT + excess_beta_sq);
  const discrete_drift = Math.pow(SIG_LIMIT, 4) / excess_beta_sq;
  const continuous_drift = DRIFT_PER_MILLISECOND * contest.tms;
  const sig_drift = Math.sqrt(discrete_drift + continuous_drift);

  // Update ratings due to waiting period between contests, then use it to
  // create Gaussian terms for the Q-function. The rank must also be stored
  // in order to determine if it's a win, loss, or tie term.
  for (const standing of contest.standings) {
    // Save old values, in case the standing gets cancelled later
    standing.player.old_approx_posterior = new Rating(standing.player.approx_posterior.mu, standing.player.approx_posterior.sig);
    standing.player.old_normal_factor = new Rating(standing.player.normal_factor.mu, standing.player.normal_factor.sig);

    const new_rating = standing.player.approx_posterior.with_noise(sig_drift);
    const decay = Math.pow(standing.player.approx_posterior.sig / new_rating.sig, 2);
    const transfer = Math.pow(decay, TRANSFER_SPEED);
    standing.player.approx_posterior = new_rating;

    const wt_norm_old = Math.pow(standing.player.normal_factor.sig, -2);
    const wt_from_norm_old = transfer * wt_norm_old;
    let bruh_sum = 0.0;
    for (const term of standing.player.logistic_factors) {
      bruh_sum += term.get_weight();
    }
    const wt_from_transfers = (1.0 - transfer) * (wt_norm_old + bruh_sum);
    const wt_total = wt_from_norm_old + wt_from_transfers;

    standing.player.base_normal_factor = new Rating(
        (wt_from_norm_old * standing.player.normal_factor.mu + wt_from_transfers * standing.player.approx_posterior.mu) / wt_total,
        Math.sqrt(1.0 / (decay * wt_total)),
    );
    for (const r of standing.player.logistic_factors) {
      r.w_out *= transfer * decay;
    }
  }

  // The computational bottleneck: update ratings based on contest performance
  const update_ratings = () => {
    const tanh_terms = [];
    for (const standing of contest.standings) {
      tanh_terms.push(new TanhTerm(standing.player.approx_posterior.with_noise(sig_perf)));
    }

    for (const standing of contest.standings) {
      const player = standing.player;

      // Reset to known good values before recomputing elo
      player.approx_posterior = new Rating(player.old_approx_posterior.mu, player.old_approx_posterior.sig);
      player.normal_factor = new Rating(player.base_normal_factor.mu, player.base_normal_factor.sig);

      const mu_perf = solve_newton((x) => {
        let sum = 0.0;
        let sum_prime = 0.0;
        for (let i = 0; i < tanh_terms.length; i++) {
          const [val, val_prime] = tanh_terms[i].base_values(x);
          if (i < standing.lo) {
            sum += val - tanh_terms[i].w_out;
            sum_prime += val_prime;
          } else if (i <= standing.hi) {
            sum += 2.0 * val;
            sum_prime += 2.0 * val_prime;
          } else {
            sum += val + tanh_terms[i].w_out;
            sum_prime += val_prime;
          }
        }

        return [sum, sum_prime];
      });

      player.performance = new Rating(mu_perf, sig_perf);

      if (player.logistic_factors.length >= MAX_LOGISTIC_FACTORS) {
        // wl can be chosen so as to preserve total weight or rating; we choose the former.
        // Either way, the deleted element should be small enough not to matter.
        const logistic = player.logistic_factors.shift();
        const wn = Math.pow(player.normal_factor.sig, -2);
        const wl = logistic.get_weight();
        player.normal_factor.mu = (wn * player.normal_factor.mu + wl * logistic.mu) / (wn + wl);
        player.normal_factor.sig = Math.sqrt(1.0 / (wn + wl));
      }
      player.logistic_factors.push(new TanhTerm(player.performance));

      const normal_weight = Math.pow(player.normal_factor.sig, -2);
      const mu = solve_newton((x) => {
        let sum = -player.normal_factor.mu * normal_weight + normal_weight * x;
        let sum_prime = normal_weight;
        for (const term of player.logistic_factors) {
          const tanh_z = Math.tanh((x - term.mu) * term.w_arg);
          sum += tanh_z * term.w_out;
          sum_prime += (1. - tanh_z * tanh_z) * term.w_arg * term.w_out;
        }
        return [sum, sum_prime];
      });
      const sig = Math.sqrt(1.0 / (Math.pow(player.approx_posterior.sig, -2) + Math.pow(player.performance.sig, -2)));
      player.approx_posterior = new Rating(mu, sig);
    }
  };

  const ignore_standing = async (standing) => {
    standing.player.approx_posterior = new Rating(standing.player.old_approx_posterior.mu, standing.player.old_approx_posterior.sig);
    standing.player.normal_factor = new Rating(standing.player.old_normal_factor.mu, standing.player.old_normal_factor.sig);
    for (const term of standing.player.logistic_factors) {
      // reset w_out to w (knowing that w_arg = w / 2)
      term.w_out = term.w_arg * 2;
    }

    // Add "ignored" score to the database for website display
    await db.run(SQL`
      INSERT INTO score (
        user_id, contest_id, score, mods,
        logistic_mu, logistic_sig, tms, ignored, difference
      )
      VALUES (
        ${standing.player.user_id}, ${contest.id}, ${standing.score}, ${standing.mods},
        ${standing.player.approx_posterior.mu}, ${standing.player.approx_posterior.sig}, ${contest.tms}, 1, 0.0
      )`,
    );
    await db.run(SQL`
      UPDATE user
      SET
        games_played = (SELECT COUNT(*) FROM score WHERE user_id = ${standing.player.user_id}),
        last_contest_tms = ${contest.tms}
      WHERE user_id = ${standing.player.user_id}`,
    );
    standing.player.games_played++;

    // Remove player from standings and recomute lo/hi
    contest.standings.shift();
    let last_score = -1;
    let last_tie = 0;
    contest.standings.forEach((elm, i) => {
      if (elm.score == last_score) {
        // Tie: set `lo` to `last_tie`
        elm.lo = last_tie;
        elm.hi = i;

        // Update `hi` of tied players
        const ties = contest.standings.filter((s) => s.lo == last_tie);
        for (const tie of ties) {
          tie.hi = i;
        }
      } else {
        // No tie
        elm.lo = i;
        elm.hi = i;
        last_tie = i;
      }

      last_score = elm.score;
    });
  };

  while (contest.standings.length > 1) {
    update_ratings();

    const best_standing = contest.standings[0];
    if (best_standing.player.elo > best_standing.player.approx_posterior.toFloat()) {
      for (const standing of contest.standings) {
        standing.player.logistic_factors.pop();
      }

      console.info(`Ignoring ${best_standing.player.username}'s standing for contest #${contest.id} (${best_standing.player.elo} > ${best_standing.player.approx_posterior.toFloat()})`);
      await ignore_standing(best_standing);
    } else {
      break;
    }
  }

  // Edge case: if too many players rank first and still lose elo, there can
  // be a situation where not enough players are in the contest for it to
  // matter.
  if (contest.standings.length < 2) {
    if (contest.standings.length == 1) {
      await ignore_standing(contest.standings[0]);
    }

    return [];
  }

  for (const standing of contest.standings) {
    const old_elo = standing.player.elo;
    const new_elo = standing.player.approx_posterior.toFloat();
    standing.player.elo = new_elo;
    standing.player.games_played++;

    await db.run(SQL`
      INSERT INTO score (
        user_id, contest_id, score, mods,
        logistic_mu, logistic_sig, tms, ignored, difference
      )
      VALUES (
        ${standing.player.user_id}, ${contest.id}, ${standing.score}, ${standing.mods},
        ${standing.player.performance.mu}, ${standing.player.performance.sig}, ${contest.tms}, 0, ${new_elo - old_elo}
      )`,
    );
    await db.run(SQL`
      UPDATE user
      SET
        elo = ${new_elo},
        approx_mu = ${standing.player.approx_posterior.mu},
        approx_sig = ${standing.player.approx_posterior.sig},
        normal_mu = ${standing.player.normal_factor.mu},
        normal_sig = ${standing.player.normal_factor.sig},
        games_played = (SELECT COUNT(*) FROM score WHERE user_id = ${standing.player.user_id}),
        last_contest_tms = ${contest.tms}
      WHERE user_id = ${standing.player.user_id}`,
    );
  }

  if (contest.fast_recompute) return [];

  const division_to_index = (text) => {
    if (text == 'Unranked') {
      return -1;
    } else if (text == 'The One') {
      return RANK_DIVISIONS.length;
    } else {
      return RANK_DIVISIONS.indexOf(text);
    }
  };

  // Return the users whose rank's display text changed
  const rank_changes = [];
  for (const standing of contest.standings) {
    if (standing.player.games_played < 5) continue;

    const new_rank = await get_rank(standing.player.approx_posterior.toFloat());
    if (new_rank.text != standing.player.rank_text) {
      const old_index = division_to_index(standing.player.rank_text);
      const new_index = division_to_index(new_rank.text);

      if (new_index > old_index) {
        rank_changes.push(`${standing.player.username} [${Config.website_base_url}/u/${standing.player.user_id}/ ▲ ${new_rank.text} ]`);
      } else {
        rank_changes.push(`${standing.player.username} [${Config.website_base_url}/u/${standing.player.user_id}/ ▼ ${new_rank.text} ]`);
      }

      await update_discord_role(standing.player.user_id, new_rank.text);

      standing.player.rank_float = new_rank.ratio;
      standing.player.rank_text = new_rank.text;
      await db.run(SQL`
        UPDATE user SET rank_text = ${new_rank.text}
        WHERE user_id = ${standing.player.user_id}`,
      );
    }
  }
  return rank_changes;
}


function get_rank_text(rank_float) {
  // TODO: use a better distribution, so diamond doesn't feel underwhelming
  // put more players in bronze/silver? gaussian distribution? see valorant's

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

    // This turns a linear curve into a smoother curve (yeah I'm not good at maths)
    // Visual representation: https://www.wolframalpha.com/input/?i=1+-+%28%28cos%28x+*+PI%29+%2F+2%29+%2B+0.5%29+with+x+from+0+to+1
    const cutoff = 1 - ((Math.cos(rank_nb * Math.PI) / 2) + 0.5);
    if (rank_float < cutoff) {
      return RANK_DIVISIONS[i];
    }
  }

  // Ok, floating point errors, who cares
  return RANK_DIVISIONS[RANK_DIVISIONS.length - 1];
}

async function get_rank(elo) {
  if (!db) {
    await init_db();
  }

  const month_ago_tms = Date.now() - (30 * 24 * 3600 * 1000);
  const better_users = await db.get(SQL`
    SELECT COUNT(*) AS nb FROM user
    WHERE elo > ${elo} AND games_played > 4 AND last_contest_tms > ${month_ago_tms}`,
  );
  const all_users = await db.get(SQL`
    SELECT COUNT(*) AS nb FROM user
    WHERE games_played > 4 AND last_contest_tms > ${month_ago_tms}`,
  );
  const ratio = 1.0 - (better_users.nb / all_users.nb);

  return {
    elo: elo,
    ratio: ratio,
    total_nb: all_users.nb,
    rank_nb: better_users.nb + 1,
    text: get_rank_text(ratio),
  };
}

async function get_rank_text_from_id(osu_user_id) {
  if (!db) {
    await init_db();
  }

  const res = await db.get(SQL`
    SELECT elo, games_played FROM user
    WHERE user_id = ${osu_user_id}`,
  );
  if (!res || !res.elo || res.games_played < 5) {
    return 'Unranked';
  }

  const rank = await get_rank(res.elo);
  return rank.text;
}

async function init_db() {
  const databases = await init_databases();
  db = databases.ranks;
  // maps_db = databases.maps;

  return db;
}

export {init_db, update_mmr, get_rank, get_rank_text_from_id, apply_rank_decay, Rating};
