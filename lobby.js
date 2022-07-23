import EventEmitter from 'events';

import bancho from './bancho.js';
import commands from './commands.js';
import databases from './database.js';

import Config from './util/config.js';
import {capture_sentry_exception} from './util/helpers.js';

const fetch_lobby_stmt = databases.ranks.prepare(
    `SELECT * FROM lobby WHERE id = ?`,
);
const create_lobby_stmt = databases.ranks.prepare(
    `INSERT INTO lobby (id, data) VALUES (?, '{}')`,
);
const update_lobby_stmt = databases.ranks.prepare(
    `UPDATE lobby SET data = ? WHERE id = ?`,
);


// Try to get a player object from a username, and return a placeholder player
// object if we didn't succeed.
async function try_get_player(display_username) {
  const stmt = databases.ranks.prepare('SELECT * FROM user WHERE username = ?');
  let player = stmt.get(display_username);
  if (!player) {
    // Player will be fetched on the next !mp settings call, when we will have
    // their id; leave them uninitialized for now.
    player = {
      username: display_username,
      elo: 450, // hardcoded 1500 - (3 * 350)
      approx_mu: 1500, approx_sig: 350,
      aim_pp: 10.0, acc_pp: 1.0, speed_pp: 1.0, overall_pp: 1.0,
      avg_ar: 8.0, avg_sr: 2.0,
      last_contest_tms: 0,
      last_update_tms: 0,
      games_played: 0, rank_text: 'Unranked',
    };
  }

  return player;
}


class BanchoLobby extends EventEmitter {
  constructor(channel) {
    super();

    this.id = parseInt(channel.substring(4), 10);
    this.channel = channel;
    this.invite_id = null;
    this.joined = false;
    this.players = [];
    this.scores = [];
    this.voteaborts = [];
    this.voteskips = [];
    this.nb_players = 0;
    this.playing = false;

    let db_lobby = fetch_lobby_stmt.get(this.id);
    if (!db_lobby) {
      create_lobby_stmt.run(this.id);
      db_lobby = {
        id: this.id,
        data: '{"mode":"new"}',
      };
    }

    // Save every lobby.data update to the database
    const lobby_id = this.id;
    this.data = new Proxy(JSON.parse(db_lobby.data), {
      set(obj, prop, value) {
        obj[prop] = value;
        update_lobby_stmt.run(JSON.stringify(obj), lobby_id);
        return true;
      },
    });
  }

