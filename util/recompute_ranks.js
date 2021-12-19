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

import {init_db, update_mmr} from '../elo_mmr.js';

recompute_ranks();

async function recompute_ranks() {
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
  const contests = await old_db.all(SQL`
    SELECT rowid, lobby_id, map_id, tms, scoring_system, mods
    FROM contest
    WHERE tms > ${latest_recomputed_tms}
    ORDER BY tms`,
  );

  console.info('Importing players...');
  const players = await old_db.all(SQL`SELECT user_id, username FROM user`);
  for (const player of players) {
    await new_db.run(SQL`
      INSERT INTO user (
        user_id, username, approx_mu, approx_sig, normal_mu, normal_sig, games_played,
        aim_pp, acc_pp, speed_pp, overall_pp, avg_ar, avg_sr
      )
      SELECT 
        ${player.user_id}, ${player.username}, 1500, 350, 1500, 350, 0,
        10.0, 1.0, 1.0, 1.0, 8.0, 2.0
      WHERE NOT EXISTS (SELECT 1 FROM user WHERE user_id = ${player.user_id})`,
    );
  }

  // Recompute all scores
  let computed = 0;
  for (const contest of contests) {
    const scores = await old_db.all(SQL`
      SELECT score.user_id, score.score, score.mods, user.username
      FROM score
      INNER JOIN user ON user.user_id = score.user_id
      WHERE score.contest_id = ${contest.rowid}`,
    );

    const lobby = {
      id: contest.lobby_id,
      beatmapId: contest.map_id,
      scores: [],
      mock_tms: contest.tms,
      mods: [{enumValue: contest.mods}],
      winCondition: contest.scoring_system,
      confirmed_players: [],
    };

    for (const score of scores) {
      lobby.scores.push({
        player: {
          user: {
            id: score.user_id,
            ircUsername: score.username,
          },
          mods: [{enumValue: score.mods}],
        },
        score: score.score,
      });
    }

    if (lobby.scores.length < 2) {
      // Ghost player was likely in the lobby (score == 0)
      // There was no contest. Don't compute anything.
      computed++;
      continue;
    }

    // Recompute MMR using fake lobby object
    await update_mmr(lobby);

    console.log(`Recomputed ${computed++}/${contests.length} contests.`);
  }
}
