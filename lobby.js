import EventEmitter from 'events';
import {open} from 'sqlite';
import sqlite3 from 'sqlite3';
import SQL from 'sql-template-strings';

import bancho from './bancho.js';
import Config from './util/config.js';
import {scan_user_profile} from './profile_scanner.js';


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
  let player = await ranks_db.get(SQL`
    SELECT * FROM user WHERE username = ${display_username}`,
  );
  if (player) {
    // Have not scanned the player's profile in the last 24 hours
    if (player.last_update_tms + (3600 * 24 * 1000) <= Date.now()) {
      console.info('[API] Scanning top 100 scores of ' + display_username);
      await scan_user_profile(player);
    }
  } else {
    // Player will be fetched on the next !mp settings call, when we will have
    // their id; leave them uninitialized for now.
    player = {
      username: display_username,
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

    this.playing = false;
    this.match_participants = [];
  }

  join() {
    // TODO: reject when channel doesn't exist
    // [IRC] < :cho.ppy.sh 403 kiwec #mp_95394277 :No such channel #mp_95394277

    return new Promise(async (resolve, reject) => {
      if (!ranks_db) {
        ranks_db = await open({
          filename: 'ranks.db',
          driver: sqlite3.cached.Database,
        });
      }

      const irc_listener = async (line) => {
        const parts = line.split(' ');

        if (line == `:${Config.osu_username}!cho@ppy.sh PART :${this.channel}`) {
          this.joined = false;
          this.emit('close');
          return;
        }

        if (parts[1] == '332' && parts[3] == this.channel) {
          this.joined = true;
          this.invite_id = parseInt(parts[6].substring(1), 10);
          return resolve();
        }

        const error_codes = ['461', '403', '405', '475', '474', '471', '473'];
        if (error_codes.includes(parts[1]) && parts[3] == this.channel) {
          bancho.off('irc', irc_listener);
          parts.splice(0, 4);
          return reject(new Error(parts.join(' ').substring(1)));
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
            } else if (m = room_name_regex.exec(message)) {
              this.parsing_settings = true;
              this.room_name = m[1];
              this.room_id = parseInt(m[2], 10);
            } else if (m = beatmap_regex.exec(message)) {
              this.beatmap_id = parseInt(m[1], 10);
              this.beatmap_name = m[2];
            } else if (m = mode_regex.exec(message)) {
              this.team_mode = m[1];
              this.win_condition = m[2];
            } else if (m = mods_regex.exec(message)) {
              this.active_mods = m[1];
            } else if (m = players_regex.exec(message)) {
              this.players_to_parse = parseInt(m[1], 10);
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
              if (player.state != 'No Map') {
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
              this.emit('playerJoined', player);
            } else if (m = left_regex.exec(message)) {
              const display_username = m[1];

              let player = this.players[display_username];
              if (typeof player !== 'undefined') {
                // Dodgers get 0 score
                if (this.playing && player.user_id && player.state != 'No Map') {
                  this.match_participants[display_username] = player;
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
      };

      bancho.on('irc', irc_listener);
      bancho.on('disconnect', () => bancho.off('irc', irc_listener));
      bancho._send('JOIN ' + this.channel);
    });
  }

  leave() {
    return new Promise((resolve, reject) => {
      if (!this.joined) {
        return resolve();
      }

      bancho._sent_messages.push({
        message: `PART :${this.channel}`,
        callback: resolve,
      });
      bancho._send('PART ' + this.channel);
    });
  }

  async send(message) {
    if (!this.joined) {
      await this.join();
    }

    return await bancho.privmsg(this.channel, message);
  }
}

export default BanchoLobby;
