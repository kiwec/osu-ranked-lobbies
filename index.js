const Bancho = require('bancho.js');
const client = new Bancho.BanchoClient(require('./config.json'));

async function main() {
  await client.connect();
  console.log('online!');
  const channel1 = await client.createLobby('test lobby 1');
  await channel1.lobby.setPassword('justatest');
  console.log('lobby1 id:', channel1.lobby.id);
  const channel2 = await client.createLobby('test lobby 2');
  await channel2.lobby.setPassword('justatest');
  console.log('lobby2 id:', channel2.lobby.id);

  channel1.lobby.on('matchFinished', () => {
    console.log('match finished');
  });

  process.on('SIGINT', async () => {
    console.log('closing lobbies...');
    await channel1.lobby.closeLobby();
    await channel2.lobby.closeLobby();
    await client.disconnect();
  });
}

main();
