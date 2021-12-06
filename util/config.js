import fs from 'fs';

const Config = JSON.parse(fs.readFileSync('./config.json'));

export default Config;