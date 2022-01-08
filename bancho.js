import EventEmitter from 'events';
import {Socket} from 'net';
import {open} from 'sqlite';
import sqlite3 from 'sqlite3';
import SQL from 'sql-template-strings';

import {scan_user_profile} from './profile_scanner.js';

import Config from './util/config.js';
import {capture_sentry_exception} from './util/helpers.js';


// IMPORTANT NOTE:
//
//   We do not keep track of IRC usernames, but only of user IDs
//   and display usernames (as shown on their osu! profile page).
//
//   The (big) downside is that we can't react to room messages based on
//   which user is sending the message, since the IRC username doesn't
//   always match the display username.
//
//   The upside is that ALL players can use our bot, and that we don't
//   need to query the osu!api to get the user ID or display username.
//   See: https://github.com/ppy/osu-api/issues/320
//


let ranks_db = null;


// Try to get a player object from a username, and return a placeholder player
// object if we didn't succeed.
async function try_get_player(display_username) {
  if (!ranks_db) {
    ranks_db = await open({
      filename: 'ranks.db',
      driver: sqlite3.cached.Database,
    });
  }

  let player = await ranks_db.get(SQL`
    SELECT * FROM user WHERE username = ${display_username}`,
  );
  if (player) {
    // Have not scanned the player's profile in the last 24 hours
    if (player.last_update_tms + (3600 * 24 * 1000) <= Date.now()) {
      await scan_user_profile(player);
    }
  } else {
    // Player will be fetched on the next !mp settings call, when we will have
    // their id; leave them uninitialized for now.
    player = {
      username: display_username,
      elo: 690, // new Rating(1500, 350).toFloat(), hardcoded
      approx_mu: 1500, approx_sig: 350,
      normal_mu: 1500, normal_sig: 350,
      aim_pp: 10.0, acc_pp: 1.0, speed_pp: 1.0, overall_pp: 1.0,
      avg_ar: 8.0, avg_sr: 2.0,
      last_update_tms: 0,
      games_played: 0, rank_text: 'Unranked',
    };
  }

  return player;
}


class BanchoClient extends EventEmitter {
  constructor() {
    super();

    // According to https://osu.ppy.sh/wiki/en/Bot_account, normal user
    // accounts can send a message every 500 milliseconds. We set a generous
    // margin so the user can still type while the bot is running without
    // risking their account getting silenced.
    // Bot accounts can send messages every 200 milliseconds, but again if you
    // modify this, it is recommended to leave a safety margin
    // (300 milliseconds should good enough anyway).
    this.MILLISECONDS_BETWEEN_SENDS = 1000;

    this._whois_requests = [];
    this._outgoing_messages = [];
    this._buffer = '';
    this._socket = null;
    this._writer = null;
    this._whoare = [];

    // Lobbies that we JOIN'd, not necessarily fully initialized
    this._lobbies = [];

    // Fully initialized lobbies where the bot is running actual logic
    this.joined_lobbies = [];
  }

