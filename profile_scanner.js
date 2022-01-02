import {open} from 'sqlite';
import * as fs from 'fs/promises';
import sqlite3 from 'sqlite3';
import fetch from 'node-fetch';
import {promisify} from 'util';
import ojsama from 'ojsama';
import SQL from 'sql-template-strings';

import {update_discord_username} from './discord_updates.js';

import {constants} from 'fs';
import Config from './util/config.js';
import {capture_sentry_exception} from './util/helpers.js';

let oauth_token = null;
let maps_db = null;
let ranks_db = null;

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

// We assume user.user_id is already set.
async function scan_user_profile(user) {
  if (!maps_db) {
    maps_db = await open({
      filename: 'maps.db',
      driver: sqlite3.cached.Database,
    });
  }
  if (!ranks_db) {
    ranks_db = await open({
      filename: 'ranks.db',
      driver: sqlite3.cached.Database,
    });
  }

  // Check if the user exists in the database
  const exists = await ranks_db.get(SQL`SELECT * FROM user WHERE user_id = ${user.user_id}`);
  if (!exists) {
    await ranks_db.run(SQL`
      INSERT INTO user (
        user_id, username, approx_mu, approx_sig, normal_mu, normal_sig, games_played,
        aim_pp, acc_pp, speed_pp, overall_pp, avg_ar, avg_sr
      )
      VALUES (
        ${user.user_id}, ${user.username}, 1500, 350, 1500, 350, 0,
        10.0, 1.0, 1.0, 1.0, 8.0, 2.0
      )`,
    );

    return await scan_user_profile(user);
  }

  if (user.username != exists.username) {
    await ranks_db.run(SQL`
      UPDATE user
      SET username = ${user.username}
      WHERE user_id = ${user.user_id}`,
    );

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

  // Re-scan users with last_update below 1638722217000 to set their nickname (see bottom of file)
  if (user.last_update_tms > 1638722217000 && user.avg_sr != null && !has_new_score) {
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

      const contents = await fs.readFile(file, 'utf-8');
      const parser = new ojsama.parser();
      parser.feed(contents);

      const map_pp = ojsama.ppv2({
        map: parser.map,
        mods: ojsama.modbits.from_string(score.mods.join('')),
        nmiss: score.statistics.count_miss,
        n50: score.statistics.count_50,
        n100: score.statistics.count_100,
        n300: score.statistics.count_300,
        combo: score.max_combo,
      });
      aim_pp += map_pp.aim * current_weight;
      acc_pp += map_pp.acc * current_weight;
      speed_pp += map_pp.speed * current_weight;
      overall_pp += map_pp.total * current_weight;

      let approach_rate = score.beatmap.ar;
      if (score.mods.includes('HR')) {
        approach_rate *= 1.4;
        if (approach_rate > 10) approach_rate = 10;
      } else if (score.mods.includes('EZ')) {
        approach_rate /= 2;
      }

      // For how long the circle is shown on screen, in milliseconds
      // See https://osu.ppy.sh/wiki/en/Beatmapping/Approach_rate
      let preempt;
      if (approach_rate > 5) {
        preempt = 1200 - 150 * (approach_rate - 5);
      } else {
        preempt = 1200 + 120 * (5 - approach_rate);
      }

      if (score.mods.includes('DT')) {
        preempt *= 2/3;
        if (preempt > 1200) {
          approach_rate = 5 - (preempt - 1200) / 120;
        } else {
          approach_rate = (1200 - preempt) / 150 + 5;
        }
      } else if (score.mods.includes('HT')) {
        preempt /= 0.75;
        if (preempt > 1200) {
          approach_rate = 5 - (preempt - 1200) / 120;
        } else {
          approach_rate = (1200 - preempt) / 150 + 5;
        }
      }
      approach_rate *= current_weight;
      avg_ar += approach_rate;
    } catch (err) {
      console.error('Failed to compute pp for map', score.beatmap.id, ':', err);
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

  // Three digit players mostly farm, so their top 100 scores are not
  // representative of what they usually achieve. Limit max pp to 600.
  if (overall_pp > 600.0) {
    const ratio = overall_pp / 600.0;
    aim_pp /= ratio;
    acc_pp /= ratio;
    speed_pp /= ratio;
    overall_pp /= ratio;
  }

  // Get average SR for those pp values
  const meta = await maps_db.get(SQL`
    SELECT AVG(pp_stars) AS avg_sr FROM (
      SELECT pp.stars AS pp_stars, (
        ABS(${aim_pp} - aim_pp)
        + ABS(${speed_pp} - speed_pp)
        + ABS(${acc_pp} - acc_pp)
        + 10*ABS(${avg_ar} - pp.ar)
      ) AS match_accuracy FROM map
      INNER JOIN pp ON map.id = pp.map_id
      WHERE mods = (1<<16) AND length > 60 AND ranked IN (4, 5, 7) AND match_accuracy IS NOT NULL
      ORDER BY match_accuracy LIMIT 1000
    )`,
  );

  user.aim_pp = aim_pp;
  user.acc_pp = acc_pp;
  user.speed_pp = speed_pp;
  user.overall_pp = overall_pp;
  user.avg_ar = avg_ar;
  user.avg_sr = meta.avg_sr;

  await ranks_db.run(SQL`
    UPDATE user
    SET
      aim_pp = ${aim_pp},
      acc_pp = ${acc_pp},
      speed_pp = ${speed_pp},
      overall_pp = ${overall_pp},
      avg_ar = ${avg_ar},
      avg_sr = ${meta.avg_sr},
      last_top_score_tms = ${last_top_score_tms},
      last_update_tms = ${Date.now()}
    WHERE user_id = ${user.user_id}`,
  );

  // User never got their discord nickname set
  if (recent_scores.length > 0 && user.last_update_tms < 1638722217000) {
    await update_discord_username(
        user.user_id,
        recent_scores[0].user.username,
        'Fixed nickname for existing user',
    );
  }

  console.log('[API] Finished recalculating pp for ' + user.username);
}

export {scan_user_profile, get_map_data};
