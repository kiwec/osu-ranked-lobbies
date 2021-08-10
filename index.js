const sqlite3 = require('sqlite3');
const sqlite = require('sqlite');

const Bancho = require('bancho.js');
const client = new Bancho.BanchoClient(require('./config.json'));

let lobby_db = null;
let map_db = null;
let score_db = null;

function get_filter(arg) {
  const allowed_filters = ['stars', 'bpm', 'cs', 'ar', 'od', 'length', '95%pp', '100%pp', 'pp95%', 'pp100%'];
  const allowed_operators = ['<=', '>=', '==', '>', '<'];

  for (const operator of allowed_operators) {
    if (arg.includes(operator)) {
      const filter = arg.split(operator)[0].toLowerCase();
      if (!allowed_filters.includes(filter)) {
        throw new Error(`Filter '${filter}' is not allowed.`);
      }

      if (filter == 'pp95%') filter = '95%pp';
      if (filter == 'pp100%') filter = '100%pp';

      const value = parseInt(arg.split(operator)[1], 10);
      return `"${filter}" ${operator} ${value}`;
    }
  }

  throw new Error(`Missing operator in '${arg}'.`);
}

async function get_map_query(msg) {
  const args = msg.message.split(' ');
  if (args.length < 2) {
    throw new Error('Missing map selection criteria. For command usage, check my profile.');
  }
  args.shift(); // ignore !createlobby or !setfilters

  // Collect filters from command arguments
  const filters = [];
  for (const arg of args) {
    try {
      filters.push(get_filter(arg));
    } catch (e) {
      throw new Error(`Invalid map selection criterion '${arg}'.`);
    }
  }

  // Get number of matching maps
  const res = await map_db.get('select count(*) as nb_maps from map where ' + (filters.join(' AND ')));
  if (res.nb_maps == 0) {
    throw new Error('No maps found for your criteria. Try being less restrictive.');
  } else if (res.nb_maps < 25) {
    // We need >20 maps because of the "recent_maps" buffer we're using.
    throw new Error('Not enough maps found for your criteria. Try being less restrictive.');
  }

  return {
    creator: msg.user.ircUsername,
    nb_maps: res.nb_maps,
    query: 'select * from map where ' + (filters.join(' AND ')),
  };
}

async function switch_map(lobby) {
  if (lobby.recent_maps.length > 20) {
    lobby.recent_maps.shift();
  }

  let new_map = null;
  do {
    const offset = Math.floor(Math.random() * lobby.info.nb_maps);
    new_map = await map_db.get(lobby.info.query + ' limit 1 offset ' + offset);
  } while (lobby.recent_maps.includes(new_map.id));

  console.log(`[Lobby ${lobby.id}] New map: ${new_map.id} ${new_map.file}`);
  lobby.recent_maps.push(new_map.id);

  try {
    await lobby.setMap(new_map.id, 0);
  } catch (e) {
    console.error(`[Lobby ${lobby.id}] Failed to switch to map ${new_map.id} ${new_map.file}:`, e);
  }
}

