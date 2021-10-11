// This script recomputes player ranks based on stored scores.
//
// Instructions:
// - Copy ranks.db to old_ranks.db
// - Delete ranks.db
// - Run this script

import {open} from 'sqlite';
import sqlite3 from 'sqlite3';
import SQL from 'sql-template-strings';

import {init_db, get_rank_text_from_id, update_mmr} from '../elo_mmr.js';
import {init_discord_bot, update_discord_role} from '../discord.js';


async function recompute_ranks() {
  await init_db();
  await init_discord_bot();

  const old_db = await open({
    filename: 'old_ranks.db',
    driver: sqlite3.cached.Database,
  });

  const discord_db = await open({
    filename: 'discord.db',
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

  // 5. Update ranks on discord
  const DISCORD_ROLES = {
    'Cardboard': '893082878806732851',
    'Copper': '893083179601260574',
    'Bronze': '893083324673822771',
    'Silver': '893083428260556801',
    'Gold': '893083477531033613',
    'Platinum': '893083535907377152',
    'Diamond': '893083693244100608',
    'Legendary': '893083871309082645',
    'The One': '892966704991330364',
  };

  const guild = await client.guilds.fetch('891781932067749948');
  const users = await discord_db.all('SELECT osu_id, discord_id FROM user');
  for (const user of users) {
    try {
      const member = await guild.members.fetch(user.discord_id);
      console.log('Fixing roles for ' + member.displayName);

      let rank_text = await get_rank_text_from_id(user.osu_id);
      rank_text = rank_text.split('+')[0];

      for (const role of member.roles.cache) {
        if (Object.values(DISCORD_ROLES).includes(role.id) && role.id != DISCORD_ROLES[rank_text]) {
          await member.roles.remove(role);
          console.log('- Removed ' + role.name);
        }
      }

      try {
        await member.roles.add(DISCORD_ROLES[rank_text]);
        console.log('+ Added ' + rank_text);
      } catch (err) {
        console.error('! Could not add role ' + rank_text);
      }

      await discord_db.run('UPDATE user SET discord_rank = ? WHERE discord_id = ?', rank_text, member.id);
    } catch (err) {
      console.error(`Failed to fix roles for ${user.discord_id}: ${err}`);
    }
  }
}

recompute_ranks().catch((err) => console.error(err));
