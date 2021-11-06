import fs from 'fs';
import {Client, Intents, MessageEmbed} from 'discord.js';


async function main() {
  const client = new Client({intents: [Intents.FLAGS.GUILDS]});

  client.once('ready', async () => {
    console.log('ready');
    const discord_channel = client.channels.cache.get('892789885335924786');
    // const discord_channel = client.channels.cache.get('893207661225594880'); // test channel

    await discord_channel.send({
      embeds: [
        new MessageEmbed({
          title: 'Instructions for creating a new ranked lobby',
          description: '**1.** Create a new lobby.\n**2.** BanchoBot should have sent a match history link. Copy the numbers after https://osu.ppy.sh/mp/.\n**3.** In the lobby chat, send **!mp addref kiwec**.\n**4.** In Discord, send **/make-ranked [the numbers you copied]** and the bot should join your lobby.',
        }),
      ],
    });

    console.log('sent');
  });

  const {discord_token} = JSON.parse(fs.readFileSync('./config.json'));
  client.login(discord_token);
}

main();
