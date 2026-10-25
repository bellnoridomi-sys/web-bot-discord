ALTER TABLE guild_configs ADD COLUMN IF NOT EXISTS automod_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE guild_configs ADD COLUMN IF NOT EXISTS automod_blocked_domains TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE guild_configs ADD COLUMN IF NOT EXISTS automod_spam_threshold INTEGER NOT NULL DEFAULT 5;
ALTER TABLE guild_configs ADD COLUMN IF NOT EXISTS automod_spam_window_seconds INTEGER NOT NULL DEFAULT 10;
ALTER TABLE guild_configs ADD COLUMN IF NOT EXISTS automod_max_mentions INTEGER NOT NULL DEFAULT 5;
ALTER TABLE guild_configs ADD COLUMN IF NOT EXISTS automod_raid_join_threshold INTEGER NOT NULL DEFAULT 8;
ALTER TABLE guild_configs ADD COLUMN IF NOT EXISTS automod_raid_window_seconds INTEGER NOT NULL DEFAULT 20;
ALTER TABLE guild_configs ADD COLUMN IF NOT EXISTS automod_lockdown_seconds INTEGER NOT NULL DEFAULT 60;
CREATE TABLE IF NOT EXISTS raid_lockdowns (
  guild_id TEXT PRIMARY KEY,
  expires_at BIGINT NOT NULL,
  snapshots JSONB NOT NULL DEFAULT '[]'
);