async function join_lobby(channel, lobby_info) {
  const lobby = channel.lobby;
  lobby.info = lobby_info;
  lobby.recent_maps = [];

  lobby.on('allPlayersReady', async () => {
    console.log(`[Lobby ${lobby.id}] Starting match.`);
    await lobby.startMatch();
  });

  lobby.on('matchFinished', async (scores) => {
    console.log(`[Lobby ${lobby.id}] Finished match.`);

    const tms = Date.now();
    for (const score of scores) {
      console.log(score.player.user.ircUsername, 'got score:', score.score);
      await score_db.run(
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

  lobby.on('playerJoined', async (obj) => {
    if (obj.player.user.ircUsername == lobby.info.creator) {
      await lobby.setHost('#'+obj.player.user.id);
    }
  });

  lobby.on('playerLeft', async (obj) => {
    let nb_players = 0;
    for (const player of lobby.slots) {
      if (player != null) nb_players++;
    }

    if (nb_players == 0) {
      await lobby_db.run(`DELETE FROM lobby WHERE lobby_id = ?`, lobby.id);
      await lobby.closeLobby();
      console.log('Closed lobby ' + lobby.id);
    }
  });

  lobby.channel.on('message', async (msg) => {
    console.log(`[Lobby ${lobby.id}] ${msg.user.ircUsername}: ${msg.message}`);

    if (msg.user.ircUsername == lobby.info.creator && msg.message == '!skip') {
      await switch_map(lobby);
    }

    if (msg.user.ircUsername == lobby.info.creator && msg.message.indexOf('!setfilter') == 0) {
      try {
        lobby.info = await get_map_query(msg);
        await lobby_db.run(
            'update lobby set nb_maps = ?, query = ? where lobby_id = ?',
            lobby.info.nb_maps, lobby.info.query, lobby.id,
        );
        await lobby.channel.sendMessage(`Updated filters, there are now ${lobby.info.nb_maps} maps in rotation. Switching map...`);
        await switch_map(lobby);
      } catch (e) {
        console.error(`[Lobby ${lobby.id}] ${e}`);
        await lobby.channel.sendMessage(e.toString());
      }
    }
  });
}

async function main() {
  map_db = await sqlite.open({
    filename: 'maps.db',
    driver: sqlite3.Database,
  });

  lobby_db = await sqlite.open({
    filename: 'lobbies.db',
    driver: sqlite3.Database,
  });

  score_db = await sqlite.open({
    filename: 'scores.db',
    driver: sqlite3.Database,
  });

  await lobby_db.exec(`CREATE TABLE IF NOT EXISTS lobby (
    lobby_id INTEGER,
    creator TEXT,
    nb_maps INTEGER,
    query TEXT
  )`);

  await score_db.exec(`CREATE TABLE IF NOT EXISTS score (
    username TEXT,
    lobby_id INTEGER,
    map_id INTEGER,
    tms INTEGER,
    score INTEGER
  )`);

  await client.connect();
  console.log('Connected to bancho!');

  const lobby_infos = await lobby_db.all('select * from lobby');
  for (const lobby_info of lobby_infos) {
    try {
      const channel = await client.getChannel('#mp_' + lobby_info.lobby_id);
      await channel.join();
      await join_lobby(channel, lobby_info);
      console.log('Rejoined lobby ' + lobby_info.lobby_id);
    } catch (e) {
      console.error('Could not rejoin lobby ' + lobby_info.lobby_id + ':', e);
      await lobby_db.run(`DELETE FROM lobby WHERE lobby_id = ?`, lobby_info.lobby_id);
    }
  }

  client.on('PM', async (msg) => {
    console.log(`[PM] ${msg.user.ircUsername}: ${msg.message}`);

    if (msg.message.indexOf('!makelobby') == 0 || msg.message.indexOf('!createlobby') == 0) {
      try {
        const lobby_info = await get_map_query(msg);
        console.log(`Creating lobby for ${lobby_info.creator}...`);
        const channel = await client.createLobby(`${lobby_info.creator}'s automap lobby`);
        await join_lobby(channel, lobby_info);
        await channel.lobby.setPassword('');
        await switch_map(channel.lobby);
        await lobby_db.run(
            'insert into lobby (lobby_id, creator, nb_maps, query) values (?, ?, ?, ?)',
            channel.lobby.id, msg.user.ircUsername, lobby_info.nb_maps, lobby_info.query,
        );
        await channel.lobby.invitePlayer(msg.user.ircUsername);
      } catch (e) {
        console.error(`-> ${msg.user.ircUsername}: ${e}`);
        await msg.user.sendMessage(e.toString());
      }

      return;
    }

    if (msg.message.indexOf('!gimme') == 0) {
      try {
        const map_info = await get_map_query(msg);
        const offset = Math.floor(Math.random() * map_info.nb_maps);
        const map = await map_db.get(map_info.query + ' limit 1 offset ' + offset);
        const map_name = map.file.substr(0, map.file.lastIndexOf('.')); // remove ".osu"
        const str = '[https://osu.ppy.sh/beatmapsets/' + map.set_id + '#osu/' + map.id + ' ' + map_name + ']';
        console.log(`-> ${msg.user.ircUsername}: ${str}`);
        await msg.user.sendMessage(str);
      } catch (e) {
        console.error(`-> ${msg.user.ircUsername}: ${e}`);
        await msg.user.sendMessage(e.toString());
      }
    }
  });

  console.log('We\'re good to go.');
}

main();
