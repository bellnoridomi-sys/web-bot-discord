import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { Server as SocketIOServer } from 'socket.io';
import pg from 'pg';
import {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  PermissionsBitField,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  REST,
  Routes,
  SlashCommandBuilder
} from 'discord.js';
import {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
  VoiceConnectionDisconnectReason
} from '@discordjs/voice';

const { Pool } = pg;
const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: true, credentials: true } });
const PORT = Number(process.env.PORT || 10000);
const isProd = process.env.NODE_ENV === 'production';
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const APP_NAME = process.env.APP_NAME || 'Aki Dev';
const SESSION_COOKIE = 'aki_sid';
const INTERNAL_PREFIX = 'aki';

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(rateLimit({ windowMs: 60_000, limit: 160, standardHeaders: true, legacyHeaders: false }));

const sessionStore = new Map();
const oauthStateStore = new Map();
const activityCache = [];
const memory = {
  configs: new Map(),
  warnings: new Map(),
  afk: new Map()
};

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
      max: 4,
      idleTimeoutMillis: 10_000
    })
  : null;

async function dbQuery(text, params = []) {
  if (!pool) return null;
  return pool.query(text, params);
}

async function initDb() {
  if (!pool) return;
  await dbQuery(`
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
  `);
}

async function getConfig(guildId) {
  if (pool) {
    const r = await dbQuery('SELECT * FROM guild_configs WHERE guild_id=$1', [guildId]);
    if (r.rowCount) return r.rows[0];
    await dbQuery('INSERT INTO guild_configs(guild_id) VALUES($1) ON CONFLICT DO NOTHING', [guildId]);
    return getConfig(guildId);
  }
  if (!memory.configs.has(guildId)) memory.configs.set(guildId, {
    guild_id: guildId,
    auto_voice_enabled: false,
    auto_voice_channel_id: null,
    prefix: '!',
    log_channel_id: null,
    auto_role_id: null
  });
  return memory.configs.get(guildId);
}

async function setConfig(guildId, patch) {
  const current = await getConfig(guildId);
  const next = { ...current, ...patch };
  if (pool) {
    await dbQuery(`
      INSERT INTO guild_configs(guild_id, auto_voice_enabled, auto_voice_channel_id, prefix, log_channel_id, auto_role_id, updated_at)
      VALUES($1,$2,$3,$4,$5,$6,NOW())
      ON CONFLICT(guild_id) DO UPDATE SET
        auto_voice_enabled=EXCLUDED.auto_voice_enabled,
        auto_voice_channel_id=EXCLUDED.auto_voice_channel_id,
        prefix=EXCLUDED.prefix,
        log_channel_id=EXCLUDED.log_channel_id,
        auto_role_id=EXCLUDED.auto_role_id,
        updated_at=NOW()
    `, [guildId, Boolean(next.auto_voice_enabled), next.auto_voice_channel_id || null, next.prefix || '!', next.log_channel_id || null, next.auto_role_id || null]);
  } else memory.configs.set(guildId, next);
  return next;
}

async function addActivity(guildId, userId, action, details) {
  const row = { guild_id: guildId || null, user_id: userId || null, action, details: String(details || '').slice(0, 1500), created_at: new Date().toISOString() };
  activityCache.unshift(row);
  while (activityCache.length > 80) activityCache.pop();
  if (pool) await dbQuery('INSERT INTO activity(guild_id,user_id,action,details) VALUES($1,$2,$3,$4)', [guildId || null, userId || null, action, row.details]);
  if (guildId) io.to('guild:' + guildId).emit('activity', row);
  sendActivityToDiscord(row).catch(error => console.warn('Discord audit delivery failed:', error.message));
  return row;
}

async function sendActivityToDiscord(row) {
  if (!row.guild_id || !bot.isReady()) return;
  const config = await getConfig(row.guild_id).catch(() => null);
  if (!config?.log_channel_id) return;
  const channel = await bot.channels.fetch(config.log_channel_id).catch(() => null);
  if (!channel?.isTextBased?.() || !channel.guild || channel.guild.id !== row.guild_id) return;
  const me = channel.guild.members.me || await channel.guild.members.fetchMe().catch(() => null);
  const permissions = me ? channel.permissionsFor(me) : null;
  if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) return;
  const embed = new EmbedBuilder()
    .setColor(row.action?.startsWith('error:') ? 0xED4245 : 0x5865F2)
    .setTitle('🧾 Aki Activity · ' + String(row.action || 'event').slice(0, 200))
    .setDescription(String(row.details || 'No details').slice(0, 3500))
    .addFields({ name: 'Actor ID', value: String(row.user_id || 'System').slice(0, 100), inline: true }, { name: 'Source', value: String(row.action || 'event').startsWith('web:') ? 'Web dashboard' : 'Discord / Bot', inline: true })
    .setTimestamp(new Date(row.created_at));
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function addWarning(guildId, userId, moderatorId, reason) {
  if (pool) {
    await dbQuery('INSERT INTO warnings(guild_id,user_id,moderator_id,reason) VALUES($1,$2,$3,$4)', [guildId, userId, moderatorId, reason]);
  } else {
    const key = `${guildId}:${userId}`;
    const list = memory.warnings.get(key) || [];
    list.push({ user_id: userId, moderator_id: moderatorId, reason, created_at: new Date().toISOString() });
    memory.warnings.set(key, list);
  }
}

async function getWarnings(guildId, userId) {
  if (pool) {
    const r = await dbQuery('SELECT * FROM warnings WHERE guild_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 15', [guildId, userId]);
    return r.rows;
  }
  return memory.warnings.get(`${guildId}:${userId}`) || [];
}

function normalizeMediaUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Media URL phải dùng http hoặc https.');
    if (url.toString().length > 2048) throw new Error('Media URL quá dài.');
    return url.toString();
  } catch (error) {
    if (error.message === 'Media URL phải dùng http hoặc https.' || error.message === 'Media URL quá dài.') throw error;
    throw new Error('Media URL không hợp lệ.');
  }
}

async function setAfk(guildId, userId, reason, mediaUrl = null) {
  const since = Date.now();
  const cleanReason = String(reason || 'Không có lý do').trim().slice(0, 1000) || 'Không có lý do';
  const cleanMedia = mediaUrl ? normalizeMediaUrl(mediaUrl) : null;
  if (pool) {
    await dbQuery(`INSERT INTO afk(guild_id,user_id,reason,media_url,since) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(guild_id,user_id) DO UPDATE SET reason=EXCLUDED.reason,media_url=EXCLUDED.media_url,since=EXCLUDED.since`, [guildId, userId, cleanReason, cleanMedia, since]);
  } else memory.afk.set(`${guildId}:${userId}`, { reason: cleanReason, media_url: cleanMedia, since });
  return { reason: cleanReason, media_url: cleanMedia, since };
}
async function clearAfk(guildId, userId) {
  if (pool) await dbQuery('DELETE FROM afk WHERE guild_id=$1 AND user_id=$2', [guildId, userId]);
  else memory.afk.delete(`${guildId}:${userId}`);
}
async function getAfk(guildId, userId) {
  if (pool) {
    const r = await dbQuery('SELECT * FROM afk WHERE guild_id=$1 AND user_id=$2', [guildId, userId]);
    return r.rows[0] || null;
  }
  return memory.afk.get(`${guildId}:${userId}`) || null;
}
function afkPayload(memberUser, afk) {
  const username = memberUser?.globalName || memberUser?.username || 'User';
  const embed = new EmbedBuilder()
    .setColor(0x161616)
    .setAuthor({ name: `💤 ${username} đang AFK`, ...(memberUser?.displayAvatarURL ? { iconURL: memberUser.displayAvatarURL({ size: 128 }) } : {}) })
    .setDescription(`> ${String(afk.reason || 'Không có lý do').slice(0, 1000)}`)
    .setFooter({ text: 'Aki Dev · AFK System' })
    .setTimestamp(Number(afk.since) || Date.now());
  if (afk.media_url) embed.setImage(afk.media_url);
  return { embeds: [embed], allowedMentions: { parse: [] } };
}

async function scheduleReminder(guildId, userId, channelId, text, executeAt) {
  if (pool) await dbQuery('INSERT INTO reminders(guild_id,user_id,channel_id,text,execute_at) VALUES($1,$2,$3,$4,$5)', [guildId, userId, channelId, text, executeAt]);
}

async function reminderTick() {
  if (!pool || !bot.isReady()) return;
  const r = await dbQuery('SELECT * FROM reminders WHERE done=false AND execute_at <= $1 ORDER BY execute_at LIMIT 20', [Date.now()]);
  for (const item of r.rows) {
    await dbQuery('UPDATE reminders SET done=true WHERE id=$1', [item.id]);
    try {
      const ch = await bot.channels.fetch(item.channel_id);
      if (ch?.isTextBased()) await ch.send(`<@${item.user_id}> ⏰ **Nhắc bạn:** ${item.text}`);
    } catch (error) {
      console.error('Reminder delivery failed:', error.message);
    }
  }
}

