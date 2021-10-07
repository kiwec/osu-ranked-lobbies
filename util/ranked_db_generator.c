#include <sqlite3.h>
#include <stdio.h>

#define OPPAI_IMPLEMENTATION
#include "oppai.c"


int main(int argc, char* argv[]) {
  sqlite3* db;
  sqlite3_stmt* map_stmt;
  sqlite3_stmt* pp_stmt;

  sqlite3_open("maps.db", &db);
  if(db == NULL) {
    fprintf(stderr, "Failed to open database 'maps.db'.\n");
    return 1;
  }

  // Don't care about power failure since it's a one-time job
  char* errorMessage;
  sqlite3_exec(db, "PRAGMA synchronous=OFF", NULL, NULL, &errorMessage);
  sqlite3_exec(db, "PRAGMA count_changes=OFF", NULL, NULL, &errorMessage);
  sqlite3_exec(db, "PRAGMA journal_mode=MEMORY", NULL, NULL, &errorMessage);
  sqlite3_exec(db, "PRAGMA temp_store=MEMORY", NULL, NULL, &errorMessage);

  sqlite3_exec(db, "BEGIN TRANSACTION", NULL, NULL, &errorMessage);

  sqlite3_prepare_v2(db, "select id from map", -1, &map_stmt, NULL);
  sqlite3_prepare_v2(db, "update map set dt_aim_pp = ?1, dt_speed_pp = ?2, dt_acc_pp = ?3, dt_overall_pp = ?4 where id = ?5", -1, &pp_stmt, NULL);

  while(sqlite3_step(map_stmt) != SQLITE_DONE) {
    char map_filename[32];
    int map_id = sqlite3_column_int(map_stmt, 0);
    sprintf(map_filename, "maps/%d.osu", map_id);
    printf("%s\n", map_filename);
    
    ezpp_t oppai = ezpp_new();
    ezpp_set_accuracy_percent(oppai, 100);
    ezpp_set_mods(oppai, MODS_DT);
    ezpp_set_autocalc(oppai, 1);
    ezpp(oppai, map_filename);

    sqlite3_bind_double(pp_stmt, 1, ezpp_aim_pp(oppai));
    sqlite3_bind_double(pp_stmt, 2, ezpp_speed_pp(oppai));
    sqlite3_bind_double(pp_stmt, 3, ezpp_acc_pp(oppai));
    sqlite3_bind_double(pp_stmt, 4, ezpp_pp(oppai));
    sqlite3_bind_int(pp_stmt, 5, map_id);
    sqlite3_step(pp_stmt);
    sqlite3_reset(pp_stmt);

    ezpp_free(oppai);
  }

  sqlite3_exec(db, "COMMIT TRANSACTION", NULL, NULL, &errorMessage);
  sqlite3_finalize(map_stmt);
  sqlite3_close(db);

  return 0;
}
