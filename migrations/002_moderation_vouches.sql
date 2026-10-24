CREATE TABLE IF NOT EXISTS moderation_cases (
  case_id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS moderation_cases_guild_target_idx ON moderation_cases(guild_id, target_user_id, case_id DESC);
CREATE TABLE IF NOT EXISTS vouches (
  guild_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, author_id, target_id),
  CHECK (author_id <> target_id)
);
CREATE INDEX IF NOT EXISTS vouches_guild_target_idx ON vouches(guild_id, target_id, created_at DESC);
CREATE TABLE IF NOT EXISTS scam_blacklist (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  added_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, user_id)
);