function makeSession(user, guilds) {
  const sid = crypto.randomBytes(32).toString('hex');
  sessionStore.set(sid, { user, guilds, createdAt: Date.now(), lastSeen: Date.now() });
  return sid;
}
function getSession(req) {
  const sid = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`${SESSION_COOKIE}=`))?.split('=')[1];
  return sid ? sessionStore.get(sid) : null;
}
function requireAuth(req, res, next) {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
  s.lastSeen = Date.now();
  req.session = s;
  next();
}
function appendSetCookie(res, cookie) {
  const current = res.getHeader('Set-Cookie');
  const cookies = current ? (Array.isArray(current) ? current : [current]) : [];
  res.setHeader('Set-Cookie', [...cookies, cookie]);
}
function setSessionCookie(res, sid) {
  const cookie = SESSION_COOKIE + '=' + sid + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + (60 * 60 * 24 * 7) + (isProd ? '; Secure' : '');
  appendSetCookie(res, cookie);
}
function setupActivitySocketAuth() {
  io.use((socket, next) => {
    const sid = getCookieValue({ headers: socket.handshake.headers }, SESSION_COOKIE);
    const session = sid ? sessionStore.get(sid) : null;
    if (!session) {
      const error = new Error('AUTH_REQUIRED');
      error.data = { code: 'AUTH_REQUIRED' };
      return next(error);
    }
    socket.data.sessionSid = sid;
    next();
  });
  io.on('connection', socket => {
    socket.on('unwatch-guild', () => {
      for (const room of socket.rooms) if (room.startsWith('guild:')) socket.leave(room);
    });
    socket.on('watch-guild', guildId => {
      for (const room of socket.rooms) if (room.startsWith('guild:')) socket.leave(room);
      if (typeof guildId !== 'string' || !/^\d{17,20}$/.test(guildId)) return socket.emit('socket-error', { error: 'INVALID_GUILD' });
      const session = sessionStore.get(socket.data.sessionSid);
      if (!session) return socket.disconnect(true);
      const meta = (session.guilds || []).find(g => g.id === guildId);
      if (!bot.guilds.cache.has(guildId) || !canManageGuildFromOAuthMeta(meta)) {
        return socket.emit('socket-error', { error: 'NO_GUILD_ACCESS' });
      }
      socket.join('guild:' + guildId);
    });
  });
}
function clearSessionCookie(res) {
  appendSetCookie(res, SESSION_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (isProd ? '; Secure' : ''));
}

function encodeState() {
  return crypto.randomBytes(24).toString('hex');
}
function validOAuthState(state) {
  return typeof state === 'string' && /^[a-f0-9]{48}$/.test(state);
}
function oauthStateCookieName(state) {
  return validOAuthState(state) ? 'aki_oas_' + state : null;
}
function getCookieValue(req, name) {
  const entry = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(name + '='));
  return entry ? entry.slice(name.length + 1) : null;
}
function setOAuthStateCookie(res, state) {
  const name = oauthStateCookieName(state);
  if (!name) throw new Error('Invalid OAuth state format.');
  // OAuth returns from a different site. None+Secure makes the cookie available
  // on the cross-site redirect in production browsers.
  appendSetCookie(res, name + '=' + state + '; Path=/; HttpOnly; SameSite=' + (isProd ? 'None; Secure' : 'Lax') + '; Max-Age=600');
}
function hasOAuthStateCookie(req, state) {
  const name = oauthStateCookieName(state);
  return Boolean(name && getCookieValue(req, name) === state);
}
function clearOAuthStateCookie(res, state) {
  const name = oauthStateCookieName(state);
  if (name) appendSetCookie(res, name + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (isProd ? '; Secure' : ''));
}
async function storeOAuthState(state, data) {
  if (pool) {
    await dbQuery(
      'INSERT INTO oauth_states(state, provider, created_at, existing_sid) VALUES($1,$2,$3,$4) ON CONFLICT(state) DO UPDATE SET provider=EXCLUDED.provider, created_at=EXCLUDED.created_at, existing_sid=EXCLUDED.existing_sid',
      [state, data.provider, data.createdAt, data.existingSid || null]
    );
    return;
  }
  oauthStateStore.set(state, data);
}
async function consumeOAuthState(stateKey) {
  if (!validOAuthState(stateKey)) return null;
  if (pool) {
    const result = await dbQuery(
      'DELETE FROM oauth_states WHERE state=$1 RETURNING provider, created_at, existing_sid',
      [stateKey]
    );
    const row = result?.rows?.[0];
    if (!row) return null;
    return {
      provider: row.provider,
      createdAt: Number(row.created_at),
      existingSid: row.existing_sid || null
    };
  }
  const row = oauthStateStore.get(stateKey) || null;
  oauthStateStore.delete(stateKey);
  return row;
}

async function discordOAuthCallback(code) {
  const clientId = process.env.DISCORD_CLIENT_ID || '';
  const clientSecret = process.env.DISCORD_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) throw new Error('DISCORD_OAUTH_CONFIG_MISSING');

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: SITE_URL + '/auth/discord/callback'
  });
  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!tokenRes.ok) {
    let payload = {};
    try { payload = await tokenRes.json(); } catch {}
    const errorCode = typeof payload.error === 'string' ? payload.error : 'unknown';
    throw new Error('DISCORD_TOKEN_EXCHANGE_' + tokenRes.status + '_' + errorCode);
  }
  return tokenRes.json();
}
async function discordApi(apiPath, token) {
  const response = await fetch('https://discord.com/api/v10' + apiPath, {
    headers: { Authorization: 'Bearer ' + token }
  });
  if (!response.ok) throw new Error('DISCORD_API_' + response.status + '_' + apiPath);
  return response.json();
}
async function getDiscordAccessTokenForSession(session) {
  if (session.discordAccessToken && Number(session.discordTokenExpiresAt || 0) > Date.now() + 30000) return session.discordAccessToken;
  if (!session.discordRefreshToken) return null;
  const clientId = process.env.DISCORD_CLIENT_ID || '';
  const clientSecret = process.env.DISCORD_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) throw new Error('DISCORD_OAUTH_CONFIG_MISSING_FOR_REFRESH');
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: session.discordRefreshToken });
  const response = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!response.ok) {
    let payload = {};
    try { payload = await response.json(); } catch {}
    throw new Error('DISCORD_REFRESH_' + response.status + '_' + (typeof payload.error === 'string' ? payload.error : 'unknown'));
  }
  const token = await response.json();
  session.discordAccessToken = token.access_token;
  session.discordTokenExpiresAt = Date.now() + (Number(token.expires_in) || 604800) * 1000;
  if (token.refresh_token) session.discordRefreshToken = token.refresh_token;
  return session.discordAccessToken;
}
function discordLoginErrorMessage(error) {
  const message = typeof error === 'string' ? error : String(error?.message || '');
  if (message === 'DISCORD_OAUTH_CONFIG_MISSING') {
    return 'Thiếu DISCORD_CLIENT_ID hoặc DISCORD_CLIENT_SECRET trong Environment của Render.';
  }
  if (message.startsWith('DISCORD_TOKEN_EXCHANGE_')) {
    if (message.includes('_invalid_client')) {
      return 'Discord từ chối OAuth Client ID/Secret. Kiểm tra DISCORD_CLIENT_ID và DISCORD_CLIENT_SECRET có thuộc cùng một ứng dụng trong Discord Developer Portal, rồi redeploy.';
    }
    if (message.includes('_invalid_grant')) {
      return 'Mã đăng nhập không còn hợp lệ hoặc Redirect URI không khớp. Hãy bắt đầu đăng nhập mới và kiểm tra Redirect URI trùng chính xác với URL callback trên Render.';
    }
    return 'Discord không chấp nhận mã OAuth. Kiểm tra Client ID/Secret và Redirect URI trong Discord Developer Portal và Render.';
  }
  if (message.startsWith('DISCORD_API_401_')) {
    return 'Discord đã từ chối access token. Hãy thử đăng nhập lại; nếu vẫn lỗi, kiểm tra cấu hình OAuth của ứng dụng.';
  }
  if (message.startsWith('DISCORD_API_403_')) {
    return 'Discord từ chối quyền truy cập hồ sơ. Hãy thử đăng nhập lại và chấp thuận các quyền identify, guilds.';
  }
  return 'Lỗi xử lý Discord OAuth. Kiểm tra Logs của Render để xem mã lỗi an toàn (không chia sẻ token hoặc secret).';
}

