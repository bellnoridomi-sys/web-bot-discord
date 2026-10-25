CREATE TABLE IF NOT EXISTS guild_xp_settings (
  guild_id TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ignored_channel_ids TEXT[] NOT NULL DEFAULT '{}',
  ignored_role_ids TEXT[] NOT NULL DEFAULT '{}',
  role_multipliers JSONB NOT NULL DEFAULT '{}'::jsonb,
  level_rewards JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
