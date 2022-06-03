import bancho from './bancho.js';
import databases from './database.js';
import {get_rank} from './elo_mmr.js';
import {get_map_data} from './profile_scanner.js';
import {load_collection, init_lobby as init_collection_lobby} from './collection.js';
import {init_lobby as init_ranked_lobby} from './ranked.js';
import Config from './util/config.js';


async function reply(user, lobby, message) {
  if (lobby) {
    await lobby.send(`${user}: ${message}`);
  } else {
    await bancho.privmsg(user, message);
  }
}

async function join_command(msg, match) {
  try {
    const lobby = await bancho.join('#mp_' + match[1]);
    lobby.data.creator = msg.from;
    lobby.data.creator_osu_id = await bancho.whois(msg.from);
    await lobby.send(`Hi! Type '!ranked' to start a ranked lobby, or '!collection <id>' to load a collection from osu!collector.`);
  } catch (err) {
    await bancho.privmsg(
        msg.from,
        `Failed to join the lobby. Make sure you have sent '!mp addref ${Config.osu_username}' in #multiplayer and that the lobby ID is correct.`,
    );
  }
}


async function collection_command(msg, match, lobby) {
  lobby.data.collection_id = match[1];
  if (lobby.data.mode == 'new') {
    await init_collection_lobby(lobby);
  } else {
    try {
      await load_collection(lobby, match[1]);
    } catch (err) {
      await lobby.send(`Failed to load collection: ${err.message}`);
      throw err;
    }
  }
}

async function ranked_command(msg, match, lobby) {
  lobby.created_just_now = true;
  lobby.data.fixed_star_range = false;
  lobby.data.min_stars = 0.0;
  lobby.data.max_stars = 11.0;
  await init_ranked_lobby(lobby);
}


async function rank_command(msg, match, lobby) {
  const requested_username = match[1].trim() || msg.from;

  let user;
  let user_id;
  const user_from_id_stmt = databases.ranks.prepare(`
    SELECT games_played, elo, user_id FROM user
    WHERE user_id = ?`,
  );
  if (requested_username === msg.from) {
    user_id = await bancho.whois(requested_username);
    user = user_from_id_stmt.get(user_id);
  } else {
    const user_from_username_stmt = databases.ranks.prepare(`
      SELECT games_played, elo, user_id FROM user
      WHERE username = ?`,
    );
    user = user_from_username_stmt.get(requested_username);
    if (!user) {
      try {
        user_id = await bancho.whois(requested_username);
        user = user_from_id_stmt.get(user_id);
      } catch (err) {
        await reply(msg.from, lobby, `Player ${requested_username} not found. Are they online?`);
        return;
      }
    }
  }

  let rank_info = {};
  if (!user || user.games_played < 5) {
    rank_info.text = 'Unranked';
  } else {
    rank_info = get_rank(user.elo);
  }

  if (rank_info.text == 'Unranked') {
    if (requested_username === msg.from) {
      const games_played = user ? user.games_played : 0;
      await reply(msg.from, lobby, `You are unranked. Play ${5 - games_played} more game${games_played < 4 ? 's' : ''} to get a rank!`);
    } else {
      await reply(msg.from, lobby, `${requested_username} is unranked.`);
    }
  } else {
    await reply(msg.from, lobby, `[${Config.website_base_url}/u/${user.user_id}/ ${requested_username}] | Rank: ${rank_info.text} (#${rank_info.rank_nb}) | Elo: ${Math.round(rank_info.elo)} | Games played: ${user.games_played}`);
  }
}

async function start_command(msg, match, lobby) {
  if (lobby.countdown != -1 || lobby.playing) return;

  if (lobby.nb_players < 2) {
    await lobby.send(`!mp start .${Math.random().toString(36).substring(2, 6)}`);
    return;
  }

  lobby.countdown = setTimeout(async () => {
    if (lobby.playing) {
      lobby.countdown = -1;
      return;
    }

    lobby.countdown = setTimeout(async () => {
      lobby.countdown = -1;
      if (!lobby.playing) {
        await lobby.send(`!mp start .${Math.random().toString(36).substring(2, 6)}`);
      }
    }, 10000);
    await lobby.send('Starting the match in 10 seconds... Ready up to start sooner.');
  }, 20000);
  await lobby.send('Starting the match in 30 seconds... Ready up to start sooner.');
}

