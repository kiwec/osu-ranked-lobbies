-- discord.db
ALTER TABLE ranked_lobby ADD COLUMN creator TEXT;
ALTER TABLE ranked_lobby ADD COLUMN creator_discord_id TEXT;
UPDATE ranked_lobby SET creator = 'kiwec';
UPDATE ranked_lobby SET creator_discord_id = '889603773574578198';
