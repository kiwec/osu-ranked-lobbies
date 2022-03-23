import fs from 'fs';
import {Client, Intents, MessageActionRow, MessageButton, MessageEmbed} from 'discord.js';
import Config from './config.js';

async function main() {
  const client = new Client({intents: [Intents.FLAGS.GUILDS]});

  client.once('ready', async () => {
    console.log('ready');

    const lobby_creation_tutorial = {
      embeds: [
        new MessageEmbed({
          title: 'Instructions for creating a new bot lobby',
          description: `**1.** Create a new lobby.
**2.** BanchoBot should have sent a match history link. Copy the numbers after \`https://osu.ppy.sh/mp/\`.
**3.** In the lobby chat, send \`!mp addref ${Config.osu_username}\` to allow the bot to join the lobby.
**4.** Send \`!join [the numbers you copied]\` to the bot and it will join your lobby.`,
        }),
      ],
    };

    const welcome_channel = client.channels.cache.get(Config.discord_welcome_channel_id);
    await welcome_channel.send({
      content: `**__Rules__**
- Be nice to others and stay family friendly
- That's it

To access text channels, link your account with the button below.`,
      components: [
        new MessageActionRow().addComponents([
          new MessageButton({
            custom_id: 'orl_link_osu_account',
            label: 'Link account',
            style: 'PRIMARY',
          }),
        ]),
      ],
    });

    const faq_channel = client.channels.cache.get(Config.discord_faq_channel_id);
    await faq_channel.send({
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
              name: 'Why is the bot picking 4* maps in the 5* lobby?',
              value: 'The maps are actually 5*, it\'s just that the game still displays the old star rating system.',
            },
            {
              name: 'What are the ranks?',
              value: `Here is the rank distribution:
- Cardboard: Bottom 2.03%
- Wood: Top 97.96%
- Bronze: Top 82.35%
- Silver: Top 60.63%
- Gold: Top 38.42%
- Platinum: Top 19.54%
- Diamond: Top 6.45%
- Legendary: Top 0.04%
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

    const ranked_lobbies_channel = client.channels.cache.get(Config.discord_ranked_lobbies_channel_id);
    await ranked_lobbies_channel.send(lobby_creation_tutorial);
    await ranked_lobbies_channel.send({
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
              name: '!ban <player>',
              value: `Vote to ban a player. You should probably use the in-game ignoring and reporting features instead.`,
            },
            {
              name: '!rank <player>',
              value: `Display your rank or the rank of another player.`,
            },
            {
              name: '!stars <minimum> <maximum>',
              value: 'Set the minimum and maximum star values of the lobby. Only the lobby creator can use this command.',
            },
          ],
        }),
      ],
    });

    const collection_lobbies_channel = client.channels.cache.get(Config.discord_collection_lobbies_channel_id);
    await collection_lobbies_channel.send(lobby_creation_tutorial);
    await collection_lobbies_channel.send({
      embeds: [
        new MessageEmbed({
          title: 'Commands for collection lobbies',
          fields: [
            {
              name: '!collection <id>',
              value: 'Switches to another collection. Only the lobby creator can use this command.',
            },
            {
              name: '!abort',
              value: 'Vote to abort the match. At least half the players in the lobby must vote to abort for a match to get aborted.',
            },
            {
              name: '!skip',
              value: 'Vote to skip the current map. At least half the players in the lobby must vote to skip for a map to get skipped.',
            },
          ],
        }),
      ],
    });

    console.log('sent');
  });

  const {discord_token} = JSON.parse(fs.readFileSync('./config.json'));
  await client.login(discord_token);
}

main();
