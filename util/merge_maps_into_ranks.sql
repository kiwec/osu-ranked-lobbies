attach './maps.db' as toMerge;
BEGIN;
CREATE TABLE map (
    id INTEGER PRIMARY KEY,
    set_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    length REAL NOT NULL,
    ranked INT NOT NULL,
    dmca INTEGER NOT NULL,
    stars REAL NOT NULL,
    aim_pp REAL NOT NULL,
    speed_pp REAL NOT NULL,
    acc_pp REAL NOT NULL,
    overall_pp REAL NOT NULL,
    ar REAL NOT NULL,
    dt_stars REAL NOT NULL,
    dt_aim_pp REAL NOT NULL,
    dt_speed_pp REAL NOT NULL,
    dt_acc_pp REAL NOT NULL,
    dt_overall_pp REAL NOT NULL,
    dt_ar REAL NOT NULL
);
insert into map select * from toMerge.map;
commit;
detach toMerge;

CREATE INDEX contest_id_idx ON score (contest_id);
