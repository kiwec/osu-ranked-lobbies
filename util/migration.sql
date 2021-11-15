-- discord.db
ALTER TABLE ranked_lobby ADD COLUMN creator TEXT;
ALTER TABLE ranked_lobby ADD COLUMN creator_discord_id TEXT;
ALTER TABLE ranked_lobby ADD COLUMN min_stars REAL;
ALTER TABLE ranked_lobby ADD COLUMN max_stars REAL;
UPDATE ranked_lobby SET creator = 'kiwec';
UPDATE ranked_lobby SET creator_discord_id = '889603773574578198';

-- ranks.db
ALTER TABLE user ADD COLUMN avg_sr REAL;
ALTER TABLE user SET last_top_score_tms = 0;
ALTER TABLE user SET last_update_tms = 0;
