import {SlashCommandBuilder} from '@discordjs/builders';
import {REST} from '@discordjs/rest';
import {Routes} from 'discord-api-types/v9';

import fs from 'fs';
const Config = JSON.parse(fs.readFileSync('../config.json'));

const commands = [
  new SlashCommandBuilder().setName('profile').setDescription('Get your profile information.'),
  new SlashCommandBuilder().setName('preference').setDescription('Set your preferred scoring criteria.'),
]
    .map((command) => command.toJSON());

const rest = new REST({version: '9'}).setToken(Config.discord_token);

rest.put(
    Routes.applicationCommands('892791929455128596'),
    {body: commands},
)
    .then(() => console.log('Successfully registered application commands.'))
    .catch(console.error);
