import {Client, Intents, MessageActionRow, MessageButton, MessageEmbed, MessageSelectMenu} from 'discord.js';

import fs from 'fs';
const Config = JSON.parse(fs.readFileSync('./config.json'));


async function main() {
  const client = new Client({intents: [Intents.FLAGS.GUILDS]});

  client.once('ready', async () => {
    console.log('ready');
    const discord_channel = client.channels.cache.get('892880734526795826');
    // const discord_channel = client.channels.cache.get('893207661225594880'); // test channel

    await discord_channel.send({
      content: 'Once your account is linked, you can vote for your preferred scoring system:',
      components: [
        new MessageActionRow().addComponents(
            new MessageSelectMenu()
                .setCustomId('orl_set_scoring')
                .setPlaceholder('No preference')
                .addOptions([
                  {
                    label: 'ScoreV1',
                    description: 'Default scoring system',
                    value: '0',
                  },
                  {
                    label: 'ScoreV2',
                    description: 'Tournament scoring system',
                    value: '3',
                  },
                  {
                    label: 'Accuracy',
                    description: 'Player with the highest accuracy wins',
                    value: '1',
                  },
                  {
                    label: 'Combo',
                    description: 'Player with the highest combo count at the end of the beatmap (not max combo!) wins',
                    value: '2',
                  },
                ]),
        ),
      ],
    });
    console.log('sent');
  });

  const {discord_token} = JSON.parse(fs.readFileSync('./config.json'));
  client.login(discord_token);
}

main();
