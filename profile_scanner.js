import {createRequire} from 'module';
const require = createRequire(import.meta.url);
const rosu = require('rosu-pp');

import * as fs from 'fs/promises';
import fetch from 'node-fetch';
import {promisify} from 'util';

import databases from './database.js';
import {update_discord_username} from './discord_updates.js';

import {constants} from 'fs';
import Config from './util/config.js';
import {capture_sentry_exception} from './util/helpers.js';

let oauth_token = null;

async function osu_fetch(url, options) {
  let res;

  if (!oauth_token) {
    try {
      res = await fetch('https://osu.ppy.sh/oauth/token', {
        method: 'post',
        body: JSON.stringify({
          client_id: Config.osu_v2api_client_id,
          client_secret: Config.osu_v2api_client_secret,
          grant_type: 'client_credentials',
          scope: 'public',
        }),
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
      });
    } catch (err) {
      throw new Error(`Got system error ${err.code} while fetching OAuth token.`);
    }

    const foo = await res.json();
    oauth_token = foo.access_token;
  }

  if (!options.headers) {
    options.headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };
  }

  options.headers['Authorization'] = 'Bearer ' + oauth_token;

  try {
    res = await fetch(url, options);
  } catch (err) {
    throw new Error(`Got system error ${err.code} while fetching '${url}'.`);
  }
  if (res.status == 401) {
    console.log('OAuth token expired, fetching a new one...');
    oauth_token = null;
    await promisify(setTimeout)(1000);
    return await osu_fetch(url, options);
  } else {
    return res;
  }
}

async function get_map_data(map_id) {
  console.info(`[API] Fetching map data for map ID ${map_id}`);
  const res = await osu_fetch(
      `https://osu.ppy.sh/api/v2/beatmaps/lookup?id=${map_id}`,
      {method: 'get'},
  );

  return await res.json();
}

const profile_scan_queue = [];
function scan_user_profile(user) {
  return new Promise((resolve, reject) => {
    const run_scan = async () => {
      try {
        await _scan_user_profile(user);
        resolve();
      } catch (err) {
        reject(err);
      }

      profile_scan_queue.shift();
      if (profile_scan_queue.length > 0) {
        profile_scan_queue[0]();
      }
    };

    profile_scan_queue.push(run_scan);
    if (profile_scan_queue.length == 1) {
      run_scan();
    }
  });
}

