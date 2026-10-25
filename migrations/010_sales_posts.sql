ALTER TABLE guild_configs ADD COLUMN IF NOT EXISTS sale_channel_id TEXT;
ALTER TABLE guild_configs ADD COLUMN IF NOT EXISTS sale_cooldown_minutes INTEGER NOT NULL DEFAULT 30;
CREATE TABLE IF NOT EXISTS sale_post_cooldowns (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_post_at BIGINT NOT NULL,
  PRIMARY KEY (guild_id,user_id)
);
CREATE INDEX IF NOT EXISTS sale_post_cooldowns_last_post_idx ON sale_post_cooldowns(last_post_at);
CREATE TABLE IF NOT EXISTS sale_posts (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  seller_id TEXT NOT NULL,
  title TEXT NOT NULL,
  price TEXT NOT NULL,
  description TEXT NOT NULL,
  contact TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sale_posts_guild_created_idx ON sale_posts(guild_id,created_at DESC);
CREATE INDEX IF NOT EXISTS sale_posts_seller_created_idx ON sale_posts(guild_id,seller_id,created_at DESC);
