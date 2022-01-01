// This script recomputes player ranks based on stored scores.
//
// Instructions:
// - Copy the osubot directory to another directory
// - Keep the bot running in the old osubot directory
// - Delete 'ranks.db' from the new directory
// - Run `node util/recompute_ranks.js` in the new directory
// - After a few runs and once all ranks are updated, kill the bot,
//   replace the database, update the code, restart the bot. Done!

import {open} from 'sqlite';
import sqlite3 from 'sqlite3';
import SQL from 'sql-template-strings';

import {init_databases} from '../database.js';
import {init_db, update_mmr} from '../elo_mmr.js';

recompute_ranks();

async function recompute_ranks() {
  const player_cache = [];

  await init_databases();
  const new_db = await init_db();
  let latest_recomputed_tms = -1;
  const res = await new_db.get(SQL`SELECT MAX(tms) AS max_tms FROM contest`);
  if (res && res.max_tms) {
    latest_recomputed_tms = res.max_tms;
  }

  const old_db = await open({
    filename: '../osubot/ranks.db',
    driver: sqlite3.cached.Database,
  });
  let contests = await old_db.all(SQL`
    SELECT rowid, lobby_id, map_id, tms, scoring_system, lobby_creator, mods
    FROM contest
    WHERE tms > ${latest_recomputed_tms}
    ORDER BY tms`,
  );
  let prev = null;
  contests = contests.filter((contest) => {
    const niou = contest.map_id + ':' + contest.tms;
    if (prev == niou) {
      console.log('ignoring contest', contest.rowid, '(duplicate)');
      return false;
    } else {
      prev = niou;
      return true;
    }
  });

  console.info('Importing players...');
  const players = await old_db.all(SQL`SELECT * FROM user`);
  for (const player of players) {
    const rows = await new_db.run(SQL`
      UPDATE user SET
        rank_text = ${player.rank_text},
        aim_pp = ${player.aim_pp}, acc_pp = ${player.acc_pp}, speed_pp = ${player.speed_pp},
        overall_pp = ${player.overall_pp}, avg_ar = ${player.avg_ar}, avg_sr = ${player.avg_sr},
        last_top_score_tms = ${player.last_top_score_tms}, last_update_tms = ${player.last_update_tms}
      WHERE user_id = ${player.user_id}`,
    );
    if (rows.changes == 0) {
      await new_db.run(SQL`
        INSERT INTO user (
          user_id, username, approx_mu, approx_sig, normal_mu, normal_sig, games_played,
          aim_pp, acc_pp, speed_pp,
          overall_pp, avg_ar, avg_sr,
          last_top_score_tms, last_update_tms,
          rank_text
        )
        SELECT
          ${player.user_id}, ${player.username}, 1500, 350, 1500, 350, 0,
          ${player.aim_pp}, ${player.acc_pp}, ${player.speed_pp},
          ${player.overall_pp}, ${player.avg_ar}, ${player.avg_sr},
          ${player.last_top_score_tms}, ${player.last_update_tms},
          ${player.rank_text}
        WHERE NOT EXISTS (SELECT 1 FROM user WHERE user_id = ${player.user_id})`,
      );
    }
  }

  // Recompute all scores
  let computed = 0;
  for (const contest of contests) {
    const scores = await old_db.all(SQL`
      SELECT score.user_id, score.score, score.mods, user.username
      FROM score
      INNER JOIN user ON user.user_id = score.user_id
      WHERE score.contest_id = ${contest.rowid} AND score > 0`,
    );

    const lobby = {
      id: contest.lobby_id,
      creator: contest.lobby_creator,
      beatmap_id: contest.map_id,
      match_participants: [],
      scores: [],
      mock_tms: contest.tms,
      is_dt: contest.mods & 64,
      win_condition: contest.scoring_system,
    };

    for (const score of scores) {
      if (!(score.username in player_cache)) {
        player_cache[score.username] = {
          id: score.user_id,
          user_id: score.user_id,
          username: score.username,
          approx_mu: 1500, approx_sig: 350,
          normal_mu: 1500, normal_sig: 350,
          games_played: 0, rank_text: 'Unranked',
        };
      }

      lobby.scores[score.username] = score.score;
      lobby.match_participants[score.username] = player_cache[score.username];
    }

    // Recompute MMR using fake lobby object
    await update_mmr(lobby);

    console.log(`Recomputed ${computed++}/${contests.length} contests.`);
  }
}
