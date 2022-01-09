// This scripts exports contests to /tmp/osucontests in a format that can be
// processed by the official Rust implementation of Elo-MMR.
//
// The point is that it's easier to tweak parameters with the Rust
// implementation, since it recomputes ranks way faster than with
// JavaScript + the millions of sqlite database calls.
//
// Of course, speed doesn't matter when we only have 16 players in a contest,
// which is why we have a JavaScript implementation in the first place.

import fs from 'fs';

import databases from '../database.js';


async function export_ranks() {
  const contests_stmt = databases.ranks.prepare(`
    SELECT rowid, lobby_id, map_id, tms, scoring_system, mods
    FROM contest
    ORDER BY tms`,
  );
  const scores_stmt = databases.ranks.prepare('SELECT user_id, score FROM score WHERE contest_id = ?');
  const username_stmt = databases.ranks.prepare('SELECT username FROM user WHERE user_id = ?');

  let exported = 0;
  const contests = contests_stmt.all();
  for (const contest of contests) {
    const output = {
      'name': 'contest #' + exported,
      'time_seconds': Math.round(contest.tms / 1000),
      'standings': [],
    };

    const scores = scores_stmt.all(contest.rowid);
    const user_ids = [];
    for (const score of scores) {
      if (user_ids.includes(score.user_id)) {
        console.log('Duplicate score for user ID', score.user_id);
        continue;
      }

      const user = username_stmt.get(score.user_id);
      output['standings'].push([user.username, null, null, score.score]);
      user_ids.push(score.user_id);
    }

    output['standings'].sort((a, b) => a[3] - b[3]);
    output['standings'].reverse();

    let last_score = -1;
    let last_tie = 0;
    output['standings'].forEach((elm, i) => {
      if (elm[3] == last_score) {
        // Tie: set `lo` to `last_tie`
        elm[1] = last_tie;
        elm[2] = i;

        // Update `hi` of tied players
        const ties = output['standings'].filter((elm) => elm[1] == last_tie);
        for (const tie of ties) {
          tie[2] = i;
        }
      } else {
        // No tie
        elm[1] = i;
        elm[2] = i;
        last_tie = i;
      }

      last_score = elm[3];
    });

    if (output['standings'].length < 2) {
      // Ghost player was likely in the lobby (score == 0)
      // There was no contest. Don't compute anything.
      continue;
    }

    // Remove score
    for (const standing of output['standings']) {
      standing.pop();
    }

    fs.writeFileSync(`/tmp/osucontests/${exported}.json`, JSON.stringify(output));
    console.log(`Exported ${exported++}/${contests.length} contests.`);
  }
}

export_ranks();
