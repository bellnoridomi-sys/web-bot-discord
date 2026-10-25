CREATE TABLE IF NOT EXISTS guild_message_templates (
  guild_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('welcome','goodbye')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  image_url TEXT,
  button_label TEXT,
  button_url TEXT,
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id,kind),
  CHECK ((button_label IS NULL AND button_url IS NULL) OR (button_label IS NOT NULL AND button_url IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS guild_message_templates_updated_idx ON guild_message_templates(guild_id,updated_at DESC);