app.get('/auth/discord', async (req, res) => {
  if (!process.env.DISCORD_CLIENT_ID) return res.status(503).send('Discord OAuth is not configured. Add DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET.');
  const state = encodeState();
  const existingSid = getCookieValue(req, SESSION_COOKIE);
  try {
    await storeOAuthState(state, { provider: 'discord', createdAt: Date.now(), existingSid });
    setOAuthStateCookie(res, state);
    const url = new URL('https://discord.com/oauth2/authorize');
    url.searchParams.set('client_id', process.env.DISCORD_CLIENT_ID);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', SITE_URL + '/auth/discord/callback');
    url.searchParams.set('scope', 'identify guilds');
    url.searchParams.set('state', state);
    return res.redirect(url.toString());
  } catch (error) {
    console.error('Could not create Discord OAuth state:', error);
    return res.status(503).send('Không tạo được phiên đăng nhập Discord. Hãy thử lại sau.');
  }
});
app.get('/auth/discord/callback', async (req, res) => {
  const stateKey = typeof req.query.state === 'string' ? req.query.state : '';
  try {
    const cookieMatches = hasOAuthStateCookie(req, stateKey);
    clearOAuthStateCookie(res, stateKey);
    if (!cookieMatches) {
      console.warn('Discord OAuth state cookie missing or mismatched; verify callback hostname and browser cookie settings.');
      return res.status(400).send('Phiên OAuth không khớp cookie của trình duyệt. Hãy mở dashboard ở đúng địa chỉ https://aki-discord-control-6yfp.onrender.com, đóng tab đăng nhập Discord cũ rồi thử lại.');
    }
    const state = await consumeOAuthState(stateKey);
    if (!state || state.provider !== 'discord' || Date.now() - state.createdAt > 10 * 60_000) {
      console.warn('Discord OAuth state missing, wrong provider, or expired in state store.');
      return res.status(400).send('Phiên đăng nhập đã hết hạn hoặc Render không tìm thấy state. Hãy thử lại từ trang chủ; nếu tiếp tục, kiểm tra DATABASE_URL trên Render.');
    }
    if (req.query.error) return res.status(400).send('Bạn đã huỷ đăng nhập Discord. Hãy quay lại trang chủ để thử lại.');
    if (typeof req.query.code !== 'string' || !req.query.code) return res.status(400).send('Discord không trả về mã đăng nhập. Hãy thử đăng nhập lại.');
    const token = await discordOAuthCallback(req.query.code);
    const user = await discordApi('/users/@me', token.access_token);
    const guilds = await discordApi('/users/@me/guilds', token.access_token);
    const linkedUser = state.existingSid ? sessionStore.get(state.existingSid) : null;
    let sid = state.existingSid;
    if (linkedUser) {
      linkedUser.user = { ...linkedUser.user, provider: 'discord', discordId: user.id, id: user.id, username: user.global_name || user.username, avatar: user.avatar, discriminator: user.discriminator, googleLinked: linkedUser.user.provider === 'google' || linkedUser.user.googleLinked };
      linkedUser.guilds = guilds;
      linkedUser.lastSeen = Date.now();
    } else {
      sid = makeSession({ provider: 'discord', id: user.id, discordId: user.id, username: user.global_name || user.username, avatar: user.avatar, discriminator: user.discriminator }, guilds);
    }
    const activeSession = sessionStore.get(sid);
    if (activeSession) {
      activeSession.discordAccessToken = token.access_token;
      activeSession.discordRefreshToken = token.refresh_token || null;
      activeSession.discordTokenExpiresAt = Date.now() + (Number(token.expires_in) || 604800) * 1000;
    }
    setSessionCookie(res, sid);
    return res.redirect('/dashboard');
  } catch (error) {
    const errorCode = String(error?.message || 'UNKNOWN_DISCORD_OAUTH_ERROR');
    console.error('Discord OAuth callback failed:', errorCode);
    return res.status(500).send(discordLoginErrorMessage(errorCode));
  }
});

app.get('/auth/google', async (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(503).send('Google OAuth is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
  const state = encodeState();
  try {
    await storeOAuthState(state, { provider: 'google', createdAt: Date.now(), existingSid: null });
    setOAuthStateCookie(res, state);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
    url.searchParams.set('redirect_uri', SITE_URL + '/auth/google/callback');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('state', state);
    url.searchParams.set('access_type', 'online');
    url.searchParams.set('prompt', 'select_account');
    return res.redirect(url.toString());
  } catch (error) {
    console.error('Could not create Google OAuth state:', error);
    return res.status(503).send('Không tạo được phiên đăng nhập Google. Hãy thử lại sau.');
  }
});
app.get('/auth/google/callback', async (req, res) => {
  const stateKey = typeof req.query.state === 'string' ? req.query.state : '';
  try {
    const cookieMatches = hasOAuthStateCookie(req, stateKey);
    clearOAuthStateCookie(res, stateKey);
    if (!cookieMatches) {
      console.warn('Google OAuth state cookie missing or mismatched; verify callback hostname and browser cookie settings.');
      return res.status(400).send('Phiên OAuth không khớp cookie trình duyệt. Hãy mở dashboard ở đúng địa chỉ rồi thử đăng nhập Google lại.');
    }
    const state = await consumeOAuthState(stateKey);
    if (!state || state.provider !== 'google' || Date.now() - state.createdAt > 10 * 60_000) {
      console.warn('Google OAuth state missing, wrong provider, or expired in state store.');
      return res.status(400).send('Phiên đăng nhập đã hết hạn hoặc state không được lưu. Hãy thử lại và kiểm tra DATABASE_URL trên Render.');
    }
    if (req.query.error) return res.status(400).send('Bạn đã huỷ đăng nhập Google. Hãy quay lại trang chủ để thử lại.');
    if (typeof req.query.code !== 'string' || !req.query.code) return res.status(400).send('Google không trả về mã đăng nhập. Hãy thử đăng nhập lại.');
    const body = new URLSearchParams({
      code: req.query.code,
      client_id: process.env.GOOGLE_CLIENT_ID || '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      redirect_uri: SITE_URL + '/auth/google/callback',
      grant_type: 'authorization_code'
    });
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (!tokenRes.ok) throw new Error('Google token exchange failed (' + tokenRes.status + ')');
    const token = await tokenRes.json();
    const userRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: 'Bearer ' + token.access_token } });
    if (!userRes.ok) throw new Error('Google userinfo failed (' + userRes.status + ')');
    const user = await userRes.json();
    const sid = makeSession({ provider: 'google', id: user.sub, username: user.name || user.email, email: user.email, avatar: user.picture }, []);
    setSessionCookie(res, sid);
    return res.redirect('/dashboard');
  } catch (error) {
    console.error('Google OAuth callback failed:', error);
    return res.status(500).send('Google login failed. Check OAuth redirect URL and credentials.');
  }
});

app.get('/auth/logout', (req, res) => {
  const sid = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`${SESSION_COOKIE}=`))?.split('=')[1];
  if (sid) sessionStore.delete(sid);
  clearSessionCookie(res);
  res.redirect('/');
});

const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ],
  allowedMentions: { parse: ['users', 'roles'] }
});

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Kiểm tra độ trễ bot.'),
  new SlashCommandBuilder().setName('help').setDescription('Hiện danh sách tính năng.'),
  new SlashCommandBuilder().setName('server').setDescription('Thông tin máy chủ.'),
  new SlashCommandBuilder().setName('userinfo').setDescription('Thông tin một thành viên.').addUserOption(o => o.setName('user').setDescription('Thành viên').setRequired(false)),
  new SlashCommandBuilder().setName('avatar').setDescription('Xem avatar.').addUserOption(o => o.setName('user').setDescription('Thành viên').setRequired(false)),
  new SlashCommandBuilder().setName('botinfo').setDescription('Thông tin bot.'),
  new SlashCommandBuilder().setName('poll').setDescription('Tạo poll 2–4 lựa chọn.')
    .addStringOption(o => o.setName('question').setDescription('Câu hỏi').setRequired(true))
    .addStringOption(o => o.setName('option1').setDescription('Lựa chọn 1').setRequired(true))
    .addStringOption(o => o.setName('option2').setDescription('Lựa chọn 2').setRequired(true))
    .addStringOption(o => o.setName('option3').setDescription('Lựa chọn 3').setRequired(false))
    .addStringOption(o => o.setName('option4').setDescription('Lựa chọn 4').setRequired(false)),
  new SlashCommandBuilder().setName('8ball').setDescription('Hỏi quả cầu tiên tri.').addStringOption(o => o.setName('question').setDescription('Câu hỏi').setRequired(true)),
  new SlashCommandBuilder().setName('roll').setDescription('Tung xúc xắc.').addIntegerOption(o => o.setName('sides').setDescription('Số mặt (2–1000)').setMinValue(2).setMaxValue(1000).setRequired(false)),
  new SlashCommandBuilder().setName('coinflip').setDescription('Tung đồng xu.'),
  new SlashCommandBuilder().setName('remind').setDescription('Đặt lời nhắc theo giây.').addIntegerOption(o => o.setName('seconds').setDescription('Số giây').setMinValue(5).setMaxValue(604800).setRequired(true)).addStringOption(o => o.setName('text').setDescription('Nội dung').setRequired(true)),
  new SlashCommandBuilder().setName('afk').setDescription('Bật AFK + ảnh/GIF tuỳ chọn.').addStringOption(o => o.setName('reason').setDescription('Lý do').setMaxLength(1000).setRequired(false)).addStringOption(o => o.setName('image_url').setDescription('URL ảnh/GIF (https://...)').setMaxLength(2048).setRequired(false)).addAttachmentOption(o => o.setName('media').setDescription('Upload ảnh/GIF trực tiếp').setRequired(false)),
  new SlashCommandBuilder().setName('warn').setDescription('Cảnh cáo thành viên.').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers.toString()).addUserOption(o => o.setName('user').setDescription('Thành viên').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Lý do').setRequired(true)),
  new SlashCommandBuilder().setName('warnings').setDescription('Xem cảnh cáo.').addUserOption(o => o.setName('user').setDescription('Thành viên').setRequired(true)),
  new SlashCommandBuilder().setName('clear').setDescription('Xoá tin nhắn gần nhất.').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString()).addIntegerOption(o => o.setName('amount').setDescription('1–100').setMinValue(1).setMaxValue(100).setRequired(true)),
  new SlashCommandBuilder().setName('slowmode').setDescription('Đặt slowmode.').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels.toString()).addIntegerOption(o => o.setName('seconds').setDescription('0–21600 giây').setMinValue(0).setMaxValue(21600).setRequired(true)),
  new SlashCommandBuilder().setName('lock').setDescription('Khoá kênh hiện tại.').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels.toString()),
  new SlashCommandBuilder().setName('unlock').setDescription('Mở khoá kênh hiện tại.').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels.toString()),
  new SlashCommandBuilder().setName('kick').setDescription('Kick thành viên.').setDefaultMemberPermissions(PermissionFlagsBits.KickMembers.toString()).addUserOption(o => o.setName('user').setDescription('Thành viên').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Lý do').setRequired(false)),
  new SlashCommandBuilder().setName('ban').setDescription('Ban thành viên.').setDefaultMemberPermissions(PermissionFlagsBits.BanMembers.toString()).addUserOption(o => o.setName('user').setDescription('Thành viên').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Lý do').setRequired(false)),
  new SlashCommandBuilder().setName('timeout').setDescription('Timeout thành viên.').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers.toString()).addUserOption(o => o.setName('user').setDescription('Thành viên').setRequired(true)).addIntegerOption(o => o.setName('minutes').setDescription('1–40320 phút').setMinValue(1).setMaxValue(40320).setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Lý do').setRequired(false)),
  new SlashCommandBuilder().setName('role').setDescription('Thêm/gỡ role.').setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles.toString()).addStringOption(o => o.setName('mode').setDescription('add hoặc remove').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' })).addUserOption(o => o.setName('user').setDescription('Thành viên').setRequired(true)).addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)),
  new SlashCommandBuilder().setName('legit').setDescription('Đánh dấu thành viên đã được staff xác minh.').setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles.toString()).addUserOption(o => o.setName('user').setDescription('Thành viên được xác minh').setRequired(true)),
  new SlashCommandBuilder().setName('ticket-setup').setDescription('Đăng bảng mở ticket hỗ trợ.').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels.toString()).addChannelOption(o => o.setName('channel').setDescription('Kênh đăng bảng ticket').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(false)),
  new SlashCommandBuilder().setName('role-panel').setDescription('Đăng bảng tự nhận role bằng nút emoji.').setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles.toString()).addChannelOption(o => o.setName('channel').setDescription('Kênh đăng bảng role').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(false)),
  new SlashCommandBuilder().setName('announce').setDescription('Đăng thông báo đẹp.').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString()).addStringOption(o => o.setName('message').setDescription('Nội dung').setRequired(true)),
  new SlashCommandBuilder().setName('vc-join').setDescription('Bot vào voice.').setDefaultMemberPermissions(PermissionFlagsBits.Connect.toString()).addChannelOption(o => o.setName('channel').setDescription('Kênh voice').addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice).setRequired(true)),
  new SlashCommandBuilder().setName('vc-leave').setDescription('Bot rời voice.').setDefaultMemberPermissions(PermissionFlagsBits.Connect.toString()),
  new SlashCommandBuilder().setName('auto-voice').setDescription('Bật/tắt tự động giữ voice.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString()).addBooleanOption(o => o.setName('enabled').setDescription('Bật hoặc tắt').setRequired(true)).addChannelOption(o => o.setName('channel').setDescription('Kênh voice').addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice).setRequired(false))
].map(c => c.toJSON());

