import EventEmitter from 'events';
import {Socket} from 'net';

import Config from './util/config.js';
import {capture_sentry_exception} from './util/helpers.js';


// Public events:
// - 'disconnect'
// - 'pm' {
//   from: string,
//   message: string
// }
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
    this._sent_messages = [];
    this._buffer = '';
    this._socket = null;
    this._writer = null;
    this._whoare = [];
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
      while (this._sent_messages.length > 0) {
        const obj = this._sent_messages.shift();
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

          const tournament_command_regex = /PRIVMSG #mp_(\d+) :!mp .+/;
          if (tournament_command_regex.test(obj.message)) {
            // Tournament API does not echo the commands for some reason.
            // In any case, those messages should not be awaited, but their
            // respective events instead.
            obj.callback();
          } else {
            this._sent_messages.push(obj);
          }
        }
      }, this.MILLISECONDS_BETWEEN_SENDS);
    });

    return new Promise((resolve, reject) => {
      this._socket.on('data', (data) => {
        data = data.toString().replace(/\r/g, '');
        this._buffer += data;

        const lines = this._buffer.split('\n');
        for (let i = 0; i < lines.length - 1; i++) {
          // Before processing the line, check if we need to ACK the promise of a sent message
          for (const sent of this._sent_messages) {
            if (`:${Config.osu_username}!cho@ppy.sh ${sent.message}` == lines[i]) {
              this._sent_messages = this._sent_messages.filter((msg) => msg != sent);
              sent.callback();
              break;
            }
          }

          this.emit('irc', lines[i]);
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
            this._whois_requests[parts[3]](user_id);
            delete this._whois_requests[parts[3]];
            continue;
          }

          if (parts[1] == '464') {
            console.error('[IRC] Invalid username/password. See: https://osu.ppy.sh/p/irc');
            parts.shift(); parts.shift();
            reject(new Error(parts.join(' ').substring(1)));
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

      this._whois_requests[irc_username] = resolve;
      this._send('WHOIS ' + irc_username);
    });
  }
}

export default new BanchoClient();
