const sqlite3 = require('sqlite3');
const sqlite = require('sqlite');

const Bancho = require('bancho.js');
const client = new Bancho.BanchoClient(require('./config.json'));

// set this to a lobby id to rejoin it instead of creating a new lobby
// TODO: detect lobbies? store in db?
const rejoin_lobby = null;

async function load_maps(lobby, pp, variation) {
  const beatmaps = require('./pp_db/beatmaps_with_pp.json');
  lobby.maps = [];
  for (const map of beatmaps) {
    if (map.pp > pp - variation && map.pp < pp + variation) {
      lobby.maps.push(map.id);
    }
  }

  lobby.previous_maps = [];
  console.log('loaded ' + pp + 'pp maps');
  await switch_map(lobby);
}

async function switch_map(lobby) {
  if (lobby.previous_maps.length > 20) {
    lobby.previous_maps.shift();
  }

  let new_map_id = 0;
  do {
    new_map_id = lobby.maps[Math.floor(Math.random()*lobby.maps.length)];
  } while (lobby.previous_maps.includes(new_map_id));

  console.log('new map id:', new_map_id);
  lobby.previous_maps.push(new_map_id);

  try {
    await lobby.setMap(new_map_id, 0);
  } catch (e) {
    console.error('failed to change map:', e);
    await switch_map(lobby);
  }
}

async function main() {
  const db = await sqlite.open({
    filename: 'farm.db',
    driver: sqlite3.Database,
  });

  await db.exec(`CREATE TABLE IF NOT EXISTS score (
    username TEXT,
    lobby_id INTEGER,
    map_id INTEGER,
    tms INTEGER,
    score INTEGER
  )`);

  await client.connect();
  console.log('online!');

  client.on('PM', (msg) => {
    try {
      if (msg.message.indexOf('!gimme ') == 0) {
        if (msg.message.endsWith('pp')) {
          const pp_str = msg.message.substr('!gimme '.length, msg.message.lastIndexOf('pp'));
          const pp = parseInt(pp_str, 10);

          // this is really unoptimized lol
          const beatmaps = require('./pp_db/beatmaps_with_pp.json');
          const farmable = {};
          for (const map of beatmaps) {
            if (map.pp > pp - 10 && map.pp < pp + 10) {
              farmable.push(map);
            }
          }

          const map = farmable[Math.floor(Math.random()*farmable.length)];
          const map_name = map.file.substr(0, map.file.lastIndexOf('.')); // remove ".osu"
          msg.user.sendMessage('[https://osu.ppy.sh/beatmapsets/' + map.set_id + '#osu/' + map.id + ' ' + map_name + '] - 95% acc = ' + map.pp + 'pp');
        }
      }
    } catch (e) {
      console.error('Error while processing !gimme:', e);
      console.error('Message that triggered it:', msg.message);
      msg.user.sendMessage('Sorry, an error occurred while processing that command. Try again maybe?');
    }
  });

  let channel = null;
  if (rejoin_lobby) {
    channel = await client.getChannel('#mp_' + rejoin_lobby);
    await channel.join();
  } else {
    channel = await client.createLobby('150pp maps (auto map select) !start !skip');
  }

  console.log('lobby id:', channel.lobby.id);

  const lobby = channel.lobby;
  await load_maps(lobby, 150, 10);
  await lobby.setPassword('');

  lobby.on('allPlayersReady', async () => {
    await lobby.startMatch();
  });

  lobby.on('matchFinished', async (scores) => {
    console.log('match finished');

    const tms = Date.now();

    for (const score of scores) {
      console.log(score.player.user.ircUsername, 'got score:', score.score);
      await db.run(
          'INSERT INTO score VALUES (?, ?, ?, ?, ?)',
          score.player.user.ircUsername,
          lobby.id,
          lobby.beatmapId,
          tms,
          score.score,
      );
    }

    await switch_map(lobby);
  });

  lobby.channel.on('message', async (msg) => {
    if (msg.message == '!start') {
      await lobby.startMatch();
    }

    if (msg.message == '!skip') {
      await switch_map(lobby);
    }

    if (msg.user.isClient() && msg.message.indexOf('!setpp') == 0) {
      const args = msg.message.split(' ');
      const pp = parseInt(args[1], 10);
      const variation = parseInt(args[2], 10);
      await load_maps(lobby, pp, variation);
      await lobby.channel.sendMessage(`Now playing ${pp}pp maps (+- ${variation} pp). Don't forget to rename the lobby!`);
    }
  });

  process.on('SIGINT', async () => {
    console.log('closing lobbies...');
    await lobby.closeLobby();
    await client.disconnect();
  });
}

main();
