import fs from 'fs';
import {Client, Intents, MessageEmbed, MessageActionRow, MessageSelectMenu} from 'discord.js';


async function main() {
  const client = new Client({intents: [Intents.FLAGS.GUILDS]});

  client.once('ready', async () => {
    console.log('ready');
    const discord_channel = client.channels.cache.get('891787381106171925');
    // const discord_channel = client.channels.cache.get('893207661225594880'); // test channel

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
          ],
        }),
      ],
    });

    await discord_channel.send({
      embeds: [
        new MessageEmbed({
          title: 'Commands for custom lobbies',
          fields: [
            {
              name: '!skip',
              value: 'Select a new map. Only the lobby creator can run this command.',
            },
            {
              name: '!setfilters <criteria>',
              value: `Change the criteria used for selecting a map. Only the lobby creator can run this command.
ex: !setfilters stars>4.5 stars<=4.99 +HDDT`,
            },
            {
              name: '!makelobby <criteria> <mods>',
              value: `Create an unranked lobby that automatically rotates the map to one that fits the given criteria.
Mods are optional. They affect some filters like pp, stars, etc.
ex: !makelobby stars>4 stars<5 +DT

You should sent that command to [the in-game bot](https://osu.ppy.sh/users/12398096), not in a multiplayer lobby.

The following filters are accepted:
- stars
- length
- bpm (bugged)
- cs
- ar
- od
- 95%pp (the pp you would get for 95% accuracy)
- 100%pp (the pp you would get for SS)

The following mods are accepted:
- HD (hidden)
- FL (flashlight)
- EZ ("easy")
- HR (hard rock)
- HT (half time)
- DT (double time)
- NC (nightcore)`,
            },
          ],
        }),
      ],
    });

    //     await discord_channel.send({
    //       embeds: [
    //         new MessageEmbed({
    //           title: 'Frequently Asked Questions',
    //           fields: [
    //             {
    //               name: 'How do the ranks work?',
    //               value: 'The ranks are calculated based on how well you do against other players in the lobby. A player getting the first place in every game will rank up very fast. There is no difference between getting 1 and 10000000 more points than the next in line.',
    //             },
    //             {
    //               name: 'Will mods make me rank up faster?',
    //               value: 'No. Mods are mostly preference. They affect your score according to vanilla osu! rules, so it might give you an edge, but consistency is key. Playing HDHR is more of a flex than anything. Looking at you, the 4 digits stuck in Plat.',
    //             },
    //             {
    //               name: 'How are the maps chosen?',
    //               value: `They're chosen based on the average skill of the players in the lobby. To be more specific, the bot gets a "comfortable pp level" for each player based on their top 100 plays, and then gets the median value for the lobby. From then on, it simply chooses a map close to that pp level.`,
    //             },
    //             {
    //               name: 'Why choose maps from pp instead of stars?',
    //               value: `A level's star rating is a good indicator of whether or not you can finish the map. A level's pp rating is a good indicator of whether or not you can FC the map. There's not much point in competing on reading skills - you already know if you can or can't pass a certain star level. Competing on consistency, though? Now we're talking.`,
    //             },
    //             {
    //               name: 'What are the ranks?',
    //               value: `Here is the rank distribution:
    // - Cardboard: Bottom 0.62%
    // - Copper: Top 99.38%
    // - Bronze: Top 90.45%
    // - Silver: Top 72.70%
    // - Gold: Top 50.00%
    // - Platinum: Top 27.30%
    // - Diamond: Top 9.55%
    // - Legendary: Top 0.62%
    // - The One: #1`,
    //             },
    //             {
    //               name: `What's the map pool?`,
    //               value: 'The map pool is all maps that have a leaderboard: ranked, approved and loved maps. So, about 90k maps total.',
    //             },
    //             {
    //               name: `Why isn't the game starting when all players are ready?`,
    //               value: `That happens the last person that wasn't ready leaves. Anyone can unready and re-ready to start the game immediately. (I can't fix this bug, it comes from BanchoBot itself.)'`,
    //             },
    //             {
    //               name: `Can I see the source code?`,
    //               value: 'Yes: https://git.sr.ht/~kiwec/osu_automap_bot',
    //             },
    //           ],
    //         }),
    //       ],
    //     });
    console.log('sent');
  });

  const {discord_token} = JSON.parse(fs.readFileSync('./config.json'));
  client.login(discord_token);
}

main();
