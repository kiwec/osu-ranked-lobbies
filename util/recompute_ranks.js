// This script recomputes player ranks based on stored scores.
//
// Instructions:
// - Run `node util/recompute_ranks.js`
// - Stop the bot
// - Run `INCREMENTAL_UPDATE=1 node util/recompute_ranks.js`
// - Replace `ranks.db` with `new_ranks.db`
// - Start the bot. Done!

import Database from 'better-sqlite3';
import ProgressBar from 'progress';

import databases from '../database.js';
import {update_mmr} from '../elo_mmr.js';

recompute_ranks();

async function recompute_ranks() {
  databases.ranks.exec('BEGIN DEFERRED TRANSACTION');

  console.info('Fetching maps...');
  const maps_stmt = databases.maps.prepare('SELECT id, overall_pp, dt_overall_pp FROM map');
  const maps = maps_stmt.all();
  const pps = [];
  const dt_pps = [];
  for (const map of maps) {
    pps[map.id] = map.overall_pp;
    dt_pps[map.id] = map.dt_overall_pp;
  }

  let latest_recomputed_tms = -1;
  const max_tms_stmt = databases.ranks.prepare('SELECT MAX(tms) AS max_tms FROM contest');
  const res = max_tms_stmt.get();
  if (res && res.max_tms) {
    latest_recomputed_tms = res.max_tms;
  }

  const old_db = new Database('ranks.db', {readonly: true});
  const contests_stmt = old_db.prepare(`
    SELECT rowid, lobby_id, map_id, tms, lobby_creator, mods
    FROM contest
    WHERE tms > ?
    ORDER BY tms`,
  );
  const contests = contests_stmt.all(latest_recomputed_tms);

  console.info('Fetching scores...');
  const scores_stmt = old_db.prepare('SELECT * FROM score WHERE tms > ?');
  const all_scores = scores_stmt.all(latest_recomputed_tms);

  let bar = new ProgressBar('populating contests [:bar] :rate/s | :etas remaining', {
    complete: '=',
    incomplete: ' ',
    width: 20,
    total: contests.length,
  });
  for (const contest of contests) {
    contest.scores = all_scores.filter((score) => score.contest_id == contest.rowid);
    contest.pp = contest.mods & 64 ? dt_pps[contest.map_id] : pps[contest.map_id];

    // Let's make the database consistent
    if (!contest.lobby_creator) contest.lobby_creator = 'kiwec';
    if (contest.lobby_creator == '12398096') contest.lobby_creator = 'kiwec';

    bar.tick(1);
  }

  const player_cache = [];
  const players_stmt = old_db.prepare('SELECT * FROM user WHERE games_played > 0');
  const new_players_stmt = databases.ranks.prepare('SELECT * FROM user');
  const players = players_stmt.all();
  const new_players = new_players_stmt.all();
  bar = new ProgressBar('importing players [:bar] :rate/s | :etas remaining', {
    complete: '=',
    incomplete: ' ',
    width: 20,
    total: players.length,
  });
  const insert_user_stmt = databases.ranks.prepare(`
    INSERT INTO user (
      user_id, username, approx_mu, approx_sig, games_played,
      aim_pp, acc_pp, speed_pp, overall_pp, avg_ar, avg_sr,
      last_top_score_tms, last_update_tms,
      rank_text
    ) VALUES (?, ?, 1500, 350, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const player of players) {
    player_cache[player.user_id] = new_players.find((n_p) => n_p.user_id == player.user_id);
    if (!player_cache[player.user_id]) {
      player_cache[player.user_id] = {
        id: player.user_id,
        user_id: player.user_id,
        username: player.username,
        overall_pp: player.overall_pp,
        elo: 800, // hardcoded 1500 - (2 * 350)
        approx_mu: 1500,
        approx_sig: 350,
        last_contest_tms: 0,
        games_played: 0,
      };

      insert_user_stmt.run(
          player.user_id, player.username,
          player.aim_pp, player.acc_pp, player.speed_pp, player.overall_pp,
          player.avg_ar, player.avg_sr,
          player.last_top_score_tms, player.last_update_tms,
          player.rank_text,
      );
    }

    bar.tick(1);
  }

  // Recompute all scores
  bar = new ProgressBar('recomputing scores [:bar] :rate/s | :etas remaining', {
    complete: '=',
    incomplete: ' ',
    width: 20,
    total: contests.length,
  });
  for (const contest of contests) {
    const lobby = {
      id: contest.lobby_id,
      creator: contest.lobby_creator,
      beatmap_id: contest.map_id,
      current_map_pp: contest.pp,
      match_participants: [],
      scores: [],
      is_dt: contest.mods & 64,
    };

    if (typeof lobby.current_map_pp === 'undefined') {
      console.info(' PP not found for map ID ' + lobby.beatmap_id);
      continue;
    }

    for (const score of contest.scores) {
      const score_player = player_cache[score.user_id];
      score.username = score_player.username;
      lobby.scores[score.username] = score.score;
      lobby.match_participants[score.username] = score_player;
    }

    // Recompute MMR using fake lobby object
    await update_mmr(lobby, contest.tms);

    bar.tick(1);
  }

  databases.ranks.exec('COMMIT TRANSACTION');
}
