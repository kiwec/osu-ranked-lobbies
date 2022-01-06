// Note to potential API users:
// - If you want to do batch requests, it's probably better to just ask for
//   the data instead.
// - API is subject to change. Message us if you're using it so we avoid
//   breaking it in the future.

import SQL from 'sql-template-strings';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime.js';
dayjs.extend(relativeTime);

import {init_databases} from './database.js';
import {get_rank} from './elo_mmr.js';


let maps_db = null;
let ranks_db = null;

const USER_NOT_FOUND = new Error('User not found. Have you played a game in a ranked lobby yet?');
USER_NOT_FOUND.code = 404;


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

async function get_leaderboard_page(page_num) {
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

  return data;
}

async function get_user_profile(user_id) {
  const user = await ranks_db.get(SQL`
    SELECT * FROM user
    WHERE user_id = ${user_id}
    AND games_played > 0`,
  );
  if (!user) {
    throw USER_NOT_FOUND;
  }

  return {
    username: user.username,
    user_id: user.user_id,
    games_played: user.games_played,
    elo: Math.round(user.elo),
    rank: await get_rank(user.elo),
  };
}

async function get_user_matches(user_id, page_num) {
  const user = await ranks_db.get(SQL`
    SELECT user_id, games_played FROM user
    WHERE user_id = ${user_id}
    AND games_played > 0`,
  );
  if (!user) {
    throw USER_NOT_FOUND;
  }

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

  return data;
}

async function register_routes(app) {
  const databases = await init_databases();
  maps_db = databases.maps;
  ranks_db = databases.ranks;

  app.get('/api/leaderboard/:pageNum/', async (req, http_res) => {
    try {
      const data = await get_leaderboard_page(parseInt(req.params.pageNum, 10));
      http_res.set('Cache-control', 'public, max-age=60');
      http_res.json(data);
    } catch (err) {
      http_res.status(err.code).json({error: err.message});
    }
  });

  app.get('/api/user/:userId/', async (req, http_res) => {
    try {
      const data = await get_user_profile(parseInt(req.params.userId, 10));
      http_res.set('Cache-control', 'public, max-age=60');
      http_res.json(data);
    } catch (err) {
      http_res.status(err.code).json({error: err.message});
    }
  });

  app.get('/api/user/:userId/matches/:pageNum/', async (req, http_res) => {
    try {
      const data = await get_user_matches(
          parseInt(req.params.userId, 10),
          parseInt(req.params.pageNum, 10),
      );
      http_res.set('Cache-control', 'public, max-age=60');
      http_res.json(data);
    } catch (err) {
      http_res.status(err.code).json({error: err.message});
    }
  });
}

export {
  generate_pagination,
  get_leaderboard_page,
  get_user_profile,
  get_user_matches,
  register_routes,
};
