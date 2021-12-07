import fs from 'fs';
import {Client, Intents, MessageEmbed} from 'discord.js';
import Config from './config.js';

async function main() {
  const client = new Client({intents: [Intents.FLAGS.GUILDS]});

  client.once('ready', async () => {
    console.log('ready');

    const welcome_channel = client.channels.cache.get(Config.discord_welcome_channel_id);

    const discord_channel = client.channels.cache.get(Config.discord_faq_channel_id); // faq channel

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

    const lobbies_channel = client.channels.cache.get(Config.discord_lobbies_channel_id);
    await lobbies_channel.send({
      embeds: [
        new MessageEmbed({
          title: 'Instructions for creating a new ranked lobby',
          description: '**1.** Create a new lobby.\n**2.** BanchoBot should have sent a match history link. Copy the numbers after https://osu.ppy.sh/mp/.\n**3.** In the lobby chat, send **!mp addref kiwec**.\n**4.** In Discord, send **/make-lobby [the numbers you copied]** and the bot should join your lobby.',
        }),
      ],
    });
    await lobbies_channel.send({
      embeds: [
        new MessageEmbed({
          title: 'Commands for ranked lobbies',
          fields: [
            {
              name: '!about or !discord',
              value: 'Display some information for new players.',
            },
            {
              name: '!start',
              value: `Count down 30 seconds then start the map. Useful when some players are AFK or forget to ready up. Anybody can use this command.`,
            },
            {
              name: '!wait',
              value: `Cancel !start. Use it when you're not done downloading.`,
            },
            {
              name: '!skip',
              value: 'Vote to skip the current map. At least half the players in the lobby must vote to skip for a map to get skipped.',
            },
            {
              name: '!abort',
              value: 'Vote to abort the match. At least half the players in the lobby must vote to abort for a match to get aborted.',
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
              name: '!stars <minimum> <maximum>',
              value: 'Set the minimum and maximum star values of the lobby. Only the lobby creator can use this command.',
            },
            {
              name: '!dt',
              value: 'Toggle the Double Time mod on/off. Only the lobby creator can use this command.',
            },
            {
              name: '!scorev2',
              value: 'Toggle ScoreV2 scoring on/off. Only the lobby creator can use this command.',
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
