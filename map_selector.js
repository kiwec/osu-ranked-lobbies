import {open} from 'sqlite';
import * as fs from 'fs/promises';
import sqlite3 from 'sqlite3';
import fetch from 'node-fetch';
import {promisify} from 'util';
import ojsama from 'ojsama';
import SQL from 'sql-template-strings';

import {readFileSync, constants} from 'fs';
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
      driver: sqlite3.cached.Database,
    });
  }
  if (!ranks_db) {
    ranks_db = await open({
      filename: 'ranks.db',
      driver: sqlite3.cached.Database,
    });
  }

  // Try to fetch user info from database
  let user = await ranks_db.get(SQL`SELECT * FROM user WHERE user_id = ${bancho_user.id}`);
  if (!user) {
    await ranks_db.run(SQL`
      INSERT INTO user (user_id, username, approx_mu, approx_sig, normal_mu, normal_sig, games_played)
      VALUES (${bancho_user.id}, ${bancho_user.ircUsername}, 1500, 350, 1500, 350, 0)`,
    );
    user = await ranks_db.get(SQL`SELECT * FROM user WHERE user_id = ${bancho_user.id}`);
  }

  bancho_user.games_played = user.games_played;

  if (user.aim_pp) {
    bancho_user.pp = {
      aim: user.aim_pp,
      acc: user.acc_pp,
      speed: user.speed_pp,
      overall: user.overall_pp,
      ar: user.avg_ar,
    };

    // Already updated their profile recently enough
    if (user.last_update_tms + 3600 * 24 > Date.now()) {
      return;
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
    const score_tms = Date.parse(score.created_at) / 1000;
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
    ar: 0,
  };
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
      pp.aim += map_pp.aim * current_weight;
      pp.acc += map_pp.acc * current_weight;
      pp.speed += map_pp.speed * current_weight;
      pp.overall += map_pp.total * current_weight;

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
      pp.ar += approach_rate;
    } catch (err) {
      console.error('Failed to compute pp for map', score.beatmap.id, ':', err);
      continue;
    }

    total_weight += current_weight;
    current_weight *= 0.95;
  }

  if (total_weight > 0) {
    pp.aim /= total_weight;
    pp.acc /= total_weight;
    pp.speed /= total_weight;
    pp.overall /= total_weight;
    pp.ar /= total_weight;
  }
  bancho_user.pp = pp;

  await ranks_db.run(SQL`
    UPDATE user
    SET
      aim_pp = ${pp.aim},
      acc_pp = ${pp.acc},
      speed_pp = ${pp.speed},
      overall_pp = ${pp.overall},
      avg_ar = ${pp.ar},
      last_top_score_tms = ${last_top_score_tms},
      last_update_tms = ${Date.now()}
    WHERE user_id = ${bancho_user.id}`,
  );
  console.log('Finished recalculating pp for ' + bancho_user.ircUsername);
}

export {load_user_info};
