import EventEmitter from 'events';
import {Socket} from 'net';

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


class BanchoClient extends EventEmitter {
  constructor() {
    super();

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
      }, Config.MILLISECONDS_BETWEEN_SENDS);
    });

    return new Promise(async (resolve, reject) => {
      const {BanchoLobby} = await import('./lobby.js');

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
              this._whoare[parts[3]] = user_id;
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
    // Make sure users can't send commands by injecting '\r\n'
    raw_message = raw_message.split('\r')[0];
    raw_message = raw_message.split('\n')[0];

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
      let nb_owned_lobbies = 0;
      for (const lobby of this._lobbies) {
        if (lobby.data.creator == Config.osu_username) {
          nb_owned_lobbies++;
        }
      }
      if (nb_owned_lobbies >= Config.max_lobbies) {
        return reject(new Error('Cannot create any more matches.'));
      }

      const room_created_listener = async (msg) => {
        const room_created_regex = /Created the tournament match https:\/\/osu\.ppy\.sh\/mp\/(\d+) (.+)/;
        if (msg.from == 'BanchoBot') {
          if (msg.message.indexOf('You cannot create any more tournament matches.') == 0) {
            this.off('pm', room_created_listener);
            return reject(new Error('Cannot create any more matches.'));
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
    // In a recent Bancho update, PMing users with spaces in their username
    // resulted in sometimes PMing the wrong user. To get around this, we
    // always replace spaces with underscores.
    destination = destination.replaceAll(' ', '_');

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
export default bancho;
