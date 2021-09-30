// JavaScript port of https://github.com/EbTech/Elo-MMR (simple_elo_mmr.rs)
// Might be incorrect. I wish math people stopped using those weird runes.

import {strict as assert} from 'assert';
import {open} from 'sqlite';
import sqlite3 from 'sqlite3';


let db = null;


// Squared variation in individual performances, when the contest_weight is 1
const BETA = 200.0;

// Each contest participation adds an amount of drift such that, in the
// absence of much time passing, the limiting skill uncertainty's square
// approaches this value
const SIG_LIMIT = 80.0;

// Additional variance per second, from a drift that's continuous in time
const DRIFT_PER_SEC = 0.0;

// Maximum number of opponents and recent events to use, as a compute-saving
// approximation
const TRANSFER_SPEED = 1.0;

// Limits the maximum number of contests to be included in the rating
// computation
const MAX_LOGISTIC_FACTORS = 1000;

const TANH_MULTIPLIER = Math.PI / 1.7320508075688772;

assert(BETA > SIG_LIMIT, 'beta must exceed sig_limit');


// To avoid re-fetching players from the database after the end of each
// contest, we store all of them in memory. It should be fine for now, but in
// the future, we should use a cache instead.
const players = [];


class Contest {
  constructor(lobby) {
    this.lobby_id = lobby.id;
    this.map_id = lobby.beatmapId;
    this.tms = Date.now();

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
    for (const score of lobby.scores) {
      this.standings.push({
        player_id: score.player.user.id,
        bancho_user: score.player.user,
        score: score.score,
      });
    }
    this.standings.sort((a, b) => a.score - b.score);
    this.standings.reverse();
    let last_score = -1;
    let lo = 0;
    let hi = -1;
    for (const standing of this.standings) {
      standing.lo = lo;
      standing.hi = hi;
      if (standing.score == last_score) {
        hi++;
        for (const s of this.standings) {
          if (s.lo == lo) {
            s.hi = hi;
          }
        }
      } else {
        lo++;
        hi = lo;
        last_score = standing.score;
      }
    }
  }

  // Fills the missing values from `this.standings`
  // Fetches players from database if they're not already loaded - expensive operation.
  async init() {
    const res = await db.run(
        'INSERT INTO contest (lobby_id, map_id, tms) VALUES (?, ?, ?)',
        this.lobby_id, this.map_id, this.tms,
    );
    this.id = res.lastID;

    for (const standing of this.standings) {
      if (!(standing.player_id in players)) {
        players[standing.player_id] = new Player(standing.bancho_user);
        await players[standing.player_id].fetch_from_database();
      }
      standing.player = players[standing.player_id];
    }
  }
}


class Player {
  constructor(bancho_user) {
    this.user_id = bancho_user.id;
    this.username = bancho_user.ircUsername;
    this.approx_posterior = new Rating(1500.0, 350.0);
    this.normal_factor = new Rating(1500.0, 350.0);
    this.logistic_factors = [];
  }

  // Fetches ranking data from the database.
  //
  // If the user is new -> initialize them in the database
  // If the user isn't new -> get their rating and logistic factors
  async fetch_from_database() {
    const user = await db.get('SELECT * FROM user WHERE user_id = ?', this.user_id);
    if (!user) {
      await db.run(
          `INSERT INTO user (user_id, username, approx_mu, approx_sig, normal_mu, normal_sig)
        VALUES (?, ?, 1500, 350, 1500, 350)`,
          this.user_id, this.username,
      );
      this.old_rating = null;
      return;
    }

    // User changed their nickname - update it in database
    if (this.username != user.username) {
      console.log('INFO: ' + user.username + ' is now known as ' + this.username + '.');
      await db.run('UPDATE user SET username = ? WHERE user_id = ?', this.username, this.user_id);
    }

    this.approx_posterior = new Rating(user.approx_mu, user.approx_sig);
    this.normal_factor = new Rating(user.normal_mu, user.normal_sig);

    const scores = await db.all(
        'SELECT logistic_mu, logistic_sig FROM score WHERE user_id = ? ORDER BY tms DESC LIMIT ?',
        this.user_id, MAX_LOGISTIC_FACTORS,
    );
    for (const score of scores) {
      this.logistic_factors.push(new TanhTerm(new Rating(score.logistic_mu, score.logistic_sig)));
    }

    // Not used for computing new rank - but for knowing when the display text changed
    const better_users = await db.get('SELECT COUNT(*) AS nb FROM user WHERE elo > ?', this.approx_posterior.toFloat());
    const all_users = await db.get('SELECT COUNT(*) AS nb FROM user');
    this.rank_float = 1.0 - (better_users.nb / all_users.nb);
  }

