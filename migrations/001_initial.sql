CREATE TABLE IF NOT EXISTS guild_configs (
      guild_id TEXT PRIMARY KEY,
      auto_voice_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      auto_voice_channel_id TEXT,
      prefix TEXT NOT NULL DEFAULT '!',
      log_channel_id TEXT,
      auto_role_id TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE guild_configs ADD COLUMN IF NOT EXISTS auto_role_id TEXT;
    ALTER TABLE guild_configs ADD COLUMN IF NOT EXISTS welcome_channel_id TEXT;
    ALTER TABLE guild_configs ADD COLUMN IF NOT EXISTS goodbye_channel_id TEXT;
    CREATE TABLE IF NOT EXISTS warnings (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      moderator_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS afk (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      media_url TEXT,
      since BIGINT NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
    ALTER TABLE afk ADD COLUMN IF NOT EXISTS media_url TEXT;
    CREATE TABLE IF NOT EXISTS reaction_role_panels (
      guild_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS reaction_role_bindings (
      guild_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      role_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(guild_id, message_id, emoji)
    );
    CREATE INDEX IF NOT EXISTS reaction_role_bindings_message_idx ON reaction_role_bindings(guild_id, message_id);
    CREATE TABLE IF NOT EXISTS community_profiles (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      xp BIGINT NOT NULL DEFAULT 0,
      level INTEGER NOT NULL DEFAULT 0,
      coins BIGINT NOT NULL DEFAULT 0,
      last_daily BIGINT NOT NULL DEFAULT 0,
      last_work BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS community_profiles_coins_idx ON community_profiles(guild_id, coins DESC);
    CREATE INDEX IF NOT EXISTS community_profiles_xp_idx ON community_profiles(guild_id, xp DESC);
    CREATE TABLE IF NOT EXISTS reminders (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      text TEXT NOT NULL,
      execute_at BIGINT NOT NULL,
      done BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS activity (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT,
      user_id TEXT,
      action TEXT NOT NULL,
      details TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      existing_sid TEXT
    );
    CREATE INDEX IF NOT EXISTS oauth_states_created_at_idx ON oauth_states(created_at);
    CREATE TABLE IF NOT EXISTS dashboard_sessions (
      sid TEXT PRIMARY KEY,
      session_data JSONB NOT NULL,
      last_seen BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS dashboard_sessions_last_seen_idx ON dashboard_sessions(last_seen);
