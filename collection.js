import fetch from 'node-fetch';

import bancho from './bancho.js';
import {remove_discord_lobby_listing} from './discord_updates.js';


async function select_next_map() {
  if (!this.data.playlist) return;

  this.voteskips = [];

  if (this.recently_played.length >= Math.min(25, this.data.playlist.length - 1)) {
    this.recently_played.shift();
  }

  let map = null;
  do {
    map = this.data.playlist[Math.floor(Math.random() * this.data.playlist.length)];
  } while (this.recently_played.includes(map.id));

  const map_name = `[https://osu.ppy.sh/beatmapsets/${map.set_id}#osu/${map.id} ${map.title}]`;
  const beatconnect_link = `[https://beatconnect.io/b/${map.set_id} [1]]`;
  const chimu_link = `[https://chimu.moe/d/${map.set_id} [2]]`;
  const nerina_link = `[https://nerina.pw/d/${map.set_id} [3]]`;
  const sayobot_link = `[https://osu.sayobot.cn/osu.php?s=${map.set_id} [4]]`;

  this.map = map;
  this.recently_played.push(map.id);
  await this.send(`!mp map ${map.id} * | ${map_name} (${map.stars}*) Alternate downloads: ${beatconnect_link} ${chimu_link} ${nerina_link} ${sayobot_link}`);
}


async function load_collection(lobby, collection_id) {
  const playlist = [];

  let res = await fetch(`https://osucollector.com/api/collections/${collection_id}/beatmapsv2?perPage=1000`);
  if (res.status == 404) {
    throw new Error('Collection not found.');
  }
  if (!res.ok) {
    throw new Error(await res.text());
  }

  let json = await res.json();
  if (json.hasMore) {
    await lobby.send('Fetching collection maps, please wait...');
  }

  const process_batch = (json) => {
    for (const beatmap of json.beatmaps) {
      playlist.push({
        id: beatmap.id,
        set_id: beatmap.beatmapset.id,
        title: beatmap.beatmapset.title,
        stars: beatmap.difficulty_rating,
        mode: beatmap.mode,
      });
    }
  };

  while (true) {
    process_batch(json);

    if (json.hasMore) {
      res = await fetch(`https://osucollector.com/api/collections/${collection_id}/beatmapsv2?perPage=1000&cursor=${json.nextPageCursor}`);
      if (!res.ok) {
        throw new Error(await res.text());
      }
      json = await res.json();
    } else {
      break;
    }
  }

  lobby.data.collection_id = collection_id;
  lobby.data.playlist = playlist;
  await lobby.select_next_map();
}


async function init_lobby(lobby) {
  lobby.recently_played = [];
  lobby.data.mode = 'collection';
  lobby.select_next_map = select_next_map;

  // After the host finishes playing, their client resets the map to the one they played.
  // Because we change the map *before* they rejoin the lobby, we need to re-select our map.
  lobby.on('playerChangedBeatmap', async () => {
    if (lobby.recently_played.includes(lobby.beatmap_id)) {
      await lobby.send(`!mp map ${lobby.recently_played[lobby.recently_played.length - 1]} *`);
    }
  });

  lobby.on('matchFinished', async () => {
    await lobby.select_next_map();
  });

  lobby.on('close', async () => {
    // Lobby closed (intentionally or not), clean up
    bancho.joined_lobbies.splice(bancho.joined_lobbies.indexOf(lobby), 1);
    await remove_discord_lobby_listing(lobby.id);
  });

  if (!lobby.data.playlist) {
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
