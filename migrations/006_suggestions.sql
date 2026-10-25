ALTER TABLE guild_configs ADD COLUMN IF NOT EXISTS suggestion_channel_id TEXT;
CREATE TABLE IF NOT EXISTS suggestions (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  created_by TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS suggestions_guild_status_idx ON suggestions(guild_id,status,id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS suggestions_message_id_idx ON suggestions(guild_id,message_id) WHERE message_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS suggestion_votes (
  suggestion_id BIGINT NOT NULL REFERENCES suggestions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  vote TEXT NOT NULL CHECK (vote IN ('up','down')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (suggestion_id,user_id)
);
CREATE INDEX IF NOT EXISTS suggestion_votes_suggestion_vote_idx ON suggestion_votes(suggestion_id,vote);
