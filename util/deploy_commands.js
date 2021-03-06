import {REST} from '@discordjs/rest';
import {Routes} from 'discord-api-types/v9';

import Config from './config.js';

const rest = new REST({version: '9'}).setToken(Config.discord_token);
deploy_commands();

// Docs: https://discord.com/developers/docs/interactions/application-commands
async function deploy_commands() {
  const commands = [
    {
      type: 2,
      name: 'Display o!RL profile',
      description: '',
      options: [],
      default_permission: false,
    },
    {
      name: 'profile',
      description: 'Display your o!RL profile',
      options: [
        {
          type: 6,
          name: 'user',
          description: 'The user whose profile you want to get',
          required: false,
        },
      ],
      default_permission: false,
    },
    {
      name: 'eval',
      description: 'Run code on the bot',
      options: [
        {
          type: 3,
          name: 'code',
          description: 'The code to run',
          required: true,
        },
      ],
      default_permission: false,
    },
  ];

  // Create/Update guild commands
  await rest.put(
      Routes.applicationGuildCommands(Config.discord_bot_id, Config.discord_guild_id),
      {body: commands},
  );

  console.log('Successfully registered application commands.');
}
