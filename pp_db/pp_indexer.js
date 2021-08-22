const {execFileSync} = require('child_process');

const sqlite3 = require('sqlite3');
const sqlite = require('sqlite');

const beatmaps = require('./beatmaps.json');
console.log(beatmaps.length, 'beatmaps to scan for pp');

// yes hardcoded too bad for you
const base_path = '/home/kiwec/Games/osu/drive_c/osu/Songs';
const oppai_exe = '/home/kiwec/Documents/oppai-ng/oppai';

async function altmain() {
  const map_db = await sqlite.open({
    filename: 'maps_test.db',
    driver: sqlite3.Database,
  });

  await map_db.exec(`CREATE TABLE map (id INTEGER, set_id INTEGER, osufile TEXT)`);
  let count = 0;
  for (const map of beatmaps) {
  	await map_db.run('INSERT INTO map (id, set_id, osufile) VALUES (?, ?, ?)', map.id, map.set_id, map.path + '/' + map.file);
	  count++;
	  console.log(count + '/' + beatmaps.length, '| map:', map.id);
  }
}

async function main() {
  const map_db = await sqlite.open({
    filename: 'maps.db',
    driver: sqlite3.Database,
  });

  await map_db.exec(`CREATE TABLE map (
    id INTEGER,
    set_id INTEGER,
    file TEXT,
    stars REAL,
    bpm REAL,
    cs REAL,
    ar REAL,
    od REAL,
    length REAL,
    "95%pp" REAL,
    "100%pp" REAL
  )`);

  let count = 0;
  for (const map of beatmaps) {
	  // yes this is insecure ik
	  try {
		  const _95pp = JSON.parse(execFileSync(
			  oppai_exe,
			  [base_path + '/' + map.path + '/' + map.file, '-ojson', '95%'],
		  ));
		  const _100pp = JSON.parse(execFileSync(
			  oppai_exe,
			  [base_path + '/' + map.path + '/' + map.file, '-ojson', '100%'],
		  ));

	    await map_db.run(
	      'INSERT INTO map (id, set_id, file, stars, bpm, cs, ar, od, length, "95%pp", "100%pp") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
	      map.id,
	      map.set_id,
	      map.file,
	      _100pp.stars,
	      map.bpm,
	      map.cs,
	      map.ar,
	      map.od,
	      map.length,
	      _95pp.pp,
	      _100pp.pp,
	    );

		  count++;
		  console.log(count + '/' + beatmaps.length, '| map:', map.id);
	  } catch (e) {
	  	console.error(e);
	    console.log('map', map.id, 'sucks, ignoring');
	  }
  }
}

altmain();
