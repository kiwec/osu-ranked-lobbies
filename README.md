# osu! ranked lobbies

A bot that creates osu! lobbies, with an alternative leaderboard not based on performance points.

Contributions are welcome; if you have trouble getting the bot to run, feel free to message kiwec on discord (or on osu!).

***

## Development setup

### Prerequisite
* [Yarn](https://yarnpkg.com/)
* [Cargo](https://doc.rust-lang.org/cargo/getting-started/installation.html)
* [Visual Studio 2013/2015/2017/2019 With C++ Option](https://docs.microsoft.com/en-us/visualstudio/install/install-visual-studio?view=vs-2022)
* [Node LTS](https://nodejs.org/en/)

***

### Installation
* run `yarn`

* Copy `config.json.example` to `config.json` and add the required API keys.

>  The `sentry_dsn` setting is only required if you intend to run the bot in production, as it is used for error monitoring.


* Download `maps.db` [from my website](https://osu.kiwec.net/maps.db)

> You can also build it yourself: https://github.com/kiwec/orl-maps-db-generator

* Download and extract the latest `osu_files.tar.bz2` file [from data.ppy.sh](https://data.ppy.sh/) and extract the `.osu` files to the `maps/` directory

> This step isn't required, but makes profile scanning faster and avoids spamming the osu! servers with requests.

* Run the bot once, it will crash, then run `sqlite3 ranks.db < util/merge_maps_into_ranks.sql`.

> A bit janky, I know, I'll make it easier later™.

***

## Feature flags

During development, you might not want to run the entire bot. You can disable the following feature flags in config.json:

* `CONNECT_TO_BANCHO`: connects to the osu! servers, rejoins lobbies, replies to in-game commands, etc.

* `APPLY_RANK_DECAY`: applies rank decay when the bot is started, and then every hour after that. Leave it off unless you're testing ranking changes.

* `CREATE_LOBBIES`: creates 4 lobbies automatically. Highly recommended to disable this (or edit the lobby creation code in index.js) during development.

* `CONNECT_TO_DISCORD`: connects to the discord api, reacts to interactions, changes user roles, etc.

* `HOST_WEBSITE`: hosts the o!rl website on port 3001.

* `ENABLE_SENTRY`: use Sentry service for error monitoring

### License

This project is licensed under the GNU Affero General Public License. You're free to use this project however you want as long as you keep it open source. For more details, [read the complete LICENSE file](https://github.com/kiwec/osu-ranked-lobbies/blob/master/LICENSE)
