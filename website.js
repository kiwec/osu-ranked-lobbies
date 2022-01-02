import express from 'express';
import fetch from 'node-fetch';
import morgan from 'morgan';
import Sentry from '@sentry/node';
import {open} from 'sqlite';
import sqlite3 from 'sqlite3';
import cookieParser from 'cookie-parser';

import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime.js';
dayjs.extend(relativeTime);

import {get_rank, get_rank_text_from_id} from './elo_mmr.js';
import {update_discord_role, update_discord_username} from './discord_updates.js';
import SQL from 'sql-template-strings';
import Config from './util/config.js';
import {render_with_layout, render_error} from './util/helpers.js';


function generate_pagination(page_num, min_pages, max_pages) {
  const MAX_PAGINATED_PAGES = Math.min(max_pages, 9);
  let pagination_min = page_num;
  let pagination_max = page_num;
  let nb_paginated_pages = min_pages;
  const pages = [];

  while (nb_paginated_pages < MAX_PAGINATED_PAGES) {
    if (pagination_min > min_pages) {
      pagination_min--;
      nb_paginated_pages++;
    }
    if (pagination_max < max_pages) {
      pagination_max++;
      nb_paginated_pages++;
    }
  }
  for (let i = pagination_min; i <= pagination_max; i++) {
    pages.push({
      number: i,
      is_current: i == page_num,
    });
  }

  return {
    previous: Math.max(page_num - 1, 1),
    next: Math.min(page_num + 1, max_pages),
    pages: pages,
  };
}

