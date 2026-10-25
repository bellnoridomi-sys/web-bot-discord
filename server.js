import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { normalizeReactionEmoji, isActiveReactionRolePanel, sanitizePollText, sanitizePollFooter, isRoleHigherThan } from './lib/role-utils.js';
import { isAllowedOrigin } from './lib/security-utils.js';
import { normalizeMediaUrl } from './lib/media-utils.js';
import { getLevelProgress, calculateMessageXp } from './lib/community-utils.js';
import { vouchDenialReason, formatAuditReason } from './lib/moderation-utils.js';
import { parseDuration } from './lib/duration-utils.js';
import { isOpenAkiTicket, parseAkiTicketTopic, ticketDeletionDelay, TICKET_RETENTION_MS, normalizeTicketType, ticketTypeLabel } from './lib/ticket-utils.js';
import { Server as SocketIOServer } from 'socket.io';
import pg from 'pg';
import {
  Client,
  Partials,
  GatewayIntentBits,
  PermissionFlagsBits,
  PermissionsBitField,
  ChannelType,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
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
const PORT = Number(process.env.PORT || 10000);
const isProd = process.env.NODE_ENV === 'production';
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const io = new SocketIOServer(server, { cors: { origin: SITE_URL, credentials: true } });
const APP_NAME = process.env.APP_NAME || 'Aki Dev';
const SESSION_COOKIE = 'aki_sid';
const INTERNAL_PREFIX = 'aki';
const LEGIT_TARGET_USER_ID = process.env.LEGIT_TARGET_USER_ID || '';

app.set('trust proxy', 1);
app.use(helmet({ crossOriginEmbedderPolicy: false, contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
  imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
  connectSrc: ["'self'", 'https://discord.com'], objectSrc: ["'none'"],
  baseUri: ["'self'"], frameAncestors: ["'self'"],
  formAction: ["'self'", 'https://discord.com', 'https://accounts.google.com']
} } }));
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(rateLimit({ windowMs: 60_000, limit: 160, standardHeaders: true, legacyHeaders: false }));
app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (!isAllowedOrigin(req.get('origin'), SITE_URL)) return res.status(403).json({ error: 'ORIGIN_NOT_ALLOWED' });
  next();
});

const sessionStore = new Map();
const oauthStateStore = new Map();
const activityCache = [];
const xpCooldowns = new Map();
const runtimeErrorCooldowns = new Map();
const memoryReminderCounts = new Map();
const memoryReminderTimers = new Map();
let nextMemoryReminderId = 1;
const voiceReconnectTimers = new Map();
const memory = {
  configs: new Map(),
  warnings: new Map(),
  afk: new Map(),
  reactionRolePanels: new Map(),
  reactionRoleBindings: new Map(),
  communityProfiles: new Map(),
  moderationCases: [],
  vouches: new Map(),
  scamBlacklist: new Map(),
  tempBans: new Map(),
  reminders: []
};

const databaseHost = (() => { try { return new URL(process.env.DATABASE_URL || '').hostname; } catch { return ''; } })();
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: ['localhost', '127.0.0.1', '::1'].includes(databaseHost) || process.env.PGSSL_MODE === 'disable'
        ? false : { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false' },
      max: 4, idleTimeoutMillis: 10_000
    })
  : null;

async function dbQuery(text, params = []) {
  if (!pool) return null;
  return pool.query(text, params);
}

async function initDb() {
  if (!pool) return;
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  const migrationDir = new URL('./migrations/', import.meta.url);
  const migrations = fs.readdirSync(migrationDir).filter(name => /^\\d+_[a-z0-9_-]+\\.sql$/i.test(name)).sort();
  for (const version of migrations) {
    const existing = await dbQuery('SELECT 1 FROM schema_migrations WHERE version=$1', [version]);
    if (existing?.rowCount) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(new URL(version, migrationDir), 'utf8'));
      await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [version]);
      await client.query('COMMIT');
      console.log('Applied database migration:', version);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
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
    auto_role_id: null,
    welcome_channel_id: null,
    goodbye_channel_id: null
  });
  return memory.configs.get(guildId);
}

async function setConfig(guildId, patch) {
  const current = await getConfig(guildId);
  const next = { ...current, ...patch };
  if (pool) {
    await dbQuery(`
      INSERT INTO guild_configs(guild_id, auto_voice_enabled, auto_voice_channel_id, prefix, log_channel_id, auto_role_id, welcome_channel_id, goodbye_channel_id, updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW())
      ON CONFLICT(guild_id) DO UPDATE SET
        auto_voice_enabled=EXCLUDED.auto_voice_enabled,
        auto_voice_channel_id=EXCLUDED.auto_voice_channel_id,
        prefix=EXCLUDED.prefix,
        log_channel_id=EXCLUDED.log_channel_id,
        auto_role_id=EXCLUDED.auto_role_id,
        welcome_channel_id=EXCLUDED.welcome_channel_id,
        goodbye_channel_id=EXCLUDED.goodbye_channel_id,
        updated_at=NOW()
    `, [guildId, Boolean(next.auto_voice_enabled), next.auto_voice_channel_id || null, next.prefix || '!', next.log_channel_id || null, next.auto_role_id || null, next.welcome_channel_id || null, next.goodbye_channel_id || null]);
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


async function reportRuntimeError(error, source = 'runtime', guildId = null) {
  const text = String(error?.stack || error?.message || error || 'Unknown runtime error').slice(0, 3500);
  const message = String(error?.message || error || 'Unknown runtime error').slice(0, 500);
  const safeText = text.replace(/```/g, '``\u200b`').replace(/(token|secret|password)(\s*[:=]\s*)\S+/gi, '$1$2[REDACTED]').slice(0, 3800);
  console.error('[runtime-error]', source, guildId || 'global', text);
  const key = `${source}:${guildId || 'global'}:${message}`;
  const now = Date.now();
  if (now - (runtimeErrorCooldowns.get(key) || 0) < 30_000) return;
  runtimeErrorCooldowns.set(key, now);
  if (!bot.isReady()) return;
  const guilds = guildId
    ? [bot.guilds.cache.get(guildId)].filter(Boolean)
    : [...bot.guilds.cache.values()].slice(0, 25);
  for (const guild of guilds) {
    try {
      const config = await getConfig(guild.id).catch(() => null);
      if (!config?.log_channel_id) continue;
      const channel = await guild.channels.fetch(config.log_channel_id).catch(() => null);
      if (!channel?.isTextBased?.() || channel.guild?.id !== guild.id) continue;
      const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
      const permissions = me ? channel.permissionsFor(me) : null;
      if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) continue;
      const embed = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('🚨 Aki Runtime Error · ' + String(source).slice(0, 180))
        .setDescription('```text\n' + safeText + '\n```')
        .addFields({ name: 'Server', value: guild.name.slice(0, 100), inline: true }, { name: 'Time', value: `<t:${Math.floor(now / 1000)}:F>`, inline: true })
        .setFooter({ text: 'Automatic diagnostic log · do not share tokens/secrets' });
      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (logError) {
      console.warn('Could not deliver runtime error log:', logError?.message || logError);
    }
  }
}

async function addWarning(guildId, userId, moderatorId, reason) {
  if (pool) {
    await dbQuery('INSERT INTO warnings(guild_id,user_id,moderator_id,reason) VALUES($1,$2,$3,$4)', [guildId, userId, moderatorId, reason]);
  } else {
    const key = `${guildId}:${userId}`;
    const list = memory.warnings.get(key) || [];
    list.push({ id: Date.now(), guild_id: guildId, user_id: userId, moderator_id: moderatorId, reason, created_at: new Date().toISOString() });
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
async function scheduleTempBan(guildId, userId, moderatorId, reason, expiresAt) {
  const row = { guild_id: guildId, user_id: userId, moderator_id: moderatorId, reason: String(reason || '').slice(0, 1000), expires_at: Number(expiresAt), created_at: new Date().toISOString() };
  if (pool) {
    await dbQuery('INSERT INTO temp_bans(guild_id,user_id,moderator_id,reason,expires_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(guild_id,user_id) DO UPDATE SET moderator_id=EXCLUDED.moderator_id,reason=EXCLUDED.reason,expires_at=EXCLUDED.expires_at,created_at=NOW()', [guildId, userId, moderatorId, row.reason, row.expires_at]);
  } else memory.tempBans.set(guildId + ':' + userId, row);
}
async function removeTempBan(guildId, userId) {
  if (pool) await dbQuery('DELETE FROM temp_bans WHERE guild_id=$1 AND user_id=$2', [guildId, userId]);
  else memory.tempBans.delete(guildId + ':' + userId);
}
async function tempBanTick() {
  if (!bot.isReady()) return;
  const now = Date.now();
  let due = [];
  if (pool) {
    const result = await dbQuery('SELECT guild_id,user_id,moderator_id,reason,expires_at FROM temp_bans WHERE expires_at <= $1 ORDER BY expires_at LIMIT 25', [now]);
    due = result.rows;
  } else {
    due = [...memory.tempBans.values()].filter(row => isExpiryDue(row.expires_at, now));
  }
  for (const item of due) {
    const guild = bot.guilds.cache.get(item.guild_id);
    if (!guild) continue;
    try {
      await guild.members.unban(item.user_id, formatAuditReason('Aki Dev auto-unban', 'Temporary ban expired'));
      await removeTempBan(item.guild_id, item.user_id);
      await addModerationCase(item.guild_id, item.user_id, item.moderator_id, 'tempban-expired', 'Temporary ban expired at ' + new Date(Number(item.expires_at)).toISOString()).catch(() => {});
    } catch (error) {
      if (error?.code === 10026 || error?.status === 404) {
        await removeTempBan(item.guild_id, item.user_id).catch(() => {});
      } else {
        console.warn('Temporary unban failed:', { guildId: item.guild_id, error: error?.message || 'unknown error' });
      }
    }
  }
}
async function addModerationCase(guildId, targetId, moderatorId, action, reason) {
  const cleanReason = String(reason || 'No reason').slice(0, 1000);
  if (pool) {
    const result = await dbQuery('INSERT INTO moderation_cases(guild_id,target_user_id,moderator_id,action,reason) VALUES($1,$2,$3,$4,$5) RETURNING case_id,guild_id,target_user_id,moderator_id,action,reason,created_at', [guildId, targetId, moderatorId, action, cleanReason]);
    return result.rows[0];
  }
  const row = { case_id: memory.moderationCases.length + 1, guild_id: guildId, target_user_id: targetId, moderator_id: moderatorId, action, reason: cleanReason, created_at: new Date().toISOString() };
  memory.moderationCases.unshift(row);
  return row;
}
async function getModerationCase(guildId, caseId) {
  if (pool) {
    const result = await dbQuery('SELECT case_id,guild_id,target_user_id,moderator_id,action,reason,created_at FROM moderation_cases WHERE guild_id=$1 AND case_id=$2', [guildId, caseId]);
    return result.rows[0] || null;
  }
  return memory.moderationCases.find(row => row.guild_id === guildId && Number(row.case_id) === Number(caseId)) || null;
}
async function getModerationLog(guildId, targetId = null, limit = 10) {
  const safeLimit = Math.max(1, Math.min(25, Number(limit) || 10));
  if (pool) {
    const result = targetId
      ? await dbQuery('SELECT case_id,target_user_id,moderator_id,action,reason,created_at FROM moderation_cases WHERE guild_id=$1 AND target_user_id=$2 ORDER BY case_id DESC LIMIT $3', [guildId, targetId, safeLimit])
      : await dbQuery('SELECT case_id,target_user_id,moderator_id,action,reason,created_at FROM moderation_cases WHERE guild_id=$1 ORDER BY case_id DESC LIMIT $2', [guildId, safeLimit]);
    return result.rows;
  }
  return memory.moderationCases.filter(row => row.guild_id === guildId && (!targetId || row.target_user_id === targetId)).slice(0, safeLimit);
}
async function deleteWarning(guildId, warningId) {
  if (pool) {
    const result = await dbQuery('DELETE FROM warnings WHERE guild_id=$1 AND id=$2 RETURNING id,user_id,moderator_id,reason', [guildId, warningId]);
    return result.rows[0] || null;
  }
  for (const list of memory.warnings.values()) {
    const index = list.findIndex(row => row.guild_id === guildId && Number(row.id) === Number(warningId));
    if (index >= 0) return list.splice(index, 1)[0];
  }
  return null;
}
async function addVouch(guildId, authorId, targetId, message) {
  const denial = vouchDenialReason(authorId, targetId, false);
  if (denial) return { ok: false, reason: denial };
  const cleanMessage = String(message || '').trim().slice(0, 500);
  if (pool) {
    const result = await dbQuery('INSERT INTO vouches(guild_id,author_id,target_id,message) VALUES($1,$2,$3,$4) ON CONFLICT(guild_id,author_id,target_id) DO NOTHING RETURNING created_at', [guildId, authorId, targetId, cleanMessage]);
    if (!result.rowCount) return { ok: false, reason: 'duplicate-vouch' };
    return { ok: true, created_at: result.rows[0].created_at };
  }
  const key = guildId + ':' + authorId + ':' + targetId;
  if (memory.vouches.has(key)) return { ok: false, reason: 'duplicate-vouch' };
  const row = { guild_id: guildId, author_id: authorId, target_id: targetId, message: cleanMessage, created_at: new Date().toISOString() };
  memory.vouches.set(key, row);
  return { ok: true, created_at: row.created_at };
}
async function getVouches(guildId, targetId) {
  if (pool) {
    const rows = await dbQuery('SELECT author_id,target_id,message,created_at FROM vouches WHERE guild_id=$1 AND target_id=$2 ORDER BY created_at DESC LIMIT 10', [guildId, targetId]);
    const count = await dbQuery('SELECT COUNT(*)::int AS total FROM vouches WHERE guild_id=$1 AND target_id=$2', [guildId, targetId]);
    return { total: Number(count.rows[0]?.total || 0), rows: rows.rows };
  }
  const all = [...memory.vouches.values()].filter(row => row.guild_id === guildId && row.target_id === targetId).sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)));
  return { total: all.length, rows: all.slice(0, 10) };
}
async function addScamFlag(guildId, targetId, addedBy, reason) {
  const cleanReason = String(reason || '').trim().slice(0, 500);
  if (pool) {
    const result = await dbQuery('INSERT INTO scam_blacklist(guild_id,user_id,added_by,reason) VALUES($1,$2,$3,$4) ON CONFLICT(guild_id,user_id) DO UPDATE SET added_by=EXCLUDED.added_by,reason=EXCLUDED.reason,created_at=NOW() RETURNING user_id', [guildId, targetId, addedBy, cleanReason]);
    return result.rows[0];
  }
  const row = { guild_id: guildId, user_id: targetId, added_by: addedBy, reason: cleanReason, created_at: new Date().toISOString() };
  memory.scamBlacklist.set(guildId + ':' + targetId, row);
  return row;
}
async function checkScamFlag(guildId, targetId) {
  if (pool) {
    const result = await dbQuery('SELECT user_id,added_by,reason,created_at FROM scam_blacklist WHERE guild_id=$1 AND user_id=$2', [guildId, targetId]);
    return result.rows[0] || null;
  }
  return memory.scamBlacklist.get(guildId + ':' + targetId) || null;
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

const MAX_PENDING_REMINDERS_PER_USER = 10;
function reminderKey(guildId, userId) { return guildId + ':' + userId; }
async function scheduleReminder(guildId, userId, channelId, text, executeAt) {
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize quota checks for the same guild/user to prevent concurrent commands exceeding the limit.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [reminderKey(guildId, userId)]);
      const pending = await client.query('SELECT COUNT(*)::int AS count FROM reminders WHERE guild_id=$1 AND user_id=$2 AND done=FALSE', [guildId, userId]);
      if (Number(pending?.rows?.[0]?.count || 0) >= MAX_PENDING_REMINDERS_PER_USER) {
        throw new Error('Bạn chỉ được có tối đa ' + MAX_PENDING_REMINDERS_PER_USER + ' lời nhắc đang chờ trong server này.');
      }
      const inserted = await client.query('INSERT INTO reminders(guild_id,user_id,channel_id,text,execute_at) VALUES($1,$2,$3,$4,$5) RETURNING id', [guildId, userId, channelId, String(text || '').slice(0, 1000), executeAt]);
      await client.query('COMMIT');
      return Number(inserted.rows[0].id);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  const key = reminderKey(guildId, userId), count = memoryReminderCounts.get(key) || 0;
  if (count >= MAX_PENDING_REMINDERS_PER_USER) throw new Error('Bạn chỉ được có tối đa ' + MAX_PENDING_REMINDERS_PER_USER + ' lời nhắc đang chờ trong server này.');
  const id = nextMemoryReminderId++;
  memoryReminderCounts.set(key, count + 1);
  memory.reminders.push({ id, guild_id: guildId, user_id: userId, channel_id: channelId, text: String(text), execute_at: executeAt, done: false });
  return id;
}
function releaseMemoryReminder(guildId, userId) {
  const key = reminderKey(guildId, userId), count = memoryReminderCounts.get(key) || 0;
  if (count <= 1) memoryReminderCounts.delete(key); else memoryReminderCounts.set(key, count - 1);
}
async function listPendingReminders(guildId, userId) {
  if (pool) {
    const result = await dbQuery('SELECT id,text,channel_id,execute_at FROM reminders WHERE guild_id=$1 AND user_id=$2 AND done=FALSE ORDER BY execute_at LIMIT 10', [guildId, userId]);
    return result.rows;
  }
  return memory.reminders.filter(row => row.guild_id === guildId && row.user_id === userId && !row.done)
    .sort((a,b) => a.execute_at - b.execute_at).slice(0, 10);
}
async function cancelPendingReminder(guildId, userId, reminderId) {
  if (pool) {
    const result = await dbQuery('UPDATE reminders SET done=TRUE WHERE guild_id=$1 AND user_id=$2 AND id=$3 AND done=FALSE RETURNING id', [guildId, userId, reminderId]);
    return Boolean(result.rowCount);
  }
  const index = memory.reminders.findIndex(row => row.guild_id === guildId && row.user_id === userId && Number(row.id) === Number(reminderId) && !row.done);
  if (index < 0) return false;
  const [row] = memory.reminders.splice(index, 1);
  const timer = memoryReminderTimers.get(Number(reminderId));
  if (timer) clearTimeout(timer);
  memoryReminderTimers.delete(Number(reminderId));
  releaseMemoryReminder(row.guild_id, row.user_id);
  return true;
}

async function reminderTick() {
  if (!pool || !bot.isReady()) return;
  const r = await dbQuery('SELECT * FROM reminders WHERE done=false AND execute_at <= $1 ORDER BY execute_at LIMIT 20', [Date.now()]);
  for (const item of r.rows) {
    await dbQuery('UPDATE reminders SET done=true WHERE id=$1', [item.id]);
    try {
      const ch = await bot.channels.fetch(item.channel_id);
      if (ch?.isTextBased()) await ch.send({
        content: `<@${item.user_id}> ⏰ **Nhắc bạn:** ${item.text}`,
        allowedMentions: { parse: [], users: [item.user_id] }
      });
    } catch (error) {
      console.error('Reminder delivery failed:', error.message);
    }
  }
}

const XP_COOLDOWN_MS = 60_000;
const XP_PER_MESSAGE_MIN = 8;
const XP_PER_MESSAGE_MAX = 14;
const COINS_DAILY_AMOUNT = 100;
const COINS_WORK_MIN = 15;
const COINS_WORK_MAX = 60;
const DAILY_COOLDOWN_MS = 24 * 60 * 60_000;
const WORK_COOLDOWN_MS = 60 * 60_000;

async function ensureCommunityProfile(guildId, userId) {
  if (pool) {
    await dbQuery('INSERT INTO community_profiles(guild_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [guildId, userId]);
    const result = await dbQuery('SELECT guild_id,user_id,xp,level,coins,last_daily,last_work FROM community_profiles WHERE guild_id=$1 AND user_id=$2', [guildId, userId]);
    return result.rows[0];
  }
  const key = `${guildId}:${userId}`;
  if (!memory.communityProfiles.has(key)) memory.communityProfiles.set(key, { guild_id: guildId, user_id: userId, xp: 0, level: 0, coins: 0, last_daily: 0, last_work: 0 });
  return memory.communityProfiles.get(key);
}

async function awardCommunityXp(guildId, userId, amount) {
  const key = `${guildId}:${userId}`;
  const now = Date.now();
  const last = xpCooldowns.get(key) || 0;
  if (now - last < XP_COOLDOWN_MS) return null;
  xpCooldowns.set(key, now);
  const gain = Math.max(1, Math.min(100, Math.floor(Number(amount) || 0)));
  if (pool) {
    const result = await dbQuery(`
      INSERT INTO community_profiles(guild_id,user_id,xp,level,coins,last_daily,last_work)
      VALUES($1,$2,$3,0,0,0,0)
      ON CONFLICT(guild_id,user_id) DO UPDATE SET
        xp=community_profiles.xp + EXCLUDED.xp,
        level=FLOOR((community_profiles.xp + EXCLUDED.xp) / 100.0)::INTEGER,
        updated_at=NOW()
      RETURNING xp,level
    `, [guildId, userId, gain]);
    return { gain, xp: Number(result.rows[0].xp), level: Number(result.rows[0].level) };
  }
  const profile = await ensureCommunityProfile(guildId, userId);
  const oldLevel = Number(profile.level) || 0;
  profile.xp = (Number(profile.xp) || 0) + gain;
  profile.level = Math.floor(profile.xp / 100);
  return { gain, xp: profile.xp, level: profile.level, oldLevel };
}

async function claimCommunityCoins(guildId, userId, type) {
  const isDaily = type === 'daily';
  const now = Date.now();
  const cooldown = isDaily ? DAILY_COOLDOWN_MS : WORK_COOLDOWN_MS;
  const column = isDaily ? 'last_daily' : 'last_work';
  const reward = isDaily ? COINS_DAILY_AMOUNT : COINS_WORK_MIN + Math.floor(Math.random() * (COINS_WORK_MAX - COINS_WORK_MIN + 1));
  await ensureCommunityProfile(guildId, userId);
  if (pool) {
    const result = await dbQuery(`UPDATE community_profiles SET coins=coins+$1, ${column}=$2, updated_at=NOW() WHERE guild_id=$3 AND user_id=$4 AND ${column} <= $5 RETURNING coins`, [reward, now, guildId, userId, now - cooldown]);
    if (result.rowCount) return { ok: true, reward, coins: Number(result.rows[0].coins), nextAt: now + cooldown };
    const profile = await ensureCommunityProfile(guildId, userId);
    return { ok: false, coins: Number(profile.coins), nextAt: Number(profile[column]) + cooldown };
  }
  const profile = await ensureCommunityProfile(guildId, userId);
  if (now - Number(profile[column] || 0) < cooldown) return { ok: false, coins: Number(profile.coins), nextAt: Number(profile[column]) + cooldown };
  profile.coins = Number(profile.coins || 0) + reward;
  profile[column] = now;
  return { ok: true, reward, coins: profile.coins, nextAt: now + cooldown };
}

function progressBar(current, total, length = 12) {
  const ratio = total > 0 ? Math.max(0, Math.min(1, current / total)) : 0;
  const filled = Math.round(ratio * length);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, length - filled));
}

async function getCommunityLeaderboard(guildId, kind = 'levels', limit = 10) {
  const safeLimit = Math.max(1, Math.min(10, Number(limit) || 10));
  if (pool) {
    const column = kind === 'coins' ? 'coins' : 'xp';
    const result = await dbQuery(`SELECT user_id,xp,level,coins FROM community_profiles WHERE guild_id=$1 ORDER BY ${column} DESC, user_id ASC LIMIT $2`, [guildId, safeLimit]);
    return result.rows.map((row, index) => ({ rank: index + 1, user_id: row.user_id, xp: Number(row.xp), level: Number(row.level), coins: Number(row.coins) }));
  }
  return [...memory.communityProfiles.values()].filter(p => p.guild_id === guildId)
    .sort((a,b) => (kind === 'coins' ? Number(b.coins)-Number(a.coins) : Number(b.xp)-Number(a.xp)))
    .slice(0, safeLimit).map((p,index) => ({ ...p, rank:index+1 }));
}

function makeSession(user, guilds) {
  const sid = crypto.randomBytes(32).toString('hex');
  sessionStore.set(sid, { user, guilds, createdAt: Date.now(), lastSeen: Date.now() });
  return sid;
}
function getSession(req) {
  const sid = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`${SESSION_COOKIE}=`))?.split('=')[1];
  const session = sid ? sessionStore.get(sid) : null;
  if (session) session.lastSeen = Date.now();
  return session;
}
function sessionEncryptionKey() {
  const secret = process.env.SESSION_ENCRYPTION_KEY || process.env.DISCORD_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '';
  return secret ? crypto.createHash('sha256').update(secret, 'utf8').digest() : null;
}
function sessionForStorage(session) {
  const stored = { ...session };
  const previousCipher = stored.discordOAuthTokens;
  delete stored.discordAccessToken;
  delete stored.discordRefreshToken;
  delete stored.discordTokenExpiresAt;
  delete stored.discordOAuthTokens;
  const tokens = {
    accessToken: session.discordAccessToken || null,
    refreshToken: session.discordRefreshToken || null,
    expiresAt: Number(session.discordTokenExpiresAt) || 0
  };
  const key = sessionEncryptionKey();
  if (key && (tokens.accessToken || tokens.refreshToken)) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
    stored.discordOAuthTokens = {
      version: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64')
    };
  } else if (previousCipher) {
    stored.discordOAuthTokens = previousCipher;
  }
  return stored;
}
function restoreSessionFromStorage(saved) {
  const session = { ...saved };
  const envelope = session.discordOAuthTokens;
  delete session.discordOAuthTokens;
  if (!envelope || envelope.version !== 1) return session;
  const key = sessionEncryptionKey();
  if (!key) return session;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final()
    ]).toString('utf8');
    const tokens = JSON.parse(plain);
    if (tokens.accessToken) session.discordAccessToken = tokens.accessToken;
    if (tokens.refreshToken) session.discordRefreshToken = tokens.refreshToken;
    if (tokens.expiresAt) session.discordTokenExpiresAt = Number(tokens.expiresAt);
  } catch {
    console.warn('Could not decrypt a stored Discord OAuth token; the user may need to log in again.');
  }
  return session;
}
async function persistSession(sid) {
  if (!pool || !sid) return;
  const session = sessionStore.get(sid);
  if (!session) {
    await dbQuery('DELETE FROM dashboard_sessions WHERE sid=$1', [sid]);
    return;
  }
  await dbQuery(
    'INSERT INTO dashboard_sessions(sid, session_data, last_seen) VALUES($1,$2::jsonb,$3) ON CONFLICT(sid) DO UPDATE SET session_data=EXCLUDED.session_data, last_seen=EXCLUDED.last_seen',
    [sid, JSON.stringify(sessionForStorage(session)), Number(session.lastSeen) || Date.now()]
  );
}
async function restorePersistentSessions() {
  if (!pool) return;
  const cutoff = Date.now() - 7 * 24 * 60 * 60_000;
  await dbQuery('DELETE FROM dashboard_sessions WHERE last_seen <= $1', [cutoff]);
  const result = await dbQuery('SELECT sid, session_data FROM dashboard_sessions WHERE last_seen > $1', [cutoff]);
  for (const row of result?.rows || []) {
    const session = row.session_data;
    if (!row.sid || !session?.user || !Array.isArray(session.guilds)) continue;
    sessionStore.set(row.sid, restoreSessionFromStorage(session));
  }
  console.log(`Restored ${sessionStore.size} login session(s) from PostgreSQL.`);
}
async function persistAllSessions() {
  if (!pool) return;
  const cutoff = Date.now() - 7 * 24 * 60 * 60_000;
  for (const [sid, session] of sessionStore) {
    if (Number(session.lastSeen || session.createdAt || 0) <= cutoff) {
      sessionStore.delete(sid);
      continue;
    }
    await dbQuery(
      'INSERT INTO dashboard_sessions(sid, session_data, last_seen) VALUES($1,$2::jsonb,$3) ON CONFLICT(sid) DO UPDATE SET session_data=EXCLUDED.session_data, last_seen=EXCLUDED.last_seen',
      [sid, JSON.stringify(sessionForStorage(session)), Number(session.lastSeen) || Date.now()]
    );
  }
  await dbQuery('DELETE FROM dashboard_sessions WHERE last_seen <= $1', [cutoff]);
}
function requireAuth(req, res, next) {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'NOT_AUTHENTICATED', message: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập Discord lại.' });
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
      return res.status(400).send(`Phiên OAuth không khớp cookie của trình duyệt. Hãy mở dashboard tại ${SITE_URL}, đóng tab đăng nhập Discord cũ rồi thử lại.`);
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
    await persistSession(sid);
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
    await persistSession(sid);
    setSessionCookie(res, sid);
    return res.redirect('/dashboard');
  } catch (error) {
    console.error('Google OAuth callback failed:', error);
    return res.status(500).send('Google login failed. Check OAuth redirect URL and credentials.');
  }
});

