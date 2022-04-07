import fetch from 'node-fetch';

import bancho from './bancho.js';
import {remove_discord_lobby_listing} from './discord_updates.js';
import {get_map_info} from './profile_scanner.js';


// Yeah prototype pollution bad who cares
Array.prototype.random = function() {
  return this[Math.floor((Math.random() * this.length))];
};


async function select_next_map() {
  const MAP_TYPES = {
    1: 'graveyarded',
    2: 'wip',
    3: 'pending',
    4: 'ranked',
    5: 'approved',
    6: 'qualified',
    7: 'loved',
  };

  if (!this.data.collection) return;

  clearTimeout(this.countdown);
  this.countdown = -1;
  this.voteskips = [];

  if (this.recently_played.length >= Math.min(25, this.data.collection.beatmapsets.length - 1)) {
    this.recently_played.shift();
  }

  let new_map = null;
  do {
    const mapset = this.data.collection.beatmapsets.random();
    const map_id = mapset.beatmaps.random().id;
    new_map = await get_map_info(map_id);
  } while (this.recently_played.includes(new_map.id));

  const flavor = `${MAP_TYPES[new_map.ranked]} ${new_map.stars.toFixed(2)}*, ${Math.round(new_map.overall_pp)}pp`;
  const map_name = `[https://osu.ppy.sh/beatmaps/${new_map.id} ${new_map.name}]`;
  const beatconnect_link = `[https://beatconnect.io/b/${new_map.set_id} [1]]`;
  const chimu_link = `[https://chimu.moe/d/${new_map.set_id} [2]]`;
  const nerina_link = `[https://nerina.pw/d/${new_map.set_id} [3]]`;
  const sayobot_link = `[https://osu.sayobot.cn/osu.php?s=${new_map.set_id} [4]]`;

  this.map = new_map;
  this.recently_played.push(new_map.id);
  await this.send(`!mp map ${new_map.id} * | ${map_name} (${flavor}) Alternate downloads: ${beatconnect_link} ${chimu_link} ${nerina_link} ${sayobot_link}`);
}


async function load_collection(lobby, collection_id) {
  const res = await fetch(`https://osucollector.com/api/collections/${collection_id}`);
  if (res.status == 404) {
    throw new Error('Collection not found.');
  }
  if (!res.ok) {
    throw new Error(await res.text());
  }

  lobby.data.collection = await res.json();
  lobby.data.collection_id = collection_id;
  await lobby.select_next_map();
}


async function init_lobby(lobby) {
  lobby.recently_played = [];
  lobby.countdown = -1;
  lobby.data.mode = 'collection';
  lobby.select_next_map = select_next_map;

  // After the host finishes playing, their client resets the map to the one they played.
  // Because we change the map *before* they rejoin the lobby, we need to re-select our map.
  lobby.on('playerChangedBeatmap', async () => {
    if (lobby.recently_played.includes(lobby.beatmap_id)) {
      await lobby.send(`!mp map ${lobby.recently_played[lobby.recently_played.length - 1]} *`);
    }
  });

  lobby.on('allPlayersReady', async () => {
    if (!lobby.playing) {
      // We set lobby.playing = true here to stop people from being able to
      // spam the Ready button, which would result in !mp start spam.
      lobby.playing = true;
      await lobby.send(`!mp start .${Math.random().toString(36).substring(2, 6)}`);
    }
  });

  lobby.on('matchStarted', () => {
    clearTimeout(lobby.countdown);
    lobby.countdown = -1;
  });

  lobby.on('matchFinished', async () => {
    await lobby.select_next_map();
  });

  lobby.on('close', async () => {
    // Lobby closed (intentionally or not), clean up
    bancho.joined_lobbies.splice(bancho.joined_lobbies.indexOf(lobby), 1);
    await remove_discord_lobby_listing(lobby.id);
  });

  if (!lobby.data.collection) {
    try {
      await load_collection(lobby, lobby.data.collection_id);
    } catch (err) {
      await lobby.send(`Failed to load collection: ${err.message}`);
      throw err;
    }
  }

  // Fetch lobby name
  await lobby.send(`!mp settings ${Math.random().toString(36).substring(2, 6)}`);
  bancho.joined_lobbies.push(lobby);
}


export {init_lobby, load_collection};
