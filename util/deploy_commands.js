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
      name: 'make-lobby',
      description: 'Create a new ranked lobby.',
      options: [
        {
          type: 4,
          name: 'lobby-id',
          description: 'The lobby ID given by BanchoBot',
          required: true,
        },
        {
          type: 10,
          name: 'min-stars',
          description: 'Minimum star level',
          required: false,
        },
        {
          type: 10,
          name: 'max-stars',
          description: 'Maximum star level',
          required: false,
        },
        {
          type: 5,
          name: 'dt',
          description: 'Use double time',
          required: false,
        },
        {
          type: 5,
          name: 'scorev2',
          description: 'Use ScoreV2',
          required: false,
        },
      ],
      default_permission: false,
    },
  ];

  // Remove global commands
  const res1 = await rest.get(Routes.applicationCommands(Config.discord_bot_id));
  for (const cmd of res1) {
    console.log('Deleting global command', cmd.id, cmd.name);
    await rest.delete(Routes.applicationCommands(Config.discord_bot_id) + '/' + cmd.id);
  }

  // Create/Update guild commands
  const res2 = await rest.put(
      Routes.applicationGuildCommands(Config.discord_bot_id, Config.discord_guild_id),
      {body: commands},
  );
  for (const command of res2) {
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