app.get('/auth/logout', async (req, res) => {
  const sid = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`${SESSION_COOKIE}=`))?.split('=')[1];
  if (sid) {
    sessionStore.delete(sid);
    if (pool) await dbQuery('DELETE FROM dashboard_sessions WHERE sid=$1', [sid]).catch(error => console.warn('Could not delete stored login session:', error.message));
  }
  clearSessionCookie(res);
  res.redirect('/');
});

const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
  allowedMentions: { parse: ['users', 'roles'] }
});

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Kiểm tra độ trễ bot.'),
  new SlashCommandBuilder().setName('help').setDescription('Hiện danh sách tính năng.'),
  new SlashCommandBuilder().setName('server').setDescription('Thông tin máy chủ.'),
  new SlashCommandBuilder().setName('userinfo').setDescription('Thông tin một thành viên.').addUserOption(o => o.setName('user').setDescription('Thành viên').setRequired(false)),
  new SlashCommandBuilder().setName('avatar').setDescription('Xem avatar.').addUserOption(o => o.setName('user').setDescription('Thành viên').setRequired(false)),
  new SlashCommandBuilder().setName('botinfo').setDescription('Thông tin bot.'),
  new SlashCommandBuilder().setName('rank').setDescription('Xem cấp độ và XP của thành viên.').addUserOption(o => o.setName('user').setDescription('Thành viên (mặc định là bạn)').setRequired(false)),
  new SlashCommandBuilder().setName('balance').setDescription('Xem số dư xu của thành viên.').addUserOption(o => o.setName('user').setDescription('Thành viên (mặc định là bạn)').setRequired(false)),
  new SlashCommandBuilder().setName('daily').setDescription('Nhận 100 xu mỗi 24 giờ.'),
  new SlashCommandBuilder().setName('work').setDescription('Làm việc nhận xu, hồi sau 1 giờ.'),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Top 10 level hoặc số xu của server.')
    .addStringOption(o => o.setName('type').setDescription('Bảng xếp hạng').addChoices({ name: 'Levels / XP', value: 'levels' }, { name: 'Coins / Xu', value: 'coins' }).setRequired(false)),
  new SlashCommandBuilder().setName('poll').setDescription('Tạo poll 2–4 lựa chọn.')
    .addStringOption(o => o.setName('question').setDescription('Câu hỏi').setRequired(true))
    .addStringOption(o => o.setName('option1').setDescription('Lựa chọn 1').setRequired(true))
    .addStringOption(o => o.setName('option2').setDescription('Lựa chọn 2').setRequired(true))
    .addStringOption(o => o.setName('option3').setDescription('Lựa chọn 3').setRequired(false))
    .addStringOption(o => o.setName('option4').setDescription('Lựa chọn 4').setRequired(false)),
  new SlashCommandBuilder().setName('8ball').setDescription('Hỏi quả cầu tiên tri.').addStringOption(o => o.setName('question').setDescription('Câu hỏi').setRequired(true)),
  new SlashCommandBuilder().setName('roll').setDescription('Tung xúc xắc.').addIntegerOption(o => o.setName('sides').setDescription('Số mặt (2–1000)').setMinValue(2).setMaxValue(1000).setRequired(false)),
  new SlashCommandBuilder().setName('coinflip').setDescription('Tung đồng xu.'),
  new SlashCommandBuilder().setName('remind').setDescription('Đặt lời nhắc (30m, 2h, 1d).').addStringOption(o => o.setName('duration').setDescription('Thời lượng: 30m, 2h, 1d (5 giây đến 7 ngày)').setMaxLength(12).setRequired(true)).addStringOption(o => o.setName('text').setDescription('Nội dung').setMaxLength(1000).setRequired(true)),
  new SlashCommandBuilder().setName('reminders').setDescription('Xem lời nhắc đang chờ của bạn.'),
  new SlashCommandBuilder().setName('reminder-cancel').setDescription('Huỷ một lời nhắc của bạn.').addIntegerOption(o => o.setName('reminder_id').setDescription('ID lời nhắc').setMinValue(1).setRequired(true)),
  new SlashCommandBuilder().setName('afk').setDescription('Bật AFK + ảnh/GIF tuỳ chọn.').addStringOption(o => o.setName('reason').setDescription('Lý do').setMaxLength(1000).setRequired(false)).addStringOption(o => o.setName('image_url').setDescription('URL ảnh/GIF (https://...)').setMaxLength(2048).setRequired(false)).addAttachmentOption(o => o.setName('media').setDescription('Upload ảnh/GIF trực tiếp').setRequired(false)),
  new SlashCommandBuilder().setName('warn').setDescription('Cảnh cáo thành viên.').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers.toString()).addUserOption(o => o.setName('user').setDescription('Thành viên').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Lý do').setRequired(true)),
  new SlashCommandBuilder().setName('warnings').setDescription('Xem cảnh cáo.').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers.toString()).addUserOption(o => o.setName('user').setDescription('Thành viên').setRequired(true)),
  new SlashCommandBuilder().setName('clear').setDescription('Xoá tin nhắn gần nhất.').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString()).addIntegerOption(o => o.setName('amount').setDescription('1–100').setMinValue(1).setMaxValue(100).setRequired(true)),
  new SlashCommandBuilder().setName('slowmode').setDescription('Đặt slowmode.').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels.toString()).addIntegerOption(o => o.setName('seconds').setDescription('0–21600 giây').setMinValue(0).setMaxValue(21600).setRequired(true)),
  new SlashCommandBuilder().setName('lock').setDescription('Khoá kênh hiện tại.').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels.toString()),
  new SlashCommandBuilder().setName('unlock').setDescription('Mở khoá kênh hiện tại.').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels.toString()),
  new SlashCommandBuilder().setName('kick').setDescription('Kick thành viên.').setDefaultMemberPermissions(PermissionFlagsBits.KickMembers.toString()).addUserOption(o => o.setName('user').setDescription('Thành viên').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Lý do').setRequired(false)),
  new SlashCommandBuilder().setName('ban').setDescription('Ban thành viên.').setDefaultMemberPermissions(PermissionFlagsBits.BanMembers.toString()).addUserOption(o => o.setName('user').setDescription('Thành viên').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Lý do').setRequired(false)),
  new SlashCommandBuilder().setName('tempban').setDescription('Ban tạm thời và tự gỡ khi hết hạn.').setDefaultMemberPermissions(PermissionFlagsBits.BanMembers.toString()).addUserOption(o => o.setName('user').setDescription('Thành viên').setRequired(true)).addIntegerOption(o => o.setName('minutes').setDescription('1–40320 phút').setMinValue(1).setMaxValue(40320).setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Lý do').setRequired(false)),
  new SlashCommandBuilder().setName('timeout').setDescription('Timeout thành viên.').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers.toString()).addUserOption(o => o.setName('user').setDescription('Thành viên').setRequired(true)).addIntegerOption(o => o.setName('minutes').setDescription('1–40320 phút').setMinValue(1).setMaxValue(40320).setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Lý do').setRequired(false)),
  new SlashCommandBuilder().setName('unban').setDescription('Gỡ ban theo Discord user ID.').setDefaultMemberPermissions(PermissionFlagsBits.BanMembers.toString()).addStringOption(o => o.setName('user_id').setDescription('Discord user ID').setMinLength(17).setMaxLength(20).setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Lý do').setRequired(false)),
  new SlashCommandBuilder().setName('untimeout').setDescription('Gỡ timeout thành viên.').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers.toString()).addUserOption(o => o.setName('user').setDescription('Thành viên').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Lý do').setRequired(false)),
  new SlashCommandBuilder().setName('delwarn').setDescription('Xoá một cảnh cáo.').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers.toString()).addIntegerOption(o => o.setName('warning_id').setDescription('ID cảnh cáo').setMinValue(1).setRequired(true)),
  new SlashCommandBuilder().setName('case').setDescription('Xem case moderation theo ID.').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers.toString()).addIntegerOption(o => o.setName('case_id').setDescription('Case ID').setMinValue(1).setRequired(true)),
  new SlashCommandBuilder().setName('modlog').setDescription('Xem nhật ký moderation của server/thành viên.').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers.toString()).addUserOption(o => o.setName('user').setDescription('Lọc thành viên (tuỳ chọn)').setRequired(false)),
  new SlashCommandBuilder().setName('vouch').setDescription('Đánh giá giao dịch một lần cho mỗi cặp.').addUserOption(o => o.setName('user').setDescription('Thành viên nhận vouch').setRequired(true)).addStringOption(o => o.setName('message').setDescription('Đánh giá').setMaxLength(500).setRequired(true)),
  new SlashCommandBuilder().setName('vouches').setDescription('Xem đánh giá của thành viên.').addUserOption(o => o.setName('user').setDescription('Thành viên').setRequired(false)),
  new SlashCommandBuilder().setName('scamcheck').setDescription('Kiểm tra ID trong danh sách cảnh báo scammer.').addStringOption(o => o.setName('user_id').setDescription('Discord user ID').setMinLength(17).setMaxLength(20).setRequired(true)),
  new SlashCommandBuilder().setName('scam-add').setDescription('Thêm ID vào danh sách cảnh báo.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString()).addStringOption(o => o.setName('user_id').setDescription('Discord user ID').setMinLength(17).setMaxLength(20).setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Lý do/chứng cứ tham chiếu').setMaxLength(500).setRequired(true)),
  new SlashCommandBuilder().setName('role').setDescription('Thêm/gỡ role.').setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles.toString()).addStringOption(o => o.setName('mode').setDescription('add hoặc remove').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' })).addUserOption(o => o.setName('user').setDescription('Thành viên').setRequired(true)).addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)),
  new SlashCommandBuilder().setName('legit').setDescription('Đánh dấu thành viên đã được staff xác minh.').setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles.toString()).addUserOption(o => o.setName('user').setDescription('Thành viên được xác minh').setRequired(true)),
  new SlashCommandBuilder().setName('ticket-setup').setDescription('Đăng bảng mở ticket hỗ trợ.').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels.toString()).addChannelOption(o => o.setName('channel').setDescription('Kênh đăng bảng ticket').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(false)),
  new SlashCommandBuilder().setName('role-panel').setDescription('Đăng bảng tự nhận role bằng nút emoji.').setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles.toString()).addChannelOption(o => o.setName('channel').setDescription('Kênh đăng bảng role').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(false)),
  new SlashCommandBuilder().setName('announce').setDescription('Đăng thông báo đẹp.').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString()).addStringOption(o => o.setName('message').setDescription('Nội dung').setRequired(true)),
  new SlashCommandBuilder().setName('vc-join').setDescription('Bot vào voice.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString()).addChannelOption(o => o.setName('channel').setDescription('Kênh voice').addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice).setRequired(true)),
  new SlashCommandBuilder().setName('vc-leave').setDescription('Bot rời voice.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString()),
  new SlashCommandBuilder().setName('auto-voice').setDescription('Bật/tắt tự động giữ voice.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString()).addBooleanOption(o => o.setName('enabled').setDescription('Bật hoặc tắt').setRequired(true)).addChannelOption(o => o.setName('channel').setDescription('Kênh voice').addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice).setRequired(false)),
  new SlashCommandBuilder().setName('welcome-setup').setDescription('Chọn kênh chào thành viên mới.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString()).addChannelOption(o => o.setName('channel').setDescription('Kênh chào mừng').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)),
  new SlashCommandBuilder().setName('goodbye-setup').setDescription('Chọn kênh thông báo thành viên rời server.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString()).addChannelOption(o => o.setName('channel').setDescription('Kênh tạm biệt').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
].map(c => c.toJSON());

const helpLines = [
  ['ping', 'Kiểm tra latency'], ['server', 'Thông tin server'], ['userinfo', 'Thông tin user'], ['avatar', 'Avatar'], ['botinfo', 'Thông tin bot'], ['rank', 'Cấp độ và XP'], ['balance', 'Số dư xu'], ['daily', 'Nhận xu mỗi ngày'], ['work', 'Làm việc nhận xu'], ['leaderboard', 'Top level / xu'],
  ['poll', 'Tạo bình chọn'], ['8ball', 'Quả cầu tiên tri'], ['roll', 'Xúc xắc'], ['coinflip', 'Đồng xu'], ['remind', 'Đặt lời nhắc 30m / 2h / 1d'], ['reminders', 'Lời nhắc đang chờ'], ['reminder-cancel', 'Huỷ lời nhắc'],
  ['afk', 'AFK + ảnh/GIF riêng'], ['warn', 'Cảnh cáo'], ['warnings', 'Lịch sử cảnh cáo'], ['clear', 'Xoá tin nhắn'], ['slowmode', 'Slowmode'],
  ['lock', 'Khoá kênh'], ['unlock', 'Mở khoá'], ['kick', 'Kick'], ['ban', 'Ban'], ['tempban', 'Ban tạm'], ['timeout', 'Timeout'], ['unban', 'Gỡ ban'], ['untimeout', 'Gỡ timeout'], ['delwarn', 'Xoá cảnh cáo'], ['case', 'Tra cứu case'], ['modlog', 'Nhật ký moderation'], ['role', 'Quản lý role'], ['vouch', 'Đánh giá giao dịch'], ['vouches', 'Danh sách vouch'], ['scamcheck', 'Kiểm tra scammer'], ['scam-add', 'Thêm cảnh báo scammer'],
  ['announce', 'Thông báo'], ['legit', 'Staff xác minh thành viên'], ['ticket-setup', 'Đăng bảng ticket hỗ trợ'], ['role-panel', 'Đăng bảng tự nhận role'], ['vc-join', 'Vào voice'], ['vc-leave', 'Rời voice'], ['auto-voice', 'Tự động giữ voice'], ['welcome-setup', 'Cấu hình chào mừng'], ['goodbye-setup', 'Cấu hình tạm biệt']
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
function ensureTargetBelowInvoker(actor, target, action = 'thao tác này') {
  if (!actor || !target) throw new Error('Không xác định được người thực hiện hoặc thành viên mục tiêu.');
  const guild = actor.guild;
  if (actor.id === guild.ownerId) return;
  if (target.id === guild.ownerId) throw new Error('Không thể thực hiện thao tác với chủ server.');
  if (target.id === actor.id) throw new Error('Bạn không thể dùng lệnh này lên chính mình.');
  if (!isRoleHigherThan(actor.roles.highest, target.roles.highest)) throw new Error(`Role cao nhất của mục tiêu phải thấp hơn role cao nhất của bạn để ${action}.`);
}
function ensureRoleBelowInvoker(actor, role) {
  if (!actor || !role) throw new Error('Không xác định được người thực hiện hoặc role.');
  if (role.managed || role.id === actor.guild.id) throw new Error('Không thể tự gán/gỡ role @everyone hoặc role do tích hợp quản lý.');
  if (actor.id !== actor.guild.ownerId && !isRoleHigherThan(actor.roles.highest, role)) throw new Error('Role cần gán/gỡ phải thấp hơn role cao nhất của bạn.');
}

async function joinGuildVoice(guild, channelId, source = 'manual') {
  const channel = await guild.channels.fetch(channelId);
  if (!channel || ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type)) throw new Error('Voice channel không hợp lệ.');
  const scheduled = voiceReconnectTimers.get(guild.id);
  if (scheduled) { clearTimeout(scheduled); voiceReconnectTimers.delete(guild.id); }
  const existing = getVoiceConnection(guild.id);
  if (existing && existing.state.status !== VoiceConnectionStatus.Destroyed && existing.__aki?.channelId === channel.id) return channel;
  if (existing && existing.state.status !== VoiceConnectionStatus.Destroyed) existing.destroy();
  const me = guild.members.me || await guild.members.fetchMe();
  if (!channel.joinable || !channel.permissionsFor(me)?.has(PermissionFlagsBits.Connect)) throw new Error('Bot không có quyền Connect vào voice này.');
  const connection = joinVoiceChannel({ guildId: guild.id, channelId: channel.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: true, selfMute: true });
  try { await entersState(connection, VoiceConnectionStatus.Ready, 15_000); }
  catch (error) { connection.destroy(); throw new Error(`Không kết nối được voice: ${error.message}`); }
  connection.__aki = { guildId: guild.id, channelId: channel.id, source };
  attachVoiceRecovery(guild, connection);
  await setConfig(guild.id, { auto_voice_channel_id: source === 'auto' ? channel.id : (await getConfig(guild.id)).auto_voice_channel_id });
  io.to('guild:' + guild.id).emit('bot-status', { type: 'voice', guildId: guild.id, channelId: channel.id, connected: true });
  return channel;
}

function scheduleAutoVoiceReconnect(guild, channelId, delay = 3_000) {
  if (!guild || !channelId || voiceReconnectTimers.has(guild.id)) return;
  const active = getVoiceConnection(guild.id);
  if (active && active.state.status !== VoiceConnectionStatus.Destroyed && active.__aki?.channelId === channelId) return;
  const timer = setTimeout(() => {
    voiceReconnectTimers.delete(guild.id);
    const current = getVoiceConnection(guild.id);
    if (current && current.state.status !== VoiceConnectionStatus.Destroyed) return;
    joinGuildVoice(guild, channelId, 'auto').catch(error => console.error('Auto voice reconnect failed:', error.message));
  }, delay);
  voiceReconnectTimers.set(guild.id, timer);
  timer.unref?.();
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
      if (cfg.auto_voice_enabled && cfg.auto_voice_channel_id === meta.channelId) scheduleAutoVoiceReconnect(guild, meta.channelId, 3_000);
    }
  });
  connection.on(VoiceConnectionStatus.Destroyed, () => io.to('guild:' + guild.id).emit('bot-status', { type: 'voice', guildId: guild.id, connected: false }));
}

const SELF_ASSIGNABLE_ROLES = [
  { key: 'gamer', name: '🎮 Gamer', color: 0x5865F2 },
  { key: 'social', name: '💬 Social', color: 0x57F287 },
  { key: 'trader', name: '🛍️ Trader', color: 0xFEE75C },
  { key: 'buyer', name: '🛒 Buyer', color: 0xEB459E },
  { key: 'seller', name: '📦 Seller', color: 0xED4245 },
  { key: 'events', name: '🔔 Event Ping', color: 0x99AAB5 }
];

const REACTION_ROLE_CHOICES = [
  { key: 'announcements', emoji: '📣', name: '📣 Announcement Ping', color: 0x5865F2, description: 'Thông báo quan trọng của server' },
  { key: 'events', emoji: '🎉', name: '🔔 Event Ping', color: 0x57F287, description: 'Sự kiện và hoạt động cộng đồng' },
  { key: 'giveaways', emoji: '🎁', name: '🎁 Giveaway Ping', color: 0xEB459E, description: 'Quà tặng và giveaway' },
  { key: 'gaming', emoji: '🎮', name: '🎮 Game Ping', color: 0xFEE75C, description: 'Tìm team và hẹn giờ chơi game' },
  { key: 'social', emoji: '💬', name: '💬 Social Ping', color: 0x99AAB5, description: 'Hoạt động giao lưu cộng đồng' }
];

async function ensureNamedRole(guild, name, color = 0x99AAB5, permissions = []) {
  let role = guild.roles.cache.find(r => r.name === name);
  if (!role) role = await guild.roles.create({ name, color, permissions, reason: 'Aki automation setup' });
  return role;
}

function buildReactionRoleButtonRows() {
  const buttons = REACTION_ROLE_CHOICES.map(choice => new ButtonBuilder()
    .setCustomId('aki:rr:' + choice.key)
    .setLabel(choice.name.slice(0, 80))
    .setStyle(ButtonStyle.Secondary));
  return [new ActionRowBuilder().addComponents(...buttons.slice(0, 5))];
}


function buildSelfRoleRows() {
  const buttons = SELF_ASSIGNABLE_ROLES.map(role => new ButtonBuilder().setCustomId('aki:role:' + role.key).setLabel(role.name).setStyle(ButtonStyle.Secondary));
  return [new ActionRowBuilder().addComponents(...buttons.slice(0, 5)), new ActionRowBuilder().addComponents(...buttons.slice(5))].filter(row => row.components.length);
}

async function getReactionRolePanel(guildId) {
  if (pool) {
    const result = await dbQuery('SELECT guild_id, channel_id, message_id FROM reaction_role_panels WHERE guild_id=$1', [guildId]);
    return result?.rows?.[0] || null;
  }
  return memory.reactionRolePanels.get(guildId) || null;
}

async function saveReactionRolePanel(guildId, channelId, messageId, bindings) {
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM reaction_role_bindings WHERE guild_id=$1', [guildId]);
      await client.query(
        'INSERT INTO reaction_role_panels(guild_id, channel_id, message_id, updated_at) VALUES($1,$2,$3,NOW()) ON CONFLICT(guild_id) DO UPDATE SET channel_id=EXCLUDED.channel_id, message_id=EXCLUDED.message_id, updated_at=NOW()',
        [guildId, channelId, messageId]
      );
      for (const binding of bindings) {
        await client.query(
          'INSERT INTO reaction_role_bindings(guild_id,message_id,emoji,role_id) VALUES($1,$2,$3,$4) ON CONFLICT(guild_id,message_id,emoji) DO UPDATE SET role_id=EXCLUDED.role_id',
          [guildId, messageId, normalizeReactionEmoji(binding.emoji), binding.roleId]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return;
  }
  for (const [key, value] of memory.reactionRoleBindings) {
    if (value.guildId === guildId) memory.reactionRoleBindings.delete(key);
  }
  memory.reactionRolePanels.set(guildId, { guild_id: guildId, channel_id: channelId, message_id: messageId });
  for (const binding of bindings) {
    memory.reactionRoleBindings.set(`${guildId}:${messageId}:${normalizeReactionEmoji(binding.emoji)}`, {
      guildId, messageId, emoji: normalizeReactionEmoji(binding.emoji), role_id: binding.roleId
    });
  }
}
async function getReactionRoleBinding(guildId, messageId, emoji) {
  if (pool) {
    const result = await dbQuery(
      'SELECT role_id FROM reaction_role_bindings WHERE guild_id=$1 AND message_id=$2 AND emoji=$3',
      [guildId, messageId, normalizeReactionEmoji(emoji)]
    );
    return result?.rows?.[0] || null;
  }
  return memory.reactionRoleBindings.get(`${guildId}:${messageId}:${normalizeReactionEmoji(emoji)}`) || null;
}


async function setupRolePanel(guild, channel, actorId) {
  if (!channel?.isTextBased?.() || channel.guild?.id !== guild.id || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
    throw new Error('Chọn một kênh text hoặc announcement thuộc đúng server.');
  }
  const me = guild.members.me || await guild.members.fetchMe();
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('Bot cần quyền Manage Roles.');
  const channelPermissions = channel.permissionsFor(me);
  if (!channelPermissions?.has([
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AddReactions,
    PermissionFlagsBits.ReadMessageHistory
  ])) {
    throw new Error('Bot cần View Channel, Send Messages, Embed Links, Add Reactions và Read Message History ở kênh này.');
  }

  const memberRole = await ensureNamedRole(guild, '👥 Member', 0x99AAB5, []);
  if (memberRole.position >= me.roles.highest.position) {
    throw new Error('Role 👥 Member phải nằm dưới role cao nhất của bot trong Server Settings → Roles.');
  }
  const config = await getConfig(guild.id);
  if (!config.auto_role_id) await setConfig(guild.id, { auto_role_id: memberRole.id });

  const roles = [];
  for (const choice of REACTION_ROLE_CHOICES) {
    const role = await ensureNamedRole(guild, choice.name, choice.color, []);
    if (role.position >= me.roles.highest.position) {
      throw new Error(`Role ${role.name} đang ở trên hoặc ngang role cao nhất của bot. Đưa role bot lên cao hơn trong Server Settings → Roles rồi thử lại.`);
    }
    roles.push({ ...choice, role });
  }

  const oldPanel = await getReactionRolePanel(guild.id);
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎭 Chọn role ping của bạn')
    .setDescription([
      'Thêm reaction emoji hoặc nhấn nút emoji tương ứng để **nhận/gỡ role**.',
      '👥 Muốn tự gán Member cho người mới, hãy chọn 👥 Member trong mục Auto-role trên dashboard.',
      '',
      ...roles.map(choice => `${choice.emoji} **${choice.name}** — ${choice.description} (<@&${choice.role.id}>)`)
    ].join('\n'))
    .setFooter({ text: 'Aki Dev · Reaction Roles' });
  const message = await channel.send({ embeds: [embed], components: buildReactionRoleButtonRows(), allowedMentions: { parse: [] } });
  const bindings = roles.map(choice => ({ emoji: choice.emoji, roleId: choice.role.id }));
  try {
    // Finish the visible panel before switching the stored mapping; don't strand users on a partial panel.
    for (const choice of roles) await message.react(choice.emoji);
  } catch (error) {
    await message.delete().catch(() => {});
    throw new Error('Không thể thêm emoji reaction vào bảng role. Kiểm tra quyền Add Reactions và thử lại. Chi tiết: ' + error.message);
  }
  await saveReactionRolePanel(guild.id, channel.id, message.id, bindings);
  if (oldPanel?.message_id && oldPanel.message_id !== message.id) {
    const oldChannel = await guild.channels.fetch(oldPanel.channel_id).catch(() => null);
    if (oldChannel?.isTextBased?.()) {
      const oldMessage = await oldChannel.messages.fetch(oldPanel.message_id).catch(() => null);
      if (oldMessage) await oldMessage.delete().catch(() => {});
    }
  }
  await addActivity(guild.id, actorId, 'roles:reaction-panel', 'Đã đăng bảng reaction-role tại #' + channel.name + ' (5 role ping, Member auto-role).');
  return message;
}
async function ensureTicketCategory(guild) {
  const me = guild.members.me || await guild.members.fetchMe();
  if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) throw new Error('Bot cần quyền Manage Channels để tạo ticket.');
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('Bot cần quyền Manage Roles để tạo quyền truy cập ticket cho đội ngũ.');
  const staffSpecs = [
    { name: '👑 Admin', color: 0xED4245, permissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ModerateMembers] },
    { name: '🛡️ Moderator', color: 0x5865F2, permissions: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ModerateMembers] },
    { name: '🧾 Trade Moderator', color: 0xFEE75C, permissions: [PermissionFlagsBits.ManageMessages] },
    { name: '🆘 Support', color: 0x57F287, permissions: [PermissionFlagsBits.ManageMessages] }
  ];
  const staffRoles = [];
  for (const spec of staffSpecs) staffRoles.push(await ensureNamedRole(guild, spec.name, spec.color, spec.permissions));
  let category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === '🎫・TICKETS');
  if (!category) {
    const overwrites = [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }];
    for (const role of staffRoles) overwrites.push({ id: role.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    overwrites.push({ id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] });
    category = await guild.channels.create({ name: '🎫・TICKETS', type: ChannelType.GuildCategory, permissionOverwrites: overwrites, reason: 'Aki ticket system setup' });
  }
  return { category, staffRoles, me };
}