// We assume user.user_id is already set.
async function _scan_user_profile(user) {
  // Check if the user exists in the database
  let stmt = databases.ranks.prepare('SELECT * FROM user WHERE user_id = ?');
  const exists = stmt.get(user.user_id);
  if (!exists) {
    stmt = databases.ranks.prepare(`
      INSERT INTO user (
        user_id, username, approx_mu, approx_sig, games_played,
        aim_pp, acc_pp, speed_pp, overall_pp, avg_ar, avg_sr
      ) VALUES (?, ?, 1500, 350, 0, 10.0, 1.0, 1.0, 1.0, 8.0, 2.0)`,
    );
    stmt.run(user.user_id, user.username);

    return await _scan_user_profile(user);
  }

  if (user.username != exists.username) {
    stmt = databases.ranks.prepare('UPDATE user SET username = ? WHERE user_id = ?');
    stmt.run(user.username, user.user_id);

    console.info(`[API] ${exists.username} is now known as ${user.username}`);
    await update_discord_username(
        user.user_id, user.username, 'osu! username change',
    );
  }

  // Already updated their profile recently enough
  if (user.avg_sr != null && user.last_update_tms + (3600 * 24 * 1000) > Date.now()) {
    return;
  }

  // Fetch top user scores from osu!api
  let res;
  try {
    console.info(`[API] Scanning top 100 scores of ${user.username}`);
    res = await osu_fetch(
        `https://osu.ppy.sh/api/v2/users/${user.user_id}/scores/best?key=id&mode=osu&limit=100&include_fails=0`,
        {method: 'get'},
    );
    if (res.statusCode >= 500) {
      return;
    }
  } catch (err) {
    // Since we already ignore error 500s, also ignore other errors.
    return;
  }

  let recent_scores;
  try {
    recent_scores = await res.json();
    if (!(Symbol.iterator in Object(recent_scores))) {
      throw new Error('recent_scores is not iterable:', recent_scores);
    }
  } catch (err) {
    console.error('status:', res.statusCode, 'has html data in json response:', await res.text());
    capture_sentry_exception(err);
    return;
  }

  let has_new_score = false;
  for (const score of recent_scores) {
    const score_tms = Date.parse(score.created_at) / 1000;
    if (score_tms > user.last_top_score_tms) {
      has_new_score = true;
      break;
    }
  }
  if (user.avg_sr != null && !has_new_score) {
    return;
  }

  // Re-scan all scores for pp values
  let total_weight = 0;
  let current_weight = 1.0;
  let last_top_score_tms = 0;
  let aim_pp = 0;
  let acc_pp = 0;
  let speed_pp = 0;
  let overall_pp = 0;
  let avg_ar = 0;
  for (const score of recent_scores) {
    const score_tms = Date.parse(score.created_at) / 1000;
    if (score_tms > last_top_score_tms) {
      last_top_score_tms = score_tms;
    }

    try {
      // Looking for .osu files? peppy provides monthly dumps here: https://data.ppy.sh/
      const file = 'maps/' + parseInt(score.beatmap.id, 10) + '.osu';

      try {
        await fs.access(file, constants.F_OK);
      } catch (err) {
        // TODO: add to map/pp database?
        console.log(`Beatmap id ${score.beatmap.id} not found, downloading it.`);
        const new_file = await fetch(`https://osu.ppy.sh/osu/${score.beatmap.id}`);
        await fs.writeFile(file, await new_file.text());
      }

      let mods = 0;
      if (score.mods.includes('NF')) mods |= (1<<0);
      if (score.mods.includes('EZ')) mods |= (1<<1);
      if (score.mods.includes('TD')) mods |= (1<<2);
      if (score.mods.includes('HD')) mods |= (1<<3);
      if (score.mods.includes('HR')) mods |= (1<<4);
      if (score.mods.includes('SD')) mods |= (1<<5);
      if (score.mods.includes('DT')) mods |= (1<<6);
      if (score.mods.includes('RX')) mods |= (1<<7);
      if (score.mods.includes('HT')) mods |= (1<<8);
      if (score.mods.includes('NC')) mods |= (1<<9);
      if (score.mods.includes('FL')) mods |= (1<<10);
      if (score.mods.includes('AT')) mods |= (1<<11);
      if (score.mods.includes('SO')) mods |= (1<<12);
      if (score.mods.includes('AP')) mods |= (1<<13);
      if (score.mods.includes('PF')) mods |= (1<<14);

      const pp_res = rosu.calculate({
        path: file,
        mods: mods,
        combo: score.max_combo,
        n300: score.statistics.count_300,
        n100: score.statistics.count_100,
        n50: score.statistics.count_50,
        nMisses: score.statistics.count_miss,
      });

      aim_pp += pp_res[0].ppAim * current_weight;
      acc_pp += pp_res[0].ppAcc * current_weight;
      speed_pp += pp_res[0].ppSpeed * current_weight;
      overall_pp += pp_res[0].pp * current_weight;
      avg_ar += pp_res[0].ar * current_weight;
    } catch (err) {
      console.error(`[PP] Map #${score.beatmap.id}:`, err);
      continue;
    }

    total_weight += current_weight;
    current_weight *= 0.95;
  }

  if (total_weight > 0) {
    aim_pp /= total_weight;
    acc_pp /= total_weight;
    speed_pp /= total_weight;
    overall_pp /= total_weight;
    avg_ar /= total_weight;
  }

  // Get average SR for those pp values
  stmt = databases.maps.prepare(`
    SELECT AVG(stars) AS avg_sr FROM (
      SELECT stars, (
        ABS(? - aim_pp)
        + ABS(? - speed_pp)
        + ABS(? - acc_pp)
        + 10*ABS(? - ar)
      ) AS match_accuracy FROM map
      WHERE length > 60 AND ranked IN (4, 5, 7) AND match_accuracy IS NOT NULL
      ORDER BY match_accuracy LIMIT 1000
    )`,
  );
  const meta = stmt.get(aim_pp, speed_pp, acc_pp, avg_ar);

  user.aim_pp = aim_pp;
  user.acc_pp = acc_pp;
  user.speed_pp = speed_pp;
  user.overall_pp = overall_pp;
  user.avg_ar = avg_ar;
  user.avg_sr = meta.avg_sr;
  user.last_update_tms = Date.now();

  stmt = databases.ranks.prepare(`
    UPDATE user
    SET
      aim_pp = ?, acc_pp = ?, speed_pp = ?, overall_pp = ?, avg_ar = ?, avg_sr = ?,
      last_top_score_tms = ?, last_update_tms = ?
    WHERE user_id = ?`,
  );
  stmt.run(
      aim_pp, acc_pp, speed_pp, overall_pp, avg_ar, meta.avg_sr,
      last_top_score_tms, user.last_update_tms, user.user_id,
  );

  console.log('[API] Finished recalculating pp for ' + user.username);
}

export {scan_user_profile, get_map_data};
