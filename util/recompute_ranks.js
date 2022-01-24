// This script recomputes player ranks based on stored scores.
//
// Instructions:
// - Run `sqlite3 ranks.db < util/merge_maps_into_ranks.sql`
// - Stop the bot
// - Run `node util/recompute_ranks.js`
// - Replace `ranks.db` with `new_ranks.db`
// - Run `sqlite3 ranks.db < util/merge_maps_into_ranks.sql`
// - Start the bot. Done!

import Database from 'better-sqlite3';
import ProgressBar from 'progress';

import databases from '../database.js';
import {update_mmr} from '../elo_mmr.js';

recompute_ranks();

async function recompute_ranks() {
  let latest_recomputed_tms = -1;
  const max_tms_stmt = databases.ranks.prepare('SELECT MAX(tms) AS max_tms FROM contest');
  const res = max_tms_stmt.get();
  if (res && res.max_tms) {
    latest_recomputed_tms = res.max_tms;
  }

  const old_db = new Database('ranks.db', {readonly: true});
  const contests_stmt = old_db.prepare(`
    SELECT contest.rowid, lobby_id, map_id, tms, lobby_creator, mods, overall_pp, dt_overall_pp
    FROM contest
    INNER JOIN map ON contest.map_id = map.id
    WHERE tms > ?
    ORDER BY tms`,
  );
  const contests = contests_stmt.all(latest_recomputed_tms);

  const player_cache = [];
  const players_stmt = old_db.prepare('SELECT * FROM user WHERE games_played > 0');
  const new_players_stmt = databases.ranks.prepare('SELECT * FROM user');
  const players = players_stmt.all();
  const new_players = new_players_stmt.all();
  let bar = new ProgressBar('importing players [:bar] :rate/s | :etas remaining', {
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
        elo: 450, // hardcoded 1500 - (3 * 350)
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
  const score_stmt = old_db.prepare('SELECT * FROM score WHERE contest_id = ?');
  bar = new ProgressBar('recomputing scores [:bar] :rate/s | :etas remaining', {
    complete: '=',
    incomplete: ' ',
    width: 20,
    total: contests.length,
  });
  for (const contest of contests) {
    contest.scores = score_stmt.all(contest.rowid);
    contest.pp = contest.mods & 64 ? contest.dt_overall_pp : contest.overall_pp;

    // Let's make the database consistent
    if (!contest.lobby_creator) contest.lobby_creator = 'kiwec';
    if (contest.lobby_creator == '12398096') contest.lobby_creator = 'kiwec';

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

  console.info('Done!');
}