async function setupTicketPanel(guild, channel, actorId) {
  if (!channel?.isTextBased?.() || channel.guild?.id !== guild.id) throw new Error('Chọn một kênh text thuộc đúng server.');
  const { me } = await ensureTicketCategory(guild);
  const perms = channel.permissionsFor(me);
  if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) throw new Error('Bot cần View Channel, Send Messages và Embed Links ở kênh panel.');
  const recent = await channel.messages.fetch({ limit: 30 }).catch(() => null);
  const existing = recent?.find(item => item.author.id === bot.user?.id && item.components.some(row => row.components.some(component => component.customId === 'aki:ticket:create' || String(component.customId || '').startsWith('aki:ticket:create:'))));
  if (existing) return existing;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('aki:ticket:create:support').setLabel('🎫 Hỗ trợ').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('aki:ticket:create:middleman').setLabel('🤝 Middleman').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('aki:ticket:create:scam-report').setLabel('🚨 Báo cáo scam').setStyle(ButtonStyle.Danger)
  );
  const message = await channel.send({
    embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('🎫 Trung tâm hỗ trợ').setDescription('Chọn loại yêu cầu để mở form ticket riêng tư.\n\nKhông gửi mật khẩu, token hoặc thông tin thanh toán nhạy cảm.').setFooter({ text: 'Aki Dev · Ticket System' })],
    components: [row], allowedMentions: { parse: [] }
  });
  await addActivity(guild.id, actorId, 'ticket:panel', 'Đã đăng panel ticket tại #' + channel.name + '.');
  return message;
}