const helpLines = [
  ['ping', 'Kiểm tra latency'], ['server', 'Thông tin server'], ['userinfo', 'Thông tin user'], ['avatar', 'Avatar'], ['botinfo', 'Thông tin bot'],
  ['poll', 'Tạo bình chọn'], ['8ball', 'Quả cầu tiên tri'], ['roll', 'Xúc xắc'], ['coinflip', 'Đồng xu'], ['remind', 'Nhắc việc'],
  ['afk', 'AFK + ảnh/GIF riêng'], ['warn', 'Cảnh cáo'], ['warnings', 'Lịch sử cảnh cáo'], ['clear', 'Xoá tin nhắn'], ['slowmode', 'Slowmode'],
  ['lock', 'Khoá kênh'], ['unlock', 'Mở khoá'], ['kick', 'Kick'], ['ban', 'Ban'], ['timeout', 'Timeout'], ['role', 'Quản lý role'],
  ['announce', 'Thông báo'], ['vc-join', 'Vào voice'], ['vc-leave', 'Rời voice'], ['auto-voice', 'Tự động giữ voice']
];

const magic8 = [
  'Khả năng cao là có.', 'Không nên trông chờ vào nó.', 'Chắc chắn rồi.', 'Chưa thể nói trước.', 'Cứ thử đi.', 'Tui nghi là không.', 'Dấu hiệu khá tích cực.', 'Hỏi lại sau nhé.'
];
const reply = (content, extra = {}) => ({ content, ...extra });
const embedPayload = embed => ({ embeds: [embed] });

function webMemberCan(guild, userId, permission) {
  const raw = guild?.members?.cache?.get(userId);
  if (!raw) return false;
  if (raw.id === guild.ownerId) return true;
  return raw.permissions.has(permission);
}
async function fetchGuildMember(guild, userId) {
  try { return await guild.members.fetch(userId); } catch { return null; }
}
function ensureMemberPermission(member, permission) {
  if (!member) throw new Error('Không xác định được thành viên điều khiển.');
  if (member.id === member.guild.ownerId || member.permissions.has(permission)) return;
  throw new Error(`Bạn cần quyền **${new PermissionsBitField(permission).toArray().join(', ')}** để dùng tính năng này.`);
}

async function joinGuildVoice(guild, channelId, source = 'manual') {
  const channel = await guild.channels.fetch(channelId);
  if (!channel || ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type)) throw new Error('Voice channel không hợp lệ.');
  const me = guild.members.me || await guild.members.fetchMe();
  if (!channel.joinable || !channel.permissionsFor(me)?.has(PermissionFlagsBits.Connect)) throw new Error('Bot không có quyền Connect vào voice này.');
  const connection = joinVoiceChannel({ guildId: guild.id, channelId: channel.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: true, selfMute: true });
  try { await entersState(connection, VoiceConnectionStatus.Ready, 15_000); }
  catch (error) { connection.destroy(); throw new Error(`Không kết nối được voice: ${error.message}`); }
  connection.__aki = { guildId: guild.id, channelId: channel.id, source };
  attachVoiceRecovery(guild, connection);
  await setConfig(guild.id, { auto_voice_channel_id: source === 'auto' ? channel.id : (await getConfig(guild.id)).auto_voice_channel_id });
  io.emit('bot-status', { type: 'voice', guildId: guild.id, channelId: channel.id, connected: true });
  return channel;
}

function attachVoiceRecovery(guild, connection) {
  if (connection.__akiRecoveryAttached) return;
  connection.__akiRecoveryAttached = true;
  connection.on(VoiceConnectionStatus.Disconnected, async (_, __) => {
    const meta = connection.__aki;
    if (!meta) return;
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
      ]);
    } catch {
      connection.destroy();
      const cfg = await getConfig(guild.id);
      if (cfg.auto_voice_enabled && cfg.auto_voice_channel_id === meta.channelId) {
        setTimeout(() => joinGuildVoice(guild, meta.channelId, 'auto').catch(e => console.error('Voice reconnect failed:', e.message)), 3_000);
      }
    }
  });
  connection.on(VoiceConnectionStatus.Destroyed, () => io.emit('bot-status', { type: 'voice', guildId: guild.id, connected: false }));
}

