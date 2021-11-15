import fs from 'fs';
import {Client, Intents} from 'discord.js';


async function main() {
  const client = new Client({intents: [Intents.FLAGS.GUILDS]});

  client.once('ready', async () => {
    console.log('ready');
    // const discord_channel = client.channels.cache.get('892880734526795826');
    const discord_channel = client.channels.cache.get('893207661225594880'); // test channel

    await discord_channel.send({
      content: 'Once your account is linked, you can vote for your preferred scoring system:',
      components: [
        new MessageActionRow().addComponents(
            new MessageSelectMenu()
                .setCustomId('orl_set_scoring')
                .setPlaceholder('No preference')
                .addOptions([
                  {
                    label: 'No preference',
                    description: 'Let others decide',
                    value: 'whatever',
                  },
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