function scheduleClosedTicketDeletion(channel, closedAt) {
  const delay = ticketDeletionDelay(closedAt);
  if (delay === null) return;
  const timer = setTimeout(() => {
    channel.delete('Aki ticket retention expired').catch(error => console.warn('Closed ticket auto-delete failed:', error.message));
  }, delay);
  timer.unref?.();
}

async function sendTicketTranscript(channel, ownerId, closedBy) {
  const messages = [];
  let before;
  for (let page = 0; page < 5; page++) {
    const batch = await channel.messages.fetch(before ? { limit: 100, before } : { limit: 100 });
    if (!batch.size) break;
    messages.push(...batch.values());
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }
  messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const lines = [
    'Aki Dev · Ticket transcript',
    'Guild: ' + channel.guild.name + ' (' + channel.guild.id + ')',
    'Channel: #' + channel.name + ' (' + channel.id + ')',
    'Owner: ' + ownerId,
    'Closed by: ' + closedBy,
    'Exported: ' + new Date().toISOString(),
    ''
  ];
  for (const message of messages) {
    const body = String(message.content || '').replace(/\r/g, '');
    const attachments = [...message.attachments.values()].map(item => item.url);
    lines.push('[' + new Date(message.createdTimestamp).toISOString() + '] ' +
      (message.author?.tag || message.author?.username || 'Unknown') + ' (' + message.author?.id + '): ' +
      (body || '[no text]') + (attachments.length ? '\nAttachments: ' + attachments.join(' ') : ''));
  }
  let transcript = lines.join('\n');
  if (transcript.length > 1_000_000) transcript = transcript.slice(-1_000_000);
  const config = await getConfig(channel.guild.id).catch(() => null);
  const logChannel = (config?.log_channel_id ? await channel.guild.channels.fetch(config.log_channel_id).catch(() => null) : null) ||
    channel.guild.channels.cache.find(item => item.isTextBased?.() && item.name === '🧾・staff-log');
  if (!logChannel?.isTextBased?.()) return false;
  const me = channel.guild.members.me || await channel.guild.members.fetchMe();
  if (!logChannel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles])) return false;
  await logChannel.send({
    content: '📄 Transcript của #' + channel.name + ' · ticket owner <@' + ownerId + '> · đóng bởi <@' + closedBy + '>',
    files: [new AttachmentBuilder(Buffer.from(transcript, 'utf8'), { name: 'ticket-' + channel.id + '-transcript.txt' })],
    allowedMentions: { parse: [] }
  });
  return true;
}

async function handleAkiModalSubmit(interaction) {
  const prefix = 'aki:ticket:submit:';
  if (!interaction.customId?.startsWith(prefix) || !interaction.guild) return false;
  const type = normalizeTicketType(interaction.customId.slice(prefix.length));
  if (!type) {
    await interaction.reply({ content: 'Loại ticket không hợp lệ. Hãy mở lại panel ticket.', ephemeral: true });
    return true;
  }
  await interaction.deferReply({ ephemeral: true });
  const guild = interaction.guild;
  const member = await guild.members.fetch(interaction.user.id);
  await guild.channels.fetch();
  const existing = guild.channels.cache.find(c => c.type === ChannelType.GuildText && isOpenAkiTicket(c.topic, member.id));
  if (existing) {
    await interaction.editReply({ content: 'Bạn đã có ticket đang mở: ' + existing.toString() });
    return true;
  }
  const description = String(interaction.fields.getTextInputValue('description') || '').trim().slice(0, 1800);
  if (!description) {
    await interaction.editReply({ content: 'Hãy nhập mô tả yêu cầu trước khi gửi.' });
    return true;
  }
  const { category, staffRoles, me } = await ensureTicketCategory(guild);
  const slug = String(member.user.username || 'member').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'member';
  const label = ticketTypeLabel(type);
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
    { id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] }
  ];
  for (const role of staffRoles) overwrites.push({ id: role.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  const ticket = await guild.channels.create({
    name: ('ticket-' + type + '-' + slug).slice(0, 100),
    type: ChannelType.GuildText,
    parent: category.id,
    topic: 'aki-ticket-owner=' + member.id + ';aki-ticket-type=' + type,
    permissionOverwrites: overwrites,
    reason: 'Aki ticket opened by ' + member.id + ' (' + type + ')'
  });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('aki:ticket:claim').setLabel('🙋 Staff nhận xử lý').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('aki:ticket:close').setLabel('🔒 Đóng ticket').setStyle(ButtonStyle.Danger)
  );
  const descriptionEmbed = new EmbedBuilder().setColor(0x5865F2).setTitle('🎫 ' + label)
    .setDescription(description)
    .addFields({ name: 'Người mở', value: '<@' + member.id + '>', inline: true }, { name: 'Trạng thái', value: '🟡 Chờ staff nhận xử lý', inline: true })
    .setFooter({ text: 'Aki Dev · Ticket System' }).setTimestamp();
  await ticket.send({
    content: '🔔 Ticket mới · ' + label,
    embeds: [descriptionEmbed],
    components: [row],
    allowedMentions: { parse: [] }
  });
  await interaction.editReply({ content: '✅ Ticket ' + label + ' đã được tạo: ' + ticket.toString() });
  await addActivity(guild.id, member.id, 'ticket:created', 'Đã mở #' + ticket.name + ' (' + type + ').').catch(() => {});
  return true;
}

