import crypto from 'crypto';
import fs from 'fs';
import {Client, Intents, MessageActionRow, MessageButton} from 'discord.js';

import bancho from './bancho.js';
import databases from './database.js';
import {capture_sentry_exception} from './util/helpers.js';
import Config from './util/config.js';

const client = new Client({intents: [Intents.FLAGS.GUILDS]});


function init() {
  return new Promise(async (resolve, reject) => {
    try {
      client.once('ready', async () => {
        client.on('interactionCreate', (interaction) => on_interaction(interaction).catch(capture_sentry_exception));
        console.log('Discord bot is ready.');
        resolve(client);
      });

      const {discord_token} = JSON.parse(fs.readFileSync('./config.json'));
      await client.login(discord_token);
    } catch (e) {
      reject(e);
    }
  });
}

async function on_interaction(interaction) {
  const get_user_stmt = databases.discord.prepare('SELECT * FROM user WHERE discord_id = ?');
  const user = get_user_stmt.get(interaction.user.id);

  if (interaction.isContextMenu()) {
    if (interaction.commandName == 'Display o!RL profile') {
      const target = get_user_stmt.get(interaction.targetId);

      if (target) {
        await interaction.reply(`${Config.website_base_url}/u/${target.osu_id}`);
      } else {
        await interaction.reply({
          content: 'That user hasn\'t linked their osu! account yet.',
          ephemeral: true,
        });
      }

      return;
    }
  }

  if (interaction.isCommand()) {
    if (interaction.commandName == 'profile') {
      let user = interaction.options.getUser('user');
      if (!user) {
        user = interaction.member;
      }

      const target = get_user_stmt.get(user.id);
      if (target) {
        await interaction.reply(`${Config.website_base_url}/u/${target.osu_id}`);
      } else {
        await interaction.reply({
          content: 'That user hasn\'t linked their osu! account yet.',
          ephemeral: true,
        });
      }

      return;
    }

    if (interaction.commandName == 'eval') {
      if (interaction.member.id != Config.discord_admin) {
        await interaction.reply({
          content: 'Only the bot owner can use this command.',
          ephemeral: true,
        });
        return;
      }

      try {
        const eval_res = eval(interaction.options.getString('code'));
        await interaction.reply({
          content: `\`\`\`js\n${eval_res}\n\`\`\``,
        });
      } catch (err) {
        await interaction.reply({
          content: `\`ERROR\` \`\`\`xl\n${err}\n\`\`\``,
        });
      }

      return;
    }
  }

  try {
    if (interaction.customId && interaction.customId.indexOf('orl_get_lobby_invite_') == 0) {
      await on_lobby_invite_button_press(user, interaction);
      return;
    }

    if (interaction.customId == 'orl_link_osu_account') {
      await on_link_osu_account_press(user, interaction);
      return;
    }
  } catch (err) {
    // Discord API likes to fail.
    if (err.message != 'Unknown interaction') {
      capture_sentry_exception(err);
    }
  }
}

async function on_lobby_invite_button_press(user, interaction) {
  const parts = interaction.customId.split('_');
  const lobby_id = parseInt(parts[parts.length - 1], 10);

  if (!user) {
    const welcome = await client.channels.cache.get(Config.discord_welcome_channel_id);
    await interaction.reply({
      content: `Before getting an invite, you need to click the button in ${welcome} to link your osu! account.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ephemeral: true});

  const stmt = databases.ranks.prepare('SELECT username FROM user WHERE user_id = ?');
  const player = stmt.get(user.osu_id);
  if (!player) {
    await interaction.editReply({
      content: 'Sorry, but you need to join your first lobby from in-game. Search for "o!RL".',
      ephemeral: true,
    });
    return;
  }

  for (const lobby of bancho.joined_lobbies) {
    if (lobby.channel == '#mp_' + lobby_id) {
      await bancho.privmsg(player.username, `${player.username}, here's your invite: [http://osump://${lobby.invite_id}/ ${lobby.name}]`);
      await interaction.editReply({
        content: 'An invite to the lobby has been sent. Check your in-game messages. 😌',
        ephemeral: true,
      });
      return;
    }
  }

  await interaction.editReply({
    content: 'Sorry, looks like that lobby just closed. <:tf:900417849179389992>',
    ephemeral: true,
  });
  await interaction.message.delete();
}

async function on_link_osu_account_press(user, interaction) {
  // Check if user already linked their account
  if (user) {
    await interaction.member.roles.add(Config.discord_linked_account_role_id);
    await interaction.reply({
      content: 'You already linked your account 👉 https://osu.ppy.sh/users/' + user.osu_id,
      ephemeral: true,
    });
    return;
  }

  // Create ephemeral token
  const ephemeral_token = crypto.randomBytes(16).toString('hex');
  let stmt = databases.discord.prepare('DELETE from auth_tokens WHERE discord_user_id = ?');
  stmt.run(interaction.user.id);
  stmt = databases.discord.prepare('INSERT INTO auth_tokens (discord_user_id, ephemeral_token) VALUES (?, ?)');
  stmt.run(interaction.user.id, ephemeral_token);

  // Send authorization link
  await interaction.reply({
    content: `Hello ${interaction.user}, let's get your account linked!`,
    ephemeral: true,
    components: [
      new MessageActionRow().addComponents([
        new MessageButton({
          url: `https://osu.ppy.sh/oauth/authorize?client_id=${Config.osu_v2api_client_id}&response_type=code&scope=identify&state=${ephemeral_token}&redirect_uri=${Config.website_base_url}/auth`,
          label: 'Verify using osu!web',
          style: 'LINK',
        }),
      ]),
    ],
  });
}

export {
  init,
};
