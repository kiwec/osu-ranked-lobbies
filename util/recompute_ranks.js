// This script recomputes player ranks based on stored scores.
//
// Instructions:
// - Copy ranks.db to old_ranks.db
// - Delete ranks.db
// - Run this script

import {open} from 'sqlite';
import sqlite3 from 'sqlite3';
import SQL from 'sql-template-strings';

import {init_db, update_mmr} from '../elo_mmr.js';


async function recompute_ranks() {
  await init_db();

  const old_db = await open({
    filename: 'old_ranks.db',
    driver: sqlite3.cached.Database,
  });

  const contests = await old_db.all(SQL`
    SELECT rowid, lobby_id, map_id, tms
    FROM contest
    ORDER BY tms`,
  );
  let computed = 0;

  for (const contest of contests) {
    // 1. Build fake lobby object
    const lobby = {
      id: contest.lobby_id,
      beatmapId: contest.map_id,
      scores: [],
      mock_tms: contest.tms,
      mods: [],
      winCondition: 0, // ScoreV1
    };

    // 2. Populate fake lobby with fake score objects
    const scores = await old_db.all(SQL`
      SELECT user_id, score FROM score
      WHERE contest_id = ${contest.rowid}`,
    );
    for (const score of scores) {
      // 3. Populate fake score objects with fake user objects
      const user = await old_db.get(SQL`
        SELECT username FROM user
        WHERE user_id = ${score.user_id}`,
      );
      lobby.scores.push({
        player: {
          user: {
            id: score.user_id,
            ircUsername: user.username,
          },
          mods: [],
        },
        score: score.score,
      });
    }

    // 4. Recompute MMR using fake lobby object
    await update_mmr(lobby);
    console.log(`Recomputed ${computed++}/${contests.length} contests.`);
  }
}

recompute_ranks().catch((err) => console.error(err));