async function handleAkiButton(interaction) {
  const customId = interaction.customId || '';
  if (!customId.startsWith('aki:') || !interaction.guild) return false;
  const guild = interaction.guild;
  if (customId.startsWith('aki:rr:')) {
    await interaction.deferReply({ ephemeral: true });
    const key = customId.slice('aki:rr:'.length);
    const spec = REACTION_ROLE_CHOICES.find(item => item.key === key);
    if (!spec) { await interaction.editReply({ content: 'Role không hợp lệ.' }); return true; }
    const member = await guild.members.fetch(interaction.user.id);
    const roles = await guild.roles.fetch().catch(() => guild.roles.cache);
    const role = roles.find(r => r.name === spec.name);
    if (!role) { await interaction.editReply({ content: 'Role chưa tồn tại. Hãy đăng lại bảng nhận role từ dashboard.' }); return true; }
    const me = guild.members.me || await guild.members.fetchMe();
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) { await interaction.editReply({ content: 'Bot thiếu quyền Manage Roles.' }); return true; }
    if (role.position >= me.roles.highest.position) { await interaction.editReply({ content: 'Role ' + role.name + ' đang ở trên hoặc ngang role bot. Hãy đưa role bot lên cao hơn.' }); return true; }
    const hadRole = member.roles.cache.has(role.id);
    if (hadRole) {
      await member.roles.remove(role, 'Reaction-role button removed');
      await interaction.editReply({ content: '➖ Đã gỡ role ' + role.name + '.' });
      await addActivity(guild.id, member.id, 'role:button-remove', role.name + ' · nút emoji').catch(() => {});
    } else {
      await member.roles.add(role, 'Reaction-role button selected');
      await interaction.editReply({ content: '✅ Đã nhận role ' + role.name + '.' });
      await addActivity(guild.id, member.id, 'role:button-add', role.name + ' · nút emoji').catch(() => {});
    }
    return true;
  }
  if (customId.startsWith('aki:role:')) {
    const key = customId.slice('aki:role:'.length);
    const spec = SELF_ASSIGNABLE_ROLES.find(r => r.key === key);
    if (!spec) { await interaction.reply({ content: 'Role không hợp lệ.', ephemeral: true }); return true; }
    const member = await guild.members.fetch(interaction.user.id);
    const role = guild.roles.cache.find(r => r.name === spec.name);
    if (!role) { await interaction.reply({ content: 'Role chưa được tạo. Nhờ quản trị viên chạy /role-panel hoặc setup server.', ephemeral: true }); return true; }
    if (role.position >= (guild.members.me || await guild.members.fetchMe()).roles.highest.position) { await interaction.reply({ content: 'Bot chưa thể quản lý role này vì role đang ở trên hoặc ngang role cao nhất của bot.', ephemeral: true }); return true; }
    const hadRole = member.roles.cache.has(role.id);
    if (hadRole) await member.roles.remove(role, 'Self-role panel'); else await member.roles.add(role, 'Self-role panel');
    await interaction.reply({ content: (hadRole ? '➖ Đã gỡ role ' : '✅ Đã nhận role ') + role.name, ephemeral: true });
    await addActivity(guild.id, interaction.user.id, hadRole ? 'role:self-remove' : 'role:self-add', role.name + ' · từ role panel').catch(() => {});
    return true;
  }
  if (customId === 'aki:ticket:create' || customId.startsWith('aki:ticket:create:')) {
    const requestedType = customId === 'aki:ticket:create' ? 'support' : normalizeTicketType(customId.slice('aki:ticket:create:'.length));
    if (!requestedType) { await interaction.reply({ content: 'Loại ticket không hợp lệ.', ephemeral: true }); return true; }
    const modal = new ModalBuilder()
      .setCustomId('aki:ticket:submit:' + requestedType)
      .setTitle('Ticket · ' + ticketTypeLabel(requestedType))
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('description').setLabel('Mô tả yêu cầu').setStyle(TextInputStyle.Paragraph)
          .setMinLength(5).setMaxLength(1800).setRequired(true)
          .setPlaceholder('Mô tả ngắn gọn tình huống, không gửi mật khẩu/token.')
      ));
    await interaction.showModal(modal);
    return true;
  }
  if (customId === 'aki:ticket:claim') {
    const channel = interaction.channel;
    const ticketMeta = parseAkiTicketTopic(channel?.topic);
    if (!channel || channel.type !== ChannelType.GuildText || !ticketMeta.ownerId || ticketMeta.status === 'closed') {
      await interaction.reply({ content: 'Ticket này không còn mở hoặc không hợp lệ.', ephemeral: true }); return true;
    }
    const member = await guild.members.fetch(interaction.user.id);
    const staffRoleNames = new Set(['👑 Admin', '🛡️ Moderator', '🧾 Trade Moderator', '🆘 Support']);
    const isStaff = member.permissions.has(PermissionFlagsBits.ManageChannels) || member.permissions.has(PermissionFlagsBits.ManageGuild) ||
      member.roles.cache.some(role => staffRoleNames.has(role.name));
    if (!isStaff) { await interaction.reply({ content: 'Chỉ staff được cấp quyền mới nhận xử lý ticket.', ephemeral: true }); return true; }
    const claimedBy = String(channel.topic || '').match(/(?:^|;)aki-ticket-claimed-by=(\d{17,20})(?:;|$)/)?.[1];
    if (claimedBy && claimedBy !== member.id) {
      await interaction.reply({ content: 'Ticket đã được nhận bởi <@' + claimedBy + '>.', ephemeral: true, allowedMentions: { parse: [] } }); return true;
    }
    if (!claimedBy) await channel.setTopic((String(channel.topic || '') + ';aki-ticket-claimed-by=' + member.id).slice(0, 1024));
    await interaction.reply({ content: '✅ Bạn đã nhận xử lý ticket này.', ephemeral: true });
    await channel.send({ content: '🙋 Ticket được nhận xử lý bởi <@' + member.id + '>.', allowedMentions: { parse: [] } });
    await addActivity(guild.id, member.id, 'ticket:claimed', 'Đã nhận xử lý #' + channel.name + '.').catch(() => {});
    return true;
  }
  if (customId === 'aki:ticket:close') {
    const channel = interaction.channel;
    const ownerMatch = String(channel?.topic || '').match(/aki-ticket-owner=(\d{17,20})/);
    if (!channel || channel.type !== ChannelType.GuildText || !ownerMatch) { await interaction.reply({ content: 'Đây không phải ticket Aki hợp lệ.', ephemeral: true }); return true; }
    const member = await guild.members.fetch(interaction.user.id);
    const canClose = member.id === ownerMatch[1] || member.permissions.has(PermissionFlagsBits.ManageChannels) || member.permissions.has(PermissionFlagsBits.ManageGuild);
    if (!canClose) { await interaction.reply({ content: 'Chỉ người mở ticket hoặc staff có quyền quản lý kênh mới được đóng ticket.', ephemeral: true }); return true; }
    await interaction.reply({ content: '🔒 Đang đóng ticket…', ephemeral: true });
    const closedAt = Date.now();
    await sendTicketTranscript(channel, ownerMatch[1], interaction.user.id).catch(error => console.warn('Ticket transcript could not be saved:', error.message));
    await channel.permissionOverwrites.edit(ownerMatch[1], { ViewChannel: false, SendMessages: false }).catch(() => {});
    await channel.setTopic('aki-ticket-owner=' + ownerMatch[1] + ';aki-ticket-status=closed;aki-ticket-closed-at=' + closedAt).catch(() => {});
    if (!channel.name.startsWith('closed-')) await channel.setName(('closed-' + channel.name).slice(0, 100)).catch(() => {});
    scheduleClosedTicketDeletion(channel, closedAt);
    await addActivity(guild.id, interaction.user.id, 'ticket:closed', 'Đã đóng #' + channel.name + '. Transcript đã được gửi vào kênh log (nếu cấu hình). Xoá tự động sau 7 ngày.').catch(() => {});
    return true;
  }
  return false;
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
    case 'rank': {
      const member = target || user;
      if (!member) throw new Error('Không tìm thấy thành viên.');
      const profile = await ensureCommunityProfile(guild.id, member.id);
      const { xp, level, progress, need } = getLevelProgress(profile.xp);
      return embedPayload(new EmbedBuilder().setColor(0x5865F2).setTitle('✨ Rank · ' + (member.user.globalName || member.user.username))
        .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
        .setDescription('**Level ' + level + '** · ' + xp + ' XP tổng\n`' + progressBar(progress, need) + '` ' + progress + '/100 XP tới level tiếp theo')
        .setFooter({ text: 'Aki Community · XP cooldown 60 giây/tin nhắn' }).setTimestamp());
    }
    case 'balance': {
      const member = target || user;
      if (!member) throw new Error('Không tìm thấy thành viên.');
      const profile = await ensureCommunityProfile(guild.id, member.id);
      return embedPayload(new EmbedBuilder().setColor(0xFEE75C).setTitle('🪙 Ví xu · ' + (member.user.globalName || member.user.username))
        .setDescription('**' + (Number(profile.coins) || 0).toLocaleString('en-US') + ' xu**')
        .setFooter({ text: 'Xu ảo trong server · không có giá trị tiền thật' }).setTimestamp());
    }
    case 'daily': {
      const result = await claimCommunityCoins(guild.id, userId, 'daily');
      if (!result.ok) return reply('⏳ Bạn đã nhận daily rồi. Nhận lại ' + `<t:${Math.ceil(result.nextAt / 1000)}:R>` + '.');
      return reply('🌞 Bạn nhận được **+' + result.reward + ' xu**! Số dư: **' + result.coins.toLocaleString('en-US') + ' xu**.');
    }
    case 'work': {
      const result = await claimCommunityCoins(guild.id, userId, 'work');
      if (!result.ok) return reply('🛠️ Bạn vừa làm việc rồi. Có thể làm tiếp ' + `<t:${Math.ceil(result.nextAt / 1000)}:R>` + '.');
      return reply('🛠️ Hoàn thành công việc và nhận **+' + result.reward + ' xu**! Số dư: **' + result.coins.toLocaleString('en-US') + ' xu**.');
    }
    case 'leaderboard': {
      const kind = args.kind === 'coins' ? 'coins' : 'levels';
      const rows = await getCommunityLeaderboard(guild.id, kind, 10);
      const body = rows.length ? rows.map(row => kind === 'coins'
        ? '`#' + row.rank + '` <@' + row.user_id + '> · **' + Number(row.coins).toLocaleString('en-US') + ' xu**'
        : '`#' + row.rank + '` <@' + row.user_id + '> · **Level ' + row.level + '** (' + Number(row.xp).toLocaleString('en-US') + ' XP)'
      ).join('\n') : 'Chưa có dữ liệu. Hãy trò chuyện hoặc dùng /daily để bắt đầu.';
      return embedPayload(new EmbedBuilder().setColor(0x5865F2).setTitle(kind === 'coins' ? '🏆 Top xu server' : '🏆 Top level server')
        .setDescription(body).setFooter({ text: 'Aki Community · cập nhật trực tiếp từ profile' }).setTimestamp());
    }
    case 'poll': {
      const opts = [args.option1, args.option2, args.option3, args.option4].filter(Boolean);
      const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
      const question = sanitizePollText(args.question || 'Bình chọn', 250);
      const safeOptions = opts.map(value => sanitizePollText(value, 900));
      const safeFooter = sanitizePollFooter(userName);
      return embedPayload(new EmbedBuilder().setTitle('◈ ' + question).setDescription(safeOptions.map((v, i) => emojis[i] + ' ' + v).join('\n\n')).setFooter({ text: 'Poll by ' + safeFooter }).setTimestamp());
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
      const seconds = parseDuration(args.duration ?? args.seconds);
      const executeAt = Date.now() + seconds * 1000;
      const reminderId = await scheduleReminder(guild.id, userId, channel.id, String(args.text || '').slice(0, 1000), executeAt);
      if (!pool) {
        const timer = setTimeout(() => {
          channel.send({ content: `<@${userId}> ⏰ **Nhắc bạn:** ${String(args.text || '').slice(0, 1000)}`, allowedMentions: { parse: [], users: [userId] } })
            .catch(() => {}).finally(() => {
              memoryReminderTimers.delete(reminderId);
              memory.reminders = memory.reminders.filter(row => Number(row.id) !== Number(reminderId));
              releaseMemoryReminder(guild.id, userId);
            });
        }, seconds * 1000);
        memoryReminderTimers.set(reminderId, timer);
      }
      return reply(`⏰ Đã đặt lời nhắc #${reminderId} sau **${args.duration ?? seconds + 's'}**.`);
    }
    case 'reminders': {
      const rows = await listPendingReminders(guild.id, userId);
      if (!rows.length) return reply('Bạn không có lời nhắc nào đang chờ.');
      const body = rows.map(row => '#' + row.id + ' · <t:' + Math.floor(Number(row.execute_at) / 1000) + ':R> · ' + String(row.text || '').slice(0, 150)).join('\\n');
      return embedPayload(new EmbedBuilder().setColor(0x5865F2).setTitle('⏰ Lời nhắc của bạn').setDescription(body).setFooter({ text: 'Huỷ bằng /reminder-cancel reminder_id' }).setTimestamp());
    }
    case 'reminder-cancel': {
      const id = Number(args.reminderId);
      if (!Number.isSafeInteger(id) || id < 1) throw new Error('Reminder ID không hợp lệ.');
      const cancelled = await cancelPendingReminder(guild.id, userId, id);
      if (!cancelled) throw new Error('Không tìm thấy lời nhắc đang chờ của bạn.');
      return reply('✅ Đã huỷ lời nhắc #' + id + '.');
    }
    case 'afk': {
      const media = args.media_url || args.image_url || null;
      const afk = await setAfk(guild.id, userId, args.reason, media);
      return afkPayload(user?.user || guild.client.users.cache.get(userId), afk);
    }
    case 'legit': {
      ensureMemberPermission(user, PermissionFlagsBits.ManageRoles);
      if (!target) throw new Error('Không tìm thấy thành viên cần xác minh. Dùng +legit @thành_viên.');
      ensureTargetBelowInvoker(user, target, 'xác minh/gán role Legit');
      if (target.id === guild.ownerId) throw new Error('Owner không cần gắn role Legit.');
      const role = await ensureNamedRole(guild, '✅ Legit', 0x57F287, []);
      const me = guild.members.me || await guild.members.fetchMe();
      if (role.position >= me.roles.highest.position) throw new Error('Role ✅ Legit phải nằm dưới role cao nhất của bot trong Server Settings → Roles.');
      await target.roles.add(role, 'Legit verified by staff ' + userId);
      const vouchChannel = guild.channels.cache.find(c => c.name === '✅・legit-vouches' && c.isTextBased());
      if (vouchChannel) {
        try {
          const botMember = guild.members.me || await guild.members.fetchMe();
          if (vouchChannel.permissionsFor(botMember)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
            await vouchChannel.send({ embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('✅ Legit verified').setDescription('**' + (target.user.globalName || target.user.username) + '** đã được staff xác minh.').addFields({ name: 'Thành viên', value: '<@' + target.id + '>', inline: true }, { name: 'Staff xác minh', value: '<@' + userId + '>', inline: true }).setTimestamp()], allowedMentions: { parse: [] } });
          }
        } catch (error) { console.warn('Legit vouch message failed:', error.message); }
      }
      await addActivity(guild.id, userId, 'legit:verified', '✅ Đã xác minh ' + (target.user.globalName || target.user.username) + ' bằng role ' + role.name + '.');
      return reply('✅ Đã xác minh legit cho **' + (target.user.globalName || target.user.username) + '**. Role ✅ Legit đã được gắn.');
    }
    case 'ticket-setup': {
      ensureMemberPermission(user, PermissionFlagsBits.ManageChannels);
      const panelChannel = args.channel ? await guild.channels.fetch(args.channel).catch(() => null) : channel;
      const message = await setupTicketPanel(guild, panelChannel, userId);
      return reply('🎫 Đã đăng bảng ticket tại <#' + message.channelId + '>.');
    }
    case 'role-panel': {
      ensureMemberPermission(user, PermissionFlagsBits.ManageRoles);
      const panelChannel = args.channel ? await guild.channels.fetch(args.channel).catch(() => null) : channel;
      const message = await setupRolePanel(guild, panelChannel, userId);
      return reply('🎭 Đã đăng bảng tự nhận role tại <#' + message.channelId + '>.');
    }
    case 'warn': {
      ensureMemberPermission(user, PermissionFlagsBits.ModerateMembers);
      if (!target) throw new Error('Không tìm thấy target.');
      ensureTargetBelowInvoker(user, target, 'cảnh cáo');
      if (target.id === guild.ownerId) throw new Error('Không thể cảnh cáo owner.');
      const audit = formatAuditReason(userName, args.reason);
      await addWarning(guild.id, target.id, userId, audit);
      const record = await addModerationCase(guild.id, target.id, userId, 'warn', audit);
      const count = (await getWarnings(guild.id, target.id)).length;
      await target.send(`⚠️ Bạn vừa nhận cảnh cáo tại **${guild.name}**. Lý do: ${String(args.reason || 'Không có lý do').slice(0, 800)}`).catch(() => {});
      return reply(`⚠️ Đã cảnh cáo **${target.user.globalName || target.user.username}**. Tổng: **${count}**. Case #${record.case_id}.`);
    }
    case 'warnings': {
      ensureMemberPermission(user, PermissionFlagsBits.ModerateMembers);
      const m = target || user;
      const list = await getWarnings(guild.id, m.id);
      return reply(`📋 **Warnings · ${m.user.globalName || m.user.username}**\n${list.length ? list.map((w, i) => `#${w.id || i + 1} · ${w.reason}`).join('\n') : 'Không có cảnh cáo.'}`);
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
      ensureTargetBelowInvoker(user, target, 'kick');
      if (!target.kickable) throw new Error('Bot không thể kick target này.');
      const audit = formatAuditReason(userName, args.reason);
      await target.kick(audit);
      const record = await addModerationCase(guild.id, target.id, userId, 'kick', audit);
      return reply(`👢 Đã kick **${target.user.globalName || target.user.username}**. Case #${record.case_id}.`);
    }
    case 'ban': {
      ensureMemberPermission(user, PermissionFlagsBits.BanMembers);
      if (!target) throw new Error('Không tìm thấy target.');
      ensureTargetBelowInvoker(user, target, 'ban');
      if (!target.bannable) throw new Error('Bot không thể ban target này.');
      const audit = formatAuditReason(userName, args.reason);
      await target.ban({ reason: audit, deleteMessageSeconds: 0 });
      const record = await addModerationCase(guild.id, target.id, userId, 'ban', audit);
      return reply(`⛔ Đã ban **${target.user.globalName || target.user.username}**. Case #${record.case_id}.`);
    }

    case 'unban': {
      ensureMemberPermission(user, PermissionFlagsBits.BanMembers);
      const targetId = String(args.userId || '');
      if (!/^[0-9]{17,20}$/.test(targetId)) throw new Error('Discord user ID không hợp lệ.');
      const audit = formatAuditReason(userName, args.reason);
      await guild.members.unban(targetId, audit);
      await removeTempBan(guild.id, targetId);
      const record = await addModerationCase(guild.id, targetId, userId, 'unban', audit);
      return reply('✅ Đã gỡ ban cho ID `' + targetId + '`. Case #' + record.case_id + '.');
    }
    case 'untimeout': {
      ensureMemberPermission(user, PermissionFlagsBits.ModerateMembers);
      if (!target) throw new Error('Không tìm thấy thành viên.');
      ensureTargetBelowInvoker(user, target, 'gỡ timeout');
      const audit = formatAuditReason(userName, args.reason);
      await target.timeout(null, audit);
      const record = await addModerationCase(guild.id, target.id, userId, 'untimeout', audit);
      return reply('✅ Đã gỡ timeout cho **' + (target.user.globalName || target.user.username) + '**. Case #' + record.case_id + '.');
    }
    case 'delwarn': {
      ensureMemberPermission(user, PermissionFlagsBits.ModerateMembers);
      const deleted = await deleteWarning(guild.id, args.warningId);
      if (!deleted) throw new Error('Không tìm thấy cảnh cáo trong server này.');
      const record = await addModerationCase(guild.id, deleted.user_id, userId, 'delwarn', formatAuditReason(userName, 'Xoá cảnh cáo #' + args.warningId));
      return reply('🧹 Đã xoá cảnh cáo #' + args.warningId + '. Case #' + record.case_id + '.');
    }
    case 'case': {
      ensureMemberPermission(user, PermissionFlagsBits.ModerateMembers);
      const item = await getModerationCase(guild.id, args.caseId);
      if (!item) throw new Error('Không tìm thấy case trong server này.');
      return embedPayload(new EmbedBuilder().setColor(0x5865F2).setTitle('🧾 Moderation Case #' + item.case_id).addFields(
        { name: 'Action', value: String(item.action).slice(0, 100), inline: true },
        { name: 'Thành viên', value: '<@' + item.target_user_id + '> (' + item.target_user_id + ')', inline: false },
        { name: 'Moderator', value: '<@' + item.moderator_id + '> (' + item.moderator_id + ')', inline: false },
        { name: 'Lý do / audit', value: String(item.reason || 'No reason').slice(0, 1000), inline: false },
        { name: 'Thời gian', value: new Date(item.created_at).toISOString(), inline: false }
      ).setTimestamp());
    }
    case 'modlog': {
      ensureMemberPermission(user, PermissionFlagsBits.ModerateMembers);
      const items = await getModerationLog(guild.id, args.user || null, 10);
      if (!items.length) return reply('Chưa có case moderation trong phạm vi này.');
      const body = items.map(item => '#' + item.case_id + ' · **' + item.action + '** · <@' + item.target_user_id + '> · ' + String(item.reason || 'No reason').slice(0, 160)).join('\n');
      return embedPayload(new EmbedBuilder().setColor(0x5865F2).setTitle('🧾 Modlog · ' + (args.user ? 'thành viên' : 'server')).setDescription(body).setFooter({ text: 'Dùng /case case_id để xem chi tiết' }).setTimestamp());
    }
    case 'vouch': {
      if (!target) throw new Error('Không tìm thấy thành viên nhận vouch.');
      if (vouchDenialReason(userId, target.id, false) === 'self-vouch') throw new Error('Bạn không thể tự vouch cho chính mình.');
      const result = await addVouch(guild.id, userId, target.id, args.message);
      if (!result.ok && result.reason === 'duplicate-vouch') throw new Error('Bạn đã vouch cho thành viên này rồi; mỗi cặp chỉ được vouch một lần.');
      await addActivity(guild.id, userId, 'vouch:created', '⭐ Đã vouch cho ' + (target.user.globalName || target.user.username) + '.').catch(() => {});
      return reply('⭐ Cảm ơn bạn đã vouch cho **' + (target.user.globalName || target.user.username) + '**.');
    }
    case 'vouches': {
      const member = target || user;
      if (!member) throw new Error('Không tìm thấy thành viên.');
      const result = await getVouches(guild.id, member.id);
      if (!result.rows.length) return reply('Chưa có vouch cho **' + (member.user.globalName || member.user.username) + '**. Tổng: ' + result.total + '.');
      const body = result.rows.map((row, i) => (i + 1) + '. <@' + row.author_id + '> — ' + String(row.message || 'Không có ghi chú').slice(0, 250)).join('\n');
      return embedPayload(new EmbedBuilder().setColor(0x57F287).setTitle('⭐ Vouches · ' + (member.user.globalName || member.user.username)).setDescription(body).setFooter({ text: 'Tổng vouch: ' + result.total + ' · hiển thị tối đa 10 gần nhất' }).setTimestamp());
    }
    case 'scam-add': {
      ensureMemberPermission(user, PermissionFlagsBits.ManageGuild);
      if (!/^[0-9]{17,20}$/.test(String(args.userId || ''))) throw new Error('Discord user ID không hợp lệ.');
      const row = await addScamFlag(guild.id, args.userId, userId, args.reason);
      const record = await addModerationCase(guild.id, args.userId, userId, 'scam-add', formatAuditReason(userName, args.reason));
      await addActivity(guild.id, userId, 'scam:blacklist-add', '🚨 Thêm ID ' + args.userId + ' vào danh sách cảnh báo.').catch(() => {});
      return reply('🚨 Đã thêm ID `' + row.user_id + '` vào danh sách cảnh báo của server. Case #' + record.case_id + '.');
    }
    case 'scamcheck': {
      if (!/^[0-9]{17,20}$/.test(String(args.userId || ''))) throw new Error('Discord user ID không hợp lệ.');
      const row = await checkScamFlag(guild.id, args.userId);
      if (!row) return reply('✅ ID `' + args.userId + '` không có trong danh sách cảnh báo của server này. Điều đó không đảm bảo giao dịch an toàn.');
      return embedPayload(new EmbedBuilder().setColor(0xED4245).setTitle('🚨 Cảnh báo scammer')
        .setDescription('ID `' + row.user_id + '` đang có trong danh sách cảnh báo của server.\nLý do: ' + String(row.reason || 'Không có ghi chú').slice(0, 800))
        .addFields({ name: 'Được thêm bởi', value: '<@' + row.added_by + '>', inline: true }, { name: 'Ngày', value: new Date(row.created_at).toISOString(), inline: true })
        .setFooter({ text: 'Hãy kiểm tra chứng cứ trước khi đưa ra kết luận.' }).setTimestamp());
    }

    case 'tempban': {
      ensureMemberPermission(user, PermissionFlagsBits.BanMembers);
      if (!target) throw new Error('Không tìm thấy target.');
      ensureTargetBelowInvoker(user, target, 'tempban');
      if (!target.bannable) throw new Error('Bot không thể ban target này.');
      const minutes = Number(args.minutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 40320) throw new Error('Thời lượng tempban phải từ 1 đến 40320 phút.');
      const audit = formatAuditReason(userName, args.reason);
      const expiresAt = Date.now() + minutes * 60_000;
      await scheduleTempBan(guild.id, target.id, userId, audit, expiresAt);
      try { await target.ban({ reason: audit, deleteMessageSeconds: 0 }); }
      catch (error) { await removeTempBan(guild.id, target.id).catch(() => {}); throw error; }
      const record = await addModerationCase(guild.id, target.id, userId, 'tempban', audit + ' · expires ' + new Date(expiresAt).toISOString());
      return reply('⏳ Đã tempban **' + (target.user.globalName || target.user.username) + '** trong ' + minutes + ' phút. Bot sẽ tự gỡ ban khi hết hạn. Case #' + record.case_id + '.');
    }
    case 'timeout': {
      ensureMemberPermission(user, PermissionFlagsBits.ModerateMembers);
      if (!target) throw new Error('Không tìm thấy target.');
      ensureTargetBelowInvoker(user, target, 'timeout');
      if (!target.moderatable) throw new Error('Bot không thể timeout target này.');
      const audit = formatAuditReason(userName, args.reason);
      await target.timeout(Number(args.minutes) * 60_000, audit);
      const record = await addModerationCase(guild.id, target.id, userId, 'timeout', audit);
      return reply(`⏳ Đã timeout **${target.user.globalName || target.user.username}** trong **${args.minutes} phút**. Case #${record.case_id}.`);
    }
    case 'role': {
      ensureMemberPermission(user, PermissionFlagsBits.ManageRoles);
      if (!target || !args.role) throw new Error('Thiếu user hoặc role.');
      ensureTargetBelowInvoker(user, target, 'gán/gỡ role');
      const role = await guild.roles.fetch(args.role);
      if (!role) throw new Error('Không tìm thấy role.');
      ensureRoleBelowInvoker(user, role);
      const botMember = guild.members.me || await guild.members.fetchMe();
      if (role.position >= botMember.roles.highest.position) throw new Error('Role cần nằm dưới role cao nhất của bot.');
      if (args.mode === 'add') await target.roles.add(role); else if (args.mode === 'remove') await target.roles.remove(role); else throw new Error('mode phải là add hoặc remove.');
      return reply(`🎛️ Đã **${args.mode === 'add' ? 'thêm' : 'gỡ'}** role <@&${role.id}> cho ${target}.`);
    }
    case 'announce': {
      ensureMemberPermission(user, PermissionFlagsBits.ManageMessages);
      return embedPayload(new EmbedBuilder().setTitle('◈ ANNOUNCEMENT').setDescription(String(args.message)).setFooter({ text: `${APP_NAME} · by Aki dev` }).setTimestamp());
    }
    case 'vc-join': {
      ensureMemberPermission(user, PermissionFlagsBits.ManageGuild);
      const ch = await joinGuildVoice(guild, args.channel, 'manual');
      return reply(`🎧 Đã vào voice **${ch.name}**.`);
    }
    case 'vc-leave': {
      ensureMemberPermission(user, PermissionFlagsBits.ManageGuild);
      const c = getVoiceConnection(guild.id);
      if (!c) return reply('🎧 Bot không ở voice.');
      c.destroy();
      return reply('🎧 Đã rời voice.');
    }
    case 'welcome-setup':
    case 'goodbye-setup': {
      ensureMemberPermission(user, PermissionFlagsBits.ManageGuild);
      const targetChannel = args.channel ? await guild.channels.fetch(args.channel).catch(() => null) : null;
      if (!targetChannel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(targetChannel.type)) throw new Error('Chọn kênh text hoặc announcement thuộc server này.');
      const key = name === 'welcome-setup' ? 'welcome_channel_id' : 'goodbye_channel_id';
      await setConfig(guild.id, { [key]: targetChannel.id });
      await addActivity(guild.id, userId, name, '#' + targetChannel.name);
      return reply((name === 'welcome-setup' ? '👋 Kênh chào mừng' : '👋 Kênh tạm biệt') + ' đã được đặt thành <#' + targetChannel.id + '>.');
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
  if (['userinfo', 'avatar', 'warnings', 'legit', 'rank', 'balance', 'vouch', 'vouches', 'untimeout', 'modlog'].includes(interaction.commandName)) out.user = getUserId();
  if (['ticket-setup', 'role-panel'].includes(interaction.commandName)) out.channel = interaction.options.getChannel('channel')?.id || undefined;
  if (['warn', 'kick', 'ban', 'timeout'].includes(interaction.commandName)) { out.user = getUserId(); }
  if (interaction.commandName === 'warn' || interaction.commandName === 'kick' || interaction.commandName === 'ban' || interaction.commandName === 'timeout') out.reason = interaction.options.getString('reason');
  if (['timeout', 'tempban'].includes(interaction.commandName)) out.minutes = interaction.options.getInteger('minutes');
  if (interaction.commandName === 'untimeout') out.reason = interaction.options.getString('reason');
  if (interaction.commandName === 'unban') { out.userId = interaction.options.getString('user_id'); out.reason = interaction.options.getString('reason'); }
  if (interaction.commandName === 'delwarn') out.warningId = interaction.options.getInteger('warning_id');
  if (interaction.commandName === 'case') out.caseId = interaction.options.getInteger('case_id');
  if (interaction.commandName === 'vouch') out.message = interaction.options.getString('message');
  if (interaction.commandName === 'scamcheck') out.userId = interaction.options.getString('user_id');
  if (interaction.commandName === 'scam-add') { out.userId = interaction.options.getString('user_id'); out.reason = interaction.options.getString('reason'); }
  if (interaction.commandName === 'poll') for (const k of ['question','option1','option2','option3','option4']) out[k] = interaction.options.getString(k) || undefined;
  if (interaction.commandName === 'leaderboard') out.kind = interaction.options.getString('type') || 'levels';
  if (interaction.commandName === '8ball') out.question = interaction.options.getString('question');
  if (interaction.commandName === 'roll') out.sides = interaction.options.getInteger('sides');
  if (interaction.commandName === 'remind') { out.duration = interaction.options.getString('duration'); out.text = interaction.options.getString('text'); }
  if (interaction.commandName === 'reminder-cancel') out.reminderId = interaction.options.getInteger('reminder_id');
  if (interaction.commandName === 'afk') { out.reason = interaction.options.getString('reason') || undefined; out.media_url = interaction.options.getAttachment('media')?.url || interaction.options.getString('image_url') || undefined; }
  if (interaction.commandName === 'clear' || interaction.commandName === 'slowmode') out[interaction.commandName === 'clear' ? 'amount' : 'seconds'] = interaction.options.getInteger(interaction.commandName === 'clear' ? 'amount' : 'seconds');
  if (interaction.commandName === 'role') { out.mode = interaction.options.getString('mode'); out.user = getUserId(); out.role = interaction.options.getRole('role')?.id; }
  if (interaction.commandName === 'announce') out.message = interaction.options.getString('message');
  if (['vc-join', 'welcome-setup', 'goodbye-setup'].includes(interaction.commandName)) out.channel = interaction.options.getChannel('channel')?.id;
  if (interaction.commandName === 'auto-voice') { out.enabled = interaction.options.getBoolean('enabled'); out.channel = interaction.options.getChannel('channel')?.id; }
  return out;
}

bot.on('error', error => { void reportRuntimeError(error, 'discord-client'); });
bot.on('shardError', error => { void reportRuntimeError(error, 'discord-shard'); });
process.on('unhandledRejection', reason => { void reportRuntimeError(reason instanceof Error ? reason : new Error(String(reason)), 'unhandled-rejection'); });
process.on('uncaughtException', error => {
  // Best-effort remote report, then exit so the hosting platform can restart a possibly corrupted process.
  const timeout = new Promise(resolve => setTimeout(resolve, 2500));
  Promise.race([reportRuntimeError(error, 'uncaught-exception'), timeout]).finally(() => process.exit(1));
});

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
    await guild.channels.fetch().catch(() => {});
    for (const channel of guild.channels.cache.values()) {
      const ticket = parseAkiTicketTopic(channel.topic);
      if (ticket.status === 'closed' && ticket.closedAt) scheduleClosedTicketDeletion(channel, ticket.closedAt);
    }
    const cfg = await getConfig(guild.id);
    if (cfg.auto_voice_enabled && cfg.auto_voice_channel_id) joinGuildVoice(guild, cfg.auto_voice_channel_id, 'auto').catch(e => console.error(`Auto voice ${guild.id}:`, e.message));
  }
  for (const guild of bot.guilds.cache.values()) {
    io.to('guild:' + guild.id).emit('bot-status', {
      type: 'ready',
      guildId: guild.id,
      guildName: guild.name,
      user: { id: bot.user.id, tag: bot.user.tag },
      guildCount: bot.guilds.cache.size
    });
  }
});