async function runCommand(name, ctx) {
  const { guild, userId, channel, args = {}, source = 'discord' } = ctx;
  const user = await fetchGuildMember(guild, userId);
  const userName = user?.displayName || ctx.userName || 'Unknown';
  const target = args.user ? await guild.members.fetch(args.user).catch(() => null) : null;
  switch (name) {
    case 'ping': {
      const ws = Math.round(bot.ws.ping);
      return reply('🏓 **Pong!** Gateway: `' + ws + 'ms`');
    }
    case 'help':
      return reply('🖤 **' + APP_NAME + ' Command Deck**\n' + helpLines.map(([n,d]) => '• `/' + n + '` — ' + d).join('\n'));
    case 'server':
      return embedPayload(new EmbedBuilder().setTitle(`◈ ${guild.name}`).setDescription(`Owner: <@${guild.ownerId}>\nMembers: ${guild.memberCount}\nChannels: ${guild.channels.cache.size}\nRoles: ${guild.roles.cache.size}`).addFields({ name: 'Server ID', value: guild.id, inline: true }, { name: 'Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true }).setTimestamp());
    case 'userinfo': {
      const m = target || user;
      if (!m) throw new Error('Không tìm thấy user.');
      const u = m.user;
      return embedPayload(new EmbedBuilder().setTitle(`◈ ${u.globalName || u.username}`).setThumbnail(u.displayAvatarURL({ size: 256 })).addFields({ name: 'ID', value: u.id, inline: true }, { name: 'Joined', value: m.joinedTimestamp ? `<t:${Math.floor(m.joinedTimestamp / 1000)}:R>` : '—', inline: true }, { name: 'Roles', value: `${Math.max(0, m.roles.cache.size - 1)}`, inline: true }).setTimestamp());
    }
    case 'avatar': {
      const m = target || user;
      return embedPayload(new EmbedBuilder().setTitle(`Avatar · ${m.user.globalName || m.user.username}`).setImage(m.user.displayAvatarURL({ size: 1024, extension: 'png' })).setFooter({ text: 'Aki Dev' }));
    }
    case 'botinfo':
      return embedPayload(new EmbedBuilder().setTitle('◈ Aki Dev Bot Core').setDescription('Monochrome Discord control system.').addFields({ name: 'Servers', value: `${bot.guilds.cache.size}`, inline: true }, { name: 'Commands', value: `${commands.length}`, inline: true }, { name: 'Latency', value: `${Math.round(bot.ws.ping)}ms`, inline: true }).setTimestamp());
    case 'poll': {
      const opts = [args.option1, args.option2, args.option3, args.option4].filter(Boolean);
      const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
      return embedPayload(new EmbedBuilder().setTitle(`◈ ${args.question}`).setDescription(opts.map((v, i) => `${emojis[i]} ${v}`).join('\n\n')).setFooter({ text: `Poll by ${userName}` }).setTimestamp());
    }
    case '8ball':
      return reply(`🎱 **${magic8[Math.floor(Math.random() * magic8.length)]}**`);
    case 'roll': {
      const sides = Math.min(1000, Math.max(2, Number(args.sides || 6)));
      return reply(`🎲 **${1 + Math.floor(Math.random() * sides)}** / ${sides}`);
    }
    case 'coinflip':
      return reply(`🪙 **${Math.random() < 0.5 ? 'Heads' : 'Tails'}**`);
    case 'remind': {
      const seconds = Number(args.seconds);
      if (!Number.isInteger(seconds) || seconds < 5 || seconds > 604800) throw new Error('seconds phải từ 5 đến 604800.');
      const executeAt = Date.now() + seconds * 1000;
      await scheduleReminder(guild.id, userId, channel.id, String(args.text), executeAt);
      if (!pool) setTimeout(() => channel.send(`<@${userId}> ⏰ **Nhắc bạn:** ${args.text}`), seconds * 1000);
      return reply(`⏰ Đã đặt nhắc trong **${seconds}s**.`);
    }
    case 'afk': {
      const media = args.media_url || args.image_url || null;
      const afk = await setAfk(guild.id, userId, args.reason, media);
      return afkPayload(user?.user || guild.client.users.cache.get(userId), afk);
    }
    case 'warn': {
      ensureMemberPermission(user, PermissionFlagsBits.ModerateMembers);
      if (!target) throw new Error('Không tìm thấy target.');
      if (target.id === guild.ownerId) throw new Error('Không thể cảnh cáo owner.');
      await addWarning(guild.id, target.id, userId, String(args.reason));
      const count = (await getWarnings(guild.id, target.id)).length;
      await target.send(`⚠️ Bạn vừa nhận cảnh cáo tại **${guild.name}**. Lý do: ${args.reason}`).catch(() => {});
      return reply(`⚠️ Đã cảnh cáo **${target.user.globalName || target.user.username}**. Tổng: **${count}**.`);
    }
    case 'warnings': {
      const m = target || user;
      const list = await getWarnings(guild.id, m.id);
      return reply(`📋 **Warnings · ${m.user.globalName || m.user.username}**\n${list.length ? list.map((w, i) => `${i + 1}. ${w.reason}`).join('\n') : 'Không có cảnh cáo.'}`);
    }
    case 'clear': {
      ensureMemberPermission(user, PermissionFlagsBits.ManageMessages);
      const amount = Number(args.amount);
      if (!channel?.bulkDelete) throw new Error('Lệnh này cần text channel.');
      const deleted = await channel.bulkDelete(amount, true);
      return reply(`🧹 Đã xoá **${deleted.size}** tin nhắn.`);
    }
    case 'slowmode': {
      ensureMemberPermission(user, PermissionFlagsBits.ManageChannels);
      if (!channel?.setRateLimitPerUser) throw new Error('Kênh hiện tại không hỗ trợ slowmode.');
      await channel.setRateLimitPerUser(Number(args.seconds), `Aki Dev by ${userName}`);
      return reply(`⏱️ Slowmode: **${args.seconds}s**.`);
    }
    case 'lock': {
      ensureMemberPermission(user, PermissionFlagsBits.ManageChannels);
      await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }, { reason: `Locked by ${userName}` });
      return reply('🔒 Kênh đã khoá.');
    }
    case 'unlock': {
      ensureMemberPermission(user, PermissionFlagsBits.ManageChannels);
      await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null }, { reason: `Unlocked by ${userName}` });
      return reply('🔓 Kênh đã mở khoá.');
    }
    case 'kick': {
      ensureMemberPermission(user, PermissionFlagsBits.KickMembers);
      if (!target) throw new Error('Không tìm thấy target.');
      if (!target.kickable) throw new Error('Bot không thể kick target này.');
      await target.kick(args.reason || 'No reason');
      return reply(`👢 Đã kick **${target.user.globalName || target.user.username}**.`);
    }
    case 'ban': {
      ensureMemberPermission(user, PermissionFlagsBits.BanMembers);
      if (!target) throw new Error('Không tìm thấy target.');
      if (!target.bannable) throw new Error('Bot không thể ban target này.');
      await target.ban({ reason: args.reason || 'No reason', deleteMessageSeconds: 0 });
      return reply(`⛔ Đã ban **${target.user.globalName || target.user.username}**.`);
    }
    case 'timeout': {
      ensureMemberPermission(user, PermissionFlagsBits.ModerateMembers);
      if (!target) throw new Error('Không tìm thấy target.');
      if (!target.moderatable) throw new Error('Bot không thể timeout target này.');
      await target.timeout(Number(args.minutes) * 60_000, args.reason || 'No reason');
      return reply(`⏳ Đã timeout **${target.user.globalName || target.user.username}** trong **${args.minutes} phút**.`);
    }
    case 'role': {
      ensureMemberPermission(user, PermissionFlagsBits.ManageRoles);
      if (!target || !args.role) throw new Error('Thiếu user hoặc role.');
      const role = await guild.roles.fetch(args.role);
      if (!role) throw new Error('Không tìm thấy role.');
      if (role.position >= guild.members.me.roles.highest.position) throw new Error('Role cần nằm dưới role cao nhất của bot.');
      if (args.mode === 'add') await target.roles.add(role); else await target.roles.remove(role);
      return reply(`🎛️ Đã **${args.mode === 'add' ? 'thêm' : 'gỡ'}** role <@&${role.id}> cho ${target}.`);
    }
    case 'announce': {
      ensureMemberPermission(user, PermissionFlagsBits.ManageMessages);
      return embedPayload(new EmbedBuilder().setTitle('◈ ANNOUNCEMENT').setDescription(String(args.message)).setFooter({ text: `${APP_NAME} · by Aki dev` }).setTimestamp());
    }
    case 'vc-join': {
      ensureMemberPermission(user, PermissionFlagsBits.Connect);
      const ch = await joinGuildVoice(guild, args.channel, 'manual');
      return reply(`🎧 Đã vào voice **${ch.name}**.`);
    }
    case 'vc-leave': {
      ensureMemberPermission(user, PermissionFlagsBits.Connect);
      const c = getVoiceConnection(guild.id);
      if (!c) return reply('🎧 Bot không ở voice.');
      c.destroy();
      return reply('🎧 Đã rời voice.');
    }
    case 'auto-voice': {
      ensureMemberPermission(user, PermissionFlagsBits.ManageGuild);
      if (args.enabled) {
        if (!args.channel) throw new Error('Khi bật auto-voice phải chọn channel.');
        await setConfig(guild.id, { auto_voice_enabled: true, auto_voice_channel_id: args.channel });
        await joinGuildVoice(guild, args.channel, 'auto');
        return reply(`♾️ Auto Voice **ON** · <#${args.channel}>`);
      }
      await setConfig(guild.id, { auto_voice_enabled: false });
      const c = getVoiceConnection(guild.id); c?.destroy();
      return reply('♾️ Auto Voice **OFF**.');
    }
    default: throw new Error('Command không tồn tại.');
  }
}

function extractInteractionArgs(interaction) {
  const getUserId = () => interaction.options.getUser('user')?.id;
  const out = {};
  if (['userinfo', 'avatar', 'warnings'].includes(interaction.commandName)) out.user = getUserId();
  if (['warn', 'kick', 'ban', 'timeout'].includes(interaction.commandName)) { out.user = getUserId(); }
  if (interaction.commandName === 'warn' || interaction.commandName === 'kick' || interaction.commandName === 'ban' || interaction.commandName === 'timeout') out.reason = interaction.options.getString('reason');
  if (interaction.commandName === 'timeout') out.minutes = interaction.options.getInteger('minutes');
  if (interaction.commandName === 'poll') for (const k of ['question','option1','option2','option3','option4']) out[k] = interaction.options.getString(k) || undefined;
  if (interaction.commandName === '8ball') out.question = interaction.options.getString('question');
  if (interaction.commandName === 'roll') out.sides = interaction.options.getInteger('sides');
  if (interaction.commandName === 'remind') { out.seconds = interaction.options.getInteger('seconds'); out.text = interaction.options.getString('text'); }
  if (interaction.commandName === 'afk') { out.reason = interaction.options.getString('reason') || undefined; out.media_url = interaction.options.getAttachment('media')?.url || interaction.options.getString('image_url') || undefined; }
  if (interaction.commandName === 'clear' || interaction.commandName === 'slowmode') out[interaction.commandName === 'clear' ? 'amount' : 'seconds'] = interaction.options.getInteger(interaction.commandName === 'clear' ? 'amount' : 'seconds');
  if (interaction.commandName === 'role') { out.mode = interaction.options.getString('mode'); out.user = getUserId(); out.role = interaction.options.getRole('role')?.id; }
  if (interaction.commandName === 'announce') out.message = interaction.options.getString('message');
  if (interaction.commandName === 'vc-join') out.channel = interaction.options.getChannel('channel')?.id;
  if (interaction.commandName === 'auto-voice') { out.enabled = interaction.options.getBoolean('enabled'); out.channel = interaction.options.getChannel('channel')?.id; }
  return out;
}

bot.on('ready', async () => {
  console.log(`Logged in as ${bot.user.tag}`);
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    if (process.env.DISCORD_GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(bot.user.id, process.env.DISCORD_GUILD_ID), { body: commands });
      console.log(`Registered ${commands.length} guild commands.`);
    } else {
      await rest.put(Routes.applicationCommands(bot.user.id), { body: commands });
      console.log(`Registered ${commands.length} global commands.`);
    }
  } catch (error) { console.error('Command registration failed:', error); }
  for (const guild of bot.guilds.cache.values()) {
    const cfg = await getConfig(guild.id);
    if (cfg.auto_voice_enabled && cfg.auto_voice_channel_id) joinGuildVoice(guild, cfg.auto_voice_channel_id, 'auto').catch(e => console.error(`Auto voice ${guild.id}:`, e.message));
  }
  io.emit('bot-status', { type: 'ready', user: { id: bot.user.id, tag: bot.user.tag }, guilds: bot.guilds.cache.size });
});