  connect() {
    this._socket = new Socket();

    // Note sure if this is correct when IRC PING exists
    this._socket.setKeepAlive(true);
    this._socket.setTimeout(10000, () => {
      this._socket.emit('error', new Error('Timed out.'));
    });

    this._socket.on('error', (err) => {
      console.error('[IRC] Connection error:', err);
      capture_sentry_exception(err);
      this._socket.destroy();
    });

    this._socket.on('close', () => {
      console.info('[IRC] Connection closed. Cleaning up.');

      while (this._outgoing_messages.length > 0) {
        const obj = this._outgoing_messages.shift();
        obj.callback();
      }

      this._buffer = '';
      clearInterval(this._writer);
      this._writer = null;
      this.emit('disconnect');
    });

    console.info('[IRC] Connecting...');
    this._socket.connect({
      host: 'irc.ppy.sh',
      port: 6667,
    }, () => {
      console.info('[IRC] Connected.');

      this._send(`PASS ${Config.osu_irc_password}`);
      this._send(`USER ${Config.osu_username} 0 * :${Config.osu_username}`);
      this._send(`NICK ${Config.osu_username}`);

      this._writer = setInterval(() => {
        const obj = this._outgoing_messages.shift();
        if (obj) {
          this._send(obj.message);
          obj.callback();
        }
      }, this.MILLISECONDS_BETWEEN_SENDS);
    });

    return new Promise((resolve, reject) => {
      this._socket.on('data', (data) => {
        data = data.toString().replace(/\r/g, '');
        this._buffer += data;

        const lines = this._buffer.split('\n');
        for (let i = 0; i < lines.length - 1; i++) {
          const parts = lines[i].split(' ');
          if (parts[1] != 'QUIT') {
            console.debug('[IRC] < ' + lines[i]);
          }

          if (parts[0] == 'PING') {
            parts.shift();
            this._send('PONG ' + parts.join(' '));
            continue;
          }

          if (parts[1] == '001') {
            console.info('[IRC] Successfully logged in.');
            resolve();
            continue;
          }

          if (parts[1] == '311') {
            // parts[3]: target username
            // parts[4]: user profile url
            const user_id = parseInt(parts[4].substring(parts[4].lastIndexOf('/') + 1), 10);
            if (parts[3] in this._whois_requests) {
              this._whois_requests[parts[3]].resolve(user_id);
              delete this._whois_requests[parts[3]];
            }

            continue;
          }

          if (parts[1] == '401') {
            const target = parts[3];
            parts.splice(0, 4);
            if (target in this._whois_requests) {
              this._whois_requests[target].reject(parts.join(' ').substring(1));
              delete this._whois_requests[target];
            }

            continue;
          }

          // These channel-specific errors can be sent to a channel, even if
          // you haven't joined it or been forced to join it. :)
          const error_codes = ['461', '403', '405', '475', '474', '471', '473'];
          if (error_codes.includes(parts[1])) {
            const channel = parts[3];
            parts.splice(0, 4);
            this.emit(
                'lobbyJoined', {
                  channel: channel,
                  lobby: null,
                },
                new Error(parts.join(' ').substring(1)),
            );
            continue;
          }

          if (parts[1] == '464') {
            console.error('[IRC] Invalid username/password. See: https://osu.ppy.sh/p/irc');
            parts.shift(); parts.shift();
            reject(new Error(parts.join(' ').substring(1)));
            continue;
          }

          // Bancho can push JOIN commands anytime, and we need to handle those appropriately.
          if (parts[1] == 'JOIN') {
            const channel = parts[2].substring(1);
            const lobby = new BanchoLobby(channel);
            this._lobbies.push(lobby);
            continue;
          }

          if (parts[1] == 'PRIVMSG' && parts[2] == Config.osu_username) {
            const full_source = parts.shift();
            parts.splice(0, 2);
            let source = null;
            if (full_source.indexOf('!') != -1) {
              source = full_source.substring(1, full_source.indexOf('!'));
            }
            const message = parts.join(' ').substring(1);

            this.emit('pm', {
              from: source,
              message: message,
            });

            continue;
          }

          // Unhandled line: pass it to all JOIN'd lobbies
          for (const lobby of this._lobbies) {
            lobby.handle_line(lines[i]);
          }
        }

        this._buffer = lines.pop();
      });
    });
  }

  _send(raw_message) {
    if (this._socket && this._socket.readyState == 'open') {
      if (raw_message.indexOf('PASS ') == 0) {
        console.debug('[IRC] > PASS *********');
      } else {
        console.debug('[IRC] > ' + raw_message);
      }

      this._socket.write(raw_message + '\r\n');
    }
  }

  // The process for making lobbies goes like this:
  //
  // 1. You send !mp make <lobby title>
  // 2. Bancho makes you JOIN a new lobby
  // 3. Bancho sends you info about that lobby
  // 4. Bancho finally tells you the title and ID of the lobby
  //
  // Because of this, we automatically join lobbies that Bancho "pushes" onto
  // us, and wait for step 4 to resolve that auto-joined lobby.
  make(lobby_title) {
    return new Promise((resolve, reject) => {
      const room_created_listener = async (msg) => {
        const room_created_regex = /Created the tournament match https:\/\/osu\.ppy\.sh\/mp\/(\d+) (.+)/;
        if (msg.from == 'BanchoBot') {
          if (msg.message.indexOf('You cannot create any more tournament matches.') == 0) {
            this.off('pm', room_created_listener);
            reject(new Error('Cannot create any more matches.'));
            return;
          }

          const m = room_created_regex.exec(msg.message);
          if (m && m[2] == lobby_title) {
            this.off('pm', room_created_listener);

            for (const lobby of this._lobbies) {
              if (lobby.id == m[1]) {
                console.log(`Created lobby "${lobby_title}".`);
                return resolve(lobby);
              }
            }

            // Should not be reachable, as long as Bancho sends the commands
            // in the right order (which it should).
            return reject(new Error('Lobby was created but not joined. (ask the devs to check the logs)'));
          }
        }
      };

      this.on('pm', room_created_listener);
      this.privmsg('BanchoBot', `!mp make ${lobby_title}`);
    });
  }

  join(channel) {
    return new Promise((resolve, reject) => {
      for (const lobby of this._lobbies) {
        if (lobby.channel == channel) {
          return reject(new Error('Lobby already joined'));
        }
      }

      const join_listener = (evt, err) => {
        if (evt.channel == channel) {
          this.off('lobbyJoined', join_listener);

          if (err) {
            return reject(err);
          } else {
            return resolve(evt.lobby);
          }
        }
      };

      this.on('lobbyJoined', join_listener);
      this._send('JOIN ' + channel);
    });
  }

  privmsg(destination, content) {
    return new Promise((resolve, reject) => {
      if (!this._socket || this._socket.readyState != 'open') {
        return resolve();
      }

      this._outgoing_messages.push({
        message: `PRIVMSG ${destination} :${content}`,
        callback: resolve,
      });
    });
  }

