import {open} from 'sqlite';
import * as fs from 'fs/promises';
import sqlite3 from 'sqlite3';
import fetch from 'node-fetch';
import {promisify} from 'util';
import ojsama from 'ojsama';

import {readFileSync} from 'fs';
const Config = JSON.parse(readFileSync('./config.json'));

let oauth_token = null;
let maps_db = null;
let ranks_db = null;

async function osu_fetch(url, options) {
  if (!oauth_token) {
    const res = await fetch('https://osu.ppy.sh/oauth/token', {
      method: 'post',
      body: JSON.stringify({
        client_id: Config.client_id,
        client_secret: Config.client_secret,
        grant_type: 'client_credentials',
        scope: 'public',
      }),
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
    });
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

  const res = await fetch(url, options);
  if (res.status == 401) {
    console.log('OAuth token expired, fetching a new one...');
    oauth_token = null;
    await promisify(setTimeout)(1000);
    return await osu_fetch(url, options);
  } else {
    return res;
  }
}

// We assume bancho_user.id is already set.
async function load_user_info(bancho_user) {
  if (!maps_db) {
    maps_db = await open({
      filename: 'maps.db',
      driver: sqlite3.Database,
    });
  }
  if (!ranks_db) {
    ranks_db = await open({
      filename: 'ranks.db',
      driver: sqlite3.Database,
    });
  }

  // Try to fetch user info from database
  const user = await ranks_db.get('SELECT * FROM user WHERE user_id = ?', bancho_user.id);
  if (!user) {
    await ranks_db.run(
        `INSERT INTO user (user_id, username, approx_mu, approx_sig, normal_mu, normal_sig)
      VALUES (?, ?, 1500, 350, 1500, 350)`,
        bancho_user.id, bancho_user.ircUsername,
    );
  } else {
    bancho_user.id = user.user_id;

    if (user.aim_pp) {
      bancho_user.pp = {
        aim: user.aim_pp,
        acc: user.acc_pp,
        speed: user.speed_pp,
        overall: user.overall_pp,
      };

      // Already updated their profile recently enough
      if (user.last_update_tms + 3600 * 24 > Date.now()) {
        return;
      }
    }
  }

  // Fetch top user scores from osu api
  const res = await osu_fetch(
      `https://osu.ppy.sh/api/v2/users/${bancho_user.id}/scores/best?key=id&mode=osu&limit=100&include_fails=0`,
      {method: 'get'},
  );
  const recent_scores = await res.json();
  let has_new_score = false;
  for (const score of recent_scores) {
    const score_tms = Date.parse(score.created_at).getTime();
    if (score_tms > user.last_top_score_tms) {
      has_new_score = true;
      break;
    }
  }
  if (!has_new_score) {
    return;
  }

  // Re-scan all scores for pp values
  let total_weight = 0;
  let current_weight = 1.0;
  let last_top_score_tms = 0;
  const pp = {
    aim: 0,
    acc: 0,
    speed: 0,
    overall: 0,
  };
  for (const score of recent_scores) {
    const score_tms = Date.parse(score.created_at).getTime();
    if (score_tms > last_top_score_tms) {
      last_top_score_tms = score_tms;
    }

    try {
      // Looking for .osu files? peppy provides monthly dumps here: https://data.ppy.sh/
      const file = 'maps/' + parseInt(score.beatmap.id, 10) + '.osu';
      const contents = await fs.readFile(file);
      const parser = new ojsama.parser();
      parser.feed(contents);

      const map_pp = ojsama.ppv2({
        map: parser.map,
        nmiss: score.statistics.count_miss,
        n50: score.statistics.count_50,
        n100: score.statistics.count_100,
        n300: score.statistics.count_300,
        combo: score.max_combo,
      });
      pp.aim += map_pp.aim * current_weight;
      pp.acc += map_pp.acc * current_weight;
      pp.speed += map_pp.speed * current_weight;
      pp.overall += map_pp.total * current_weight;
    } catch (err) {
      // TODO: download map when needed
      console.error('Could not compute pp for map', score.beatmap.id, ':', err);
      continue;
    }

    total_weight += current_weight;
    current_weight *= 0.95;
  }

  if (total_weight > 0) {
    pp.aim /= current_weight;
    pp.acc /= current_weight;
    pp.speed /= current_weight;
    pp.overall /= current_weight;
  }
  bancho_user.pp = pp;

  await ranks_db.run(
      `UPDATE user SET
      aim_pp = ?, acc_pp = ?, speed_pp = ?, overall_pp = ?,
      last_top_score_tms = ?, last_update_tms = ?
    WHERE user_id = ?`,
      pp.aim, pp.acc, pp.speed, pp.overall,
      last_top_score_tms, Date.now(),
      bancho_user.id,
  );
  console.log('Finished recalculating pp for ' + bancho_user.ircUsername);
}

export {load_user_info};