async function addPollReactions(message, count) {
  const emojis = ['1️⃣','2️⃣','3️⃣','4️⃣'];
  for (let i = 0; i < Math.min(count, emojis.length); i++) {
    try { await message.react(emojis[i]); } catch (error) { console.error('Poll reaction failed:', error.message); }
  }
}

bot.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() || !interaction.guildId) return;
  try {
    const payload = await runCommand(interaction.commandName, { guild: interaction.guild, userId: interaction.user.id, userName: interaction.user.globalName || interaction.user.username, channel: interaction.channel, args: extractInteractionArgs(interaction), source: 'discord' });
    await interaction.reply(payload);
    if (interaction.commandName === 'poll') { const sent = await interaction.fetchReply(); await addPollReactions(sent, [extractInteractionArgs(interaction).option1, extractInteractionArgs(interaction).option2, extractInteractionArgs(interaction).option3, extractInteractionArgs(interaction).option4].filter(Boolean).length); }
    await addActivity(interaction.guildId, interaction.user.id, `/${interaction.commandName}`, `✅ Slash command bởi ${interaction.user.globalName || interaction.user.username} tại #${interaction.channel?.name || 'unknown-channel'}.`);
  } catch (error) {
    const msg = `⚠️ ${error.message}`;
    if (interaction.replied || interaction.deferred) await interaction.followUp({ content: msg, ephemeral: true }); else await interaction.reply({ content: msg, ephemeral: true });
    addActivity(interaction.guildId, interaction.user.id, `error:/${interaction.commandName}`, `❌ Slash command thất bại bởi ${interaction.user.globalName || interaction.user.username}: ${error.message}`).catch(() => {});
  }
});

