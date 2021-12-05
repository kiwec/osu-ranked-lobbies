import fs from 'fs';
import {Client, Intents, MessageEmbed} from 'discord.js';


async function main() {
  const client = new Client({intents: [Intents.FLAGS.GUILDS]});

  client.once('ready', async () => {
    console.log('ready');

    const welcome_channel = client.channels.cache.get('892880734526795826');

    const discord_channel = client.channels.cache.get('891782460365471764'); // faq channel

    await discord_channel.send({
      embeds: [
        new MessageEmbed({
          title: 'Frequently Asked Questions',
          fields: [
            {
              name: 'When do I get a rank?',
              value: `You get a rank after playing 5 games in a ranked lobby. To have it visible in this Discord server, you need to link your account in ${welcome_channel}.`,
            },
            {
              name: 'How do the ranks work?',
              value: 'The ranks are calculated based on how well you do against other players in the lobby. A player getting the first place in every game will rank up very fast. There is no difference between getting 1 and 10000000 more points than the next in line.',
            },
            {
              name: 'Will mods make me rank up faster?',
              value: 'No. Mods are mostly preference. They affect your score according to vanilla osu! rules, so it might give you an edge, but consistency is key. Playing HDHR is more of a flex than anything. Looking at you, the 4 digits stuck in Plat.',
            },
            {
              name: 'How are the maps chosen?',
              value: `They're chosen based on the top 100 plays of the lobby players. Accuracy, aim, speed, approach rate and star rating are taken into consideration when choosing which map fits the lobby best.`,
            },
            {
              name: 'What are the ranks?',
              value: `Here is the rank distribution:
- Cardboard: Bottom 0.62%
- Wood: Top 99.38%
- Bronze: Top 90.45%
- Silver: Top 72.70%
- Gold: Top 50.00%
- Platinum: Top 27.30%
- Diamond: Top 9.55%
- Legendary: Top 0.62%
- The One: #1`,
            },
            {
              name: `What's the map pool?`,
              value: 'The map pool is all maps that have a leaderboard: ranked, approved and loved maps. So, about 90k maps total.',
            },
            {
              name: `Why isn't the game starting when all players are ready?`,
              value: `That happens the last person that wasn't ready leaves. Anyone can unready and re-ready to start the game immediately. (I can't fix this bug, it comes from BanchoBot itself.)'`,
            },
            {
              name: `Can I see the source code?`,
              value: 'Yes: https://github.com/kiwec/osu-ranked-lobbies',
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
