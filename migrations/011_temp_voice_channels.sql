ALTER TABLE guild_configs ADD COLUMN IF NOT EXISTS temp_voice_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE guild_configs ADD COLUMN IF NOT EXISTS temp_voice_trigger_channel_id TEXT;
ALTER TABLE guild_configs ADD COLUMN IF NOT EXISTS temp_voice_category_id TEXT;
ALTER TABLE guild_configs ADD COLUMN IF NOT EXISTS temp_voice_user_limit INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS temp_voice_channels (
  guild_id TEXT NOT NULL,
  channel_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS temp_voice_channels_guild_idx ON temp_voice_channels(guild_id);