async function addPollReactions(message, count) {
  const emojis = ['1️⃣','2️⃣','3️⃣','4️⃣'];
  for (let i = 0; i < Math.min(count, emojis.length); i++) {
    try { await message.react(emojis[i]); } catch (error) { console.error('Poll reaction failed:', error.message); }
  }
}

async function applyReactionRole(reaction, user, shouldAdd) {
  if (user.bot) return;
  let guildId = reaction?.message?.guildId || reaction?.message?.guild?.id || null;
  let emojiName = reaction?.emoji?.name || 'unknown emoji';
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message?.partial) await reaction.message.fetch();
    const message = reaction.message;
    const guild = message?.guild;
    if (!guild || !message.id) return;
    guildId = guild.id;
    emojiName = reaction.emoji?.name || 'unknown emoji';
    // Only the currently configured reaction-role panel may assign roles.
    if (message.author?.id !== bot.user?.id) return;
    const panel = await getReactionRolePanel(guild.id);
    if (!isActiveReactionRolePanel(panel, message)) return;
    let binding;
    try { binding = await getReactionRoleBinding(guild.id, message.id, emojiName); }
    catch (dbError) {
      console.warn('Reaction-role binding lookup failed; ignoring reaction for safety:', dbError.message);
      return;
    }
    if (!binding?.role_id) return;

    const role = await guild.roles.fetch(binding.role_id).catch(() => null);
    if (!role || role.managed || role.id === guild.id) {
      throw new Error('Role đã bị xoá hoặc không thể tự gán. Hãy đăng lại bảng nhận role từ dashboard.');
    }
    const me = guild.members.me || await guild.members.fetchMe();
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      throw new Error('Bot đang thiếu quyền Manage Roles.');
    }
    if (role.position >= me.roles.highest.position) {
      if (shouldAdd) await reaction.users.remove(user.id).catch(() => {});
      throw new Error('Role ' + role.name + ' đang ở trên role cao nhất của bot.');
    }

    const member = await guild.members.fetch({ user: user.id, force: true }).catch(() => null);
    if (!member) return;
    if (shouldAdd && !member.roles.cache.has(role.id)) {
      await member.roles.add(role, 'Self-service reaction role');
      await addActivity(guild.id, user.id, 'role:reaction-add', '✅ Đã gán ' + role.name + ' bằng emoji ' + emojiName + '.').catch(() => {});
    } else if (!shouldAdd && member.roles.cache.has(role.id)) {
      await member.roles.remove(role, 'Self-service reaction role removed');
      await addActivity(guild.id, user.id, 'role:reaction-remove', '➖ Đã gỡ ' + role.name + ' bằng emoji ' + emojiName + '.').catch(() => {});
    }
  } catch (error) {
    const message = String(error?.message || 'unknown error');
    console.warn('Reaction-role handler failed:', { guildId, userId: user.id, emoji: emojiName, add: shouldAdd, error: message });
    void reportRuntimeError(error, shouldAdd ? 'reaction-role-add' : 'reaction-role-remove', guildId);
    if (guildId) {
      await addActivity(guildId, user.id, 'error:reaction-role',
        (shouldAdd ? 'Không thể cấp role' : 'Không thể gỡ role') + ' bằng emoji ' + emojiName + ': ' + message).catch(() => {});
    }
  }
}
bot.on('messageReactionAdd', (reaction, user) => applyReactionRole(reaction, user, true));
bot.on('messageReactionRemove', (reaction, user) => applyReactionRole(reaction, user, false));

bot.on('interactionCreate', async interaction => {
  if (interaction.isModalSubmit()) {
    try { if (await handleAkiModalSubmit(interaction)) return; }
    catch (error) {
      const message = '⚠️ ' + String(error.message || 'Không thể tạo ticket.');
      if (interaction.replied || interaction.deferred) await interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
      else await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
      if (interaction.guildId) addActivity(interaction.guildId, interaction.user.id, 'error:ticket-modal', error.message).catch(() => {});
    }
  }
  if (interaction.isButton()) {
    try { if (await handleAkiButton(interaction)) return; }
    catch (error) {
      const message = '⚠️ ' + String(error.message || 'Không thể hoàn thành thao tác.');
      if (interaction.replied || interaction.deferred) await interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
      else await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
      if (interaction.guildId) addActivity(interaction.guildId, interaction.user.id, 'error:button', error.message).catch(() => {});
    }
  }
  if (!interaction.isChatInputCommand() || !interaction.guildId) return;
  const ephemeralCommands = new Set(['remind', 'reminders', 'reminder-cancel', 'warnings', 'role', 'warn', 'kick', 'ban', 'tempban', 'timeout', 'unban', 'untimeout', 'delwarn', 'case', 'modlog', 'scam-add', 'scamcheck', 'legit', 'role-panel', 'ticket-setup', 'auto-voice', 'vc-join', 'vc-leave', 'clear']);
  try {
    // Acknowledge all slash commands before doing network/database work.
    await interaction.deferReply({ ephemeral: ephemeralCommands.has(interaction.commandName) });
    const args = extractInteractionArgs(interaction);
    const payload = await runCommand(interaction.commandName, { guild: interaction.guild, userId: interaction.user.id, userName: interaction.user.globalName || interaction.user.username, channel: interaction.channel, args, source: 'discord' });
    await interaction.editReply(payload);
    if (interaction.commandName === 'poll') { const sent = await interaction.fetchReply(); await addPollReactions(sent, [args.option1,args.option2,args.option3,args.option4].filter(Boolean).length); }
    await addActivity(interaction.guildId, interaction.user.id, `/${interaction.commandName}`, `✅ Slash command bởi ${interaction.user.globalName || interaction.user.username} tại #${interaction.channel?.name || 'unknown-channel'}.`);
  } catch (error) {
    const msg = `⚠️ ${error.message}`;
    if (interaction.deferred) await interaction.editReply({ content: msg, embeds: [], components: [] }).catch(() => {});
    else if (interaction.replied) await interaction.followUp({ content: msg, ephemeral: true }).catch(() => {});
    else await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    addActivity(interaction.guildId, interaction.user.id, `error:/${interaction.commandName}`, `❌ Slash command thất bại bởi ${interaction.user.globalName || interaction.user.username}: ${error.message}`).catch(() => {});
  }
});

