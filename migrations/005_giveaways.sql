CREATE TABLE IF NOT EXISTS giveaways (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  created_by TEXT NOT NULL,
  prize TEXT NOT NULL,
  ends_at BIGINT NOT NULL,
  winner_count INTEGER NOT NULL CHECK (winner_count BETWEEN 1 AND 10),
  required_role_id TEXT,
  required_level INTEGER NOT NULL DEFAULT 0 CHECK (required_level >= 0),
  ended_at BIGINT,
  winners TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS giveaways_due_idx ON giveaways(ends_at) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS giveaways_guild_idx ON giveaways(guild_id, id DESC);
CREATE TABLE IF NOT EXISTS giveaway_entries (
  giveaway_id BIGINT NOT NULL REFERENCES giveaways(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (giveaway_id, user_id)
);
CREATE INDEX IF NOT EXISTS giveaway_entries_user_idx ON giveaway_entries(user_id, giveaway_id);
