// This script recomputes player ranks based on stored scores.
//
// Instructions:
// - node recompute_ranks.js

import fs from 'fs';
import {open} from 'sqlite';
import sqlite3 from 'sqlite3';
import SQL from 'sql-template-strings';
import {Client, Intents} from 'discord.js';

import {init_db, get_rank_text_from_id, update_mmr} from '../elo_mmr.js';


const discord_client = new Client({intents: [Intents.FLAGS.GUILDS]});

discord_client.once('ready', () => {
  console.log('Logged in to discord.');
  clear_discord_roles();
});

// uncomment when needed
// const {discord_token} = JSON.parse(fs.readFileSync('./config.json'));
// discord_client.login(discord_token);

// uncomment when needed
// recompute_ranks();

async function clear_discord_roles() {
  const DISCORD_ROLES = {
    'Cardboard': '893082878806732851',
    'Wood': '893083179601260574',
    'Bronze': '893083324673822771',
    'Silver': '893083428260556801',
    'Gold': '893083477531033613',
    'Platinum': '893083535907377152',
    'Diamond': '893083693244100608',
    'Legendary': '893083871309082645',
    'The One': '892966704991330364',
  };

  const discord_db = await open({
    filename: 'discord.db',
    driver: sqlite3.cached.Database,
  });

  const guild = await discord_client.guilds.fetch('891781932067749948');
  const users = await discord_db.all('SELECT discord_id, discord_rank FROM user');
  for (const user of users) {
    try {
      const member = await guild.members.fetch(user.discord_id);
      console.log('Updating roles for ' + member.displayName);

      // Add 'Linked account' role
      await member.roles.add('909777665223966750');

      // Remove rank role
      await member.roles.remove(DISCORD_ROLES[user.discord_rank.split('+')[0]]);
    } catch (err) {
      console.error(`Failed to fix roles for ${user.discord_id}: ${err}`);
    }
  }

  console.log('Done updating roles.');

  // NOTE: run "UPDATE user SET discord_rank = NULL;" manually
}

async function recompute_ranks() {
  const db = await init_db();

  // Fetch ALL of the database into memory since we can afford it
  const contests = await db.all(SQL`
    SELECT rowid, lobby_id, map_id, tms, scoring_system, mods
    FROM contest
    ORDER BY tms`,
  );
  const scores = await db.all(SQL`
    SELECT DISTINCT score.user_id, score.score, score.mods, score.contest_id, user.username
    FROM score
    INNER JOIN user ON user.user_id = score.user_id`,
  );
  for (const contest of contests) {
    contest.scores = scores.filter((score) => score.contest_id == contest.rowid && score.score > 0);
  }

  // Reset the database
  await db.run('DROP TABLE contest');
  await db.run('DROP TABLE score');
  await db.run('ALTER TABLE user ADD COLUMN last_contest_tms INTEGER');
  await db.run(SQL`
    UPDATE user SET
      approx_mu = 1500,
      approx_sig = 350,
      normal_mu = 1500,
      normal_sig = 350,
      games_played = 0,
      last_contest_tms = NULL`,
  );
  await init_db(); // recreate dropped tables

  // Recompute all scores
  let computed = 0;
  for (const contest of contests) {
    const lobby = {
      id: contest.lobby_id,
      beatmapId: contest.map_id,
      scores: [],
      mock_tms: contest.tms,
      mods: [{enumValue: contest.mods}],
      winCondition: contest.scoring_system,
      confirmed_players: [],
    };

    for (const score of contest.scores) {
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
