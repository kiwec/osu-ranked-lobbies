import express from 'express';
import morgan from 'morgan';
import {open} from 'sqlite';
import sqlite3 from 'sqlite3';
import {get_rank_text} from './elo_mmr.js';

const app = express();
app.use(morgan('combined'));
const port = 3001;

const ranks = await open({
  filename: 'ranks.db',
  driver: sqlite3.Database,
});

app.get('/', (req, res) => {
  res.send('this website, as you can see, is a work in progress.');

  // TODO: display leaderboard here
});

app.get('/u/:userId/', async function (req, http_res) {
  const res = await ranks.get('select * from user where user_id = ?', req.params.userId);
  const better_users = await ranks.get('SELECT COUNT(*) AS nb FROM user WHERE elo > ?', res.elo);
  const all_users = await ranks.get('SELECT COUNT(*) AS nb FROM user');

  http_res.send(`<html>
  <head>
    <meta charset="utf-8">
    <title>${res.username}'s profile</title>
  </head>
  <body>
    <pre>here is your rank info. (prettier page coming soon™)

      user id: ${res.user_id}
      username: ${res.username}
      elo-mmr: ${Math.round(res.elo)}
      rank: ${get_rank_text(1.0 - (better_users.nb / all_users.nb))} (#${better_users.nb + 1}/${all_users.nb})
    </pre>
  </body>
  </html>`);
});

app.listen(port, () => {
  console.log(`Listening on :${port}`);
});
