# Migrate ranks.db to support the skill-based selection system
ALTER TABLE user ADD COLUMN aim_pp REAL;
ALTER TABLE user ADD COLUMN acc_pp REAL;
ALTER TABLE user ADD COLUMN speed_pp REAL;
ALTER TABLE user ADD COLUMN overall_pp REAL;
ALTER TABLE user ADD COLUMN last_top_score_tms INTEGER;
ALTER TABLE user ADD COLUMN last_update_tms INTEGER;