async function wait_command(msg, match, lobby) {
  if (lobby.countdown == -1) return;

  clearTimeout(lobby.countdown);
  lobby.countdown = -1;
  await lobby.send('Match auto-start is cancelled. Type !start to restart it.');
}

async function about_command(msg, match, lobby) {
  if (lobby) {
    if (lobby.data.mode == 'collection') {
      await lobby.send(`This lobby will auto-select maps of a specific collection from osu!collector. All commands and answers to your questions are [${Config.discord_invite_link} in the Discord.]`);
    } else if (lobby.data.mode == 'ranked') {
      await lobby.send(`In this lobby, you get a rank based on how well you play compared to other players. All commands and answers to your questions are [${Config.discord_invite_link} in the Discord.]`);
    } else {
      await lobby.send(`Bruh just send !collection <id> or !ranked`);
    }
  } else {
    await bancho.privmsg(msg.from, `This bot can join lobbies and do many things. Commands and answers to your questions are available [${Config.discord_invite_link} in the Discord.]`);
  }
}

async function discord_command(msg, match, lobby) {
  await reply(msg.from, lobby, `[${Config.discord_invite_link} Come hang out in voice chat!] (or just text, no pressure)`);
}

async function stars_command(msg, match, lobby) {
  const args = msg.message.split(' ');

  // No arguments: remove star rating restrictions
  if (args.length == 1) {
    lobby.data.min_stars = 0.0;
    lobby.data.max_stars = 11.0;
    lobby.data.fixed_star_range = false;
    await lobby.select_next_map();
    return;
  }

  if (args.length < 3) {
    await lobby.send(msg.from + ': You need to specify minimum and maximum star values.');
    return;
  }

  const min_stars = parseFloat(args[1]);
  const max_stars = parseFloat(args[2]);
  if (isNaN(min_stars) || isNaN(max_stars) || min_stars >= max_stars || min_stars < 0 || max_stars > 99) {
    await lobby.send(msg.from + ': Please use valid star values.');
    return;
  }

  lobby.data.min_stars = min_stars;
  lobby.data.max_stars = max_stars;
  lobby.data.fixed_star_range = true;
  await lobby.select_next_map();
}

async function abort_command(msg, match, lobby) {
  if (!lobby.playing) {
    await lobby.send(`${msg.from}: The match has not started, cannot abort.`);
    return;
  }

  if (!lobby.voteaborts.includes(msg.from)) {
    lobby.voteaborts.push(msg.from);
    const nb_voted_to_abort = lobby.voteaborts.length;
    const nb_required_to_abort = Math.ceil(lobby.nb_players / 2);
    if (lobby.voteaborts.length >= nb_required_to_abort) {
      await lobby.send(`!mp abort ${Math.random().toString(36).substring(2, 6)}`);
      lobby.voteaborts = [];
      await lobby.select_next_map();
    } else {
      await lobby.send(`${msg.from} voted to abort the match. ${nb_voted_to_abort}/${nb_required_to_abort} votes needed.`);
    }
  }
}

async function ban_command(msg, match, lobby) {
  const bad_player = match[1].trim();
  if (bad_player == '') {
    await lobby.send(msg.from + ': You need to specify which player to ban.');
    return;
  }

  if (!lobby.votekicks[bad_player]) {
    lobby.votekicks[bad_player] = [];
  }
  if (!lobby.votekicks[bad_player].includes(msg.from)) {
    lobby.votekicks[bad_player].push(msg.from);

    const nb_voted_to_kick = lobby.votekicks[bad_player].length;
    let nb_required_to_kick = Math.ceil(lobby.nb_players / 2);
    if (nb_required_to_kick == 1) nb_required_to_kick = 2; // don't allow a player to hog the lobby

    if (nb_voted_to_kick >= nb_required_to_kick) {
      await lobby.send('!mp ban ' + bad_player);
    } else {
      await lobby.send(`${msg.from} voted to ban ${bad_player}. ${nb_voted_to_kick}/${nb_required_to_kick} votes needed.`);
    }
  }
}

