import fs from 'fs';
import {Client, Intents, MessageActionRow, MessageSelectMenu} from 'discord.js';


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

    const lobbies_channel = client.channels.cache.get('892789885335924786');
    await lobbies_channel.send({
      embeds: [
        new MessageEmbed({
          title: 'Instructions for creating a new ranked lobby',
          description: '**1.** Create a new lobby.\n**2.** BanchoBot should have sent a match history link. Copy the numbers after https://osu.ppy.sh/mp/.\n**3.** In the lobby chat, send **!mp addref kiwec**.\n**4.** In Discord, send **/make-lobby [the numbers you copied]** and the bot should join your lobby.',
        }),
      ],
    });

    console.log('sent');
  });

  const {discord_token} = JSON.parse(fs.readFileSync('./config.json'));
  client.login(discord_token);
}

main();
