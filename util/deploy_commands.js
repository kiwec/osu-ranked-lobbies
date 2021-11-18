import {SlashCommandBuilder} from '@discordjs/builders';
import {REST} from '@discordjs/rest';
import {Routes} from 'discord-api-types/v9';

import fs from 'fs';
const Config = JSON.parse(fs.readFileSync('../config.json'));

const commands = [
  new SlashCommandBuilder()
      .setName('profile')
      .setDescription('Get your profile information.'),
  new SlashCommandBuilder()
      .setName('make-lobby')
      .setDescription('Create a new ranked lobby.')
      .addIntegerOption((option) => option
          .setName('lobby-id')
          .setDescription('The lobby ID given by BanchoBot')
          .setRequired(true))
      .addNumberOption((option) => option
          .setName('min-stars')
          .setDescription('Minimum star level'))
      .addNumberOption((option) => option
          .setName('max-stars')
          .setDescription('Maximum star level'))
      .addBooleanOption((option) => option
          .setName('dt')
          .setDescription('Use double time'))
      .addBooleanOption((option) => option
          .setName('scorev2')
          .setDescription('Use ScoreV2')),
]
    .map((command) => command.toJSON());

const rest = new REST({version: '9'}).setToken(Config.discord_token);

rest.put(
    Routes.applicationCommands('892791929455128596'),
    {body: commands},
)
    .then(() => console.log('Successfully registered application commands.'))
    .catch(console.error);