  async handle_line(line) {
    const parts = line.split(' ');

    if (line == `:${Config.osu_username}!cho@ppy.sh PART :${this.channel}`) {
      this.joined = false;
      this.emit('close');
      bancho._lobbies.splice(bancho._lobbies.indexOf(this), 1);
      return;
    }

    if (parts[1] == '332' && parts[3] == this.channel) {
      this.joined = true;
      this.invite_id = parseInt(parts[6].substring(1), 10);
      bancho.emit('lobbyJoined', {
        channel: this.channel,
        lobby: this,
      });
      return;
    }

    if (parts[1] == 'PRIVMSG' && parts[2] == this.channel) {
      const full_source = parts.shift();
      parts.splice(0, 2);
      let source = null;
      if (full_source.indexOf('!') != -1) {
        source = full_source.substring(1, full_source.indexOf('!'));
      }
      const message = parts.join(' ').substring(1);

      if (source == 'BanchoBot') {
        let m;
        const joined_regex = /(.+) joined in slot \d+\./;
        const left_regex = /(.+) left the game\./;
        const room_name_regex = /Room name: (.+), History: https:\/\/osu\.ppy\.sh\/mp\/(\d+)/;
        const room_name_updated_regex = /Room name updated to "(.+)"/;
        const beatmap_regex = /Beatmap: https:\/\/osu\.ppy\.sh\/b\/(\d+) (.+)/;
        const mode_regex = /Team mode: (.+), Win condition: (.+)/;
        const mods_regex = /Active mods: (.+)/;
        const players_regex = /Players: (\d+)/;
        const slot_regex = /Slot (\d+) +(.+?) +https:\/\/osu\.ppy\.sh\/u\/(\d+) (.+)/;
        const score_regex = /(.+) finished playing \(Score: (\d+), (.+)\)\./;
        const ref_add_regex = /Added (.+) to the match referees/;
        const ref_del_regex = /Removed (.+) from the match referees/;
        const beatmap_change_regex = /Changed beatmap to https:\/\/osu\.ppy\.sh\/b\/(\d+) (.+)/;
        const player_changed_beatmap_regex = /Beatmap changed to: (.+) \(https:\/\/osu.ppy.sh\/b\/(\d+)\)/;
        const new_host_regex = /(.+) became the host./;

        if (message == 'Cleared match host') {
          this.host = null;
          this.emit('host');
        } else if (message == 'The match has started!') {
          this.voteaborts = [];
          this.voteskips = [];
          this.scores = [];
          this.playing = true;
          this.emit('matchStarted');
        } else if (message == 'The match has finished!') {
          this.playing = false;
          this.emit('matchFinished');
        } else if (message == 'Aborted the match') {
          this.playing = false;
          this.emit('matchAborted');
        } else if (message == 'All players are ready') {
          this.emit('allPlayersReady');
        } else if (message == 'Changed the match password') {
          this.passworded = true;
          this.emit('password');
        } else if (message == 'Removed the match password') {
          this.passworded = false;
          this.emit('password');
        } else if (m = room_name_regex.exec(message)) {
          this.name = m[1];
          this.id = parseInt(m[2], 10);
        } else if (m = room_name_updated_regex.exec(message)) {
          this.name = m[1];
        } else if (m = beatmap_regex.exec(message)) {
          this.map_data = null;
          this.beatmap_id = parseInt(m[1], 10);
          this.beatmap_name = m[2];
        } else if (m = beatmap_change_regex.exec(message)) {
          this.map_data = null;
          this.beatmap_id = parseInt(m[1], 10);
          this.beatmap_name = m[2];
          this.emit('refereeChangedBeatmap');
        } else if (m = player_changed_beatmap_regex.exec(message)) {
          this.map_data = null;
          this.beatmap_id = parseInt(m[2], 10);
          this.beatmap_name = m[1];
          this.emit('playerChangedBeatmap');
        } else if (m = mode_regex.exec(message)) {
          this.team_mode = m[1];
          this.win_condition = m[2];
        } else if (m = mods_regex.exec(message)) {
          this.active_mods = m[1];
        } else if (m = players_regex.exec(message)) {
          this.players = [];
          this.players_to_parse = parseInt(m[1], 10);
          this.nb_players = this.players_to_parse;
        } else if (m = ref_add_regex.exec(message)) {
          this.emit('refereeAdded', m[1]);
        } else if (m = ref_del_regex.exec(message)) {
          if (m[1] == Config.osu_username) {
            await this.send('Looks like we\'re done here.');
            await this.leave();
          }
          this.emit('refereeRemoved', m[1]);
        } else if (m = slot_regex.exec(message)) {
          const display_username = m[4].substring(0, 15).trimEnd();
          const player = await try_get_player(display_username);
          player.id = parseInt(m[3], 10);
          player.user_id = player.id;
          player.state = m[2];
          player.is_host = m[4].substring(16).indexOf('Host') != -1;
          if (player.is_host) {
            this.host = player;
          }

          // TODO: parse mods

          this.players = this.players.filter((player) => player.username != display_username);
          this.players.push(player);

          this.players_to_parse--;
          if (this.players_to_parse == 0) {
            this.emit('settings');
          }
        } else if (m = new_host_regex.exec(message)) {
          for (const player of this.players) {
            player.is_host = player.username == m[1];
            this.host = player;
          }
          this.emit('host');
        } else if (m = score_regex.exec(message)) {
          const score = {
            username: m[1],
            score: parseInt(m[2], 10),
            state: m[3], // PASSED/FAILED
          };

          this.scores.push(score);
          this.emit('score', score);
        } else if (m = joined_regex.exec(message)) {
          const display_username = m[1];
          const player = await try_get_player(display_username);
          this.players.push(player);
          this.nb_players++;
          this.emit('playerJoined', player);
        } else if (m = left_regex.exec(message)) {
          const display_username = m[1];

          let leaving_player = null;
          for (const player of this.players) {
            if (player.username == display_username) {
              leaving_player = player;
              break;
            }
          }

          if (leaving_player == null) {
            leaving_player = {
              username: display_username,
            };
          } else {
            this.nb_players--;
            this.players = this.players.filter((player) => player.username != display_username);
          }

          this.emit('playerLeft', leaving_player);
        }

        return;
      }

      this.emit('message', {
        from: source,
        message: message,
      });

      for (const cmd of commands) {
        const match = cmd.regex.exec(message);
        if (match) {
          if (!cmd.modes.includes(this.data.mode)) break;

          if (cmd.creator_only) {
            const user_is_host = this.host && this.host.username == source;
            if (!user_is_host && (this.data.creator_osu_id != await bancho.whois(source))) {
              await this.send(`${source}: You need to be the lobby creator to use this command.`);
              break;
            }
          }

          await cmd.handler({from: source, message: message}, match, this);
          break;
        }
      }

      return;
    }
  }

  async leave() {
    if (!this.joined) {
      return;
    }

    bancho._send('PART ' + this.channel);
  }

  async send(message) {
    if (!this.joined) {
      return;
    }

    return await bancho.privmsg(this.channel, message);
  }

  // Override EventEmitter to redirect errors to Sentry
  on(event_name, callback) {
    return super.on(event_name, (...args) => {
      try {
        Promise.resolve(callback(...args));
      } catch (err) {
        Sentry.setContext('lobby', {
          id: this.id,
          median_pp: this.median_overall,
          nb_players: this.nb_players,
          data: this.data,
          task: event_name,
        });
        capture_sentry_exception(err);
      }
    });
  }
}

export {BanchoLobby};
