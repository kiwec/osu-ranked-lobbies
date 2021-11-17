import fs from 'fs';
import {Client, Intents, MessageEmbed} from 'discord.js';


async function main() {
  const client = new Client({intents: [Intents.FLAGS.GUILDS]});

  client.once('ready', async () => {
    console.log('ready');

    const discord_channel = client.channels.cache.get('893207661225594880'); // test channel

    await discord_channel.send({
      embeds: [
        new MessageEmbed({
          title: 'Commands for ranked lobbies',
          fields: [
            {
              name: '!about or !discord',
              value: 'Display some information for new players.',
            },
            {
              name: '!skip',
              value: 'Vote to skip the current map. At least half the players in the lobby must vote to skip for a map to get skipped.',
            },
            {
              name: '!start',
              value: `Count down 30 seconds then start the map. Useful when some players are AFK or forget to ready up. Anybody can use this command.`,
            },
            {
              name: '!kick <player>',
              value: `Vote to kick a player. This is used in rare cases where the lobby gets stuck because of a single player. Most of the time, you'll want to use the in-game ignoring and reporting features.`,
            },
            {
              name: '!rank',
              value: `Display your rank.`,
            },
            {
              name: '!wait',
              value: `Cancel !start. Use it when you're not done downloading.`,
            },
            {
              name: '!setstars <minimum> <maximum>',
              value: 'Set the minimum and maximum star values of the lobby. Only the lobby creator can use this command.',
            },
          ],
        }),
      ],
    });

    console.log('sent');
  });

  const {discord_token} = JSON.parse(fs.readFileSync('./config.json'));
  client.login(discord_token);
}

main();