  // Modifies the player object. Returns nothing.
  add_noise_best(sig_noise) {
    const new_rating = this.approx_posterior.with_noise(sig_noise);
    const decay = Math.pow(this.approx_posterior.sig / new_rating.sig, 2);
    const transfer = Math.pow(decay, TRANSFER_SPEED);
    this.approx_posterior = new_rating;

    const wt_norm_old = Math.pow(this.normal_factor.sig, -2);
    const wt_from_norm_old = transfer * wt_norm_old;
    let bruh_sum = 0.0;
    for (const term of this.logistic_factors) {
      bruh_sum += term.get_weight();
    }
    const wt_from_transfers = (1.0 - transfer) * (wt_norm_old + bruh_sum);
    const wt_total = wt_from_norm_old + wt_from_transfers;

    this.normal_factor.mu = (wt_from_norm_old * this.normal_factor.mu + wt_from_transfers * this.approx_posterior.mu) / wt_total;
    this.normal_factor.sig = Math.sqrt(1.0 / (decay * wt_total));
    for (const r of this.logistic_factors) {
      r.w_out *= transfer * decay;
    }
  }
};

class Rating {
  constructor(mu, sig) {
    this.mu = mu;
    this.sig = sig;
  }

  with_noise(sig_noise) {
    return new Rating(this.mu, Math.hypot(this.sig, sig_noise));
  }

