ALTER TABLE guild_configs ADD COLUMN IF NOT EXISTS verification_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE guild_configs ADD COLUMN IF NOT EXISTS verification_channel_id TEXT;
ALTER TABLE guild_configs ADD COLUMN IF NOT EXISTS verification_message_id TEXT;
ALTER TABLE guild_configs ADD COLUMN IF NOT EXISTS verification_role_id TEXT;
ALTER TABLE guild_configs ADD COLUMN IF NOT EXISTS verification_quarantine_role_id TEXT;
ALTER TABLE guild_configs ADD COLUMN IF NOT EXISTS verification_min_account_days INTEGER NOT NULL DEFAULT 0;