bot.on('messageCreate', async message => {
  if (!message.guild || message.author.bot) return;
  if (/^\+legit(?:\s|$)/i.test(message.content.trim())) {
    try {
      const match = message.content.trim().match(/^\+legit(?:\s+\+?\s*(?:<@!?(\d{17,20})>|@?(\d{17,20})))?\s*$/i);
      if (!match) {
        await message.reply('Dùng `+legit` hoặc `+legit + @<ID_đã_cấu_hình>`.').catch(() => {});
        return;
      }
      const targetId = match[1] || match[2] || null;
      if (!LEGIT_TARGET_USER_ID) throw new Error('Tính năng +legit chưa được cấu hình. Chủ bot cần đặt LEGIT_TARGET_USER_ID trong Environment.');
      const isConfiguredAccount = message.author.id === LEGIT_TARGET_USER_ID;
      if (targetId && targetId !== LEGIT_TARGET_USER_ID) throw new Error('Tài khoản được nhắc không khớp với tài khoản đã cấu hình.');
      if (!isConfiguredAccount && !targetId) throw new Error('Dùng +legit + @tài_khoản_đã_cấu_hình để xác nhận.');
      if (!isConfiguredAccount) {
        const actor = message.member || await fetchGuildMember(message.guild, message.author.id);
        ensureMemberPermission(actor, PermissionFlagsBits.ManageRoles);
      }
      if (targetId) {
        const targetMember = await message.guild.members.fetch(targetId).catch(() => null);
        if (!targetMember) throw new Error('Tài khoản được cấu hình chưa ở trong server này.');
      }
      const botMember = message.guild.members.me || await message.guild.members.fetchMe();
      if (!message.channel?.permissionsFor(botMember)?.has(PermissionFlagsBits.AddReactions)) {
        throw new Error('Bot đang thiếu quyền Add Reactions trong kênh này.');
      }
      await message.react('✅');
      await addActivity(message.guild.id, message.author.id, '+legit:reaction', '✅ Reacted to +legit command in #' + message.channel.name + '.');
    } catch (error) {
      await message.reply('⚠️ ' + error.message).catch(() => {});
      addActivity(message.guild.id, message.author.id, 'error:+legit', '❌ +legit failed: ' + error.message).catch(() => {});
    }
    return;
  }
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
    if (!message.content.startsWith(prefix) && message.content.trim().length >= 4) {
      try {
        const gain = calculateMessageXp(Math.random(), XP_PER_MESSAGE_MIN, XP_PER_MESSAGE_MAX);
        const profile = await awardCommunityXp(message.guild.id, message.author.id, gain);
        if (profile && Math.floor((profile.xp - profile.gain) / 100) < profile.level) {
          await message.channel.send('🎉 <@' + message.author.id + '> lên **Level ' + profile.level + '**! Dùng `/rank` để xem tiến độ.').catch(() => {});
          await addActivity(message.guild.id, message.author.id, 'level:up', '🎉 Đạt Level ' + profile.level + ' với ' + profile.xp + ' XP.').catch(() => {});
        }
      } catch (error) {
        void reportRuntimeError(error, 'community-xp', message.guild.id);
      }
    }
    if (!message.content.startsWith(prefix)) return;
    const [name, ...parts] = message.content.slice(prefix.length).trim().split(/\s+/);
    if (!name || !commands.some(c => c.name === name)) return;
    const basicMap = {
      ping: {}, help: {}, server: {}, botinfo: {}, coinflip: {},
      '8ball': { question: parts.join(' ') }, roll: { sides: Number(parts[0]) || 6 }, remind: { duration: parts[0], text: parts.slice(1).join(' ') },
      announce: { message: parts.join(' ') }, clear: { amount: Number(parts[0]) }, slowmode: { seconds: Number(parts[0]) }, lock: {}, unlock: {},
      rank: {}, balance: {}, daily: {}, work: {}, leaderboard: { kind: parts[0] === 'coins' ? 'coins' : 'levels' },
      reminders: {}, 'reminder-cancel': { reminderId: Number(parts[0]) },
      'vc-leave': {}
    };
    if (['rank', 'balance'].includes(name)) {
      const userMention = message.mentions.users.first();
      const rawId = parts.find(part => /^\d{17,20}$/.test(part));
      if (userMention || rawId) basicMap[name].user = userMention?.id || rawId;
    }
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
bot.on('guildMemberAdd', async member => {
  let autoRoleName = null;
  let cfg = null;
  try { cfg = await getConfig(member.guild.id); }
  catch (error) { void reportRuntimeError(error, 'member-join-config', member.guild.id); }
  // Welcome failures must never prevent a new member receiving their automatic role.
  try {
    if (cfg?.welcome_channel_id) {
      const channel = await member.guild.channels.fetch(cfg.welcome_channel_id).catch(() => null);
      if (!channel?.isTextBased?.()) throw new Error('Kênh welcome đã bị xoá hoặc không phải kênh text.');
      await channel.send({ embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('👋 Chào mừng thành viên mới!').setDescription('Chào mừng ' + member.toString() + ' đến với **' + member.guild.name + '**!\nHãy đọc nội quy và chọn role phù hợp nhé.').setThumbnail(member.user.displayAvatarURL({ size: 256 })).setTimestamp()], allowedMentions: { users: [member.id] } });
    }
  } catch (error) { void reportRuntimeError(error, 'welcome-message', member.guild.id); }
  try {
    const role = cfg?.auto_role_id ? await member.guild.roles.fetch(cfg.auto_role_id).catch(() => null) : null;
    const fallbackRole = role || member.guild.roles.cache.find(r => r.name === '👥 Member') || null;
    if (fallbackRole) {
      const me = member.guild.members.me || await member.guild.members.fetchMe();
      if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('Bot thiếu quyền Manage Roles để cấp auto-role.');
      if (fallbackRole.position >= me.roles.highest.position) throw new Error('Role auto-role đang ở trên role cao nhất của bot.');
      await member.roles.add(fallbackRole, 'Aki automatic join role');
      autoRoleName = fallbackRole.name;
    }
  } catch (error) { void reportRuntimeError(error, 'auto-role-assignment', member.guild.id); }
  await addActivity(member.guild.id, member.id, 'member:join', `👋 ${member.user.globalName || member.user.username} đã tham gia server.` + (autoRoleName ? ` · auto-role: ${autoRoleName}` : '')).catch(() => {});
});
bot.on('guildMemberRemove', async member => {
  try {
    const cfg = await getConfig(member.guild.id);
    if (cfg.goodbye_channel_id) {
      const channel = await member.guild.channels.fetch(cfg.goodbye_channel_id).catch(() => null);
      if (channel?.isTextBased?.()) await channel.send({ embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('👋 Một thành viên đã rời đi').setDescription('**' + (member.user.globalName || member.user.username) + '** đã rời khỏi server.').setThumbnail(member.user.displayAvatarURL({ size: 128 })).setTimestamp()], allowedMentions: { parse: [] } });
    }
  } catch (error) { void reportRuntimeError(error, 'goodbye-message', member.guild.id); }
  addActivity(member.guild.id, member.id, 'member:leave', `👋 ${member.user.globalName || member.user.username} đã rời server.`).catch(() => {});
});
bot.on('voiceStateUpdate', async (oldState, newState) => {
  if (!bot.user || newState.id !== bot.user.id) return;
  const cfg = await getConfig(newState.guild.id);
  if (cfg.auto_voice_enabled && cfg.auto_voice_channel_id && !newState.channelId) {
    scheduleAutoVoiceReconnect(newState.guild, cfg.auto_voice_channel_id, 4_000);
  }
});

app.get('/api/commands', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ commands: commands.map(command => ({
    name: command.name,
    description: command.description || '',
    options: Array.isArray(command.options) ? command.options : [],
    defaultMemberPermissions: command.default_member_permissions || null
  })) });
});
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'aki-discord-control', persistence: pool ? 'postgres' : 'memory', time: new Date().toISOString(), bot: bot.isReady(), sessionPersistence: Boolean(pool) }));
app.get('/health', (_req, res) => res.status(200).send('OK'));

app.get('/invite', (_req, res) => {
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!clientId) return res.status(503).send('Discord invite is not configured: set DISCORD_CLIENT_ID.');
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('permissions', '1099783334998');
  url.searchParams.set('scope', 'bot applications.commands');
  return res.redirect(url.toString());
});

app.get('/api/public/stats', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=30');
  res.json({ botReady: bot.isReady(), guilds: bot.guilds.cache.size, commands: commands.length });
});

app.get('/api/public/guilds/:guildId/leaderboard', async (req, res) => {
  const guildId = String(req.params.guildId || '');
  if (!/^[0-9]{17,20}$/.test(guildId)) return res.status(400).json({ error: 'INVALID_GUILD_ID' });
  const guild = bot.guilds.cache.get(guildId);
  if (!guild) return res.status(404).json({ error: 'PUBLIC_LEADERBOARD_NOT_AVAILABLE' });
  const kind = req.query.type === 'coins' ? 'coins' : 'levels';
  try {
    const rows = await getCommunityLeaderboard(guildId, kind, 10);
    res.set('Cache-Control', 'public, max-age=30');
    return res.json({
      guild: { id: guild.id, name: guild.name, icon: guild.iconURL({ size: 128 }) },
      type: kind,
      rows: rows.map(row => ({ rank: row.rank, userId: row.user_id, level: Number(row.level) || 0, xp: Number(row.xp) || 0, coins: Number(row.coins) || 0 }))
    });
  } catch (error) {
    console.error('Public leaderboard failed:', error.message);
    return res.status(500).json({ error: 'LEADERBOARD_UNAVAILABLE' });
  }
});

