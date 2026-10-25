CREATE TABLE IF NOT EXISTS guild_tags (
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id,name)
);
CREATE INDEX IF NOT EXISTS guild_tags_guild_updated_idx ON guild_tags(guild_id,updated_at DESC);
CREATE TABLE IF NOT EXISTS faq_rules (
  guild_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  response TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id,keyword)
);
CREATE INDEX IF NOT EXISTS faq_rules_guild_updated_idx ON faq_rules(guild_id,updated_at DESC);