bot.on('messageCreate', async message => {
  if (!message.guild || message.author.bot) return;
  try {
    const afkAuthor = await getAfk(message.guild.id, message.author.id);
    if (afkAuthor) await clearAfk(message.guild.id, message.author.id).then(() => message.reply(`👋 Welcome back, **${message.author.globalName || message.author.username}**.`).catch(() => {}));
    const seenAfk = new Set();
    for (const mentioned of message.mentions.users.values()) {
      if (mentioned.bot || seenAfk.has(mentioned.id)) continue;
      seenAfk.add(mentioned.id);
      const afk = await getAfk(message.guild.id, mentioned.id);
      if (afk) await message.reply(afkPayload(mentioned, afk)).catch(() => {});
    }
    const cfg = await getConfig(message.guild.id);
    const prefix = cfg.prefix || '!';
    if (!message.content.startsWith(prefix)) return;
    const [name, ...parts] = message.content.slice(prefix.length).trim().split(/\s+/);
    if (!name || !commands.some(c => c.name === name)) return;
    const basicMap = {
      ping: {}, help: {}, server: {}, botinfo: {}, coinflip: {},
      '8ball': { question: parts.join(' ') }, roll: { sides: Number(parts[0]) || 6 }, remind: { seconds: Number(parts[0]), text: parts.slice(1).join(' ') },
      announce: { message: parts.join(' ') }, clear: { amount: Number(parts[0]) }, slowmode: { seconds: Number(parts[0]) }, lock: {}, unlock: {},
      'vc-leave': {}
    };
    if (name === 'afk') {
      const urlPart = parts.find(part => /^https?:\/\//i.test(part));
      const reason = parts.filter(part => part !== urlPart).join(' ').trim();
      basicMap.afk = { reason, media_url: urlPart };
    }
    if (!basicMap[name]) return;
    const payload = await runCommand(name, { guild: message.guild, userId: message.author.id, userName: message.member?.displayName, channel: message.channel, args: basicMap[name], source: 'prefix' });
    await message.reply(payload);
    await addActivity(message.guild.id, message.author.id, `!${name}`, `✅ Prefix command bởi ${message.member?.displayName || message.author.username} tại #${message.channel.name}.`);
  } catch (error) {
    await message.reply(`⚠️ ${error.message}`).catch(() => {});
    addActivity(message.guild.id, message.author.id, 'error:prefix', `❌ Prefix command thất bại bởi ${message.author.username}: ${error.message}`).catch(() => {});
  }
});

// Auto voice state recovery when Discord moves/disconnects the bot.
bot.on('guildMemberAdd', member => {
  addActivity(member.guild.id, member.id, 'member:join', `👋 ${member.user.globalName || member.user.username} đã tham gia server.`).catch(() => {});
});
bot.on('guildMemberRemove', member => {
  addActivity(member.guild.id, member.id, 'member:leave', `👋 ${member.user.globalName || member.user.username} đã rời server.`).catch(() => {});
});
bot.on('voiceStateUpdate', async (oldState, newState) => {
  if (!bot.user || newState.id !== bot.user.id) return;
  const cfg = await getConfig(newState.guild.id);
  if (cfg.auto_voice_enabled && cfg.auto_voice_channel_id && !newState.channelId) {
    setTimeout(() => joinGuildVoice(newState.guild, cfg.auto_voice_channel_id, 'auto').catch(() => {}), 4_000);
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'aki-discord-control', time: new Date().toISOString(), bot: bot.isReady() }));
app.get('/health', (_req, res) => res.status(200).send('OK'));

app.get('/api/me', async (req, res) => {
  const s = getSession(req);
  if (!s) return res.json({ authenticated: false });
  const accessToken = await getDiscordAccessTokenForSession(s).catch(error => {
    console.warn('Discord OAuth guild refresh token unavailable:', error.message);
    return null;
  });
  if (accessToken) {
    try { s.guilds = await discordApi('/users/@me/guilds', accessToken); }
    catch (error) { console.warn('Discord guild list refresh failed:', error.message); }
  }
  const userGuilds = s.guilds || [];
  const botGuildIds = new Set(bot.guilds.cache.keys());
  const canManageGuild = g => Boolean(g.owner) || (BigInt(g.permissions || '0') & (8n | 32n)) !== 0n;
  const manageableGuilds = userGuilds.filter(canManageGuild).map(g => ({
    id: g.id,
    name: g.name,
    icon: g.icon,
    owner: Boolean(g.owner),
    permissions: g.permissions,
    manageable: true,
    botPresent: botGuildIds.has(g.id)
  }));
  const guilds = userGuilds.filter(g => botGuildIds.has(g.id)).map(g => ({
    id: g.id, name: g.name, icon: g.icon, owner: Boolean(g.owner), permissions: g.permissions,
    manageable: canManageGuild(g), botPresent: true
  }));
  const botGuildsNotInUserList = [...bot.guilds.cache.values()]
    .filter(g => !userGuilds.some(ug => ug.id === g.id))
    .map(g => ({ id: g.id, name: g.name }));
  res.json({
    authenticated: true, user: s.user, guilds, manageableGuilds,
    guildDiagnostics: {
      discordGuildCount: userGuilds.length,
      botGuildCount: bot.guilds.cache.size,
      sharedGuildCount: guilds.length,
      manageableGuildCount: manageableGuilds.length,
      manageableMissingBotCount: manageableGuilds.filter(g => !g.botPresent).length,
      botGuildsNotInUserList,
      botReady: bot.isReady()
    },
    bot: { ready: bot.isReady(), id: bot.user?.id || null, tag: bot.user?.tag || null, guilds: bot.guilds.cache.size, ping: Math.round(bot.ws.ping) }
  });
});
app.get('/api/activity', requireAuth, async (req, res) => {
  const allowed = new Set((req.session.guilds || []).filter(g => bot.guilds.cache.has(g.id) && canManageGuildFromOAuthMeta(g)).map(g => g.id));
  if (pool) {
    const r = await dbQuery('SELECT guild_id,user_id,action,details,created_at FROM activity WHERE guild_id = ANY($1) ORDER BY created_at DESC LIMIT 30', [[...allowed]]);
    return res.json({ items: r.rows });
  }
  res.json({ items: activityCache.filter(x => !x.guild_id || allowed.has(x.guild_id)).slice(0, 30) });
});
app.get('/api/guilds/:guildId/channels', requireAuth, async (req, res) => {
  const g = bot.guilds.cache.get(req.params.guildId);
  if (!g) return res.status(404).json({ error: 'BOT_NOT_IN_GUILD' });
  const meta = (req.session.guilds || []).find(x => x.id === g.id);
  if (!canManageGuildFromOAuthMeta(meta)) return res.status(403).json({ error: 'NO_GUILD_PERMISSION' });
  await g.channels.fetch();
  res.json({ channels: [...g.channels.cache.values()].filter(c => [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(c.type)).sort((a,b) => a.position-b.position).map(c => ({ id: c.id, name: c.name, type: c.type })) });
});
app.get('/api/guilds/:guildId/config', requireAuth, async (req, res) => {
  const g = bot.guilds.cache.get(req.params.guildId);
  const meta = (req.session.guilds || []).find(x => x.id === req.params.guildId);
  if (!g || !canManageGuildFromOAuthMeta(meta)) return res.status(403).json({ error: 'NO_GUILD_PERMISSION' });
  res.json({ config: await getConfig(g.id), stats: { members: g.memberCount, channels: g.channels.cache.size, roles: g.roles.cache.size, emojis: g.emojis.cache.size, ping: Math.round(bot.ws.ping) } });
});

function canManageGuildFromOAuthMeta(meta) {
  if (!meta) return false;
  if (Boolean(meta.owner)) return true;
  try { return (BigInt(meta.permissions || '0') & (8n | 32n)) !== 0n; }
  catch { return false; }
}

setupActivitySocketAuth();

async function requireGuildControl(req, res) {
  const guild = bot.guilds.cache.get(req.params.guildId);
  const meta = (req.session.guilds || []).find(x => x.id === req.params.guildId);
  if (!guild || !meta) throw Object.assign(new Error('Bot chưa có trong server này hoặc tài khoản Discord không có trong server.'), { status: 404 });
  if (!canManageGuildFromOAuthMeta(meta)) throw Object.assign(new Error('Bạn cần quyền Manage Server hoặc Administrator.'), { status: 403 });
  return { guild, meta: { ...meta, manageable: true } };
}

app.put('/api/guilds/:guildId/config', requireAuth, async (req, res) => {
  try {
    const { guild } = await requireGuildControl(req, res);
    const body = req.body || {};
    const currentConfig = await getConfig(guild.id);
    const voiceSettingsProvided = Object.prototype.hasOwnProperty.call(body, 'auto_voice_enabled') || Object.prototype.hasOwnProperty.call(body, 'auto_voice_channel_id');
    const nextAutoVoiceEnabled = Object.prototype.hasOwnProperty.call(body, 'auto_voice_enabled') ? Boolean(body.auto_voice_enabled) : Boolean(currentConfig.auto_voice_enabled);
    const nextAutoVoiceChannelId = Object.prototype.hasOwnProperty.call(body, 'auto_voice_channel_id') ? (body.auto_voice_channel_id || null) : (currentConfig.auto_voice_channel_id || null);
    if (nextAutoVoiceEnabled && !nextAutoVoiceChannelId) return res.status(400).json({ error: 'AUTO_VOICE_CHANNEL_REQUIRED' });
    if (nextAutoVoiceChannelId) {
      const ch = await guild.channels.fetch(nextAutoVoiceChannelId).catch(() => null);
      if (!ch || ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(ch.type)) return res.status(400).json({ error: 'VOICE_CHANNEL_INVALID' });
    }
    if (body.log_channel_id) {
      const logChannel = await guild.channels.fetch(String(body.log_channel_id)).catch(() => null);
      if (!logChannel || !logChannel.isTextBased?.() || logChannel.guild?.id !== guild.id) return res.status(400).json({ error: 'LOG_CHANNEL_INVALID' });
      const me = guild.members.me || await guild.members.fetchMe();
      if (!logChannel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) return res.status(403).json({ error: 'Bot needs View Channel, Send Messages and Embed Links in the selected audit channel.' });
    }
    const configPatch = {
      auto_voice_enabled: nextAutoVoiceEnabled,
      auto_voice_channel_id: nextAutoVoiceChannelId,
      prefix: Object.prototype.hasOwnProperty.call(body, 'prefix') ? String(body.prefix || '!').slice(0, 3) : currentConfig.prefix || '!',
      log_channel_id: Object.prototype.hasOwnProperty.call(body, 'log_channel_id') ? (body.log_channel_id || null) : currentConfig.log_channel_id || null
    };
    const config = await setConfig(guild.id, configPatch);
    if (voiceSettingsProvided) {
      if (config.auto_voice_enabled) await joinGuildVoice(guild, config.auto_voice_channel_id, 'auto');
      else getVoiceConnection(guild.id)?.destroy();
    }
    await addActivity(guild.id, req.session.user.id, 'settings', JSON.stringify(config));
    res.json({ config });
  } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});

app.get('/api/guilds/:guildId/afk', requireAuth, async (req, res) => {
  try {
    const guild = bot.guilds.cache.get(req.params.guildId);
    const meta = (req.session.guilds || []).find(x => x.id === req.params.guildId);
    if (!guild || !meta) return res.status(404).json({ error: 'BOT_NOT_IN_GUILD' });
    const userId = req.session.user.discordId || (req.session.user.provider === 'discord' ? req.session.user.id : null);
    if (!userId) return res.status(409).json({ error: 'DISCORD_LINK_REQUIRED' });
    const afk = await getAfk(guild.id, userId);
    res.json({ active: Boolean(afk), afk });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/guilds/:guildId/afk', requireAuth, async (req, res) => {
  try {
    const guild = bot.guilds.cache.get(req.params.guildId);
    const meta = (req.session.guilds || []).find(x => x.id === req.params.guildId);
    if (!guild || !meta) return res.status(404).json({ error: 'BOT_NOT_IN_GUILD' });
    const userId = req.session.user.discordId || (req.session.user.provider === 'discord' ? req.session.user.id : null);
    if (!userId) return res.status(409).json({ error: 'DISCORD_LINK_REQUIRED' });
    const { reason = '', media_url = '' } = req.body || {};
    const afk = await setAfk(guild.id, userId, reason, media_url || null);
    await addActivity(guild.id, userId, 'web:afk', media_url ? 'AFK profile updated with media' : 'AFK profile updated');
    const profile = await guild.client.users.fetch(userId).catch(() => null);
    if (!profile) return res.json({ ok: true, afk });
    res.json({ ok: true, afk, preview: afkPayload(profile, afk) });
  } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});

app.delete('/api/guilds/:guildId/afk', requireAuth, async (req, res) => {
  try {
    const guild = bot.guilds.cache.get(req.params.guildId);
    const meta = (req.session.guilds || []).find(x => x.id === req.params.guildId);
    if (!guild || !meta) return res.status(404).json({ error: 'BOT_NOT_IN_GUILD' });
    const userId = req.session.user.discordId || (req.session.user.provider === 'discord' ? req.session.user.id : null);
    if (!userId) return res.status(409).json({ error: 'DISCORD_LINK_REQUIRED' });
    await clearAfk(guild.id, userId);
    await addActivity(guild.id, userId, 'web:afk:off', 'AFK cleared');
    res.json({ ok: true });
  } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});

app.post('/api/guilds/:guildId/command', requireAuth, async (req, res) => {
  try {
    const { guild } = await requireGuildControl(req, res);
    const name = String(req.body?.name || '').toLowerCase().replace(/^\//, '');
    if (!commands.some(c => c.name === name)) return res.status(400).json({ error: 'UNKNOWN_COMMAND' });
    const channel = req.body?.channelId ? await guild.channels.fetch(req.body.channelId).catch(() => null) : guild.channels.cache.find(c => c.isTextBased() && c.type !== ChannelType.GuildVoice);
    const args = req.body?.args || {};
    const payload = await runCommand(name, { guild, userId: req.session.user.provider === 'discord' ? req.session.user.id : guild.ownerId, userName: req.session.user.username, channel, args, source: 'web' });
    const sendable = channel?.isTextBased?.() && payload;
    let sent = null;
    if (sendable) sent = await channel.send(payload);
    if (sent && name === 'poll') await addPollReactions(sent, [args.option1,args.option2,args.option3,args.option4].filter(Boolean).length);
    await addActivity(guild.id, req.session.user.id, `web:${name}`, `✅ Chạy từ dashboard bởi ${req.session.user.username || 'user'} tại #${channel?.name || 'unknown-channel'}.`);
    res.json({ ok: true, command: name, payload: typeof payload === 'string' ? payload : 'embed', channelId: sent?.channelId || channel?.id || null, messageId: sent?.id || null });
  } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});

app.post('/api/guilds/:guildId/voice/join', requireAuth, async (req, res) => {
  try {
    const { guild } = await requireGuildControl(req, res);
    const member = await fetchGuildMember(guild, req.session.user.provider === 'discord' ? req.session.user.id : guild.ownerId);
    ensureMemberPermission(member, PermissionFlagsBits.ManageGuild);
    const ch = await joinGuildVoice(guild, req.body.channelId, 'manual');
    await addActivity(guild.id, req.session.user.id, 'voice:join', ch.name);
    res.json({ ok: true, channel: { id: ch.id, name: ch.name } });
  } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});
app.post('/api/guilds/:guildId/voice/leave', requireAuth, async (req, res) => {
  try {
    const { guild } = await requireGuildControl(req, res);
    const c = getVoiceConnection(guild.id);
    c?.destroy();
    await addActivity(guild.id, req.session.user.id, 'voice:leave', 'manual');
    res.json({ ok: true });
  } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});


app.post('/api/guilds/:guildId/server-builder', requireAuth, async (req, res) => {
  try {
    const { guild } = await requireGuildControl(req, res);
    const me = guild.members.me || await guild.members.fetchMe();
    if (!me.permissions.has(PermissionFlagsBits.ManageChannels) || !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return res.status(403).json({ error: 'Bot cần quyền Manage Channels và Manage Roles. Hãy cấp quyền lại cho bot rồi thử lại.' });
    }
    const preset = ['community', 'gaming', 'anime', 'market'].includes(req.body?.preset) ? req.body.preset : 'community';
    const topic = String(req.body?.topic || '').trim().slice(0, 180);
    const prefix = { community: '🌐', gaming: '🎮', anime: '🌸', market: '🛍️' }[preset];
    const templates = {
      community: { start: [['📜・nội-quy','Đọc nội quy và hướng dẫn.'],['👋・chào-mừng',topic || 'Chào mừng đến với cộng đồng!'],['🎭・nhận-role','Chọn role phù hợp.']], chat: [['💬・chat-chung','Trò chuyện cùng mọi người.'],['😂・meme','Chia sẻ meme vui vẻ.'],['📸・chia-sẻ','Ảnh, video và khoảnh khắc.'],['🤝・tìm-bạn','Kết bạn và tìm người chơi cùng.']], fun: [['🎲・bot-commands','Dùng lệnh bot tại đây.'],['🎵・chia-sẻ-nhạc','Chia sẻ bài hát yêu thích.']], voice: [['🔊・phòng-chung',''],['🎮・chơi-cùng-nhau',''],['🌙・chill-room','']], staff: [['🛡️・staff-chat','Kênh nội bộ của đội ngũ.'],['🧾・staff-log','Ghi chú và xử lý sự việc.']] },
      gaming: { start: [['📜・nội-quy','Đọc nội quy trước khi tham gia.'],['👋・chào-mừng',topic || 'Chào mừng game thủ!'],['🎭・nhận-role','Chọn game và role.']], chat: [['🎮・tìm-đồng-đội','Tìm party và teammate.'],['💬・chat-chung','Trò chuyện game thủ.'],['🏆・khoe-thành-tích','Chia sẻ rank và thành tích.'],['😂・meme-game','Meme game vui vẻ.']], fun: [['🤖・bot-commands','Dùng lệnh bot tại đây.'],['📣・thông-báo-game','Tin tức và sự kiện game.']], voice: [['🎧・party-1',''],['🎧・party-2',''],['🏆・ranked-team',''],['🌙・chill-room','']], staff: [['🛡️・staff-chat','Kênh nội bộ của đội ngũ.'],['🧾・staff-log','Ghi chú và xử lý sự việc.']] },
      anime: { start: [['📜・nội-quy','Đọc nội quy của hội.'],['🌸・chào-mừng',topic || 'Chào mừng đến với thế giới anime!'],['🎭・nhận-role','Chọn role và sở thích.']], chat: [['🍡・trò-chuyện','Tán gẫu cùng hội.'],['🎨・fan-art','Chia sẻ fan art.'],['🎬・anime-manga','Bàn luận anime và manga.'],['😂・meme-anime','Meme anime.']], fun: [['🤖・bot-commands','Dùng lệnh bot tại đây.'],['🎵・anime-music','Chia sẻ nhạc anime.']], voice: [['🎧・phòng-tám',''],['🌸・chill-room',''],['🎬・xem-cùng-nhau','']], staff: [['🛡️・staff-chat','Kênh nội bộ của đội ngũ.'],['🧾・staff-log','Ghi chú và xử lý sự việc.']] },
      market: { start: [['📜・nội-quy','Đọc quy định giao dịch.'],['👋・chào-mừng',topic || 'Chào mừng đến với khu giao dịch!'],['🎭・nhận-role','Chọn role cần thiết.']], chat: [['🛍️・chợ-chung','Trao đổi và giới thiệu sản phẩm.'],['📦・mua-bán','Đăng tin mua bán theo quy định.'],['🤝・tìm-đối-tác','Tìm đối tác và cộng tác.'],['⭐・đánh-giá','Chia sẻ đánh giá giao dịch.']], fun: [['🤖・bot-commands','Dùng lệnh bot tại đây.'],['📣・thông-báo','Thông báo từ đội ngũ.']], voice: [['🔊・phòng-chung',''],['🤝・tư-vấn','']], staff: [['🛡️・staff-chat','Kênh nội bộ của đội ngũ.'],['🧾・staff-log','Ghi chú và xử lý sự việc.']] }
    }[preset];
    const result = { preset, roles: [], categories: [], channels: [], skipped: [] };
    const roleSpecs = [
      { name: '🛡️ Moderator', color: 0x5865F2, permissions: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ViewAuditLog] },
      { name: '🆘 Support', color: 0x57F287, permissions: [PermissionFlagsBits.ManageMessages] },
      { name: '💎 VIP', color: 0xEB459E, permissions: [] },
      { name: '👥 Member', color: 0x99AAB5, permissions: [] }
    ];
    const roleMap = {};
    for (const spec of roleSpecs) {
      let role = guild.roles.cache.find(r => r.name === spec.name);
      const existed = Boolean(role);
      if (!role) role = await guild.roles.create({ name: spec.name, color: spec.color, permissions: spec.permissions, reason: 'Aki Server Builder template' });
      else result.skipped.push('role:' + spec.name);
      roleMap[spec.name] = role;
      result.roles.push({ name: role.name, created: !existed });
    }
    const everyone = guild.roles.everyone;
    const groups = [
      { key: 'start', name: '📌・BẮT ĐẦU', items: templates.start },
      { key: 'chat', name: prefix + '・CỘNG ĐỒNG', items: templates.chat },
      { key: 'fun', name: prefix + '・BOT & TIỆN ÍCH', items: templates.fun },
      { key: 'voice', name: '🔊・PHÒNG VOICE', items: templates.voice },
      { key: 'staff', name: '🛡️・ĐỘI NGŨ', items: templates.staff, private: true }
    ];
    for (const group of groups) {
      let category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === group.name);
      const existedCategory = Boolean(category);
      if (!category) category = await guild.channels.create({
        name: group.name, type: ChannelType.GuildCategory,
        permissionOverwrites: group.private ? [
          { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: roleMap['🛡️ Moderator'].id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
          { id: roleMap['🆘 Support'].id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
        ] : undefined,
        reason: 'Aki Server Builder template'
      });
      if (existedCategory) result.skipped.push('category:' + group.name);
      result.categories.push({ name: category.name, created: !existedCategory });
      for (const item of group.items) {
        const name = item[0], channelTopic = item[1];
        const type = group.key === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText;
        const existing = guild.channels.cache.find(c => c.name === name && c.type === type);
        if (existing) { result.skipped.push('channel:' + name); continue; }
        const channel = await guild.channels.create({
          name, type, parent: category.id,
          permissionOverwrites: group.private ? [
            { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: roleMap['🛡️ Moderator'].id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
            { id: roleMap['🆘 Support'].id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
          ] : undefined,
          topic: type === ChannelType.GuildText ? String(channelTopic || '').slice(0, 1024) || undefined : undefined,
          reason: 'Aki Server Builder template'
        });
        result.channels.push({ name: channel.name, type: type === ChannelType.GuildVoice ? 'voice' : 'text', category: category.name });
      }
    }
    await addActivity(guild.id, req.session.user.id, 'server-builder', JSON.stringify({ preset, roles: result.roles.length, categories: result.categories.length, channels: result.channels.length }));
    res.json({ ok: true, result });
  } catch (error) {
    console.error('Server Builder failed:', error);
    res.status(error.status || 500).json({ error: error.message || 'SERVER_BUILDER_FAILED' });
  }
});

app.get('/api/overview', requireAuth, async (req, res) => {
  res.json({
    name: APP_NAME,
    bot: { ready: bot.isReady(), guilds: bot.guilds.cache.size, ping: Math.round(bot.ws.ping), commands: commands.length },
    sessions: sessionStore.size,
    persistence: pool ? 'postgres' : 'memory'
  });
});

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const PUBLIC_INDEX = path.join(PUBLIC_DIR, 'index.html');
const PUBLIC_CSS = path.join(PUBLIC_DIR, 'style.css');
const PUBLIC_JS = path.join(PUBLIC_DIR, 'script.js');
const ROOT_INDEX = path.join(ROOT_DIR, 'index.html');
const ROOT_CSS = path.join(ROOT_DIR, 'style.css');
const ROOT_JS = path.join(ROOT_DIR, 'script.js');

// Use /public only when its complete frontend bundle exists.
// A partial /public folder must never make /style.css or /script.js fall through to index.html.
const PUBLIC_BUNDLE_READY = [PUBLIC_INDEX, PUBLIC_CSS, PUBLIC_JS].every(file => fs.existsSync(file) && fs.statSync(file).size > 64);
const WEB_DIR = PUBLIC_BUNDLE_READY ? PUBLIC_DIR : ROOT_DIR;
const INDEX_FILE = PUBLIC_BUNDLE_READY ? PUBLIC_INDEX : ROOT_INDEX;

// Explicit asset routes: CSS/JS must never be swallowed by the SPA fallback.
app.get('/style.css', (req, res, next) => {
  const file = PUBLIC_BUNDLE_READY ? PUBLIC_CSS : ROOT_CSS;
  if (fs.existsSync(file)) return res.sendFile(file);
  next();
});

app.get('/script.js', (req, res, next) => {
  const file = PUBLIC_BUNDLE_READY ? PUBLIC_JS : ROOT_JS;
  if (fs.existsSync(file)) return res.sendFile(file);
  next();
});

app.use(express.static(WEB_DIR, { extensions: ['html'] }));
app.get('/{*splat}', (req, res) => {
  const requested = String(req.path || '');
  if (/\.(?:css|js|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|mp3|wav|mp4)$/i.test(requested)) {
    return res.status(404).type('text/plain').send('Asset not found');
  }
  return res.sendFile(INDEX_FILE);
});

setInterval(() => {
  const now = Date.now();
  for (const [sid, session] of sessionStore) if (now - session.lastSeen > 7 * 24 * 60 * 60_000) sessionStore.delete(sid);
  for (const [state, obj] of oauthStateStore) if (now - obj.createdAt > 10 * 60_000) oauthStateStore.delete(state);
  if (pool) dbQuery('DELETE FROM oauth_states WHERE created_at < $1', [now - 10 * 60_000]).catch(error => console.error('OAuth state cleanup failed:', error.message));
}, 10 * 60_000);
setInterval(reminderTick, 10_000);

async function boot() {
  await initDb();
  server.listen(PORT, '0.0.0.0', () => console.log(`Aki Dev dashboard listening on 0.0.0.0:${PORT}`));
  if (process.env.DISCORD_TOKEN) {
    bot.login(process.env.DISCORD_TOKEN).catch(error => console.error('Discord login failed:', error.message));
  } else {
    console.warn('DISCORD_TOKEN missing. Web server is running, bot is disabled.');
  }
}
boot().catch(error => { console.error(error); process.exit(1); });
