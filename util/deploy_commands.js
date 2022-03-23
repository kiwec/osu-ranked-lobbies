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
  ];

  // Create/Update guild commands
  const res = await rest.put(
      Routes.applicationGuildCommands(Config.discord_bot_id, Config.discord_guild_id),
      {body: commands},
  );
  for (const command of res) {
    await rest.put(
        Routes.applicationGuildCommands(Config.discord_bot_id, Config.discord_guild_id) + `/${command.id}/permissions`,
        {body: {
          permissions: [
            {
              id: Config.discord_linked_account_role_id,
              type: 1,
              permission: true,
            },
          ],
        }},
    );
  }

  console.log('Successfully registered application commands.');
}
