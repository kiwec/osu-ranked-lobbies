import express from 'express';
import fs from 'fs';
import fetch from 'node-fetch';
import morgan from 'morgan';
import Sentry from '@sentry/node';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';

import bancho from './bancho.js';
import databases from './database.js';
import {get_rank, get_rank_text_from_id} from './elo_mmr.js';
import {update_discord_role, update_discord_username} from './discord_updates.js';
import Config from './util/config.js';
import {render_error} from './util/helpers.js';
import {register_routes as register_api_routes} from './website_api.js';


async function listen() {
  const stmts = {
    user_login: databases.ranks.prepare('SELECT user_id, expires_tms FROM website_tokens WHERE token = ?'),
    delete_token: databases.ranks.prepare('DELETE FROM website_tokens WHERE user_id = ?'),
    fetch_tokens: databases.ranks.prepare('SELECT user_id, token, expires_tms FROM website_tokens WHERE user_id = ?'),
    insert_token: databases.ranks.prepare(`
      INSERT INTO website_tokens (
        user_id,
        token,
        expires_tms,
        osu_access_token,
        osu_refresh_token
      ) VALUES (?, ?, ?, ?, ?)`,
    ),
    user_from_id: databases.ranks.prepare(`
      SELECT * FROM user
      WHERE user_id = ?`,
    ),
    search_player: databases.ranks.prepare(`
      SELECT * FROM user
      WHERE username LIKE ?
      AND games_played > 0
      ORDER BY elo DESC
      LIMIT 5
    `),
    discord_from_ephemeral_token: databases.discord.prepare('SELECT * FROM auth_tokens WHERE ephemeral_token = ?'),
    delete_ephemeral_token: databases.discord.prepare('DELETE FROM auth_tokens WHERE ephemeral_token = ?'),
    user_from_discord_id: databases.discord.prepare('SELECT * FROM user WHERE discord_id = ?'),
    link_account: databases.discord.prepare(`
      INSERT INTO user (
        discord_id,
        osu_id,
        osu_access_token,
        osu_refresh_token
      ) VALUES (?, ?, ?, ?)`,
    ),
  };

  const app = express();

  if (Config.ENABLE_SENTRY) {
    app.use(Sentry.Handlers.requestHandler());
  }

  app.use(morgan('combined'));
  app.enable('trust proxy');
  app.set('trust proxy', () => true);
  app.use(express.static('public'));

  app.use(cookieParser());

  // Auth middleware
  app.use(async function(req, res, next) {
    const cookies = req.cookies;

    if (cookies && cookies.token) {
      const user_token = stmts.user_login.get(cookies.token);
      const current_tms = Date.now();
      if (user_token) {
        req.user_id = user_token.user_id;
        res.set('X-Osu-ID', user_token.user_id);
        next();
        return;
      }
    }

    res.clearCookie('token');
    next();
  });

  await register_api_routes(app);

  app.get('/', async (req, http_res) => {
    http_res.redirect('/lobbies/');
  });

  app.get('/auth', async (req, http_res) => {
    let res;

    if (!req.query.code) {
      http_res.status(403).send(await render_error(req, 'No auth code provided.', 403));
      return;
    }

    const fetchOauthTokens = async (req) => {
      // Get oauth tokens from osu!api
      try {
        res = await fetch('https://osu.ppy.sh/oauth/token', {
          method: 'post',
          body: JSON.stringify({
            client_id: Config.osu_v2api_client_id,
            client_secret: Config.osu_v2api_client_secret,
            code: req.query.code,
            grant_type: 'authorization_code',
            redirect_uri: Config.website_base_url + '/auth',
          }),
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
        });
      } catch (err) {
        http_res.status(503).send(await render_error(req, 'Internal server error, try again later.', 503));
        console.error(res.status, await res.text());
        return null;
      }
      if (!res.ok) {
        http_res.status(403).send(await render_error(req, 'Invalid auth code.', 403));
        console.error(res.status, await res.text());
        return null;
      }

      // Get osu user id from the received oauth tokens
      return await res.json();
    };

    const fetchUserProfile = async (req, access_token) => {
      try {
        res = await fetch('https://osu.ppy.sh/api/v2/me/osu', {
          method: 'get',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${access_token}`,
          },
        });
      } catch (err) {
        http_res.status(503).send(await render_error(req, 'Internal server error, try again later.', 503));
        console.error(res.status, await res.text());
        return null;
      }
      if (!res.ok) {
        http_res.status(503).send(await render_error(req, 'osu!web sent us bogus tokens. Sorry, idk what to do now', 503));
        return null;
      }

      return await res.json();
    };

    if (req.query.state === 'login') {
      const tokens = await fetchOauthTokens(req);
      if (tokens === null) return;

      const user_profile = await fetchUserProfile(req, tokens.access_token);
      if (user_profile === null) return;

      const user_token = stmts.fetch_tokens.get(user_profile.id);
      const current_tms = Date.now();
      if (user_token && user_token.expires_tms > current_tms) {
        stmts.delete_token.run(user_token.user_id);
      } else if (user_token) {
        http_res.cookie('token', user_token.token, {sameSite: true});
        http_res.redirect(`/u/${user_token.user_id}`);
        return;
      }

      const new_expires_tms = Date.now() + tokens.expires_in * 1000;
      const new_auth_token = crypto.randomBytes(20).toString('hex');
      stmts.insert_token.run(
          user_profile.id,
          new_auth_token,
          new_expires_tms,
          tokens.access_token,
          tokens.refresh_token,
      );

      http_res.cookie('token', new_auth_token, {sameSite: true});
      http_res.redirect(`/u/${user_profile.id}`);
      return;
    }

    // Get discord user id from ephemeral token
    const ephemeral_token = req.query.state;
    res = stmts.discord_from_ephemeral_token.get(ephemeral_token);
    if (!res) {
      http_res.status(403).send(await render_error(req, 'Discord token invalid or expired. Please click the "Link account" button once again.', 403));
      return;
    }
    stmts.delete_ephemeral_token.run(ephemeral_token);
    const discord_user_id = res.discord_user_id;

    // Check if user didn't already link their account
    res = stmts.user_from_discord_id.get(discord_user_id);
    if (res) {
      http_res.redirect('/success');
      return;
    }

    const tokens = await fetchOauthTokens(req);
    if (tokens === null) return;

    const user_profile = await fetchUserProfile(req, tokens.access_token);
    if (user_profile === null) return;

    // Link accounts! Finally.
    stmts.link_account.run( discord_user_id, user_profile.id, tokens.access_token, tokens.refresh_token);
    http_res.redirect('/success');

    // Now for the fun part: add Discord roles, etc.
    await update_discord_username(
        user_profile.id,
        user_profile.username,
        'Linked their account',
    );
    await update_discord_role(
        user_profile.id,
        get_rank_text_from_id(user_profile.id),
    );
  });

  app.get('/success', async (req, http_res) => {
    const data = {title: 'Account Linked - o!RL'};
    http_res.send(await render_error(req, 'Account linked!', 200, data));
  });

  app.get('/search', async (req, http_res) => {
    const players = stmts.search_player.all(`%${req.query.query}%`);
    http_res.set('Cache-control', 'public, max-age=60');
    http_res.json(players);
  });

  app.get('/get-invite/:banchoId', async (req, http_res) => {
    if (!req.user_id) {
      http_res.send(await render_error(req, 'You need to log in to get an invite!', 403));
      return;
    }

    let inviting_lobby = null;
    for (const lobby of bancho.joined_lobbies) {
      if (lobby.invite_id == req.params.banchoId) {
        inviting_lobby = lobby;
        break;
      }
    }
    if (!inviting_lobby) {
      http_res.send(await render_error(req, 'Could not find the lobby. Maybe it has been closed?', 404));
      return;
    }

    const user = stmts.user_from_id.get(req.user_id);
    await bancho.privmsg(user.username, `${user.username}, here's your invite: [http://osump://${inviting_lobby.invite_id}/ ${inviting_lobby.name}]`);
    http_res.send(await render_error(req, 'An invite to the lobby has been sent. Check your in-game messages.', 200));
  });

  // In production, we let expressjs return a blank page of status 404, so
  // that nginx serves the index.html page directly. During development
  // however, it's useful to serve that page since it avoids having to run a
  // proxy on the development machine.
  if (!Config.IS_PRODUCTION) {
    app.get('*', async (req, http_res) => {
      http_res.set('Cache-control', 'public, max-age=14400');
      http_res.send(fs.readFileSync('public/index.html', 'utf-8'));
    });
  }

  // Dirty hack to handle Discord embeds nicely
  app.get('/u/:userId', async (req, http_res) => {
    if (req.get('User-Agent').indexOf('Discordbot') != -1) {
      const user = stmts.user_from_id.get(req.params.userId);
      if (!user) {
        http_res.status(404).send('');
        return;
      }

      const rank = get_rank(user.elo);
      http_res.send(`<html>
        <head>
          <meta content="${user.username} - o!RL" property="og:title" />
          <meta content="#${rank.rank_nb} - ${rank.text}" property="og:description" />
          <meta content="https://osu.kiwec.net/u/${user.user_id}" property="og:url" />
          <meta content="https://s.ppy.sh/a/${user.user_id}" property="og:image" />
        </head>
        <body>hi :)</body>
      </html>`);
      return;
    }

    if (Config.IS_PRODUCTION) {
      http_res.status(404).send('');
    } else {
      http_res.set('Cache-control', 'public, max-age=14400');
      http_res.send(fs.readFileSync('public/index.html', 'utf-8'));
    }
  });

  if (Config.ENABLE_SENTRY) {
    app.use(Sentry.Handlers.errorHandler());
  }

  app.listen(3001, () => {
    console.log(`Listening on :${3001}`);
  });
}

export {listen};
