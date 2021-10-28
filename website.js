import express from 'express';
import fetch from 'node-fetch';
import fs from 'fs';
import morgan from 'morgan';
import Sentry from '@sentry/node';
import {open} from 'sqlite';
import sqlite3 from 'sqlite3';

import {get_rank_text, get_rank_text_from_id} from './elo_mmr.js';
import {update_discord_role} from './discord_updates.js';
import SQL from 'sql-template-strings';

const Config = JSON.parse(fs.readFileSync('./config.json'));


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

  app.get('/', (req, res) => {
    res.redirect('https://kiwec.net/discord');
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

    if (res.games_played < 5) {
      http_res.send('unranked');
      return;
    }

    const better_users = await ranks_db.get(SQL`SELECT COUNT(*) AS nb FROM user WHERE elo > ${res.elo} AND games_played > 4`);
    const all_users = await ranks_db.get('SELECT COUNT(*) AS nb FROM user WHERE games_played > 4');

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
        rank: ${get_rank_text(1.0 - (better_users.nb / all_users.nb))} (#${better_users.nb + 1}/${all_users.nb})
      </pre>
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
