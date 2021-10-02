# Migrate maps.db to support the skill-based selection system
# Execute this before running ranked_db_generator.c
ALTER TABLE map DROP COLUMN path;
ALTER TABLE map ADD COLUMN stars REAL;
ALTER TABLE map ADD COLUMN aim_pp REAL;
ALTER TABLE map ADD COLUMN speed_pp REAL;
ALTER TABLE map ADD COLUMN acc_pp REAL;
ALTER TABLE map ADD COLUMN overall_pp REAL;
