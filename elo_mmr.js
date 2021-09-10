// JavaScript port of https://github.com/EbTech/Elo-MMR (simple_elo_mmr.rs)
// Might be incorrect. I wish math people stopped using those weird runes.

import {strict as assert} from 'assert';
import fs from 'fs';


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


class Player {
  constructor(username) {
    this.username = username;

    // Here, we're assuming the player is new. If the player already has a
    // rank, we should fetch their approx_posterior, normal_factor and
    // logistic_factors from the database.
    this.approx_posterior = new Rating(1500.0, 350.0);
    this.normal_factor = new Rating(1500.0, 350.0);
    this.logistic_factors = [];
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

  // Modifies the player object. Returns nothing.
  // TODO: update database
  update_rating_with_logistic(performance) {
    if (this.logistic_factors.length >= MAX_LOGISTIC_FACTORS) {
      // wl can be chosen so as to preserve total weight or rating; we choose the former.
      // Either way, the deleted element should be small enough not to matter.
      const logistic = this.logistic_factors.shift();
      const wn = Math.pow(this.normal_factor.sig, -2);
      const wl = logistic.get_weight();
      this.normal_factor.mu = (wn * this.normal_factor.mu + wl * logistic.mu) / (wn + wl);
      this.normal_factor.sig = Math.sqrt(1.0 / (wn + wl));
    }
    this.logistic_factors.push(new TanhTerm(performance));

    const normal_weight = Math.pow(this.normal_factor.sig, -2);
    const mu = solve_newton((x) => {
      let sum = -this.normal_factor.mu * normal_weight + normal_weight * x;
      let sum_prime = normal_weight;
      for (const term of this.logistic_factors) {
        const tanh_z = Math.tanh((x - term.mu) * term.w_arg);
        sum += tanh_z * term.w_out;
        sum_prime += (1. - tanh_z * tanh_z) * term.w_arg * term.w_out;
      }
      return [sum, sum_prime];
    });
    const sig = Math.sqrt(1.0 / (Math.pow(this.approx_posterior.sig, -2) + Math.pow(performance.sig, -2)));

    this.approx_posterior = new Rating(mu, sig);
    // TODO: put the following in db
    // -> this.approx_posterior
    // -> this.normal_factor
    // -> performance (as the last element in logistic_factors)
    // also update rank # and textual representation
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


// `contest_weight` is a float that depends on multiple factors:
// - how full the lobby is. 1 player in lobby means 1/16 the weight
// - how well the players scored on average. did they reach expected pp,
//   or did they all fail the map? the contest weighs less if the map sucked.
//
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
function update_mmr(contest_weight, standings, contest_tms) {
  // Compute sig_perf and discrete_drift from contest_weight
  const excess_beta_sq = (BETA * BETA - SIG_LIMIT * SIG_LIMIT) / contest_weight;
  const sig_perf = Math.sqrt(SIG_LIMIT * SIG_LIMIT + excess_beta_sq);
  const discrete_drift = Math.pow(SIG_LIMIT, 4) / excess_beta_sq;

  // Update ratings due to waiting period between contests, then use it to
  // create Gaussian terms for the Q-function. The rank must also be stored
  // in order to determine if it's a win, loss, or tie term.
  const tanh_terms = [];
  for (const standing of standings) {
    const continuous_drift = DRIFT_PER_SEC * contest_tms;
    const sig_drift = Math.sqrt(discrete_drift + continuous_drift);
    standing.player.add_noise_best(sig_drift);
    tanh_terms.push(new TanhTerm(standing.player.approx_posterior.with_noise(sig_perf)));
  }

  // The computational bottleneck: update ratings based on contest
  // performance
  for (const standing of standings) {
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
    standing.player.update_rating_with_logistic(new Rating(mu_perf, sig_perf));
  }
}

function test_shit_out() {
  const players = [];
  for (let i = 0; i < 12; i++) {
    const contest = JSON.parse(fs.readFileSync('/home/kiwec/Documents/Elo-MMR/cache/codeforces/' + i + '.json'));
    const contest_standings = [];
    for (const standing of contest.standings) {
      const matches = players.filter(p => p.username == standing[0]);
      let player = new Player(standing[0]);
      if(matches.length) {
        player = matches[0];
      } else {
        players.push(player);
      }
      contest_standings.push({
        player: player,
        lo: standing[1],
        hi: standing[2],
      });
    }

    update_mmr(1.0, contest_standings, contest.time_seconds);
  }

  players.sort((a, b) => b.approx_posterior.toFloat() - a.approx_posterior.toFloat());
  let i = 1;
  console.log('rank,display_rating,cur_sigma,last_perf,handle')
  for (const player of players) {
    let display_rating = player.approx_posterior.toInt();
    let cur_sigma = Math.round(player.approx_posterior.sig);
    let perf_score = Math.round(player.logistic_factors[player.logistic_factors.length - 1].mu);
    console.log(i+','+display_rating+','+cur_sigma+','+perf_score+','+player.username);
    i++;
  }
}

test_shit_out();
