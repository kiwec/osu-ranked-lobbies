const sqlite3 = require('sqlite3');
const sqlite = require('sqlite');

const Bancho = require('bancho.js');
const client = new Bancho.BanchoClient(require('./config.json'));

let lobby_db = null;
let map_db = null;

function get_filter(arg) {
  const allowed_filters = ['stars', 'length', 'bpm', 'cs', 'ar', 'od', '95%pp', '100%pp', 'pp95%', 'pp100%'];
  const allowed_operators = ['<=', '>=', '==', '>', '<', '='];

  for (const operator of allowed_operators) {
    if (arg.includes(operator)) {
      const filter = arg.split(operator)[0].toLowerCase();
      if (!allowed_filters.includes(filter)) {
        throw new Error(`Filter '${filter}' is not allowed.`);
      }

      const value = parseFloat(arg.split(operator)[1], 10);
      return {filter, operator, value};
    }
  }

  throw new Error(`Missing operator in '${arg}'.`);
}

function parse_mods(arg) {
  arg = arg.toUpperCase();
  if (arg.length < 3 || arg.length % 2 == 0) {
    throw new Error('Invalid mod list. For command usage, check my profile.');
  }

  const allowed_mods = ['HD', 'FL', 'EZ', 'HR', 'HT', 'DT', 'NC'];
  const mods = [];
  let i = 1;
  while (true) {
    if (i >= arg.length) break;

    let current_arg = arg[i] + arg[i+1];
    if (current_arg == 'NC') current_arg = 'DT';
    if (!allowed_mods.includes(current_arg)) {
      throw new Error(`Mod '${current_arg}' is not allowed.`);
    }

    mods.push(current_arg);
    i += 2;
  }

  return mods;
}

function build_query(filters, mods) {
  const MODS_NOMOD = 0;
  const MODS_NF = (1<<0);
  const MODS_EZ = (1<<1);
  const MODS_TD = (1<<2);
  const MODS_HD = (1<<3);
  const MODS_HR = (1<<4);
  const MODS_SD = (1<<5);
  const MODS_DT = (1<<6);
  const MODS_RX = (1<<7);
  const MODS_HT = (1<<8);
  const MODS_NC = (1<<9);
  const MODS_FL = (1<<10);
  const MODS_AT = (1<<11);
  const MODS_SO = (1<<12);
  const MODS_AP = (1<<13);
  const MODS_PF = (1<<14);
  const MODS_95ACC = (1<<15);
  const MODS_100ACC = (1<<16);

  let enabled_mods = MODS_NOMOD;

  if (mods.includes('EZ')) enabled_mods |= MODS_EZ;
  if (mods.includes('HR')) enabled_mods |= MODS_HR;
  if (mods.includes('DT')) enabled_mods |= MODS_DT;
  if (mods.includes('HT')) enabled_mods |= MODS_HT;
  if (mods.includes('FL')) enabled_mods |= MODS_FL;
  if (mods.includes('HD')) enabled_mods |= MODS_HD;

  for (const filter of filters) {
    const filter_name = filter.filter;

    if (filter_name == 'length') {
      if (mods.includes('DT')) {
        filter.value /= 1.5;
      } else if (mods.includes('HT')) {
        filter.value /= 0.75;
      }
    }

    if (filter_name == 'bpm') {
      if (mods.includes('DT')) {
        filter.value *= 1.5;
      } else if (mods.includes('HT')) {
        filter.value *= 0.75;
      }
    }

    if (filter_name == '95%pp' || filter_name == 'pp95%') {
      query_filters.push(`(mods == ${enabled_mods & MODS_95ACC} AND pp ${filter.operator} ${filter.value})`);
    } else if (filter_name == '100%pp' || filter_name == 'pp100%') {
      query_filters.push(`(mods == ${enabled_mods & MODS_100ACC} AND pp ${filter.operator} ${filter.value})`);
    } else {
      query_filters.push(`"${filter_name}" ${filter.operator} ${filter.value}`);
    }
  }

  return 'from pp inner join map on map.id = pp.map_id where ' + (query_filters.join(' AND '));
}

function parse_filter_string(filter_string) {
  const filters = [];
  let mods = [];

  const args = filter_string.split(' ');
  for (const arg of args) {
    if (arg.indexOf('+') == 0) {
      mods = [...mods, ...parse_mods(arg)];

      if (mods.includes('EZ') && mods.includes('HR')) {
        throw new Error('Cannot use both EZ and HR mods at the same time.');
      }

      if (mods.includes('DT') && mods.includes('HT')) {
        throw new Error('Cannot use both DT and HT mods at the same time.');
      }

      continue;
    }

    try {
      filters.push(get_filter(arg));
    } catch (e) {
      throw new Error(`Invalid map selection criterion '${arg}'.`);
    }
  }

  return {filters, mods};
}

// Edits the given "lobby_info" object, see end of function for modified values
async function update_lobby_filters(lobby_info, filter_string) {
  const args = filter_string.split(' ');
  if (args.length < 2) {
    throw new Error('Missing map selection criteria. For command usage, check my profile.');
  }
  args.shift(); // ignore !createlobby or !setfilters
  filter_string = args.join(' ');

  const {filters, mods} = parse_filter_string(filter_string);
  const query = build_query(filters, mods);

  // Get number of matching maps
  const res = await map_db.get('select count(*) as nb_maps ' + query);
  if (res.nb_maps == 0) {
    throw new Error('No maps found for your criteria. Try being less restrictive.');
  }

  lobby_info.nb_maps = res.nb_maps;
  lobby_info.filters = filter_string;
  lobby_info.mods = mods;
  lobby_info.query = query;
}