app.get('/api/me', async (req, res) => {
  const s = getSession(req);
  if (!s) return res.json({ authenticated: false });
  const sessionId = getCookieValue(req, SESSION_COOKIE);
  const accessToken = await getDiscordAccessTokenForSession(s).catch(error => {
    console.warn('Discord OAuth guild refresh token unavailable:', error.message);
    return null;
  });
  if (accessToken) {
    try { s.guilds = await discordApi('/users/@me/guilds', accessToken); }
    catch (error) { console.warn('Discord guild list refresh failed:', error.message); }
  }
  await persistSession(sessionId).catch(error => console.warn('Could not persist login session:', error.message));
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
  res.json({
    authenticated: true, user: s.user, guilds, manageableGuilds,
    guildDiagnostics: {
      discordGuildCount: userGuilds.length,
      botGuildCount: bot.guilds.cache.size,
      sharedGuildCount: guilds.length,
      manageableGuildCount: manageableGuilds.length,
      manageableMissingBotCount: manageableGuilds.filter(g => !g.botPresent).length,
      botReady: bot.isReady()
    },
    bot: { ready: bot.isReady(), id: bot.user?.id || null, tag: bot.user?.tag || null, guilds: bot.guilds.cache.size, ping: Math.round(bot.ws.ping), commands: commands.length }
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
app.get('/api/guilds/:guildId/members', requireAuth, async (req, res) => {
  const guild = bot.guilds.cache.get(req.params.guildId);
  const meta = (req.session.guilds || []).find(item => item.id === req.params.guildId);
  if (!guild || !canManageGuildFromOAuthMeta(meta)) return res.status(403).json({ error: 'NO_GUILD_PERMISSION' });
  try {
    await guild.members.fetch({ limit: 100 }).catch(() => {});
    const members = [...guild.members.cache.values()]
      .filter(member => !member.user.bot)
      .slice(0, 100)
      .map(member => ({ id: member.id, label: member.displayName || member.user.globalName || member.user.username, username: member.user.username }));
    return res.json({ members });
  } catch {
    return res.status(503).json({ error: 'MEMBER_LIST_UNAVAILABLE' });
  }
});
app.get('/api/guilds/:guildId/config', requireAuth, async (req, res) => {
  const g = bot.guilds.cache.get(req.params.guildId);
  const meta = (req.session.guilds || []).find(x => x.id === req.params.guildId);
  if (!g || !canManageGuildFromOAuthMeta(meta)) return res.status(403).json({ error: 'NO_GUILD_PERMISSION' });
  res.json({ config: await getConfig(g.id), roles: [...g.roles.cache.values()].filter(r => !r.managed && r.id !== g.id).sort((a,b) => b.position-a.position).map(r => ({ id: r.id, name: r.name, position: r.position })), stats: { members: g.memberCount, channels: g.channels.cache.size, roles: g.roles.cache.size, emojis: g.emojis.cache.size, ping: Math.round(bot.ws.ping) } });
});

function canManageGuildFromOAuthMeta(meta) {
  if (!meta) return false;
  if (Boolean(meta.owner)) return true;
  try { return (BigInt(meta.permissions || '0') & (8n | 32n)) !== 0n; }
  catch { return false; }
}

setupActivitySocketAuth();

function discordActorId(session) {
  const user = session?.user, candidate = user?.discordId || (user?.provider === 'discord' ? user.id : null);
  return typeof candidate === 'string' && /^\d{17,20}$/.test(candidate) ? candidate : null;
}
async function requireGuildControl(req, res) {
  if (!discordActorId(req.session)) throw Object.assign(new Error('Hãy đăng nhập bằng Discord để điều khiển bot và server.'), { status: 409 });
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
    if (Object.prototype.hasOwnProperty.call(body, 'auto_role_id') && body.auto_role_id) {
      const autoRole = await guild.roles.fetch(String(body.auto_role_id)).catch(() => null);
      if (!autoRole || autoRole.managed || autoRole.id === guild.id) return res.status(400).json({ error: 'AUTO_ROLE_INVALID' });
      const topRole = (guild.members.me || await guild.members.fetchMe()).roles.highest;
      if (autoRole.position >= topRole.position) return res.status(400).json({ error: 'AUTO_ROLE_ABOVE_BOT' });
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
      log_channel_id: Object.prototype.hasOwnProperty.call(body, 'log_channel_id') ? (body.log_channel_id || null) : currentConfig.log_channel_id || null,
      auto_role_id: Object.prototype.hasOwnProperty.call(body, 'auto_role_id') ? (body.auto_role_id || null) : currentConfig.auto_role_id || null
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
    const actorId = discordActorId(req.session);
    if (!actorId) return res.status(409).json({ error: 'DISCORD_LINK_REQUIRED' });
    const payload = await runCommand(name, { guild, userId: actorId, userName: req.session.user.username, channel, args, source: 'web' });
    const sendable = channel?.isTextBased?.() && payload;
    let sent = null;
    if (sendable) sent = await channel.send(payload);
    if (sent && name === 'poll') await addPollReactions(sent, [args.option1,args.option2,args.option3,args.option4].filter(Boolean).length);
    await addActivity(guild.id, req.session.user.id, `web:${name}`, `✅ Chạy từ dashboard bởi ${req.session.user.username || 'user'} tại #${channel?.name || 'unknown-channel'}.`);
    res.json({ ok: true, command: name, payload: typeof payload === 'string' ? payload : 'embed', channelId: sent?.channelId || channel?.id || null, messageId: sent?.id || null });
  } catch (error) { void reportRuntimeError(error, 'api:command', req.params.guildId); res.status(error.status || 500).json({ error: error.message }); }
});

app.post('/api/guilds/:guildId/announce', requireAuth, async (req, res) => {
  try {
    const { guild } = await requireGuildControl(req, res);
    const actorId = discordActorId(req.session);
    if (!actorId) return res.status(409).json({ error: 'DISCORD_LINK_REQUIRED' });
    const actor = await fetchGuildMember(guild, actorId);
    ensureMemberPermission(actor, PermissionFlagsBits.ManageMessages);

    const channelId = String(req.body?.channelId || '');
    const channel = channelId ? await guild.channels.fetch(channelId).catch(() => null) : null;
    if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) || channel.guild?.id !== guild.id) {
      return res.status(400).json({ error: 'ANNOUNCEMENT_CHANNEL_INVALID' });
    }
    const title = String(req.body?.title || '📣 THÔNG BÁO').trim().slice(0, 256);
    const messageText = String(req.body?.message || '').trim();
    if (!messageText) return res.status(400).json({ error: 'ANNOUNCEMENT_MESSAGE_REQUIRED' });
    if (messageText.length > 4000) return res.status(400).json({ error: 'ANNOUNCEMENT_MESSAGE_TOO_LONG' });

    const pingEveryone = Boolean(req.body?.pingEveryone);
    if (pingEveryone) ensureMemberPermission(actor, PermissionFlagsBits.MentionEveryone);
    const me = guild.members.me || await guild.members.fetchMe();
    const channelPermissions = channel.permissionsFor(me);
    if (!channelPermissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
      return res.status(403).json({ error: 'Bot cần View Channel, Send Messages và Embed Links ở kênh thông báo.' });
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(title || '📣 THÔNG BÁO')
      .setDescription(messageText)
      .setFooter({ text: APP_NAME + ' · Web Announcement' })
      .setTimestamp();
    const sent = await channel.send({
      content: pingEveryone ? '@everyone' : undefined,
      embeds: [embed],
      allowedMentions: { parse: pingEveryone ? ['everyone'] : [] }
    });
    await addActivity(guild.id, actorId, 'web:announce', '📣 Đã gửi thông báo từ dashboard tới #' + channel.name + '.');
    res.json({ ok: true, channelId: channel.id, channelName: channel.name, messageId: sent.id });
  } catch (error) {
    void reportRuntimeError(error, 'api:announce', req.params.guildId);
    res.status(error.status || 500).json({ error: error.message || 'ANNOUNCEMENT_FAILED' });
  }
});

app.post('/api/guilds/:guildId/voice/join', requireAuth, async (req, res) => {
  try {
    const { guild } = await requireGuildControl(req, res);
    const actorId = discordActorId(req.session);
    if (!actorId) return res.status(409).json({ error: 'DISCORD_LINK_REQUIRED' });
    const member = await fetchGuildMember(guild, actorId);
    ensureMemberPermission(member, PermissionFlagsBits.ManageGuild);
    const ch = await joinGuildVoice(guild, req.body.channelId, 'manual');
    await addActivity(guild.id, req.session.user.id, 'voice:join', ch.name);
    res.json({ ok: true, channel: { id: ch.id, name: ch.name } });
  } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});
app.post('/api/guilds/:guildId/voice/leave', requireAuth, async (req, res) => {
  try {
    const { guild } = await requireGuildControl(req, res);
    const actorId = discordActorId(req.session);
    if (!actorId) return res.status(409).json({ error: 'DISCORD_LINK_REQUIRED' });
    const member = await fetchGuildMember(guild, actorId);
    ensureMemberPermission(member, PermissionFlagsBits.ManageGuild);
    const c = getVoiceConnection(guild.id);
    c?.destroy();
    await addActivity(guild.id, req.session.user.id, 'voice:leave', 'manual');
    res.json({ ok: true });
  } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});


app.post('/api/guilds/:guildId/roles-panel', requireAuth, async (req, res) => {
  try {
    const { guild } = await requireGuildControl(req, res);
    const actorId = discordActorId(req.session);
    if (!actorId) return res.status(409).json({ error: 'DISCORD_LINK_REQUIRED' });
    const member = await fetchGuildMember(guild, actorId);
    ensureMemberPermission(member, PermissionFlagsBits.ManageRoles);
    const channel = await guild.channels.fetch(String(req.body?.channelId || '')).catch(() => null);
    if (!channel) return res.status(400).json({ error: 'ROLE_PANEL_CHANNEL_INVALID' });
    const sent = await setupRolePanel(guild, channel, req.session.user.id);
    res.json({ ok: true, channelId: sent.channelId, messageId: sent.id });
  } catch (error) { void reportRuntimeError(error, 'api:roles-panel', req.params.guildId); res.status(error.status || 500).json({ error: error.message || 'ROLE_PANEL_FAILED' }); }
});

app.post('/api/guilds/:guildId/tickets/setup', requireAuth, async (req, res) => {
  try {
    const { guild } = await requireGuildControl(req, res);
    const actorId = discordActorId(req.session);
    if (!actorId) return res.status(409).json({ error: 'DISCORD_LINK_REQUIRED' });
    const member = await fetchGuildMember(guild, actorId);
    ensureMemberPermission(member, PermissionFlagsBits.ManageChannels);
    const channel = await guild.channels.fetch(String(req.body?.channelId || '')).catch(() => null);
    if (!channel) return res.status(400).json({ error: 'TICKET_PANEL_CHANNEL_INVALID' });
    const sent = await setupTicketPanel(guild, channel, req.session.user.id);
    res.json({ ok: true, channelId: sent.channelId, messageId: sent.id });
  } catch (error) { res.status(error.status || 500).json({ error: error.message || 'TICKET_SETUP_FAILED' }); }
});

app.post('/api/guilds/:guildId/auto-role', requireAuth, async (req, res) => {
  try {
    const { guild } = await requireGuildControl(req, res);
    const actorId = discordActorId(req.session);
    if (!actorId) return res.status(409).json({ error: 'DISCORD_LINK_REQUIRED' });
    const member = await fetchGuildMember(guild, actorId);
    ensureMemberPermission(member, PermissionFlagsBits.ManageRoles);
    const roleId = req.body?.roleId ? String(req.body.roleId) : null;
    if (roleId) {
      const role = await guild.roles.fetch(roleId).catch(() => null);
      if (!role || role.managed || role.id === guild.id) return res.status(400).json({ error: 'AUTO_ROLE_INVALID' });
      const me = guild.members.me || await guild.members.fetchMe();
      if (role.position >= me.roles.highest.position) return res.status(400).json({ error: 'AUTO_ROLE_ABOVE_BOT' });
    }
    const config = await setConfig(guild.id, { auto_role_id: roleId });
    await addActivity(guild.id, req.session.user.id, 'autorole:updated', roleId ? 'Auto-role set to ' + (await guild.roles.fetch(roleId)).name : 'Auto-role disabled');
    res.json({ ok: true, auto_role_id: config.auto_role_id });
  } catch (error) { void reportRuntimeError(error, 'api:auto-role', req.params.guildId); res.status(error.status || 500).json({ error: error.message || 'AUTO_ROLE_UPDATE_FAILED' }); }
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
    // Combined template with all three primary themes: social, gaming and trade.
    const templates = {
      start: [['📜・nội-quy','Đọc nội quy trước khi tham gia.'],['👋・chào-mừng',topic || 'Chào mừng đến với cộng đồng!'],['✅・xác-minh','Thông tin xác minh và quy tắc an toàn.'],['🎭・nhận-role','Dùng bảng role để chọn sở thích.'],['📣・thông-báo','Thông báo chính thức từ đội ngũ.']],
      community: [['💬・chat-chung','Trò chuyện và giao lưu cùng mọi người.'],['👋・giới-thiệu','Giới thiệu bản thân và sở thích.'],['🤝・làm-quen','Làm quen bạn mới.'],['🫶・tìm-bạn','Tìm bạn nói chuyện và kết bạn.'],['❓・hỏi-đáp','Hỏi đáp chung.'],['🌏・tám-chuyện','Chủ đề đời sống và tán gẫu.'],['📸・khoe-ảnh','Chia sẻ ảnh và khoảnh khắc.'],['😂・meme','Meme vui vẻ.'],['🎨・sáng-tạo','Fan art, thiết kế và sáng tạo.'],['🎧・chia-sẻ-nhạc','Chia sẻ bài nhạc yêu thích.'],['💡・ý-tưởng','Đóng góp ý tưởng cho server.']],
      gaming: [['🎮・game-chat','Trò chuyện về game.'],['🧑‍🤝‍🧑・tìm-đồng-đội','Tìm teammate và lập party.'],['🔎・tìm-party','Đăng lịch và tìm nhóm chơi.'],['🏆・khoe-rank','Chia sẻ rank và thành tích.'],['🎬・clip-game','Clip highlight và gameplay.'],['🗓️・lịch-chơi','Hẹn giờ chơi cùng nhau.'],['🕹️・game-khac','Các tựa game khác.'],['🎁・giveaway','Quà tặng và sự kiện game.']],
      trade: [['🛍️・chợ-giao-dịch','Khu vực mua bán và trao đổi.'],['📦・đăng-bán','Đăng sản phẩm muốn bán.'],['🛒・tìm-mua','Đăng nhu cầu muốn mua.'],['🔁・trao-đổi','Trade và trao đổi vật phẩm.'],['💬・hỏi-giá','Tham khảo giá và định giá.'],['⭐・đánh-giá-giao-dịch','Đánh giá giao dịch đã hoàn tất.'],['✅・legit-vouches','Lịch sử xác nhận legit từ staff.'],['🛡️・yêu-cầu-middleman','Yêu cầu trung gian khi cần.'],['🚨・báo-cáo-scam','Báo cáo giao dịch đáng ngờ.']],
      fun: [['🎲・bot-commands','Dùng lệnh bot tại đây.'],['📊・bình-chọn','Poll và bình chọn cộng đồng.'],['🎉・sự-kiện','Hoạt động và sự kiện.'],['🤖・bot-spam','Lệnh bot và tiện ích.'],['📜・góp-ý','Góp ý với ban quản trị.']],
      support: [['🎫・mở-ticket','Dùng nút ticket panel để mở kênh riêng tư.'],['❔・faq-hỗ-trợ','Các câu hỏi thường gặp.'],['🧾・hướng-dẫn-giao-dịch','Hướng dẫn giao dịch an toàn.']],
      voice: [['🔊・voice-lounge','Phòng voice giao lưu chung.'],['🎮・gaming-party-1','Voice tìm đồng đội 1.'],['🎮・gaming-party-2','Voice tìm đồng đội 2.'],['🎮・gaming-party-3','Voice tìm đồng đội 3.'],['🤝・kết-bạn-voice','Voice làm quen bạn mới.'],['🛍️・trade-talk','Voice trao đổi và hỏi đáp.'],['🌙・chill-room','Phòng thư giãn.'],['🎵・music-lounge','Phòng nghe nhạc.']],
      staff: [['🛡️・staff-chat','Kênh nội bộ đội ngũ.'],['🧾・staff-log','Log hoạt động của bot và dashboard.'],['✅・legit-review','Staff xem xét yêu cầu legit.'],['🛍️・trade-reports','Xử lý báo cáo giao dịch.'],['🎫・ticket-staff','Điều phối hỗ trợ.'],['🔨・mod-actions','Ghi chú xử lý moderation.']]
    };
    const result = { preset, roles: [], categories: [], channels: [], skipped: [], automation: {}, warnings: [] };
    const roleSpecs = [
      { name: '👑 Admin', color: 0xED4245, permissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ViewAuditLog] },
      { name: '🛡️ Moderator', color: 0x5865F2, permissions: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ViewAuditLog] },
      { name: '🧾 Trade Moderator', color: 0xFEE75C, permissions: [PermissionFlagsBits.ManageMessages] },
      { name: '🆘 Support', color: 0x57F287, permissions: [PermissionFlagsBits.ManageMessages] },
      { name: '✅ Legit', color: 0x57F287, permissions: [] },
      { name: '💎 VIP', color: 0xEB459E, permissions: [] },
      { name: '👥 Member', color: 0x99AAB5, permissions: [] },
      { name: '🎮 Gamer', color: 0x5865F2, permissions: [] },
      { name: '💬 Social', color: 0x57F287, permissions: [] },
      { name: '🛍️ Trader', color: 0xFEE75C, permissions: [] },
      { name: '🛒 Buyer', color: 0xEB459E, permissions: [] },
      { name: '📦 Seller', color: 0xED4245, permissions: [] },
      { name: '🔔 Event Ping', color: 0x99AAB5, permissions: [] }
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
    await setConfig(guild.id, { auto_role_id: roleMap['👥 Member'].id });
    const everyone = guild.roles.everyone;
    const groups = [
      { key: 'start', name: '📌・BẮT ĐẦU', items: templates.start },
      { key: 'community', name: '💬・TRÒ CHUYỆN & GIAO LƯU', items: templates.community },
      { key: 'gaming', name: '🎮・GAME & KẾT BẠN', items: templates.gaming },
      { key: 'trade', name: '🛍️・BUÔN BÁN & TRADE', items: templates.trade },
      { key: 'fun', name: '🎉・BOT & GIẢI TRÍ', items: templates.fun },
      { key: 'support', name: '🎫・HỖ TRỢ', items: templates.support },
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
            { id: roleMap['👑 Admin'].id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
            { id: roleMap['🛡️ Moderator'].id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
            { id: roleMap['🧾 Trade Moderator'].id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
            { id: roleMap['🆘 Support'].id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
            { id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] }
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
            { id: roleMap['👑 Admin'].id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
            { id: roleMap['🛡️ Moderator'].id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
            { id: roleMap['🧾 Trade Moderator'].id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
            { id: roleMap['🆘 Support'].id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
            { id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] }
          ] : undefined,
          topic: type === ChannelType.GuildText ? String(channelTopic || '').slice(0, 1024) || undefined : undefined,
          reason: 'Aki Server Builder template'
        });
        result.channels.push({ name: channel.name, type: type === ChannelType.GuildVoice ? 'voice' : 'text', category: category.name });
      }
    }
    const rolePanelChannel = guild.channels.cache.find(c => c.name === '🎭・nhận-role' && c.type === ChannelType.GuildText);
    const ticketPanelChannel = guild.channels.cache.find(c => c.name === '🎫・mở-ticket' && c.type === ChannelType.GuildText);
    try {
      const message = await setupRolePanel(guild, rolePanelChannel, req.session.user.id);
      result.automation.rolePanel = { channel: rolePanelChannel?.name || null, messageId: message.id, ok: true };
    } catch (error) {
      result.automation.rolePanel = { ok: false }; result.warnings.push('Role panel: ' + error.message);
      console.warn('Server Builder role panel setup failed:', error.message);
    }
    const hadTicketCategory = guild.channels.cache.some(c => c.type === ChannelType.GuildCategory && c.name === '🎫・TICKETS');
    try {
      const message = await setupTicketPanel(guild, ticketPanelChannel, req.session.user.id);
      result.automation.ticketPanel = { channel: ticketPanelChannel?.name || null, messageId: message.id, ok: true };
      const ticketCategory = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === '🎫・TICKETS');
      if (ticketCategory && !result.categories.some(item => item.name === ticketCategory.name)) result.categories.push({ name: ticketCategory.name, created: !hadTicketCategory });
    } catch (error) {
      result.automation.ticketPanel = { ok: false }; result.warnings.push('Ticket panel: ' + error.message);
      console.warn('Server Builder ticket panel setup failed:', error.message);
    }
    await addActivity(guild.id, req.session.user.id, 'server-builder', JSON.stringify({ preset, roles: result.roles.length, categories: result.categories.length, channels: result.channels.length, automation: result.automation }));
    res.json({ ok: true, result });
  } catch (error) {
    console.error('Server Builder failed:', error);
    void reportRuntimeError(error, 'api:server-builder', req.params.guildId);
    res.status(error.status || 500).json({ error: error.message || 'SERVER_BUILDER_FAILED' });
  }
});

app.get('/api/overview', requireAuth, async (req, res) => {
  res.json({
    name: APP_NAME,
    bot: { ready: bot.isReady(), guilds: bot.guilds.cache.size, ping: Math.round(bot.ws.ping), commands: commands.length },
    persistence: pool ? 'postgres' : 'memory'
  });
});

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');

// Only the deliberately published public/ directory is served to browsers.
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
app.get('/privacy', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'privacy.html')));
app.get('/terms', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'terms.html')));
app.get('/leaderboard/:guildId', (req, res) => {
  if (!/^[0-9]{17,20}$/.test(String(req.params.guildId || ''))) return res.status(400).type('text/plain').send('Invalid Discord server ID.');
  return res.sendFile(path.join(PUBLIC_DIR, 'leaderboard.html'));
});
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
  for (const [key, last] of xpCooldowns) if (now - last > 30 * 60_000) xpCooldowns.delete(key);
  for (const [key, last] of runtimeErrorCooldowns) if (now - last > 10 * 60_000) runtimeErrorCooldowns.delete(key);
  if (pool) dbQuery('DELETE FROM oauth_states WHERE created_at < $1', [now - 10 * 60_000]).catch(error => console.error('OAuth state cleanup failed:', error.message));
}, 10 * 60_000);
setInterval(() => {
  persistAllSessions().catch(error => console.error('Persistent session sync failed:', error.message));
}, 30_000);
setInterval(reminderTick, 10_000);
setInterval(() => tempBanTick().catch(error => console.warn('Tempban expiry worker failed:', error?.message || 'unknown error')), 10_000);

async function boot() {
  await initDb();
  await restorePersistentSessions();
  await persistAllSessions(); // migrate any legacy plaintext OAuth fields to encrypted storage
  if (!pool) console.warn('DATABASE_URL missing. Login sessions will not survive Render restarts; configure a Render PostgreSQL DATABASE_URL.');
  server.listen(PORT, '0.0.0.0', () => console.log(`Aki Dev dashboard listening on 0.0.0.0:${PORT}`));
  if (process.env.DISCORD_TOKEN) {
    bot.login(process.env.DISCORD_TOKEN).catch(error => console.error('Discord login failed:', error.message));
  } else {
    console.warn('DISCORD_TOKEN missing. Web server is running, bot is disabled.');
  }
}
boot().catch(error => { console.error(error); process.exit(1); });
