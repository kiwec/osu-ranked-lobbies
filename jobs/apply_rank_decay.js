// This script updates ranks so that decay is applied even if the user doesn't play.
import fs from 'fs';
import Sentry from '@sentry/node';
import {open} from 'sqlite';
import sqlite3 from 'sqlite3';
import SQL from 'sql-template-strings';

import {get_rank_text_from_id} from '../elo_mmr.js';


const DRIFT_PER_MILLISECOND = 0.000000001;


const Config = JSON.parse(fs.readFileSync('./config.json'));

const client = new Client({intents: [Intents.FLAGS.GUILDS]});
client.once('ready', () => {
  console.log('Connected to discord, applying rank decay.');
  apply_rank_decay.catch(Sentry.captureException);
});

Sentry.init({dsn: Config.sentry_dsn});
client.login(Config.discord_token);


async function apply_rank_decay() {
  const discord_db = await open({
    filename: 'discord.db',
    driver: sqlite3.cached.Database,
  });

  const ranking_db = await open({
    filename: 'ranks.db',
    driver: sqlite3.cached.Database,
  });

  await ranking_db.run(SQL`
    UPDATE user SET elo = (
      approx_mu - 3.0 * MIN(350.0,
        approx_sig + (${Date.now()} - last_contest_tms) * ${DRIFT_PER_MILLISECOND}
      )
    )
  `);

  select MIN(approx_sig), MAX(approx_sig) from user;

  select elo,
  (approx_mu - 3.0 * MIN(350.0, approx_sig + (1637494149359 - last_contest_tms) * 0.000000001)) AS fixed_elo,
  MIN(350.0, approx_sig + (1637494149359 - last_contest_tms) * 0.000000001) AS fixed_sig,
  approx_mu, approx_sig, games_played, username
  from user 
  where games_played > 4
  order by fixed_elo desc limit 50;

  const discord_users = discord_db.all(SQL`
    SELECT discord_id, osu_id, discord_rank FROM user
  `);
  for (const discord_user of discord_users) {
    try {
      const rank_text = get_rank_text_from_id(discord_user.osu_id);
      if (rank_text.split('+')[0] != discord_user.discord_rank) {
        await update_discord_role(discord_user.osu_id, rank_text);
      }
    } catch (err) {
      console.error(`Failed to update rank for <@${discord_id}>:`, err);
    }
  }
}