  toFloat() {
    return this.mu - 2.0 * (this.sig - SIG_LIMIT);
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

async function update_mmr(lobby) {
  const contest = new Contest(lobby);
  if (contest.standings.length < 2) return [];
  await contest.init();

  // `contest_weight` is a float that depends on multiple factors:
  // - how full the lobby is. 1 player in lobby means 1/16 the weight
  // - TODO: how well the players scored on average. did they reach expected pp,
  //   or did they all fail the map? the contest weighs less if the map sucked.
  const contest_weight = contest.standings.length / 16.0;

  // Compute sig_perf and discrete_drift from contest_weight
  const excess_beta_sq = (BETA * BETA - SIG_LIMIT * SIG_LIMIT) / contest_weight;
  const sig_perf = Math.sqrt(SIG_LIMIT * SIG_LIMIT + excess_beta_sq);
  const discrete_drift = Math.pow(SIG_LIMIT, 4) / excess_beta_sq;

  // Update ratings due to waiting period between contests, then use it to
  // create Gaussian terms for the Q-function. The rank must also be stored
  // in order to determine if it's a win, loss, or tie term.
  const tanh_terms = [];
  for (const standing of contest.standings) {
    const continuous_drift = DRIFT_PER_SEC * contest.tms;
    const sig_drift = Math.sqrt(discrete_drift + continuous_drift);
    standing.player.add_noise_best(sig_drift);
    tanh_terms.push(new TanhTerm(standing.player.approx_posterior.with_noise(sig_perf)));
  }

  // The computational bottleneck: update ratings based on contest performance
  for (const standing of contest.standings) {
    const player = standing.player;

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

    const performance = new Rating(mu_perf, sig_perf);

    if (player.logistic_factors.length >= MAX_LOGISTIC_FACTORS) {
      // wl can be chosen so as to preserve total weight or rating; we choose the former.
      // Either way, the deleted element should be small enough not to matter.
      const logistic = player.logistic_factors.shift();
      const wn = Math.pow(player.normal_factor.sig, -2);
      const wl = logistic.get_weight();
      player.normal_factor.mu = (wn * player.normal_factor.mu + wl * logistic.mu) / (wn + wl);
      player.normal_factor.sig = Math.sqrt(1.0 / (wn + wl));
    }
    player.logistic_factors.push(new TanhTerm(performance));

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
    const sig = Math.sqrt(1.0 / (Math.pow(player.approx_posterior.sig, -2) + Math.pow(performance.sig, -2)));
    player.approx_posterior = new Rating(mu, sig);

    await db.run(
        'UPDATE user SET elo = ?, approx_mu = ?, approx_sig = ?, normal_mu = ?, normal_sig = ? WHERE user_id = ?',
        player.approx_posterior.toFloat(), mu, sig, player.normal_factor.mu, player.normal_factor.sig, player.user_id,
    );
    await db.run(
        'INSERT INTO score (user_id, contest_id, score, logistic_mu, logistic_sig, tms) VALUES (?, ?, ?, ?, ?, ?)',
        player.user_id, contest.id, standing.score, performance.mu, performance.sig, contest.tms,
    );
  }

  // Return the users whose rank's display text changed
  const rank_changes = [];
  for (const standing of contest.standings) {
    const better_users = await db.get('SELECT COUNT(*) AS nb FROM user WHERE elo > ?', standing.player.approx_posterior.toFloat());
    const all_users = await db.get('SELECT COUNT(*) AS nb FROM user');
    const new_rank_float = 1.0 - (better_users.nb / all_users.nb);
    if (get_rank_text(standing.player.rank_float) != get_rank_text(new_rank_float)) {
      rank_changes.push({
        user_id: standing.player.user_id,
        username: standing.player.username,
        rank_before: standing.player.rank_float,
        rank_after: new_rank_float,
      });
    }
    standing.player.rank_float = new_rank_float;
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
  const ranks = [
    'Cardboard',
    'Copper', 'Copper+', 'Copper++',
    'Bronze', 'Bronze+', 'Bronze++',
    'Silver', 'Silver+', 'Silver++',
    'Gold', 'Gold+', 'Gold++',
    'Platinum', 'Platinum+', 'Platinum++',
    'Diamond', 'Diamond+', 'Diamond++',
    'Legendary',
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
  return 'Legendary+';
}

async function get_rank_text_from_id(osu_user_id) {
  const res = await db.get('select elo from user where user_id = ?', osu_user_id);
  if (!res || !res.elo) {
    return 'Unranked';
  }

  const better_users = await db.get('SELECT COUNT(*) AS nb FROM user WHERE elo > ?', res.elo);
  const all_users = await db.get('SELECT COUNT(*) AS nb FROM user');
  return get_rank_text(1.0 - (better_users.nb / all_users.nb));
}

async function init_db() {
  db = await open({
    filename: 'ranks.db',
    driver: sqlite3.Database,
  });

  await db.exec(`CREATE TABLE IF NOT EXISTS user (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    elo REAL,
    approx_mu REAL,
    approx_sig REAL,
    normal_mu REAL,
    normal_sig REAL
  )`);

  await db.exec(`CREATE TABLE IF NOT EXISTS contest (
    lobby_id INTEGER,
    map_id INTEGER,
    tms INTEGER
  )`);

  await db.exec(`CREATE TABLE IF NOT EXISTS score (
    user_id INTEGER,
    contest_id INTEGER,
    score INTEGER,
    logistic_mu REAL,
    logistic_sig REAL,
    tms INTEGER
  )`);

  return db;
}

export {init_db, update_mmr, get_rank_text, get_rank_text_from_id};