async function listen() {
  const discord_db = await open({
    filename: 'discord.db',
    driver: sqlite3.cached.Database,
  });

  const maps_db = await open({
    filename: 'maps.db',
    driver: sqlite3.cached.Database,
  });

  const ranks_db = await open({
    filename: 'ranks.db',
    driver: sqlite3.cached.Database,
  });

  const app = express();

  if (Config.ENABLE_SENTRY) {
    app.use(Sentry.Handlers.requestHandler());
  }

  app.use(morgan('combined'));
  app.enable('trust proxy');
  app.set('trust proxy', () => true);
  app.use(express.static('public'));

  app.use(cookieParser());

  app.use(function(req, res, next) {
    const cookies = req.cookies;
    Config.theme = 'dark';
    if (cookies && cookies.theme) {
      Config.theme = cookies.theme;
    }
    next();
  });

  const render_leaderboard = async (page_num) => {
    const PLAYERS_PER_PAGE = 20;

    const month_ago_tms = Date.now() - (30 * 24 * 3600 * 1000);
    const total_players = await ranks_db.get(SQL`
      SELECT COUNT(*) AS nb FROM user
      WHERE games_played > 4 AND last_contest_tms > ${month_ago_tms}`,
    );

    // Fix user-provided page number
    const nb_pages = Math.ceil(total_players.nb / PLAYERS_PER_PAGE);
    if (page_num <= 0 || isNaN(page_num)) {
      page_num = 1;
      // TODO: redirect?
    }
    if (page_num > nb_pages) {
      page_num = nb_pages;
      // TODO: redirect?
    }

    const offset = (page_num - 1) * PLAYERS_PER_PAGE;
    const res = await ranks_db.all(SQL`
      SELECT * FROM user
      WHERE games_played > 4 AND last_contest_tms > ${month_ago_tms}
      ORDER BY elo DESC LIMIT ${PLAYERS_PER_PAGE} OFFSET ${offset}`,
    );


    const data = {
      nb_ranked_players: total_players.nb,
      the_one: false,
      players: [],
      pagination: generate_pagination(page_num, 1, nb_pages),
    };

    // Players
    let ranking = offset + 1;
    if (ranking == 1) {
      data.the_one = {
        user_id: res[0].user_id,
        username: res[0].username,
        ranking: ranking,
        elo: Math.round(res[0].elo),
      };

      res.shift();
      ranking++;
    }

    for (const user of res) {
      data.players.push({
        user_id: user.user_id,
        username: user.username,
        ranking: ranking,
        elo: Math.round(user.elo),
      });

      ranking++;
    }

    data.title = 'Leaderboard - o!RL';
    return render_with_layout('views/leaderboard.html', data);
  };

  const render_user = async (user, page_num) => {
    const MATCHES_PER_PAGE = 20;

    // Fix user-provided page number
    const nb_pages = Math.ceil(user.games_played / MATCHES_PER_PAGE);
    if (page_num <= 0 || isNaN(page_num)) {
      page_num = 1;
      // TODO: redirect?
    }
    if (page_num > nb_pages) {
      page_num = nb_pages;
      // TODO: redirect?
    }

    const data = {
      username: user.username,
      user_id: user.user_id,
      games_played: user.games_played,
      elo: Math.round(user.elo),
      rank: await get_rank(user.elo),
      matches: [],
      pagination: generate_pagination(page_num, 1, nb_pages),
    };

    const offset = (page_num - 1) * MATCHES_PER_PAGE;
    const scores = await ranks_db.all(SQL`
      SELECT * FROM score
      WHERE user_id = ${user.user_id}
      ORDER BY tms DESC LIMIT ${MATCHES_PER_PAGE} OFFSET ${offset}`,
    );

    for (const score of scores) {
      const elo_change = Math.round(score.difference);

      let placement = 0;
      const contest = await ranks_db.get(SQL`
        SELECT * FROM contest WHERE rowid = ${score.contest_id}`,
      );
      const contest_scores = await ranks_db.all(SQL`
        SELECT user_id FROM score
        WHERE contest_id = ${score.contest_id}
        ORDER BY score DESC`,
      );
      for (const contest_score of contest_scores) {
        placement++;
        if (contest_score.user_id == user.user_id) {
          break;
        }
      }

      data.matches.push({
        map: await maps_db.get(SQL`SELECT * FROM map WHERE id = ${contest.map_id}`),
        placement: placement,
        players_in_match: contest_scores.length,
        elo_change: elo_change,
        positive: elo_change > 0,
        negative: elo_change < 0,
        time: dayjs(score.tms).fromNow(),
        tms: Math.round(score.tms / 1000),
      });
    }

    data.title = `${data.username}  - Userpage - o!RL`;
    data.meta = `
      <meta content="${data.title}" property="og:title" />
      <meta content="#${data.rank.rank_nb} - ${data.rank.text}" property="og:description" />
      <meta content="https://osu.kiwec.net/u/${data.user_id}" property="og:url" />
      <meta content="https://s.ppy.sh/a/${data.user_id}" property="og:image" />
    `;
    data.profile_link = `https://osu.ppy.sh/users/${data.user_id}`;
    return render_with_layout('views/userpage.html', data);
  };

  app.get('/', async (req, http_res) => {
    http_res.redirect('/leaderboard/');
  });

  app.get('/leaderboard/', async (req, http_res) => {
    http_res.send(await render_leaderboard(1));
  });

  app.get('/leaderboard/page-:pageNum/', async (req, http_res) => {
    http_res.send(await render_leaderboard(parseInt(req.params.pageNum, 10)));
  });

  app.get('/u/:userId/', async (req, http_res) => {
    const user = await ranks_db.get(SQL`
      SELECT * FROM user
      WHERE user_id = ${req.params.userId}
      AND games_played > 0`,
    );
    if (!user) {
      http_res.status(404).send(await render_error('Profile not found. Have you played a game in a ranked lobby yet?', 404));
      return;
    }

    http_res.send(await render_user(user, 1));
  });

  app.get('/u/:userId/page-:pageNum', async (req, http_res) => {
    const user = await ranks_db.get(SQL`
      SELECT * FROM user
      WHERE user_id = ${req.params.userId}
      AND games_played > 0`,
    );
    if (!user) {
      http_res.status(404).send(await render_error('Profile not found. Have you played a game in a ranked lobby yet?', 404));
      return;
    }

    http_res.send(await render_user(user, parseInt(req.params.pageNum, 10)));
  });

  app.get('/auth', async (req, http_res) => {
    let res;

    if (!req.query.code) {
      http_res.status(403).send(await render_error('No auth code provided.', 403));
      return;
    }

    // Get discord user id from ephemeral token
    const ephemeral_token = req.query.state;
    res = await discord_db.get(SQL`
      SELECT * FROM auth_tokens
      WHERE ephemeral_token = ${ephemeral_token}`,
    );
    if (!res) {
      http_res.status(403).send(await render_error('Discord token invalid or expired. Please click the "Link account" button once again.', 403));
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
    if (!res.ok) {
      http_res.status(403).send(await render_error('Invalid auth code.', 403));
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
      http_res.status(503).send(await render_error('osu!web sent us bogus tokens. Sorry, idk what to do now', 503));
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
    await update_discord_username(
        user_profile.id,
        user_profile.username,
        'Linked their account',
    );
    await update_discord_role(
        user_profile.id,
        await get_rank_text_from_id(user_profile.id),
    );
  });

  app.get('/success', async (req, http_res) => {
    const data = {title: 'Account Linked - o!RL'};
    http_res.send(await render_with_layout('views/success.html', data));
  });

  if (Config.ENABLE_SENTRY) {
    app.use(Sentry.Handlers.errorHandler());
  }

  app.listen(3001, () => {
    console.log(`Listening on :${3001}`);
  });
}

export {listen};
