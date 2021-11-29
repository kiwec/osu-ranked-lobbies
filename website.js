import express from 'express';
import fetch from 'node-fetch';
import fs from 'fs';
import morgan from 'morgan';
import Sentry from '@sentry/node';
import {open} from 'sqlite';
import sqlite3 from 'sqlite3';

import {get_rank, get_rank_text_from_id, init_db} from './elo_mmr.js';
import {update_discord_role} from './discord_updates.js';
import SQL from 'sql-template-strings';

const Config = JSON.parse(fs.readFileSync('./config.json'));


function median(numbers) {
  if (numbers.length == 0) return 0;

  const middle = Math.floor(numbers.length / 2);
  if (numbers.length % 2 === 0) {
    return (numbers[middle - 1] + numbers[middle]) / 2;
  }
  return numbers[middle];
}

async function listen() {
  const discord_db = await open({
    filename: 'discord.db',
    driver: sqlite3.cached.Database,
  });

  const ranks_db = await open({
    filename: 'ranks.db',
    driver: sqlite3.cached.Database,
  });

  const app = express();
  app.use(Sentry.Handlers.requestHandler());
  app.use(morgan('combined'));
  app.enable('trust proxy');
  app.set('trust proxy', () => true);
  app.use(express.static('public'));

  app.get('/', (req, http_res) => {
    let top20 = '';
    const res = await ranks_db.get(SQL`
      SELECT * FROM user
      ORDER BY elo DESC LIMIT 20`
    );

    let rank = 1;
    for(let user of res) {
      top20 += `<tr>
        <td>${rank++}</td>
        <td><a href="/u/${user.user_id}">${user.username}</a></td>
        <td>${user.elo}</td>
      </tr>`
    }

    http_res.send(`<html>
    <head>
      <meta charset="utf-8">
      <title>Leaderboards</title>
    </head>
    <body>
      <table>
        <thead>
          <tr>
            <td>rank</td>
            <td>username</td>
            <td>elo</td>
          </tr>
        </thead>
        <tbody>${top20}</tbody>
      </table>
    </body>
    </html>`);
  });

  app.get('/auth', async (req, http_res) => {
    let res;

    if (!req.query.code) {
      http_res.status(403).send('No auth code provided.');
      return;
    }

    // Get discord user id from ephemeral token
    const ephemeral_token = req.query.state;
    res = await discord_db.get(SQL`
      SELECT * FROM auth_tokens
      WHERE ephemeral_token = ${ephemeral_token}`,
    );
    if (!res) {
      http_res.status(403).send('Discord token invalid or expired. Please click the "Link account" button once again.');
      return;
    }
    await discord_db.run(SQL`
      DELETE FROM auth_tokens
      WHERE ephemeral_token = ${ephemeral_token}`,
    );
    const discord_user_id = res.discord_user_id;

    // Check if user didn't already link their account
    res = await discord_db.get(SQL`
      SELECT * FROM user
      WHERE discord_id = ${discord_user_id}`,
    );
    if (res) {
      http_res.redirect('/success');
      return;
    }

    // Get oauth tokens from osu!api
    res = await fetch('https://osu.ppy.sh/oauth/token', {
      method: 'post',
      body: JSON.stringify({
        client_id: Config.client_id,
        client_secret: Config.client_secret,
        code: req.query.code,
        grant_type: 'authorization_code',
        redirect_uri: 'https://osu.kiwec.net/auth',
      }),
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      http_res.status(403).send('Invalid auth code.');
      console.error(res.status, await res.text());
      return;
    }

    // Get osu user id from the received oauth tokens
    const tokens = await res.json();
    res = await fetch('https://osu.ppy.sh/api/v2/me/osu', {
      method: 'get',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokens.access_token}`,
      },
    });
    if (!res.ok) {
      http_res.status(503).send('osu!web sent us bogus tokens. Sorry, idk what to do now');
      return;
    }
    const user_profile = await res.json();

    // Link accounts! Finally.
    await discord_db.run(
        `INSERT INTO user (
          discord_id,
          osu_id,
          osu_access_token,
          osu_refresh_token
        ) VALUES (?, ?, ?, ?)`,
        discord_user_id,
        user_profile.id,
        tokens.access_token,
        tokens.refresh_token,
    );

    http_res.redirect('/success');

    // Now for the fun part: add Discord roles, etc.
    await update_discord_role(
        user_profile.id,
        await get_rank_text_from_id(user_profile.id),
    );
  });

  app.get('/success', async (req, http_res) => {
    // TODO: make this nicer
    http_res.send(`<html>
    <head>
      <meta charset="utf-8">
      <title>Link successful</title>
    </head>
    <body>
      <pre>Congratulations!

      Your Discord account is now linked to your osu! account.
      </pre>
    </body>
    </html>`);
  });

  app.get('/lobby/:lobbyId/', async (req, http_res) => {
    http_res.redirect(`osu://mp/${req.params.lobbyId}/`);
  });

  app.get('/u/:userId/', async (req, http_res) => {
    const res = await ranks_db.get(SQL`
      SELECT * FROM user
      WHERE user_id = ${req.params.userId}`,
    );
    if (!res) {
      http_res.status(404).send(`Profile not found. Have you played a game in a ranked lobby yet?`);
      return;
    }

    const scores_res = await ranks_db.all(SQL`
      SELECT * FROM score
      WHERE user_id = ${req.params.userId}
      ORDER BY tms DESC LIMIT 10`,
    );
    let last_elo = 1500;
    let scores = '';
    for (const score of scores_res) {
      // Kind of dumb and slow
      const contest_res = await ranks_db.all(SQL`
        SELECT *, overall_pp FROM score
        INNER JOIN user ON user.user_id = score.user_id
        WHERE contest_id = ${score.contest_id}
        ORDER BY score DESC`,
      );
      let place = 1;
      for (const contest_score of contest_res) {
        if (contest_score.user_id == req.params.userId) {
          break;
        }
        place++;
      }

      const pps = [];
      for (const contest_score of contest_res) {
        pps.push(contest_score.overall_pp);
      }

      let mmr_diff = Math.round(score.logistic_mu - last_elo);
      if (mmr_diff >= 0) mmr_diff = '+' + mmr_diff;

      last_elo = score.logistic_mu;

      scores += `<tr>
        <td>${Math.round(median(pps))}pp</td>
        <td>${place}/${contest_res.length}</td>
        <td>${mmr_diff}</td>
        <td>${score.tms}</td>
      </tr>`;
    }

    if (res.games_played < 5) {
      http_res.send('unranked');
      return;
    }

    const rank = await get_rank(res.elo);
    http_res.send(`<html>
    <head>
      <meta charset="utf-8">
      <title>${res.username}'s profile</title>
    </head>
    <body>
      <pre>here is your rank info. (prettier page coming soon™)

        user id: ${res.user_id}
        username: ${res.username}
        games played: ${res.games_played}
        rank: ${rank.text} (#${rank.rank_nb}/${rank.total_nb})
        pp: ${res.overall_pp}
      </pre>
      <h3>last 10 matches</h3>
      <table>
        <thead><tr>
          <th>lobby skill</th>
          <th>placement</th>
          <th>mmr diff</th>
          <th>timestamp</th>
        </tr></thead>
        <tbody>
          ${scores}
        </tbody>
      </table>
      <br>
      <div>
        <!-- shameless but i'm still too lazy to design the website so... -->
        <a href="https://kiwec.net/discord">Join the o!RL discord if you haven't already #ad</a>
      </div>
    </body>
    </html>`);
  });

  app.use(Sentry.Handlers.errorHandler());

  app.listen(3001, () => {
    console.log(`Listening on :${3001}`);
  });
}

export {listen};