async function skip_command(msg, match, lobby) {
  if (lobby.voteskips.includes(msg.from)) return;

  if (lobby.host && lobby.host.username == msg.from) {
    await lobby.select_next_map();
    return;
  }

  // When bot just joined the lobby, beatmap_id is null.
  if (lobby.beatmap_id && !lobby.map_data) {
    try {
      lobby.map_data = await get_map_data(lobby.beatmap_id);
      if (lobby.map_data.beatmapset.availability.download_disabled) {
        clearTimeout(lobby.countdown);
        lobby.countdown = -1;

        await lobby.send(`Skipped map because download is unavailable [${lobby.map_data.beatmapset.availability.more_information} (more info)].`);
        stmts.dmca_map.run(lobby.beatmap_id);
        await lobby.select_next_map();
        return;
      }
    } catch (err) {
      console.error(`Failed to fetch map data for beatmap #${lobby.beatmap_id}: ${err}`);
    }
  }

  lobby.voteskips.push(msg.from);
  if (lobby.voteskips.length > lobby.nb_players / 2) {
    clearTimeout(lobby.countdown);
    lobby.countdown = -1;
    await lobby.select_next_map();
  } else {
    await lobby.send(`${lobby.voteskips.length}/${Math.floor(lobby.nb_players / 2 + 1)} players voted to switch to another map.`);
  }
}

async function toggle_scorev2_command(msg, match, lobby) {
  if (lobby.data.is_scorev2) {
    await lobby.send(`!mp set 0 0 16`);
    lobby.data.is_scorev2 = false;
  } else {
    await lobby.send(`!mp set 0 3 16`);
    lobby.data.is_scorev2 = true;
  }
}

const commands = [
  {
    regex: /!join (\d+)/gi,
    handler: join_command,
    creator_only: false,
    modes: ['pm'],
  },
  {
    regex: /!collection (\d+)/gi,
    handler: collection_command,
    creator_only: true,
    modes: ['new', 'collection'],
  },
  {
    regex: /!ranked/gi,
    handler: ranked_command,
    creator_only: true,
    modes: ['new'],
  },
  {
    regex: /^!about$/gi,
    handler: about_command,
    creator_only: false,
    modes: ['pm', 'new', 'collection', 'ranked'],
  },
  {
    regex: /^!help$/gi,
    handler: about_command,
    creator_only: false,
    modes: ['pm', 'new', 'collection', 'ranked'],
  },
  {
    regex: /^!discord$/gi,
    handler: discord_command,
    creator_only: false,
    modes: ['pm', 'new', 'collection', 'ranked'],
  },
  {
    regex: /^!rank(.*)/gi,
    handler: rank_command,
    creator_only: false,
    modes: ['pm', 'new', 'collection', 'ranked'],
  },
  {
    regex: /^!abort$/gi,
    handler: abort_command,
    creator_only: false,
    modes: ['collection', 'ranked'],
  },
  {
    regex: /^!start$/gi,
    handler: start_command,
    creator_only: false,
    modes: ['collection', 'ranked'],
  },
  {
    regex: /^!wait$/gi,
    handler: wait_command,
    creator_only: false,
    modes: ['collection', 'ranked'],
  },
  {
    regex: /^!stop$/gi,
    handler: wait_command,
    creator_only: false,
    modes: ['collection', 'ranked'],
  },
  {
    regex: /^!ban(.*)/gi,
    handler: ban_command,
    creator_only: false,
    modes: ['ranked'],
  },
  {
    regex: /^!skip$/gi,
    handler: skip_command,
    creator_only: false,
    modes: ['collection', 'ranked'],
  },
  {
    regex: /^!stars/gi,
    handler: stars_command,
    creator_only: true,
    modes: ['ranked'],
  },
  {
    regex: /^!setstar/gi,
    handler: stars_command,
    creator_only: true,
    modes: ['ranked'],
  },
  {
    regex: /^!sv\d/gi,
    handler: toggle_scorev2_command,
    creator_only: true,
    modes: ['ranked'],
  },
  {
    regex: /^!scorev\d/gi,
    handler: toggle_scorev2_command,
    creator_only: true,
    modes: ['ranked'],
  },
];

export default commands;
