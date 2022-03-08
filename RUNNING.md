Getting this bot to run all of its features is a long process, so for your convenience, the installation is split into three steps. Only the first step is required.

# Prerequisites

* [Node.JS LTS](https://nodejs.org/en/)
* [Yarn](https://yarnpkg.com/)
* [Rust](https://doc.rust-lang.org/cargo/getting-started/installation.html)
* On Windows, [Visual Studio 2013/2015/2017/2019 With C++ Option](https://docs.microsoft.com/en-us/visualstudio/install/install-visual-studio?view=vs-2022)

# Installation (basic)

* run `yarn`

* Copy `config.json.example` to `config.json`

* [Create a new osu! API application](https://osu.ppy.sh/home/account/edit#new-oauth-application), then add the client ID and secret to `osu_v2api_client_id` and `osu_v2api_client_secret` in `config.json`.

That's it! You should be able to run the website with `yarn start`.

# Installation (osu!)

* Download `ranks.db` [from my website](https://osu.kiwec.net/ranks.db)

It includes a map list of every ranked map. You can also initialize it yourself using [this tool](https://github.com/kiwec/orl-maps-db-generator).

* Download and extract the latest `osu_files.tar.bz2` file [from data.ppy.sh](https://data.ppy.sh/) and extract the `.osu` files to the `maps/` directory

* Set `CONNECT_TO_BANCHO` and `CREATE_LOBBIES` to `true` in `config.json`

* [Get an IRC password](https://osu.ppy.sh/p/irc) then add it to `config.json` (`osu_irc_password`) along with your osu! ID (`osu_id`) and username (`osu_username`).

Try running the bot with `yarn start` and see if it connects successfully. You should be able to find and join a lobby named "test lobby".

# Installation (Discord)

* Go to your Discord settings, and in Advanced, toggle `Developer Mode` on.

* [Create a new Discord application](https://discord.com/developers/applications) and add the bot id and token to `config.json`

* Create a Discord server with three channels and 10 roles, and add all of the relevant IDs to `config.json` by using Right Click -> Copy ID on the server name, channels, and roles

* Set `CONNECT_TO_DISCORD` to `true` in `config.json`

* Run `node util/deploy_commands.js`

* Run `node util/deploy_prompts.js`

Congratulations! You're done. If you made it this far, you can ask for a Developer role to `kiwec#2548`, which will let you access a top-secret channel in the o!RL Discord :)
