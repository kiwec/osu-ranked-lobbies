const {execFileSync} = require('child_process');

const beatmaps = require('./beatmaps.json');
console.log(beatmaps.length, 'beatmaps to scan for pp');

// yes hardcoded too bad for you
const base_path = '/home/kiwec/Games/osu/drive_c/osu/Songs';
const oppai_exe = '/home/kiwec/Documents/oppai-ng/oppai';

let count = 0;
for (const map of beatmaps) {
  // yes this is insecure ik
  try {
	  const pp = JSON.parse(execFileSync(
		  oppai_exe,
		  [base_path + '/' + map.path + '/' + map.file, '-ojson'],
	  ));
	  map.pp = pp.pp;
	  count++;
	  console.log(count + '/' + beatmaps.length, 'map', map.id, ':', pp.pp, 'pp');
  } catch (e) {
    console.log('map', map.id, 'sucks, ignoring');
  }
}

const fs = require('fs');
fs.writeFileSync('beatmaps_with_pp.json', JSON.stringify(beatmaps));
