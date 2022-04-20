// This script recomputes player ranks based on stored scores.
//
// Instructions:
// - Stop the bot
// - Backup `ranks.db` in case the script crashes
// - Run `node util/recompute_ranks.js`
// - Start the bot. Done!

import ProgressBar from 'progress';

import databases from '../database.js';
import {update_mmr} from '../elo_mmr.js';


const players_stmt = databases.ranks.prepare('SELECT * FROM user WHERE games_played > 0');
const db_players = players_stmt.all();
const tmp_players = [];
let bar = new ProgressBar('importing players [:bar] :rate/s | :etas remaining', {
  complete: '=',
  incomplete: ' ',
  width: 20,
  total: db_players.length,
});
for (const player of db_players) {
  tmp_players[player.user_id] = {
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

  bar.tick(1);
}


const contests_stmt = databases.ranks.prepare(`
  SELECT contest.rowid, lobby_id, map_id, tms, lobby_creator
  FROM contest
  ORDER BY tms`,
);
const contests = contests_stmt.all();
const score_stmt = databases.ranks.prepare('SELECT * FROM score WHERE contest_id = ?');
bar = new ProgressBar('importing scores [:bar] :rate/s | :etas remaining', {
  complete: '=',
  incomplete: ' ',
  width: 20,
  total: contests.length,
});
for (const contest of contests) {
  contest.scores = score_stmt.all(contest.rowid);
  contest.lobby = {
    id: contest.lobby_id,
    beatmap_id: contest.map_id,
    match_participants: [],
    scores: [],
    data: {
      creator: contest.lobby_creator,
    },
  };

  for (const score of contest.scores) {
    const score_player = tmp_players[score.user_id];
    contest.lobby.match_participants[score_player.username] = score_player;
    contest.lobby.scores.push({
      username: score_player.username,
      score: score.score,
      state: 'PASSED',
    });
  }

  bar.tick(1);
}


// Scary: Delete all contests and scores!
databases.ranks.exec(`
  DELETE FROM contest;
  DELETE FROM score;
  UPDATE user SET approx_mu = 1500, approx_sig = 350, games_played = 0;`,
);


// Recompute all scores
bar = new ProgressBar('recomputing scores [:bar] :rate/s | :etas remaining', {
  complete: '=',
  incomplete: ' ',
  width: 20,
  total: contests.length,
});
for (const contest of contests) {
  // Recompute MMR using fake lobby object
  update_mmr(contest.lobby, contest.tms);

  bar.tick(1);
}

console.info('Done!');