  // (async) Get a user ID from an IRC username.
  //
  // Avoid using this whenever possible, since a IRC username can sometimes
  // resolve to multiple players, and idk what happens in that case.
  whois(irc_username) {
    return new Promise((resolve, reject) => {
      if (irc_username in this._whoare) {
        return resolve(this._whoare[irc_username]);
      }

      this._whois_requests[irc_username] = {resolve, reject};
      this._send('WHOIS ' + irc_username);
    });
  }
}


const bancho = new BanchoClient();
class BanchoLobby extends EventEmitter {
  constructor(channel) {
    super();

    this.id = parseInt(channel.substring(4), 10);
    this.channel = channel;
    this.invite_id = null;
    this.joined = false;
    this.players = [];
    this.scores = [];
    this.parsing_settings = false;
    this.nb_players = 0;

    this.playing = false;
    this.match_participants = [];
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
        const beatmap_regex = /Beatmap: https:\/\/osu\.ppy\.sh\/b\/(\d+) (.+)/;
        const mode_regex = /Team mode: (.+), Win condition: (.+)/;
        const mods_regex = /Active mods: (.+)/;
        const players_regex = /Players: (\d+)/;
        const slot_regex = /Slot (\d+) +(.+?) +https:\/\/osu\.ppy\.sh\/u\/(\d+) (.+)/;
        const score_regex = /(.+) finished playing \(Score: (\d+), (.+)\)\./;
        const ref_add_regex = /Added (.+) to the match referees/;
        const ref_del_regex = /Removed (.+) from the match referees/;
        const beatmap_change_regex = /Changed beatmap to https:\/\/osu\.ppy\.sh\/b\/(\d+) (.+)/;

        if (message == 'The match has started!') {
          this.scores = [];
          this.match_participants = [];
          this.playing = true;
          this.emit('matchStarted');
          this.send(`!mp settings ${Math.random().toString(36).substring(2, 6)}`);
        } else if (message == 'The match has finished!') {
          this.playing = false;
          this.emit('matchFinished');
        } else if (message == 'Aborted the match') {
          this.playing = false;
          this.emit('matchAborted');
        } else if (message == 'All players are ready') {
          this.emit('allPlayersReady');
        } else if (message == 'Changed the match password') {
          this.send('!mp password');
        } else if (m = room_name_regex.exec(message)) {
          this.parsing_settings = true;
          this.name = m[1];
          this.id = parseInt(m[2], 10);
        } else if (m = beatmap_regex.exec(message)) {
          this.beatmap_id = parseInt(m[1], 10);
          this.beatmap_name = m[2];
        } else if (m = beatmap_change_regex.exec(message)) {
          this.beatmap_id = parseInt(m[1], 10);
          this.beatmap_name = m[2];
        } else if (m = mode_regex.exec(message)) {
          this.team_mode = m[1];
          this.win_condition = m[2];
        } else if (m = mods_regex.exec(message)) {
          this.active_mods = m[1];
        } else if (m = players_regex.exec(message)) {
          this.players_to_parse = parseInt(m[1], 10);
          this.nb_players = this.players_to_parse;
        } else if (m = ref_add_regex.exec(message)) {
          this.emit('refereeAdded', m[1]);
        } else if (m = ref_del_regex.exec(message)) {
          this.emit('refereeRemoved', m[1]);
        } else if (m = slot_regex.exec(message)) {
          const display_username = m[4].substring(0, 15).trimEnd();
          // NOTE: we could parse host/mods but it's a pain and unused right now

          let player = this.players[display_username];
          if (typeof player === 'undefined') {
            player = await try_get_player(display_username);
            this.players[display_username] = player;
          }

          if (!player.id) {
            player.id = parseInt(m[3], 10);
            player.user_id = player.id;
            await scan_user_profile(player);
          }

          // Ready/Not Ready/No Map
          player.state = m[2];
          if (this.playing && player.state != 'No Map') {
            this.match_participants[display_username] = player;
          }

          this.players_to_parse--;
          if (this.players_to_parse == 0) {
            this.emit('settings');
          }
        } else if (m = score_regex.exec(message)) {
          // We only handle the score if we have properly fetched the user.
          if (this.match_participants.hasOwnProperty(m[1])) {
            this.scores[m[1]] = parseInt(m[2], 10);
            this.emit('score', {
              username: m[1],
              score: m[2],
              state: m[3], // PASSED/FAILED
            });
          }
        } else if (m = joined_regex.exec(message)) {
          const display_username = m[1];
          const player = await try_get_player(display_username);
          this.players[display_username] = player;
          this.nb_players++;
          this.emit('playerJoined', player);
        } else if (m = left_regex.exec(message)) {
          const display_username = m[1];

          let player = this.players[display_username];
          if (typeof player !== 'undefined') {
            // Dodgers get 0 score
            if (display_username in this.match_participants) {
              this.scores[display_username] = 0;
              this.emit('score', {
                username: display_username,
                score: 0,
                state: 'FAILED',
              });
            }

            delete this.players[display_username];
          } else {
            player = {
              username: display_username,
            };
          }

          this.nb_players--;
          this.emit('playerLeft', player);
        }

        return;
      }

      this.emit('message', {
        from: source,
        message: message,
      });

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
}


export default bancho;