async function switch_map(lobby) {
  // When the bot restarts, re-add the currently selected map to recent maps
  if (!lobby.recent_maps.includes(lobby.beatmapId)) {
    lobby.recent_maps.push(lobby.beatmapId);
  }

  if (lobby.recent_maps.length >= Math.min(lobby.info.nb_maps, 25)) {
    lobby.recent_maps.shift();
  }

  let new_map = null;
  do {
    const offset = Math.floor(Math.random() * lobby.info.nb_maps);
    new_map = await map_db.get('select * ' + lobby.info.query + ' limit 1 offset ' + offset);
  } while (lobby.recent_maps.includes(new_map.id));

  console.log(`[Lobby ${lobby.id}] New map: ${new_map.id}`);
  lobby.recent_maps.push(new_map.id);

  try {
    const flavor = `${new_map.stars.toFixed(2)}*, ${Math.floor(new_map.pp)}pp`;
    await lobby.channel.sendMessage(`!mp map ${new_map.id} 0 ${new_map.name} (${flavor} with mods) [https://api.chimu.moe/v1/download/${new_map.id}?n=1&r=${lobby.randomString()} Direct download]`);
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
    await switch_map(lobby);
  });

  // After the host finishes playing, their client resets the map to the one they played.
  // Because we change the map *before* they rejoin the lobby, we need to re-select our map.
  // We could also remove host altogether, but not sure if that's a better solution...
  lobby.on('beatmapId', async (beatmap_id) => {
    if (lobby.recent_maps.length >= 2 && lobby.recent_maps[lobby.recent_maps.length-2] == beatmap_id) {
      await lobby.setMap(lobby.recent_maps[lobby.recent_maps.length-1]);
    }
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
    const host = lobby.getHost();
    let host_id = null;
    if (host != null) host_id = host.user.id;

    if (msg.user.id == host_id && msg.message == '!skip') {
      await switch_map(lobby);
    }

    if (msg.user.id == host_id && msg.message.indexOf('!setfilter') == 0) {
      try {
        await update_lobby_filters(lobby.info, msg.message);
        await lobby_db.run(
            'update lobby set filters = ? where lobby_id = ?',
            lobby.info.filters, lobby.id,
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

  await lobby_db.exec(`CREATE TABLE IF NOT EXISTS lobby (
    lobby_id INTEGER,
    creator TEXT,
    filters TEXT
  )`);

  await client.connect();
  console.log('Connected to bancho!');

  const lobby_infos = await lobby_db.all('select * from lobby');
  for (const lobby_info of lobby_infos) {
    try {
      const channel = await client.getChannel('#mp_' + lobby_info.lobby_id);
      await channel.join();

      const full_info = {
        creator: lobby_info.creator,
      };
      await update_lobby_filters(full_info, lobby_info.filters);

      await join_lobby(channel, full_info);
      console.log('Rejoined lobby ' + lobby_info.lobby_id);
    } catch (e) {
      console.error('Could not rejoin lobby ' + lobby_info.lobby_id + ':', e);
      await lobby_db.run(`DELETE FROM lobby WHERE lobby_id = ?`, lobby_info.lobby_id);
    }
  }

  client.on('PM', async (msg) => {
    console.log(`[PM] ${msg.user.ircUsername}: ${msg.message}`);

    if (msg.message.indexOf('!help') == 0) {
      await msg.user.sendMessage('The full command list is on my profile. :)');
      return;
    }

    if (msg.message.indexOf('!setfilter') == 0 || msg.message.indexOf('!skip') == 0) {
      await msg.user.sendMessage('Sorry, you should send that command in #multiplayer.');
      return;
    }

    if (msg.message.indexOf('!makelobby') == 0 || msg.message.indexOf('!createlobby') == 0) {
      try {
        const lobby_info = {creator: msg.user.ircUsername};
        await update_lobby_filters(lobby_info, msg.message);
        console.log(`Creating lobby for ${lobby_info.creator}...`);
        await msg.user.sendMessage(`Creating a lobby with ${lobby_info.nb_maps} maps...`);
        const channel = await client.createLobby(`${lobby_info.creator}'s automap lobby`);
        await join_lobby(channel, lobby_info);
        await channel.lobby.setPassword('');
        await channel.lobby.invitePlayer(msg.user.ircUsername);
        await channel.lobby.addRef(lobby_info.creator);
        await channel.sendMessage('!mp mods freemod ' + lobby_info.mods.join(' '));
        await switch_map(channel.lobby);
        await lobby_db.run(
            'insert into lobby (lobby_id, creator, filters) values (?, ?, ?, ?)',
            channel.lobby.id, msg.user.ircUsername, lobby_info.filters,
        );
      } catch (e) {
        console.error(`-> ${msg.user.ircUsername}: ${e}`);
        await msg.user.sendMessage(e.toString());
      }

      return;
    }
  });

  console.log('We\'re good to go.');
}

main();
