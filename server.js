import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { normalizeReactionEmoji, isActiveReactionRolePanel, sanitizePollText, sanitizePollFooter, isRoleHigherThan, canManageTarget, canAssignRole } from './lib/role-utils.js';
import { isAllowedOrigin, websocketOriginFromSiteUrl, canControlGuild, isCurrentGuildMember } from './lib/security-utils.js';
import { resolveDatabaseSsl } from './lib/db-ssl-utils.js';
import { normalizeMediaUrl } from './lib/media-utils.js';
import { getLevelProgress, calculateMessageXp } from './lib/community-utils.js';
import { normalizeIdList, normalizeRoleMultipliers, normalizeLevelRewards, shouldAwardXpMessage, applyRoleXpMultiplier, getEligibleLevelRewards } from './lib/xp-utils.js';
import { isMigrationFilename } from './lib/migration-utils.js';
import { vouchDenialReason, formatAuditReason, shouldEscalateWarnings } from './lib/moderation-utils.js';
import { parseDuration } from './lib/duration-utils.js';
import { buildNativePollPayload } from './lib/poll-utils.js';
import { parsePagination, csvCell } from './lib/activity-utils.js';
import { isAccountTooNew } from './lib/verification-utils.js';
import { drawUniqueWinners } from './lib/giveaway-utils.js';
import { normalizeSuggestionText, isSuggestionVote, canReviewSuggestion } from './lib/suggestion-utils.js';
import { SHOP_ITEMS, getShopItem, isSafeShopRole } from './lib/shop-utils.js';
import { nextDailyStreak, dailyStreakReward } from './lib/economy-utils.js';
import { normalizeSaleSubmission, canPostSale, normalizeSaleCooldownMinutes } from './lib/sales-utils.js';
import { normalizeTempVoiceRoomName, normalizeVoiceUserLimit } from './lib/temp-voice-utils.js';
import { normalizeTagName, normalizeFaqKeyword, sanitizeCommunityContent, findMatchingFaq } from './lib/tag-utils.js';
import { normalizePage, slicePage } from './lib/page-utils.js';
import { keepsCommandResultPrivate, summarizeCommandResult } from './lib/command-routing-utils.js';
import { normalizeMessageTemplate, renderMessageTemplate } from './lib/message-template-utils.js';
import { checkCommandCooldown, normalizeAutocompleteChoices, formatReminderList } from './lib/ux-utils.js';
import { getCommandRegistrationScopes } from './lib/command-registration-utils.js';
import { safeRuntimeErrorCode, classifyGatewayDebugMessage, classifyDiscordRestRoute, normalizeRateLimitDiagnostics, normalizeDiscordRestResponseDiagnostics, normalizeRetryAfterBodyValue, normalizeDiscordRestErrorBody } from './lib/runtime-diagnostics-utils.js';
import { normalizeBlockedDomains, findBlockedDomain, isMassMention, recentTimestamps, isRaidJoinBurst } from './lib/automod-utils.js';
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
  SlashCommandBuilder,
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  ActivityType
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
let applicationReady = false;
const PORT = Number(process.env.PORT || 10000);
const isProd = process.env.NODE_ENV === 'production';
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SOCKET_WS_ORIGIN = websocketOriginFromSiteUrl(SITE_URL);
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
  connectSrc: ["'self'", ...(SOCKET_WS_ORIGIN ? [SOCKET_WS_ORIGIN] : []), 'https://discord.com', 'https://accounts.google.com'], objectSrc: ["'none'"],
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
app.use((req, res, next) => {
  if (applicationReady || req.path === '/health' || req.path === '/api/health') return next();
  res.set('Retry-After', '5');
  return res.status(503).json({ error: 'SERVICE_STARTING' });
});

const sessionStore = new Map();
const oauthStateStore = new Map();
const activityCache = [];
const xpCooldowns = new Map();
const runtimeErrorCooldowns = new Map();
const commandCooldowns = new Map();
const COMMAND_COOLDOWN_MS = (() => {
  const parsed = Number(process.env.COMMAND_COOLDOWN_MS ?? 1200);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(10000, Math.floor(parsed))) : 1200;
})();
const automodMessageBuckets = new Map();
const raidJoinBuckets = new Map();
const raidLockdowns = new Map();
const automodWarningCooldowns = new Map();
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
  reminders: [],
  giveaways: new Map(),
  giveawayEntries: new Map(),
  suggestions: new Map(),
  suggestionVotes: new Map(),
  saleCooldowns: new Map(),
  salePosts: [],
  tags: new Map(),
  faqRules: new Map()
};
const faqRuleCache = new Map();
const faqResponseCooldowns = new Map();
const memoryMessageTemplates = new Map();
let nextGiveawayId = 1;
let giveawayWorkerRunning = false;
let nextSuggestionId = 1;
let nextSalePostId = 1;

const runtimeDiagnostics = {
  database: {
    state: process.env.DATABASE_URL ? 'connecting' : 'memory',
    lastErrorCode: null
  },
  discord: {
    state: process.env.DISCORD_TOKEN ? 'connecting' : 'token_missing',
    lastErrorCode: null,
    lastGatewayCloseCode: null,
    gatewayStage: 'not_started',
    lastEventAt: null,
    lastRestResponse: null,
    lastRestRateLimit: null,
    restRateLimitCount: 0,
  },
  commands: {
    global: { state: process.env.DISCORD_TOKEN ? 'waiting_for_gateway' : 'not_started', errorCode: null, lastAttemptAt: null, lastSuccessAt: null },
    guild: { state: process.env.DISCORD_GUILD_ID ? 'waiting_for_gateway' : 'not_configured', errorCode: null, lastAttemptAt: null, lastSuccessAt: null },
    lastErrorCode: null,
    total: 0
  }
};


const databaseHost = (() => { try { return new URL(process.env.DATABASE_URL || '').hostname; } catch { return ''; } })();
const databaseSsl = resolveDatabaseSsl({
  host: databaseHost,
  isRender: process.env.RENDER === 'true',
  mode: process.env.PGSSL_MODE || 'auto',
  rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED
});
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: databaseSsl,
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
  const migrations = fs.readdirSync(migrationDir).filter(isMigrationFilename).sort();
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
    goodbye_channel_id: null,
    verification_enabled: false,
    verification_channel_id: null,
    verification_message_id: null,
    verification_role_id: null,
    verification_quarantine_role_id: null,
    verification_min_account_days: 0,
    suggestion_channel_id: null,
    sale_channel_id: null,
    sale_cooldown_minutes: 30,
    temp_voice_enabled: false,
    temp_voice_trigger_channel_id: null,
    temp_voice_category_id: null,
    temp_voice_user_limit: 0,
    automod_enabled: false,
    automod_blocked_domains: [],
    automod_spam_threshold: 5,
    automod_spam_window_seconds: 10,
    automod_max_mentions: 5,
    automod_raid_join_threshold: 8,
    automod_raid_window_seconds: 20,
    automod_lockdown_seconds: 60
  });
  return memory.configs.get(guildId);
}

async function setConfig(guildId, patch) {
  const current = await getConfig(guildId);
  const next = { ...current, ...patch };
  if (pool) {
    await dbQuery(`
      INSERT INTO guild_configs(
        guild_id, auto_voice_enabled, auto_voice_channel_id, prefix, log_channel_id, auto_role_id,
        welcome_channel_id, goodbye_channel_id, verification_enabled, verification_channel_id,
        verification_message_id, verification_role_id, verification_quarantine_role_id,
        verification_min_account_days, suggestion_channel_id, sale_channel_id, sale_cooldown_minutes, automod_enabled, automod_blocked_domains,
        automod_spam_threshold, automod_spam_window_seconds, automod_max_mentions,
        automod_raid_join_threshold, automod_raid_window_seconds, automod_lockdown_seconds,
        temp_voice_enabled, temp_voice_trigger_channel_id, temp_voice_category_id, temp_voice_user_limit, updated_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,NOW())
      ON CONFLICT(guild_id) DO UPDATE SET
        auto_voice_enabled=EXCLUDED.auto_voice_enabled,
        auto_voice_channel_id=EXCLUDED.auto_voice_channel_id,
        prefix=EXCLUDED.prefix,
        log_channel_id=EXCLUDED.log_channel_id,
        auto_role_id=EXCLUDED.auto_role_id,
        welcome_channel_id=EXCLUDED.welcome_channel_id,
        goodbye_channel_id=EXCLUDED.goodbye_channel_id,
        verification_enabled=EXCLUDED.verification_enabled,
        verification_channel_id=EXCLUDED.verification_channel_id,
        verification_message_id=EXCLUDED.verification_message_id,
        verification_role_id=EXCLUDED.verification_role_id,
        verification_quarantine_role_id=EXCLUDED.verification_quarantine_role_id,
        verification_min_account_days=EXCLUDED.verification_min_account_days,
        suggestion_channel_id=EXCLUDED.suggestion_channel_id,
        sale_channel_id=EXCLUDED.sale_channel_id,
        sale_cooldown_minutes=EXCLUDED.sale_cooldown_minutes,
        automod_enabled=EXCLUDED.automod_enabled,
        automod_blocked_domains=EXCLUDED.automod_blocked_domains,
        automod_spam_threshold=EXCLUDED.automod_spam_threshold,
        automod_spam_window_seconds=EXCLUDED.automod_spam_window_seconds,
        automod_max_mentions=EXCLUDED.automod_max_mentions,
        automod_raid_join_threshold=EXCLUDED.automod_raid_join_threshold,
        automod_raid_window_seconds=EXCLUDED.automod_raid_window_seconds,
        automod_lockdown_seconds=EXCLUDED.automod_lockdown_seconds,
        temp_voice_enabled=EXCLUDED.temp_voice_enabled,
        temp_voice_trigger_channel_id=EXCLUDED.temp_voice_trigger_channel_id,
        temp_voice_category_id=EXCLUDED.temp_voice_category_id,
        temp_voice_user_limit=EXCLUDED.temp_voice_user_limit,
        updated_at=NOW()
    `, [
      guildId, Boolean(next.auto_voice_enabled), next.auto_voice_channel_id || null,
      next.prefix || '!', next.log_channel_id || null, next.auto_role_id || null,
      next.welcome_channel_id || null, next.goodbye_channel_id || null,
      Boolean(next.verification_enabled), next.verification_channel_id || null,
      next.verification_message_id || null, next.verification_role_id || null,
      next.verification_quarantine_role_id || null, Math.min(365, Math.max(0, Number(next.verification_min_account_days) || 0)),
      next.suggestion_channel_id || null,
      next.sale_channel_id || null, normalizeSaleCooldownMinutes(next.sale_cooldown_minutes),
      Boolean(next.automod_enabled), normalizeBlockedDomains(next.automod_blocked_domains || []),
      Math.max(3, Math.min(20, Number(next.automod_spam_threshold) || 5)),
      Math.max(3, Math.min(60, Number(next.automod_spam_window_seconds) || 10)),
      Math.max(3, Math.min(20, Number(next.automod_max_mentions) || 5)),
      Math.max(5, Math.min(30, Number(next.automod_raid_join_threshold) || 8)),
      Math.max(5, Math.min(60, Number(next.automod_raid_window_seconds) || 20)),
      Math.max(30, Math.min(600, Number(next.automod_lockdown_seconds) || 60)),
      Boolean(next.temp_voice_enabled), next.temp_voice_trigger_channel_id || null,
      next.temp_voice_category_id || null, normalizeVoiceUserLimit(next.temp_voice_user_limit)
    ]);
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

async function getWarningsPage(guildId, userId, requestedPage = 1) {
  const pageSize = 10;
  if (pool) {
    const totalResult = await dbQuery('SELECT COUNT(*)::int AS total FROM warnings WHERE guild_id=$1 AND user_id=$2', [guildId,userId]);
    const total = Number(totalResult.rows[0]?.total || 0);
    const meta = normalizePage(requestedPage,total,pageSize);
    const result = await dbQuery(
      'SELECT id,guild_id,user_id,moderator_id,reason,created_at FROM warnings WHERE guild_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT $3 OFFSET $4',
      [guildId,userId,meta.pageSize,meta.offset]
    );
    return { ...meta, items: result.rows };
  }
  const list = [...(memory.warnings.get(guildId + ':' + userId) || [])].sort((a,b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return slicePage(list,requestedPage,pageSize);
}
async function buildWarningsPagePayload(guild, targetId, requestedPage = 1) {
  const page = await getWarningsPage(guild.id,targetId,requestedPage);
  const member = await guild.members.fetch(targetId).catch(() => null);
  const displayName = member?.user?.globalName || member?.user?.username || targetId;
  const description = page.items.length
    ? page.items.map(row => '**#' + (row.id || '—') + '** · ' + String(row.reason || 'Không có lý do').slice(0,260) +
        ' · ' + (row.created_at ? '<t:' + Math.floor(new Date(row.created_at).getTime()/1000) + ':R>' : 'không rõ thời gian')).join('\n')
    : 'Thành viên này chưa có cảnh cáo.';
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('aki:warnings:' + targetId + ':' + Math.max(1,page.page-1)).setLabel('← Trước').setStyle(ButtonStyle.Secondary).setDisabled(page.page<=1),
    new ButtonBuilder().setCustomId('aki:warnings:' + targetId + ':' + Math.min(page.pages,page.page+1)).setLabel('Sau →').setStyle(ButtonStyle.Secondary).setDisabled(page.page>=page.pages)
  );
  const embed = new EmbedBuilder().setColor(0xED4245).setTitle('📋 Warnings · ' + displayName)
    .setDescription(description).setFooter({ text: 'Trang ' + page.page + '/' + page.pages + ' · Tổng ' + page.total + ' cảnh cáo · /delwarn warning_id' }).setTimestamp();
  return { embeds:[embed], components:[row], allowedMentions:{parse:[]} };
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

const xpSettingsCache = new Map();
const EMPTY_XP_SETTINGS = Object.freeze({
  enabled: true, ignored_channel_ids: [], ignored_role_ids: [],
  role_multipliers: {}, level_rewards: {}
});
async function getGuildXpSettings(guildId) {
  if (xpSettingsCache.has(guildId)) return xpSettingsCache.get(guildId);
  let row = null;
  if (pool) {
    const result = await dbQuery('SELECT enabled,ignored_channel_ids,ignored_role_ids,role_multipliers,level_rewards FROM guild_xp_settings WHERE guild_id=$1', [guildId]);
    row = result.rows[0] || null;
  }
  const settings = row ? {
    enabled: Boolean(row.enabled),
    ignored_channel_ids: Array.isArray(row.ignored_channel_ids) ? row.ignored_channel_ids : [],
    ignored_role_ids: Array.isArray(row.ignored_role_ids) ? row.ignored_role_ids : [],
    role_multipliers: row.role_multipliers && typeof row.role_multipliers === 'object' ? row.role_multipliers : {},
    level_rewards: row.level_rewards && typeof row.level_rewards === 'object' ? row.level_rewards : {}
  } : { ...EMPTY_XP_SETTINGS };
  xpSettingsCache.set(guildId, settings);
  return settings;
}
async function saveGuildXpSettings(guildId, settings) {
  const normalized = {
    enabled: Boolean(settings.enabled),
    ignored_channel_ids: normalizeIdList(settings.ignored_channel_ids),
    ignored_role_ids: normalizeIdList(settings.ignored_role_ids),
    role_multipliers: normalizeRoleMultipliers(settings.role_multipliers),
    level_rewards: normalizeLevelRewards(settings.level_rewards)
  };
  if (pool) {
    await dbQuery(`
      INSERT INTO guild_xp_settings(guild_id,enabled,ignored_channel_ids,ignored_role_ids,role_multipliers,level_rewards,updated_at)
      VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,NOW())
      ON CONFLICT(guild_id) DO UPDATE SET enabled=EXCLUDED.enabled,
        ignored_channel_ids=EXCLUDED.ignored_channel_ids,ignored_role_ids=EXCLUDED.ignored_role_ids,
        role_multipliers=EXCLUDED.role_multipliers,level_rewards=EXCLUDED.level_rewards,updated_at=NOW()
    `, [guildId,normalized.enabled,normalized.ignored_channel_ids,normalized.ignored_role_ids,
      JSON.stringify(normalized.role_multipliers),JSON.stringify(normalized.level_rewards)]);
  }
  xpSettingsCache.set(guildId, normalized);
  return normalized;
}
async function awardConfiguredLevelRoles(guild, member, level, settings) {
  const rewards = getEligibleLevelRewards(level, settings.level_rewards);
  if (!rewards.length) return [];
  const botMember = guild.members.me || await guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) return [];
  const granted = [];
  for (const reward of rewards) {
    if (member.roles.cache.has(reward.roleId)) continue;
    const role = await guild.roles.fetch(reward.roleId).catch(() => null);
    if (!role || role.managed || role.id === guild.id || role.position >= botMember.roles.highest.position) continue;
    try { await member.roles.add(role, 'Aki XP level reward · level ' + reward.level); granted.push(role.name); }
    catch (error) { console.warn('Could not assign XP level reward:', error?.message || 'unknown error'); }
  }
  return granted;
}
async function ensureCommunityProfile(guildId, userId) {
  if (pool) {
    await dbQuery('INSERT INTO community_profiles(guild_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [guildId, userId]);
    const result = await dbQuery('SELECT guild_id,user_id,xp,level,coins,last_daily,last_work,daily_streak FROM community_profiles WHERE guild_id=$1 AND user_id=$2', [guildId, userId]);
    return result.rows[0];
  }
  const key = `${guildId}:${userId}`;
  if (!memory.communityProfiles.has(key)) memory.communityProfiles.set(key, { guild_id: guildId, user_id: userId, xp: 0, level: 0, coins: 0, last_daily: 0, last_work: 0, daily_streak: 0 });
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
  const workReward = COINS_WORK_MIN + Math.floor(Math.random() * (COINS_WORK_MAX - COINS_WORK_MIN + 1));
  await ensureCommunityProfile(guildId, userId);
  if (pool && isDaily) {
    const result = await dbQuery(`
      UPDATE community_profiles
      SET coins=coins+$1 + CASE
            WHEN last_daily > 0 AND FLOOR($2::numeric / 86400000) - FLOOR(last_daily::numeric / 86400000)=1
            THEN LEAST(daily_streak,6)*25 ELSE 0 END,
          last_daily=$2,
          daily_streak=CASE
            WHEN last_daily=0 THEN 1
            WHEN FLOOR($2::numeric / 86400000) - FLOOR(last_daily::numeric / 86400000)=1 THEN daily_streak+1
            ELSE 1 END,
          updated_at=NOW()
      WHERE guild_id=$3 AND user_id=$4 AND last_daily <= $5
      RETURNING coins,daily_streak
    `, [COINS_DAILY_AMOUNT, now, guildId, userId, now - cooldown]);
    if (result.rowCount) {
      const streak = Number(result.rows[0].daily_streak) || 1;
      return { ok: true, reward: dailyStreakReward(streak, COINS_DAILY_AMOUNT), streak, coins: Number(result.rows[0].coins), nextAt: now + cooldown };
    }
    const profile = await ensureCommunityProfile(guildId, userId);
    return { ok: false, coins: Number(profile.coins), streak: Number(profile.daily_streak) || 0, nextAt: Number(profile[column]) + cooldown };
  }
  const reward = isDaily
    ? null
    : workReward;
  if (pool) {
    const result = await dbQuery(`UPDATE community_profiles SET coins=coins+$1, ${column}=$2, updated_at=NOW() WHERE guild_id=$3 AND user_id=$4 AND ${column} <= $5 RETURNING coins`, [reward, now, guildId, userId, now - cooldown]);
    if (result.rowCount) return { ok: true, reward, coins: Number(result.rows[0].coins), nextAt: now + cooldown };
    const profile = await ensureCommunityProfile(guildId, userId);
    return { ok: false, coins: Number(profile.coins), nextAt: Number(profile[column]) + cooldown };
  }
  const profile = await ensureCommunityProfile(guildId, userId);
  if (now - Number(profile[column] || 0) < cooldown) return { ok: false, coins: Number(profile.coins), streak: Number(profile.daily_streak) || 0, nextAt: Number(profile[column]) + cooldown };
  if (isDaily) {
    const streak = nextDailyStreak(profile.last_daily, profile.daily_streak, now);
    const dailyReward = dailyStreakReward(streak, COINS_DAILY_AMOUNT);
    profile.coins = Number(profile.coins || 0) + dailyReward;
    profile.last_daily = now;
    profile.daily_streak = streak;
    return { ok: true, reward: dailyReward, streak, coins: profile.coins, nextAt: now + cooldown };
  }
  profile.coins = Number(profile.coins || 0) + reward;
  profile[column] = now;
  return { ok: true, reward, coins: profile.coins, nextAt: now + cooldown };
}

function progressBar(current, total, length = 12) {
  const ratio = total > 0 ? Math.max(0, Math.min(1, current / total)) : 0;
  const filled = Math.round(ratio * length);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, length - filled));
}

async function getCommunityLeaderboardPage(guildId, kind = 'levels', requestedPage = 1) {
  const pageSize = 10;
  if (pool) {
    const sortColumn = kind === 'coins' ? 'coins' : 'xp';
    const countResult = await dbQuery('SELECT COUNT(*)::int AS total FROM community_profiles WHERE guild_id=$1',[guildId]);
    const meta = normalizePage(requestedPage,Number(countResult.rows[0]?.total || 0),pageSize);
    const result = await dbQuery(
      'SELECT user_id,xp,level,coins FROM community_profiles WHERE guild_id=$1 ORDER BY ' + sortColumn + ' DESC, user_id ASC LIMIT $2 OFFSET $3',
      [guildId,meta.pageSize,meta.offset]
    );
    return { ...meta, items: result.rows.map((row,index)=>({rank:meta.offset+index+1,user_id:row.user_id,xp:Number(row.xp),level:Number(row.level),coins:Number(row.coins) })) };
  }
  const all = [...memory.communityProfiles.values()].filter(row=>row.guild_id===guildId)
    .sort((a,b)=> kind==='coins' ? Number(b.coins)-Number(a.coins) : Number(b.xp)-Number(a.xp));
  const page = slicePage(all,requestedPage,pageSize);
  return { ...page, items: page.items.map((row,index)=>({...row,rank:page.offset+index+1})) };
}
async function buildLeaderboardPagePayload(guild, kind = 'levels', requestedPage = 1) {
  const page = await getCommunityLeaderboardPage(guild.id,kind,requestedPage);
  const body = page.items.length ? page.items.map(row => kind === 'coins'
    ? '`#' + row.rank + '` <@' + row.user_id + '> · **' + Number(row.coins).toLocaleString('en-US') + ' xu**'
    : '`#' + row.rank + '` <@' + row.user_id + '> · **Level ' + row.level + '** (' + Number(row.xp).toLocaleString('en-US') + ' XP)'
  ).join('\n') : 'Chưa có dữ liệu. Hãy trò chuyện hoặc dùng /daily để bắt đầu.';
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('aki:leaderboard:' + (kind==='coins'?'coins':'levels') + ':' + Math.max(1,page.page-1)).setLabel('← Trước').setStyle(ButtonStyle.Secondary).setDisabled(page.page<=1),
    new ButtonBuilder().setCustomId('aki:leaderboard:' + (kind==='coins'?'coins':'levels') + ':' + Math.min(page.pages,page.page+1)).setLabel('Sau →').setStyle(ButtonStyle.Secondary).setDisabled(page.page>=page.pages)
  );
  const embed = new EmbedBuilder().setColor(0x5865F2).setTitle(kind==='coins'?'🏆 Top xu server':'🏆 Top level server')
    .setDescription(body).setFooter({text:'Trang '+page.page+'/'+page.pages+' · '+page.total+' thành viên · Aki Community'}).setTimestamp();
  return { embeds:[embed],components:[row],allowedMentions:{parse:[]} };
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
async function revokeSocketGuildAccess(guildId, userId, errorCode = 'NO_GUILD_ACCESS') {
  if (!guildId || !userId) return;
  try {
    const sockets = await io.in('guild:' + guildId).fetchSockets();
    for (const socket of sockets) {
      const session = sessionStore.get(socket.data.sessionSid);
      if (discordActorId(session) !== userId) continue;
      socket.leave('guild:' + guildId);
      socket.emit('socket-error', { error: errorCode });
    }
  } catch (error) {
    console.warn('Could not revoke Socket.IO guild access:', error?.message || 'unknown error');
  }
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
    // Bind each live socket to the authenticated session for reliable logout revocation.
    socket.join('session:' + socket.data.sessionSid);
    socket.on('unwatch-guild', () => {
      for (const room of socket.rooms) if (room.startsWith('guild:')) socket.leave(room);
    });
    socket.on('watch-guild', async guildId => {
      for (const room of socket.rooms) if (room.startsWith('guild:')) socket.leave(room);
      if (typeof guildId !== 'string' || !/^\d{17,20}$/.test(guildId)) {
        return socket.emit('socket-error', { error: 'INVALID_GUILD' });
      }
      try {
        const session = sessionStore.get(socket.data.sessionSid);
        const actorId = discordActorId(session);
        const guild = bot.guilds.cache.get(guildId);
        const meta = (session?.guilds || []).find(item => item.id === guildId);
        if (!session || !actorId || !guild || !meta) {
          return socket.emit('socket-error', { error: 'NO_GUILD_ACCESS' });
        }
        const actor = await fetchGuildMember(guild, actorId, true);
        if (!actor || !canControlGuild(actor.id, guild.ownerId, actor.permissions.bitfield)) {
          return socket.emit('socket-error', { error: 'NO_GUILD_ACCESS' });
        }
        socket.join('guild:' + guildId);
      } catch {
        socket.emit('socket-error', { error: 'NO_GUILD_ACCESS' });
      }
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
    io.in('session:' + sid).disconnectSockets(true);
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

const slashCommands = [
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
  new SlashCommandBuilder().setName('goodbye-setup').setDescription('Chọn kênh thông báo thành viên rời server.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString()).addChannelOption(o => o.setName('channel').setDescription('Kênh tạm biệt').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)),
  new SlashCommandBuilder().setName('verify-setup').setDescription('Cấu hình cổng xác minh và cách ly tài khoản mới.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addBooleanOption(o => o.setName('enabled').setDescription('Bật hoặc tắt cổng xác minh').setRequired(true))
    .addChannelOption(o => o.setName('channel').setDescription('Kênh panel xác minh').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(false))
    .addRoleOption(o => o.setName('member_role').setDescription('Role Member cấp sau xác minh').setRequired(false))
    .addRoleOption(o => o.setName('quarantine_role').setDescription('Role cách ly tài khoản quá mới').setRequired(false))
    .addIntegerOption(o => o.setName('min_account_days').setDescription('Tuổi tài khoản tối thiểu (0–365 ngày)').setMinValue(0).setMaxValue(365).setRequired(false)),
  new SlashCommandBuilder().setName('giveaway').setDescription('Tạo giveaway có nút tham gia và tự chọn người thắng.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addStringOption(o => o.setName('prize').setDescription('Phần thưởng').setMaxLength(300).setRequired(true))
    .addIntegerOption(o => o.setName('minutes').setDescription('Thời lượng (1–10080 phút)').setMinValue(1).setMaxValue(10080).setRequired(true))
    .addIntegerOption(o => o.setName('winners').setDescription('Số người thắng (1–10)').setMinValue(1).setMaxValue(10).setRequired(true))
    .addChannelOption(o => o.setName('channel').setDescription('Kênh giveaway').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(false))
    .addRoleOption(o => o.setName('required_role').setDescription('Role bắt buộc (tuỳ chọn)').setRequired(false))
    .addIntegerOption(o => o.setName('required_level').setDescription('Level tối thiểu (tuỳ chọn)').setMinValue(0).setMaxValue(1000).setRequired(false)),
  new SlashCommandBuilder().setName('giveaway-reroll').setDescription('Chọn lại người thắng giveaway đã kết thúc.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addStringOption(o => o.setName('giveaway_id').setDescription('ID giveaway').setMinLength(1).setMaxLength(20).setAutocomplete(true).setRequired(true)),
  new SlashCommandBuilder().setName('suggest').setDescription('Đề xuất ý tưởng cho server.').addStringOption(o => o.setName('text').setDescription('Nội dung góp ý').setMinLength(5).setMaxLength(1500).setRequired(true)),
  new SlashCommandBuilder().setName('suggest-setup').setDescription('Chọn kênh đăng góp ý.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addChannelOption(o => o.setName('channel').setDescription('Kênh nhận góp ý').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)),
  new SlashCommandBuilder().setName('shop').setDescription('Xem cửa hàng role bằng xu.'),
  new SlashCommandBuilder().setName('buy').setDescription('Mua role trang trí bằng xu.')
    .addStringOption(o => o.setName('item').setDescription('Mã món hàng').setRequired(true)
      .addChoices(...SHOP_ITEMS.map(item => ({ name: item.id + ' · ' + item.price + ' xu', value: item.id })))
    ),
  new SlashCommandBuilder().setName('sell').setDescription('Mở modal đăng bán sản phẩm/dịch vụ.'),
  new SlashCommandBuilder().setName('sell-setup').setDescription('Cấu hình kênh đăng bán và cooldown.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addChannelOption(o => o.setName('channel').setDescription('Kênh đăng bán').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
    .addIntegerOption(o => o.setName('cooldown_minutes').setDescription('Cooldown mỗi người (5–1440 phút)').setMinValue(5).setMaxValue(1440).setRequired(false)),
  new SlashCommandBuilder().setName('temp-voice-setup').setDescription('Cấu hình voice room tự tạo theo server.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addBooleanOption(o => o.setName('enabled').setDescription('Bật/tắt phòng voice tạm').setRequired(true))
    .addChannelOption(o => o.setName('trigger_channel').setDescription('Kênh voice người dùng vào để tạo phòng').addChannelTypes(ChannelType.GuildVoice).setRequired(false))
    .addChannelOption(o => o.setName('category').setDescription('Category chứa phòng mới (tuỳ chọn)').addChannelTypes(ChannelType.GuildCategory).setRequired(false))
    .addIntegerOption(o => o.setName('user_limit').setDescription('Giới hạn người trong phòng, 0 = không giới hạn').setMinValue(0).setMaxValue(99).setRequired(false)),
  new SlashCommandBuilder().setName('tag').setDescription('Hiển thị tag của server.').addStringOption(o => o.setName('name').setDescription('Tên tag').setMinLength(2).setMaxLength(32).setAutocomplete(true).setRequired(true)),
  new SlashCommandBuilder().setName('tag-set').setDescription('Tạo hoặc cập nhật tag cho server.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addStringOption(o => o.setName('name').setDescription('Tên tag').setMinLength(2).setMaxLength(32).setRequired(true))
    .addStringOption(o => o.setName('content').setDescription('Nội dung tag').setMinLength(1).setMaxLength(1500).setRequired(true)),
  new SlashCommandBuilder().setName('tag-delete').setDescription('Xoá tag khỏi server.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addStringOption(o => o.setName('name').setDescription('Tên tag').setMinLength(2).setMaxLength(32).setAutocomplete(true).setRequired(true)),
  new SlashCommandBuilder().setName('faq-set').setDescription('Thêm/cập nhật FAQ auto-reply.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addStringOption(o => o.setName('keyword').setDescription('Từ hoặc cụm từ cần bắt').setMinLength(2).setMaxLength(60).setRequired(true))
    .addStringOption(o => o.setName('response').setDescription('Câu trả lời').setMinLength(1).setMaxLength(1500).setRequired(true)),
  new SlashCommandBuilder().setName('faq-delete').setDescription('Xoá FAQ auto-reply.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addStringOption(o => o.setName('keyword').setDescription('Từ khoá FAQ').setMinLength(2).setMaxLength(60).setAutocomplete(true).setRequired(true)),
  new SlashCommandBuilder().setName('xp-setup').setDescription('Cấu hình XP, bỏ qua kênh/role, hệ số và role thưởng.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addBooleanOption(o => o.setName('enabled').setDescription('Bật/tắt XP tin nhắn').setRequired(true))
    .addStringOption(o => o.setName('ignored_channels').setDescription('ID/mention kênh bỏ qua, ngăn cách bằng dấu phẩy').setMaxLength(1000).setRequired(false))
    .addStringOption(o => o.setName('ignored_roles').setDescription('ID/mention role bỏ qua, ngăn cách bằng dấu phẩy').setMaxLength(1000).setRequired(false))
    .addStringOption(o => o.setName('role_multipliers').setDescription('ROLE_ID=1.5, hệ số từ 0.5 tới 3').setMaxLength(1500).setRequired(false))
    .addStringOption(o => o.setName('level_rewards').setDescription('LEVEL=ROLE_ID, ví dụ 5=123...,10=456...').setMaxLength(1500).setRequired(false)),
  new SlashCommandBuilder().setName('automod-setup').setDescription('Bật AutoMod và cấu hình domain/chống spam/raid.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addBooleanOption(o => o.setName('enabled').setDescription('Bật hoặc tắt AutoMod').setRequired(true))
    .addStringOption(o => o.setName('blocked_domains').setDescription('Domain chặn, phân tách bằng dấu phẩy').setMaxLength(1500).setRequired(false))
    .addIntegerOption(o => o.setName('spam_threshold').setDescription('Số tin nhắn trong cửa sổ spam (3–20)').setMinValue(3).setMaxValue(20).setRequired(false))
    .addIntegerOption(o => o.setName('spam_window_seconds').setDescription('Cửa sổ spam (3–60 giây)').setMinValue(3).setMaxValue(60).setRequired(false))
    .addIntegerOption(o => o.setName('max_mentions').setDescription('Ngưỡng mass mention (3–20)').setMinValue(3).setMaxValue(20).setRequired(false))
    .addIntegerOption(o => o.setName('raid_join_threshold').setDescription('Ngưỡng join burst (5–30)').setMinValue(5).setMaxValue(30).setRequired(false))
    .addIntegerOption(o => o.setName('raid_window_seconds').setDescription('Cửa sổ raid (5–60 giây)').setMinValue(5).setMaxValue(60).setRequired(false))
    .addIntegerOption(o => o.setName('lockdown_seconds').setDescription('Thời gian khóa text khi raid (30–600 giây)').setMinValue(30).setMaxValue(600).setRequired(false))
].map(c => c.toJSON());
const contextMenuCommands = [
  new ContextMenuCommandBuilder().setName('Userinfo').setType(ApplicationCommandType.User),
  new ContextMenuCommandBuilder().setName('Warn').setType(ApplicationCommandType.User).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers.toString()),
  new ContextMenuCommandBuilder().setName('Report').setType(ApplicationCommandType.User)
].map(command => command.toJSON());
const commands = [...slashCommands, ...contextMenuCommands];

const helpLines = [
  ['ping', 'Kiểm tra latency'], ['server', 'Thông tin server'], ['userinfo', 'Thông tin user'], ['avatar', 'Avatar'], ['botinfo', 'Thông tin bot'], ['rank', 'Cấp độ và XP'], ['balance', 'Số dư xu'], ['daily', 'Nhận xu mỗi ngày'], ['work', 'Làm việc nhận xu'], ['leaderboard', 'Top level / xu'],
  ['poll', 'Tạo bình chọn'], ['8ball', 'Quả cầu tiên tri'], ['roll', 'Xúc xắc'], ['coinflip', 'Đồng xu'], ['remind', 'Đặt lời nhắc 30m / 2h / 1d'], ['reminders', 'Lời nhắc đang chờ'], ['reminder-cancel', 'Huỷ lời nhắc'],
  ['afk', 'AFK + ảnh/GIF riêng'], ['warn', 'Cảnh cáo'], ['warnings', 'Lịch sử cảnh cáo'], ['clear', 'Xoá tin nhắn'], ['slowmode', 'Slowmode'],
  ['verify-setup', 'Cổng xác minh / role cách ly'], ['xp-setup', 'Cấu hình XP và role thưởng'], ['automod-setup', 'Cấu hình AutoMod/raid'], ['giveaway', 'Tạo giveaway'], ['giveaway-reroll', 'Reroll giveaway'], ['suggest', 'Gửi góp ý'], ['suggest-setup', 'Chọn kênh góp ý'], ['shop', 'Cửa hàng xu'], ['buy', 'Mua role bằng xu'], ['tag', 'Tag FAQ'], ['tag-set', 'Lưu tag'], ['tag-delete', 'Xoá tag'], ['faq-set', 'Cấu hình FAQ'], ['faq-delete', 'Xoá FAQ'], ['sell', 'Mở form đăng bán'], ['sell-setup', 'Cấu hình kênh đăng bán'], ['temp-voice-setup', 'Tạo voice room tạm'], ['tag', 'Hiển thị tag'], ['tag-set', 'Tạo/cập nhật tag'], ['tag-delete', 'Xoá tag'], ['faq-set', 'Cấu hình FAQ auto-reply'], ['faq-delete', 'Xoá FAQ'], ['automod-setup', 'Chống spam/mass mention/raid'], ['lock', 'Khoá kênh'], ['unlock', 'Mở khoá'], ['kick', 'Kick'], ['ban', 'Ban'], ['tempban', 'Ban tạm'], ['timeout', 'Timeout'], ['unban', 'Gỡ ban'], ['untimeout', 'Gỡ timeout'], ['delwarn', 'Xoá cảnh cáo'], ['case', 'Tra cứu case'], ['modlog', 'Nhật ký moderation'], ['role', 'Quản lý role'], ['vouch', 'Đánh giá giao dịch'], ['vouches', 'Danh sách vouch'], ['scamcheck', 'Kiểm tra scammer'], ['scam-add', 'Thêm cảnh báo scammer'],
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
async function fetchGuildMember(guild, userId, force = false) {
  try {
    return force
      ? await guild.members.fetch({ user: userId, force: true })
      : await guild.members.fetch(userId);
  } catch { return null; }
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
  if (!canManageTarget(actor.id, actor.roles.highest, target.id, target.roles.highest, guild.ownerId)) {
    throw new Error(`Role cao nhất của mục tiêu phải thấp hơn role cao nhất của bạn để ${action}.`);
  }
}
function ensureRoleBelowInvoker(actor, role) {
  if (!actor || !role) throw new Error('Không xác định được người thực hiện hoặc role.');
  if (role.managed || role.id === actor.guild.id) throw new Error('Không thể tự gán/gỡ role @everyone hoặc role do tích hợp quản lý.');
  if (!canAssignRole(actor.id, actor.roles.highest, role, actor.guild.ownerId, actor.guild.id)) {
    throw new Error('Role cần gán/gỡ phải thấp hơn role cao nhất của bạn.');
  }
}


const tempVoiceCreationLocks = new Set();
const tempVoiceDeletionLocks = new Set();
function tempVoiceKey(guildId, channelId) { return guildId + ':' + channelId; }
async function isTrackedTempVoiceChannel(guildId, channelId) {
  if (pool) {
    const result = await dbQuery('SELECT 1 FROM temp_voice_channels WHERE guild_id=$1 AND channel_id=$2', [guildId,channelId]);
    return Boolean(result.rowCount);
  }
  return memory.tempVoiceChannels?.has(tempVoiceKey(guildId,channelId)) || false;
}
async function saveTempVoiceChannel(guildId, channelId, ownerId) {
  if (pool) {
    await dbQuery('INSERT INTO temp_voice_channels(guild_id,channel_id,owner_id) VALUES($1,$2,$3) ON CONFLICT(channel_id) DO UPDATE SET guild_id=EXCLUDED.guild_id,owner_id=EXCLUDED.owner_id', [guildId,channelId,ownerId]);
    return;
  }
  if (!memory.tempVoiceChannels) memory.tempVoiceChannels = new Map();
  memory.tempVoiceChannels.set(tempVoiceKey(guildId,channelId), { guild_id:guildId,channel_id,owner_id:ownerId });
}
async function deleteTempVoiceChannel(guildId, channelId) {
  if (pool) {
    await dbQuery('DELETE FROM temp_voice_channels WHERE guild_id=$1 AND channel_id=$2', [guildId,channelId]);
    return;
  }
  memory.tempVoiceChannels?.delete(tempVoiceKey(guildId,channelId));
}
async function createTempVoiceRoom(member, config) {
  const guild = member.guild;
  const key = guild.id + ':' + member.id;
  if (tempVoiceCreationLocks.has(key) || !config?.temp_voice_enabled || member.voice?.channelId !== config.temp_voice_trigger_channel_id) return null;
  tempVoiceCreationLocks.add(key);
  let created = null;
  let trackSaved = false;
  try {
    const trigger = await guild.channels.fetch(config.temp_voice_trigger_channel_id).catch(() => null);
    if (!trigger || trigger.type !== ChannelType.GuildVoice || trigger.guild.id !== guild.id) return null;
    const me = guild.members.me || await guild.members.fetchMe();
    if (!me.permissions.has([PermissionFlagsBits.ManageChannels,PermissionFlagsBits.MoveMembers,PermissionFlagsBits.Connect])) {
      throw new Error('Bot needs Manage Channels, Move Members and Connect for temporary voice rooms.');
    }
    const name = normalizeTempVoiceRoomName(member.displayName || member.user.globalName || member.user.username, member.id);
    const categoryId = config.temp_voice_category_id || trigger.parentId || undefined;
    const category = categoryId ? await guild.channels.fetch(categoryId).catch(() => null) : null;
    if (categoryId && (!category || category.type !== ChannelType.GuildCategory || category.guild.id !== guild.id)) throw new Error('Temporary voice category is invalid.');
    created = await guild.channels.create({
      name,
      type: ChannelType.GuildVoice,
      parent: category?.id,
      userLimit: normalizeVoiceUserLimit(config.temp_voice_user_limit),
      reason: 'Temporary voice room for member ' + member.id
    });
    await saveTempVoiceChannel(guild.id, created.id, member.id);
    trackSaved = true;
    if (member.voice.channelId !== config.temp_voice_trigger_channel_id) {
      await created.delete('Member left trigger before room move');
      await deleteTempVoiceChannel(guild.id, created.id);
      return null;
    }
    await member.voice.setChannel(created, 'Temporary voice room requested by member');
    await addActivity(guild.id, member.id, 'voice:temp-created', 'Đã tạo phòng voice tạm ' + created.name + '.').catch(() => {});
    return created;
  } catch (error) {
    if (created) await created.delete('Temporary voice room creation failed').catch(() => {});
    if (trackSaved && created) await deleteTempVoiceChannel(guild.id, created.id).catch(() => {});
    await reportRuntimeError(error, 'temporary-voice-create', guild.id).catch(() => {});
    return null;
  } finally { tempVoiceCreationLocks.delete(key); }
}
async function cleanupTempVoiceIfEmpty(guild, channelId) {
  const key = tempVoiceKey(guild.id, channelId);
  if (tempVoiceDeletionLocks.has(key)) return;
  tempVoiceDeletionLocks.add(key);
  try {
    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildVoice || channel.members.size > 0) return;
    if (!await isTrackedTempVoiceChannel(guild.id, channel.id)) return;
    let deleted = false;
    try { await channel.delete('Temporary voice room is empty'); deleted = true; }
    catch (error) {
      if (error?.code === 10003 || error?.status === 404) deleted = true;
      else console.warn('Temporary voice cleanup failed:', error.message);
    }
    if (!deleted) return;
    await deleteTempVoiceChannel(guild.id, channelId);
    await addActivity(guild.id, null, 'voice:temp-deleted', 'Đã tự xoá phòng voice tạm ' + channel.name + '.').catch(() => {});
  } finally { tempVoiceDeletionLocks.delete(key); }
}
async function cleanupTrackedTempVoiceRooms(guild) {
  if (pool) {
    const rows = await dbQuery('SELECT channel_id FROM temp_voice_channels WHERE guild_id=$1', [guild.id]);
    for (const row of rows.rows) await cleanupTempVoiceIfEmpty(guild, row.channel_id);
    return;
  }
  for (const row of [...(memory.tempVoiceChannels?.values() || [])].filter(item => item.guild_id === guild.id)) {
    await cleanupTempVoiceIfEmpty(guild, row.channel_id);
  }
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
  if (interaction.customId === 'aki:sell:submit' && interaction.guild) {
    await interaction.deferReply({ ephemeral: true });
    const guild = interaction.guild;
    const seller = await guild.members.fetch(interaction.user.id);
    const listing = normalizeSaleSubmission({
      title: interaction.fields.getTextInputValue('title'),
      price: interaction.fields.getTextInputValue('price'),
      description: interaction.fields.getTextInputValue('description'),
      contact: interaction.fields.getTextInputValue('contact')
    });
    const config = await getConfig(guild.id);
    const channel = config.sale_channel_id ? await guild.channels.fetch(config.sale_channel_id).catch(() => null) : null;
    if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) || channel.guild?.id !== guild.id) {
      await interaction.editReply({ content: 'Kênh đăng bán chưa cấu hình. Hãy báo staff dùng /sell-setup.' });
      return true;
    }
    const me = guild.members.me || await guild.members.fetchMe();
    if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
      await interaction.editReply({ content: 'Bot thiếu quyền đăng embed trong kênh đăng bán. Hãy báo staff.' });
      return true;
    }
    const cooldown = normalizeSaleCooldownMinutes(config.sale_cooldown_minutes);
    const reservation = await reserveSaleCooldown(guild.id, seller.id, cooldown);
    if (!reservation.allowed) {
      await interaction.editReply({ content: '⏳ Bạn đã đăng bài gần đây. Có thể đăng bài tiếp sau <t:' + Math.ceil(reservation.nextAt / 1000) + ':R>.' });
      return true;
    }
    let saleId = null;
    let sent = null;
    try {
      saleId = await createSaleRecord({
        guild_id: guild.id, channel_id: channel.id, seller_id: seller.id,
        title: listing.title, price: listing.price, description: listing.description, contact: listing.contact
      });
      const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('🛍️ ' + listing.title)
        .setDescription(listing.description)
        .addFields(
          { name: '💰 Giá', value: listing.price.slice(0, 80), inline: true },
          { name: '👤 Người bán', value: '<@' + seller.id + '>', inline: true }
        )
        .setThumbnail(seller.user.displayAvatarURL({ size: 128 }))
        .setFooter({ text: 'Aki Market · Bài đăng #' + saleId })
        .setTimestamp();
      if (listing.contact) embed.addFields({ name: '📨 Liên hệ', value: listing.contact.slice(0, 120), inline: false });
      sent = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
      await setSaleMessageId(saleId, sent.id);
      await addActivity(guild.id, seller.id, 'sales:posted', 'Đã đăng bài #' + saleId + ' · ' + listing.title + ' tại #' + channel.name + '.').catch(() => {});
      await interaction.editReply({ content: '✅ Đã đăng bài #' + saleId + ' tại <#' + channel.id + '>: ' + sent.url });
    } catch (error) {
      if (sent) await sent.delete().catch(() => {});
      if (saleId !== null) await deleteSaleRecord(saleId).catch(() => {});
      await releaseSaleCooldown(guild.id, seller.id, reservation.reservedAt).catch(() => {});
      throw error;
    }
    return true;
  }
  const contextMatch = String(interaction.customId || '').match(/^aki:context:(warn|report):(\d{17,20})$/);
  if (contextMatch && interaction.guild) {
    await interaction.deferReply({ ephemeral: true });
    const action = contextMatch[1];
    const targetId = contextMatch[2];
    const details = String(interaction.fields.getTextInputValue('details') || '').trim().slice(0, 1200);
    if (details.length < 5) {
      await interaction.editReply({ content: 'Hãy nhập ít nhất 5 ký tự mô tả.' });
      return true;
    }
    if (action === 'warn') {
      const payload = await runCommand('warn', {
        guild: interaction.guild, userId: interaction.user.id,
        userName: interaction.user.globalName || interaction.user.username,
        channel: interaction.channel, args: { user: targetId, reason: details }, source: 'context-menu'
      });
      await interaction.editReply(payload);
      return true;
    }
    const target = await interaction.guild.members.fetch(targetId).catch(() => null);
    if (!target) throw new Error('Không tìm thấy thành viên mục tiêu trong server.');
    const audit = formatAuditReason(interaction.user.globalName || interaction.user.username, details);
    const record = await addModerationCase(interaction.guild.id, targetId, interaction.user.id, 'report', audit);
    await addActivity(interaction.guild.id, interaction.user.id, 'user:report', 'Báo cáo thành viên ' + targetId + ' · case #' + record.case_id + ' · ' + details).catch(() => {});
    await interaction.editReply({ content: '📨 Đã gửi báo cáo cho đội ngũ. Case #' + record.case_id + '. Không có hình phạt tự động nào được áp dụng.' });
    return true;
  }
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
  const warningsPageMatch = customId.match(/^aki:warnings:([0-9]{17,20}):([0-9]{1,6})$/);
  if (warningsPageMatch) {
    const actor = await fetchGuildMember(guild,interaction.user.id);
    if (!actor || (actor.id !== guild.ownerId && !actor.permissions.has(PermissionFlagsBits.ModerateMembers))) {
      await interaction.reply({content:'Chỉ moderator có quyền Moderate Members mới xem được cảnh cáo.',ephemeral:true});
      return true;
    }
    await interaction.deferUpdate();
    const payload = await buildWarningsPagePayload(guild,warningsPageMatch[1],Number(warningsPageMatch[2]));
    await interaction.editReply(payload);
    return true;
  }
  const leaderboardPageMatch = customId.match(/^aki:leaderboard:(levels|coins):([0-9]{1,6})$/);
  if (leaderboardPageMatch) {
    await interaction.deferUpdate();
    const payload = await buildLeaderboardPagePayload(guild,leaderboardPageMatch[1],Number(leaderboardPageMatch[2]));
    await interaction.editReply(payload);
    return true;
  }
  if (customId === 'aki:verify:member') {
    await interaction.deferReply({ ephemeral: true });
    const config = await getConfig(guild.id);
    if (!config.verification_enabled || config.verification_message_id !== interaction.message?.id || config.verification_channel_id !== interaction.channelId) {
      await interaction.editReply({ content: 'Panel xác minh không còn hiệu lực. Hãy dùng panel mới nhất hoặc liên hệ staff.' });
      return true;
    }
    const member = await guild.members.fetch(interaction.user.id);
    const minDays = Math.min(365, Math.max(0, Number(config.verification_min_account_days) || 0));
    if (isAccountTooNew(member.user.createdTimestamp, minDays)) {
      const quarantine = config.verification_quarantine_role_id ? await guild.roles.fetch(config.verification_quarantine_role_id).catch(() => null) : null;
      if (quarantine && !member.roles.cache.has(quarantine.id)) {
        const me = guild.members.me || await guild.members.fetchMe();
        if (!me.permissions.has(PermissionFlagsBits.ManageRoles) || quarantine.managed || quarantine.id === guild.id || quarantine.position >= me.roles.highest.position) {
          await interaction.editReply({ content: 'Tài khoản chưa đủ tuổi và bot chưa thể gán role cách ly. Hãy liên hệ staff.' });
          return true;
        }
        await member.roles.add(quarantine, 'Verification gate: account too new');
      }
      const readyAt = Number(member.user.createdTimestamp) + minDays * 24 * 60 * 60 * 1000;
      await interaction.editReply({ content: '⏳ Tài khoản Discord của bạn còn quá mới. Hãy thử xác minh lại sau <t:' + Math.ceil(readyAt / 1000) + ':R>. Bạn chưa được cấp role Member.' });
      await addActivity(guild.id, member.id, 'verification:quarantined', 'Account age below ' + minDays + ' day threshold.').catch(() => {});
      return true;
    }
    const verifiedRole = config.verification_role_id ? await guild.roles.fetch(config.verification_role_id).catch(() => null) : null;
    const quarantine = config.verification_quarantine_role_id ? await guild.roles.fetch(config.verification_quarantine_role_id).catch(() => null) : null;
    const me = guild.members.me || await guild.members.fetchMe();
    if (!verifiedRole || verifiedRole.managed || verifiedRole.id === guild.id || !me.permissions.has(PermissionFlagsBits.ManageRoles) || verifiedRole.position >= me.roles.highest.position) {
      await interaction.editReply({ content: 'Role Member chưa hợp lệ hoặc bot thiếu quyền Manage Roles. Hãy báo staff.' });
      return true;
    }
    if (!member.roles.cache.has(verifiedRole.id)) await member.roles.add(verifiedRole, 'Aki verification completed');
    if (quarantine && member.roles.cache.has(quarantine.id)) await member.roles.remove(quarantine, 'Aki verification completed');
    await interaction.editReply({ content: '✅ Xác minh thành công. Bạn đã nhận role ' + verifiedRole.name + '.' });
    await addActivity(guild.id, member.id, 'verification:success', 'Đã xác minh và nhận ' + verifiedRole.name + '.').catch(() => {});
    return true;
  }
  const suggestionMatch = customId.match(/^aki:suggest:(up|down|approve|reject):([0-9]{1,20})$/);
  if (suggestionMatch) {
    await interaction.deferReply({ ephemeral: true });
    const action = suggestionMatch[1], suggestionId = suggestionMatch[2];
    const suggestion = await getSuggestion(guild.id, suggestionId);
    if (!suggestion || suggestion.message_id !== interaction.message?.id) {
      await interaction.editReply({ content: 'Góp ý này không còn hợp lệ.' });
      return true;
    }
    if (action === 'up' || action === 'down') {
      if (suggestion.status !== 'pending') {
        await interaction.editReply({ content: 'Góp ý đã được đội ngũ xử lý; vote đã khoá.' });
        return true;
      }
      const saved = await setSuggestionVote(guild.id, suggestionId, interaction.user.id, action);
      if (!saved) {
        await interaction.editReply({ content: 'Không thể ghi vote; góp ý có thể đã được xử lý.' });
        return true;
      }
      await syncSuggestionMessage(await getSuggestion(guild.id, suggestionId));
      await interaction.editReply({ content: '✅ Vote của bạn đã được ghi nhận. Mỗi người chỉ có một vote; chọn nút khác sẽ đổi vote.' });
      return true;
    }
    const actor = await fetchGuildMember(guild, interaction.user.id);
    if (!actor || (actor.id !== guild.ownerId && !actor.permissions.has(PermissionFlagsBits.ManageGuild) && !actor.permissions.has(PermissionFlagsBits.ManageMessages))) {
      await interaction.editReply({ content: 'Chỉ staff có quyền Manage Server hoặc Manage Messages mới được duyệt góp ý.' });
      return true;
    }
    const status = action === 'approve' ? 'approved' : 'rejected';
    const reviewed = await reviewSuggestion(guild.id, suggestionId, actor.id, status);
    if (!reviewed) {
      await interaction.editReply({ content: 'Góp ý này đã được xử lý bởi staff khác.' });
      return true;
    }
    await syncSuggestionMessage(reviewed);
    await interaction.editReply({ content: status === 'approved' ? '✅ Đã duyệt góp ý #' + suggestionId + '.' : 'Đã từ chối góp ý #' + suggestionId + '.' });
    await addActivity(guild.id, actor.id, 'suggestion:' + status, 'Đã ' + (status === 'approved' ? 'duyệt' : 'từ chối') + ' góp ý #' + suggestionId + '.').catch(() => {});
    return true;
  }
  if (customId.startsWith('aki:giveaway:enter:')) {
    await interaction.deferReply({ ephemeral: true });
    const giveawayId = customId.slice('aki:giveaway:enter:'.length);
    if (!/^[0-9]{1,20}$/.test(giveawayId)) {
      await interaction.editReply({ content: 'ID giveaway không hợp lệ.' });
      return true;
    }
    const giveaway = await getGiveaway(guild.id, giveawayId);
    if (!giveaway || giveaway.ended_at || Number(giveaway.ends_at) <= Date.now() || giveaway.message_id !== interaction.message?.id) {
      await interaction.editReply({ content: 'Giveaway này đã kết thúc hoặc không còn hợp lệ.' });
      return true;
    }
    const member = await guild.members.fetch(interaction.user.id);
    if (giveaway.required_role_id && !member.roles.cache.has(giveaway.required_role_id)) {
      await interaction.editReply({ content: 'Bạn chưa có role bắt buộc để tham gia giveaway.' });
      return true;
    }
    const requiredLevel = Number(giveaway.required_level) || 0;
    if (requiredLevel > 0) {
      const profile = await ensureCommunityProfile(guild.id, member.id);
      if (getLevelProgress(profile.xp).level < requiredLevel) {
        await interaction.editReply({ content: 'Bạn cần đạt Level ' + requiredLevel + ' để tham gia giveaway.' });
        return true;
      }
    }
    const inserted = await addGiveawayEntry(guild.id, giveawayId, member.id);
    await interaction.editReply({ content: inserted ? '🎉 Bạn đã tham gia giveaway #' + giveawayId + ' thành công.' : 'Bạn đã tham gia giveaway này rồi.' });
    if (inserted) await addActivity(guild.id, member.id, 'giveaway:entry', 'Đã tham gia giveaway #' + giveawayId + '.').catch(() => {});
    return true;
  }
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


async function createGiveawayRecord(data) {
  if (pool) {
    const result = await dbQuery(
      'INSERT INTO giveaways(guild_id,channel_id,created_by,prize,ends_at,winner_count,required_role_id,required_level) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [data.guild_id, data.channel_id, data.created_by, data.prize, data.ends_at, data.winner_count, data.required_role_id, data.required_level]
    );
    return result.rows[0];
  }
  const row = { id: String(nextGiveawayId++), ...data, message_id: null, ended_at: null, winners: [], created_at: new Date().toISOString() };
  memory.giveaways.set(String(row.id), row);
  memory.giveawayEntries.set(String(row.id), new Set());
  return row;
}
async function getGiveaway(guildId, giveawayId) {
  if (pool) {
    const result = await dbQuery('SELECT * FROM giveaways WHERE guild_id=$1 AND id=$2', [guildId, giveawayId]);
    return result.rows[0] || null;
  }
  const row = memory.giveaways.get(String(giveawayId));
  return row?.guild_id === guildId ? row : null;
}
async function setGiveawayMessageId(guildId, giveawayId, messageId) {
  if (pool) {
    await dbQuery('UPDATE giveaways SET message_id=$1 WHERE guild_id=$2 AND id=$3', [messageId, guildId, giveawayId]);
    return;
  }
  const row = memory.giveaways.get(String(giveawayId));
  if (row && row.guild_id === guildId) row.message_id = messageId;
}
async function addGiveawayEntry(guildId, giveawayId, userId) {
  if (pool) {
    const result = await dbQuery(
      'INSERT INTO giveaway_entries(giveaway_id,user_id) SELECT id,$3 FROM giveaways WHERE guild_id=$1 AND id=$2 AND ended_at IS NULL AND ends_at > $4 ON CONFLICT(giveaway_id,user_id) DO NOTHING RETURNING user_id',
      [guildId, giveawayId, userId, Date.now()]
    );
    return Boolean(result.rowCount);
  }
  const giveaway = await getGiveaway(guildId, giveawayId);
  if (!giveaway || giveaway.ended_at || Number(giveaway.ends_at) <= Date.now()) return false;
  const entries = memory.giveawayEntries.get(String(giveawayId)) || new Set();
  if (entries.has(userId)) return false;
  entries.add(userId);
  memory.giveawayEntries.set(String(giveawayId), entries);
  return true;
}
async function getGiveawayEntries(giveawayId) {
  if (pool) {
    const result = await dbQuery('SELECT user_id FROM giveaway_entries WHERE giveaway_id=$1 ORDER BY entered_at', [giveawayId]);
    return result.rows;
  }
  return [...(memory.giveawayEntries.get(String(giveawayId)) || new Set())].map(user_id => ({ user_id }));
}
async function saveGiveawayResults(guildId, giveawayId, winners, endedAt = null) {
  if (pool) {
    if (endedAt === null) {
      await dbQuery('UPDATE giveaways SET winners=$1::text[] WHERE guild_id=$2 AND id=$3 AND ended_at IS NOT NULL', [winners, guildId, giveawayId]);
    } else {
      await dbQuery('UPDATE giveaways SET winners=$1::text[], ended_at=$2 WHERE guild_id=$3 AND id=$4 AND ended_at IS NULL', [winners, endedAt, guildId, giveawayId]);
    }
    return;
  }
  const row = memory.giveaways.get(String(giveawayId));
  if (row && row.guild_id === guildId) {
    row.winners = winners;
    if (endedAt !== null) row.ended_at = endedAt;
  }
}
function giveawayEmbed(giveaway, ended = false) {
  const ends = Math.floor(Number(giveaway.ends_at) / 1000);
  const conditions = [];
  if (giveaway.required_role_id) conditions.push('Role bắt buộc: <@&' + giveaway.required_role_id + '>');
  if (Number(giveaway.required_level) > 0) conditions.push('Level tối thiểu: ' + giveaway.required_level);
  const winners = Array.isArray(giveaway.winners) ? giveaway.winners : [];
  const ending = ended
    ? (winners.length ? '🏆 Người thắng: ' + winners.map(id => '<@' + id + '>').join(', ') : 'Không có người tham gia đủ điều kiện.')
    : '⏰ Kết thúc <t:' + ends + ':R> · Số người thắng: ' + giveaway.winner_count;
  return new EmbedBuilder().setColor(ended ? 0x57F287 : 0x5865F2)
    .setTitle('🎁 Giveaway #' + giveaway.id + (ended ? ' · ĐÃ KẾT THÚC' : ''))
    .setDescription('**Phần thưởng:** ' + String(giveaway.prize || '').slice(0, 300) + '\n\n' + ending +
      (conditions.length ? '\n\n**Điều kiện:** ' + conditions.join(' · ') : ''))
    .setFooter({ text: 'Aki Dev · Giveaway' }).setTimestamp();
}
function giveawayJoinRow(giveawayId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('aki:giveaway:enter:' + giveawayId).setLabel('🎉 Tham gia').setStyle(ButtonStyle.Success)
  );
}
async function syncGiveawayMessage(giveaway) {
  if (!giveaway?.message_id || !giveaway.channel_id) return;
  const guild = bot.guilds.cache.get(giveaway.guild_id);
  if (!guild) return;
  const channel = await guild.channels.fetch(giveaway.channel_id).catch(() => null);
  if (!channel?.isTextBased?.()) return;
  const message = await channel.messages.fetch(giveaway.message_id).catch(() => null);
  if (!message) return;
  const ended = Boolean(giveaway.ended_at);
  await message.edit({
    embeds: [giveawayEmbed(giveaway, ended)],
    components: ended ? [] : [giveawayJoinRow(giveaway.id)],
    allowedMentions: { parse: [] }
  }).catch(() => {});
}
async function giveawayTick() {
  if (!bot.isReady() || giveawayWorkerRunning) return;
  giveawayWorkerRunning = true;
  try {
    const now = Date.now();
    const due = pool
      ? (await dbQuery('SELECT * FROM giveaways WHERE ended_at IS NULL AND ends_at <= $1 ORDER BY ends_at LIMIT 20', [now])).rows
      : [...memory.giveaways.values()].filter(item => !item.ended_at && Number(item.ends_at) <= now);
    for (const item of due) {
      const entries = await getGiveawayEntries(item.id);
      const winners = drawUniqueWinners(entries, item.winner_count);
      await saveGiveawayResults(item.guild_id, item.id, winners, now);
      const updated = await getGiveaway(item.guild_id, item.id);
      await syncGiveawayMessage(updated);
      const guild = bot.guilds.cache.get(item.guild_id);
      const channel = guild ? await guild.channels.fetch(item.channel_id).catch(() => null) : null;
      if (channel?.isTextBased?.()) {
        const content = winners.length
          ? '🎉 Giveaway #' + item.id + ' kết thúc! Xin chúc mừng ' + winners.map(id => '<@' + id + '>').join(', ') + '!'
          : '🎁 Giveaway #' + item.id + ' đã kết thúc nhưng không có người tham gia đủ điều kiện.';
        await channel.send({ content, allowedMentions: { users: winners } }).catch(() => {});
      }
      await addActivity(item.guild_id, item.created_by, 'giveaway:ended', 'Giveaway #' + item.id + ' ended; winners=' + winners.join(',')).catch(() => {});
    }
  } catch (error) {
    console.warn('Giveaway worker failed:', error?.message || 'unknown error');
  } finally {
    giveawayWorkerRunning = false;
  }
}

async function createSuggestion(data) {
  if (pool) {
    const result = await dbQuery(
      'INSERT INTO suggestions(guild_id,channel_id,created_by,text) VALUES($1,$2,$3,$4) RETURNING *',
      [data.guild_id,data.channel_id,data.created_by,data.text]
    );
    return result.rows[0];
  }
  const row = { id: String(nextSuggestionId++), ...data, message_id: null, status: 'pending', created_at: new Date().toISOString(), reviewed_by: null, reviewed_at: null };
  memory.suggestions.set(String(row.id), row);
  return row;
}
async function getSuggestion(guildId, suggestionId) {
  if (pool) {
    const result = await dbQuery('SELECT * FROM suggestions WHERE guild_id=$1 AND id=$2', [guildId,suggestionId]);
    return result.rows[0] || null;
  }
  const row = memory.suggestions.get(String(suggestionId));
  return row?.guild_id === guildId ? row : null;
}
async function setSuggestionMessageId(guildId, suggestionId, messageId) {
  if (pool) {
    await dbQuery('UPDATE suggestions SET message_id=$1 WHERE guild_id=$2 AND id=$3', [messageId,guildId,suggestionId]);
    return;
  }
  const row = memory.suggestions.get(String(suggestionId));
  if (row && row.guild_id === guildId) row.message_id = messageId;
}
async function setSuggestionVote(guildId, suggestionId, userId, vote) {
  if (!isSuggestionVote(vote)) throw new Error('Vote không hợp lệ.');
  if (pool) {
    const result = await dbQuery(
      "INSERT INTO suggestion_votes(suggestion_id,user_id,vote) SELECT id,$3,$4 FROM suggestions WHERE guild_id=$1 AND id=$2 AND status='pending' ON CONFLICT(suggestion_id,user_id) DO UPDATE SET vote=EXCLUDED.vote,updated_at=NOW() RETURNING vote",
      [guildId,suggestionId,userId,vote]
    );
    return Boolean(result.rowCount);
  }
  const suggestion = await getSuggestion(guildId,suggestionId);
  if (!suggestion || suggestion.status !== 'pending') return false;
  memory.suggestionVotes.set(String(suggestionId) + ':' + userId, vote);
  return true;
}
async function getSuggestionCounts(suggestionId) {
  if (pool) {
    const result = await dbQuery('SELECT vote,COUNT(*)::int AS count FROM suggestion_votes WHERE suggestion_id=$1 GROUP BY vote', [suggestionId]);
    const counts = { up: 0, down: 0 };
    for (const row of result.rows) if (row.vote === 'up' || row.vote === 'down') counts[row.vote] = Number(row.count) || 0;
    return counts;
  }
  const counts = { up: 0, down: 0 };
  for (const [key,vote] of memory.suggestionVotes) {
    if (key.startsWith(String(suggestionId) + ':') && isSuggestionVote(vote)) counts[vote]++;
  }
  return counts;
}
async function reviewSuggestion(guildId, suggestionId, reviewerId, status) {
  if (!canReviewSuggestion('pending', status)) return null;
  if (pool) {
    const result = await dbQuery(
      "UPDATE suggestions SET status=$1,reviewed_by=$2,reviewed_at=NOW() WHERE guild_id=$3 AND id=$4 AND status='pending' RETURNING *",
      [status,reviewerId,guildId,suggestionId]
    );
    return result.rows[0] || null;
  }
  const row = memory.suggestions.get(String(suggestionId));
  if (!row || row.guild_id !== guildId || !canReviewSuggestion(row.status,status)) return null;
  row.status = status;
  row.reviewed_by = reviewerId;
  row.reviewed_at = new Date().toISOString();
  return row;
}
function suggestionComponents(suggestion) {
  if (suggestion.status !== 'pending') return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('aki:suggest:up:' + suggestion.id).setLabel('👍 Ủng hộ').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('aki:suggest:down:' + suggestion.id).setLabel('👎 Không ủng hộ').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('aki:suggest:approve:' + suggestion.id).setLabel('✅ Duyệt').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('aki:suggest:reject:' + suggestion.id).setLabel('✖ Từ chối').setStyle(ButtonStyle.Danger)
  )];
}
async function suggestionEmbed(suggestion) {
  const counts = await getSuggestionCounts(suggestion.id);
  const statusText = suggestion.status === 'approved' ? '✅ Đã duyệt' : suggestion.status === 'rejected' ? '✖ Đã từ chối' : '🟡 Chờ đội ngũ xem xét';
  return new EmbedBuilder().setColor(suggestion.status === 'approved' ? 0x57F287 : suggestion.status === 'rejected' ? 0xED4245 : 0x5865F2)
    .setTitle('💡 Góp ý #' + suggestion.id)
    .setDescription(String(suggestion.text || '').slice(0,1500))
    .addFields(
      { name: 'Ủng hộ', value: String(counts.up), inline: true },
      { name: 'Không ủng hộ', value: String(counts.down), inline: true },
      { name: 'Trạng thái', value: statusText, inline: true },
      { name: 'Người gửi', value: '<@' + suggestion.created_by + '>', inline: false }
    )
    .setFooter({ text: 'Aki Dev · Suggestion System' }).setTimestamp(new Date(suggestion.created_at));
}
async function syncSuggestionMessage(suggestion) {
  if (!suggestion?.message_id) return;
  const guild = bot.guilds.cache.get(suggestion.guild_id);
  const channel = guild ? await guild.channels.fetch(suggestion.channel_id).catch(() => null) : null;
  const message = channel?.isTextBased?.() ? await channel.messages.fetch(suggestion.message_id).catch(() => null) : null;
  if (!message) return;
  await message.edit({ embeds: [await suggestionEmbed(suggestion)], components: suggestionComponents(suggestion), allowedMentions: { parse: [] } });
}
async function spendCommunityCoins(guildId, userId, amount) {
  const price = Math.max(0, Math.floor(Number(amount) || 0));
  if (price <= 0) return false;
  await ensureCommunityProfile(guildId, userId);
  if (pool) {
    const result = await dbQuery(
      'UPDATE community_profiles SET coins=coins-$1,updated_at=NOW() WHERE guild_id=$2 AND user_id=$3 AND coins >= $1 RETURNING coins',
      [price, guildId, userId]
    );
    return result.rowCount ? Number(result.rows[0].coins) : null;
  }
  const profile = await ensureCommunityProfile(guildId, userId);
  if (Number(profile.coins) < price) return null;
  profile.coins = Number(profile.coins) - price;
  return profile.coins;
}
async function refundCommunityCoins(guildId, userId, amount) {
  const price = Math.max(0, Math.floor(Number(amount) || 0));
  if (!price) return;
  await ensureCommunityProfile(guildId, userId);
  if (pool) {
    await dbQuery('UPDATE community_profiles SET coins=coins+$1,updated_at=NOW() WHERE guild_id=$2 AND user_id=$3', [price, guildId, userId]);
    return;
  }
  const profile = await ensureCommunityProfile(guildId, userId);
  profile.coins = Number(profile.coins || 0) + price;
}

async function reserveSaleCooldown(guildId, userId, cooldownMinutes) {
  const now = Date.now();
  const minutes = normalizeSaleCooldownMinutes(cooldownMinutes);
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [guildId + ':' + userId + ':sale']);
      const result = await client.query('SELECT last_post_at FROM sale_post_cooldowns WHERE guild_id=$1 AND user_id=$2 FOR UPDATE', [guildId,userId]);
      const last = Number(result.rows[0]?.last_post_at) || 0;
      const policy = canPostSale(last, now, minutes);
      if (!policy.allowed) {
        await client.query('ROLLBACK');
        return { allowed: false, nextAt: policy.nextAt };
      }
      await client.query(
        'INSERT INTO sale_post_cooldowns(guild_id,user_id,last_post_at) VALUES($1,$2,$3) ON CONFLICT(guild_id,user_id) DO UPDATE SET last_post_at=EXCLUDED.last_post_at',
        [guildId,userId,now]
      );
      await client.query('COMMIT');
      return { allowed: true, reservedAt: now, nextAt: now + minutes * 60_000 };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  const key = guildId + ':' + userId;
  const policy = canPostSale(memory.saleCooldowns.get(key), now, minutes);
  if (!policy.allowed) return { allowed: false, nextAt: policy.nextAt };
  memory.saleCooldowns.set(key, now);
  return { allowed: true, reservedAt: now, nextAt: now + minutes * 60_000 };
}
async function releaseSaleCooldown(guildId, userId, reservedAt) {
  if (pool) {
    await dbQuery('DELETE FROM sale_post_cooldowns WHERE guild_id=$1 AND user_id=$2 AND last_post_at=$3', [guildId,userId,reservedAt]);
    return;
  }
  const key = guildId + ':' + userId;
  if (memory.saleCooldowns.get(key) === reservedAt) memory.saleCooldowns.delete(key);
}
async function createSaleRecord(data) {
  if (pool) {
    const result = await dbQuery(
      'INSERT INTO sale_posts(guild_id,channel_id,seller_id,title,price,description,contact) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [data.guild_id,data.channel_id,data.seller_id,data.title,data.price,data.description,data.contact || null]
    );
    return String(result.rows[0].id);
  }
  const id = String(nextSalePostId++);
  memory.salePosts.push({ id, ...data, message_id: null, created_at: new Date().toISOString() });
  return id;
}
async function setSaleMessageId(saleId, messageId) {
  if (pool) {
    await dbQuery('UPDATE sale_posts SET message_id=$1 WHERE id=$2', [messageId,saleId]);
    return;
  }
  const item = memory.salePosts.find(row => String(row.id) === String(saleId));
  if (item) item.message_id = messageId;
}
async function deleteSaleRecord(saleId) {
  if (pool) {
    await dbQuery('DELETE FROM sale_posts WHERE id=$1', [saleId]);
    return;
  }
  memory.salePosts = memory.salePosts.filter(row => String(row.id) !== String(saleId));
}

async function saveGuildTag(guildId, name, content, createdBy) {
  if (pool) {
    const result = await dbQuery(
      'INSERT INTO guild_tags(guild_id,name,content,created_by) VALUES($1,$2,$3,$4) ON CONFLICT(guild_id,name) DO UPDATE SET content=EXCLUDED.content,created_by=EXCLUDED.created_by,updated_at=NOW() RETURNING name,content,created_by,updated_at',
      [guildId,name,content,createdBy]
    );
    return result.rows[0];
  }
  const row = { guild_id:guildId,name,content,created_by:createdBy,updated_at:new Date().toISOString() };
  memory.tags.set(guildId + ':' + name,row);
  return row;
}
async function getGuildTag(guildId, name) {
  if (pool) {
    const result = await dbQuery('SELECT name,content,created_by,updated_at FROM guild_tags WHERE guild_id=$1 AND name=$2',[guildId,name]);
    return result.rows[0] || null;
  }
  return memory.tags.get(guildId + ':' + name) || null;
}
async function deleteGuildTag(guildId,name) {
  if (pool) {
    const result = await dbQuery('DELETE FROM guild_tags WHERE guild_id=$1 AND name=$2 RETURNING name',[guildId,name]);
    return Boolean(result.rowCount);
  }
  return memory.tags.delete(guildId + ':' + name);
}
async function refreshFaqRuleCache(guildId) {
  let rules;
  if (pool) {
    const result = await dbQuery('SELECT guild_id,keyword,response FROM faq_rules WHERE guild_id=$1 ORDER BY LENGTH(keyword) DESC',[guildId]);
    rules = result.rows;
  } else {
    rules = [...memory.faqRules.values()].filter(row => row.guild_id === guildId);
  }
  faqRuleCache.set(guildId,rules);
  return rules;
}

async function getGuildMessageTemplate(guildId, kind) {
  if (!['welcome','goodbye'].includes(kind)) return null;
  if (pool) {
    const result = await dbQuery('SELECT guild_id,kind,title,message,image_url,button_label,button_url,updated_by,updated_at FROM guild_message_templates WHERE guild_id=$1 AND kind=$2', [guildId,kind]);
    return result.rows[0] || null;
  }
  return memoryMessageTemplates.get(guildId + ':' + kind) || null;
}
async function saveGuildMessageTemplate(guildId, kind, template, updatedBy) {
  const normalized = normalizeMessageTemplate(kind,template);
  if (pool) {
    const result = await dbQuery(
      'INSERT INTO guild_message_templates(guild_id,kind,title,message,image_url,button_label,button_url,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(guild_id,kind) DO UPDATE SET title=EXCLUDED.title,message=EXCLUDED.message,image_url=EXCLUDED.image_url,button_label=EXCLUDED.button_label,button_url=EXCLUDED.button_url,updated_by=EXCLUDED.updated_by,updated_at=NOW() RETURNING guild_id,kind,title,message,image_url,button_label,button_url,updated_by,updated_at',
      [guildId,normalized.kind,normalized.title,normalized.message,normalized.image_url,normalized.button_label,normalized.button_url,updatedBy]
    );
    return result.rows[0];
  }
  const row = { guild_id:guildId, ...normalized, updated_by:updatedBy, updated_at:new Date().toISOString() };
  memoryMessageTemplates.set(guildId + ':' + kind,row);
  return row;
}
function buildMessageTemplateEmbed(kind, template, member, guild, fallbackTitle, fallbackMessage) {
  const raw = template || { title:fallbackTitle, message:fallbackMessage };
  const rendered = renderMessageTemplate(raw, member.user?.globalName || member.user?.username || member.displayName, guild.name);
  const embed = new EmbedBuilder().setColor(kind === 'welcome' ? 0x57F287 : 0x5865F2)
    .setTitle(rendered.title).setDescription(rendered.message).setTimestamp();
  const avatar = member.user?.displayAvatarURL?.({ size: 256 });
  if (template?.image_url) embed.setImage(template.image_url);
  else if (avatar) embed.setThumbnail(avatar);
  const components = template?.button_url && template?.button_label
    ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(String(template.button_label).slice(0,80)).setURL(template.button_url))]
    : [];
  return { embeds:[embed],components,allowedMentions:{parse:[]} };
}
async function saveFaqRule(guildId, keyword, response, createdBy) {
  if (pool) {
    const result = await dbQuery(
      'INSERT INTO faq_rules(guild_id,keyword,response,created_by) VALUES($1,$2,$3,$4) ON CONFLICT(guild_id,keyword) DO UPDATE SET response=EXCLUDED.response,created_by=EXCLUDED.created_by,updated_at=NOW() RETURNING keyword,response,created_by,updated_at',
      [guildId,keyword,response,createdBy]
    );
    await refreshFaqRuleCache(guildId);
    return result.rows[0];
  }
  const row = { guild_id:guildId,keyword,response,created_by:createdBy,updated_at:new Date().toISOString() };
  memory.faqRules.set(guildId + ':' + keyword,row);
  await refreshFaqRuleCache(guildId);
  return row;
}
async function deleteFaqRule(guildId, keyword) {
  let deleted;
  if (pool) {
    const result = await dbQuery('DELETE FROM faq_rules WHERE guild_id=$1 AND keyword=$2 RETURNING keyword',[guildId,keyword]);
    deleted = Boolean(result.rowCount);
  } else {
    deleted = memory.faqRules.delete(guildId + ':' + keyword);
  }
  await refreshFaqRuleCache(guildId);
  return deleted;
}
async function maybeSendFaqReply(message, prefix) {
  if (!message.guild || !message.content || message.content.startsWith(prefix)) return false;
  let rules = faqRuleCache.get(message.guild.id);
  if (!rules) rules = await refreshFaqRuleCache(message.guild.id);
  const rule = findMatchingFaq(rules,message.content);
  if (!rule) return false;
  const now = Date.now();
  if (faqResponseCooldowns.size > 5000) {
    for (const [key,stamp] of faqResponseCooldowns) if (now-stamp > 60_000) faqResponseCooldowns.delete(key);
  }
  const cooldownKey = message.guild.id + ':' + message.author.id + ':' + rule.keyword;
  const last = faqResponseCooldowns.get(cooldownKey) || 0;
  if (now-last < 15_000) return false;
  faqResponseCooldowns.set(cooldownKey,now);
  await message.reply({ content: rule.response, allowedMentions: { parse: [] } }).catch(() => {});
  return true;
}
async function runCommand(name, ctx) {
  const { guild, userId, channel, args = {}, source = 'discord' } = ctx;
  const cooldown = checkCommandCooldown(commandCooldowns, guild.id + ':' + userId + ':' + name, Date.now(), COMMAND_COOLDOWN_MS);
  if (!cooldown.allowed) throw new Error('⏳ Chờ ' + Math.max(1, Math.ceil(cooldown.remainingMs / 1000)) + ' giây trước khi dùng lại /' + name + '.');
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
      return reply('🌞 Bạn nhận được **+' + result.reward + ' xu**! Streak: **' + result.streak + ' ngày**. Số dư: **' + result.coins.toLocaleString('en-US') + ' xu**.');
    }
    case 'work': {
      const result = await claimCommunityCoins(guild.id, userId, 'work');
      if (!result.ok) return reply('🛠️ Bạn vừa làm việc rồi. Có thể làm tiếp ' + `<t:${Math.ceil(result.nextAt / 1000)}:R>` + '.');
      return reply('🛠️ Hoàn thành công việc và nhận **+' + result.reward + ' xu**! Số dư: **' + result.coins.toLocaleString('en-US') + ' xu**.');
    }
    case 'leaderboard': {
      const kind = args.kind === 'coins' ? 'coins' : 'levels';
      return buildLeaderboardPagePayload(guild,kind,1);
    }
    case 'poll':
      return buildNativePollPayload(args);
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
      const body = formatReminderList(rows);
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
      let escalationMessage = '';
      const threshold = Number.parseInt(process.env.WARN_ESCALATION_THRESHOLD || '3', 10);
      const escalationMinutes = Number.parseInt(process.env.WARN_ESCALATION_MINUTES || '10', 10);
      if (shouldEscalateWarnings(count, threshold) && Number.isInteger(escalationMinutes) && escalationMinutes >= 1 && escalationMinutes <= 40320 && target.moderatable) {
        try {
          const escalationAudit = formatAuditReason(userName, 'Tự động timeout sau ' + count + ' cảnh cáo (' + threshold + ' mỗi chu kỳ).');
          await target.timeout(escalationMinutes * 60_000, escalationAudit);
          const escalationCase = await addModerationCase(guild.id, target.id, userId, 'auto-timeout', escalationAudit);
          escalationMessage = ' ⏳ Đã tự động timeout ' + escalationMinutes + ' phút theo ngưỡng cảnh cáo; case #' + escalationCase.case_id + '.';
        } catch (error) {
          console.warn('Warning escalation failed:', error?.message || 'unknown error');
        }
      }
      return reply(`⚠️ Đã cảnh cáo **${target.user.globalName || target.user.username}**. Tổng: **${count}**. Case #${record.case_id}.` + escalationMessage);
    }
    case 'warnings': {
      ensureMemberPermission(user, PermissionFlagsBits.ModerateMembers);
      const m = target || user;
      return buildWarningsPagePayload(guild,m.id,1);
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
    case 'xp-setup': {
      ensureMemberPermission(user, PermissionFlagsBits.ManageGuild);
      const current = await getGuildXpSettings(guild.id);
      const splitAndParse = (arg, fallback, parser) => arg == null ? fallback : parser(arg);
      const ignoredChannels = splitAndParse(args.ignoredChannels, current.ignored_channel_ids, value => normalizeIdList(value));
      const ignoredRoles = splitAndParse(args.ignoredRoles, current.ignored_role_ids, value => normalizeIdList(value));
      const multipliers = splitAndParse(args.roleMultipliers, current.role_multipliers, value => normalizeRoleMultipliers(value));
      const rewards = splitAndParse(args.levelRewards, current.level_rewards, value => normalizeLevelRewards(value));
      for (const channelId of ignoredChannels) {
        const targetChannel = await guild.channels.fetch(channelId).catch(() => null);
        if (!targetChannel || targetChannel.guild?.id !== guild.id) throw new Error('Kênh bỏ qua không thuộc server này: ' + channelId);
      }
      const roleIds = new Set([...ignoredRoles, ...Object.keys(multipliers), ...Object.values(rewards)]);
      for (const roleId of roleIds) {
        const role = await guild.roles.fetch(roleId).catch(() => null);
        if (!role || role.managed || role.id === guild.id) throw new Error('Role XP không hợp lệ hoặc không thuộc server này: ' + roleId);
      }
      const settings = await saveGuildXpSettings(guild.id, {
        enabled: args.enabled, ignored_channel_ids: ignoredChannels, ignored_role_ids: ignoredRoles,
        role_multipliers: multipliers, level_rewards: rewards
      });
      await addActivity(guild.id, userId, 'xp:setup', 'XP ' + (settings.enabled ? 'bật' : 'tắt') + ' · bỏ qua ' + settings.ignored_channel_ids.length + ' kênh/' + settings.ignored_role_ids.length + ' role · multiplier ' + Object.keys(settings.role_multipliers).length + ' role · level rewards ' + Object.keys(settings.level_rewards).length + '.');
      return reply('✨ Đã lưu XP config: **' + (settings.enabled ? 'ON' : 'OFF') + '** · bỏ qua ' + settings.ignored_channel_ids.length + ' kênh, ' + settings.ignored_role_ids.length + ' role; ' + Object.keys(settings.role_multipliers).length + ' hệ số; ' + Object.keys(settings.level_rewards).length + ' mốc thưởng.');
    }
    case 'automod-setup': {
      ensureMemberPermission(user, PermissionFlagsBits.ManageGuild);
      const current = await getConfig(guild.id);
      const enabled = Boolean(args.enabled);
      const me = guild.members.me || await guild.members.fetchMe();
      if (enabled && !me.permissions.has(PermissionFlagsBits.ManageMessages)) {
        throw new Error('Bot cần quyền Manage Messages để bật AutoMod.');
      }
      const domains = args.blockedDomains == null
        ? normalizeBlockedDomains(current.automod_blocked_domains || [])
        : normalizeBlockedDomains(args.blockedDomains);
      const config = await setConfig(guild.id, {
        automod_enabled: enabled,
        automod_blocked_domains: domains,
        automod_spam_threshold: args.spamThreshold == null ? current.automod_spam_threshold : args.spamThreshold,
        automod_spam_window_seconds: args.spamWindowSeconds == null ? current.automod_spam_window_seconds : args.spamWindowSeconds,
        automod_max_mentions: args.maxMentions == null ? current.automod_max_mentions : args.maxMentions,
        automod_raid_join_threshold: args.raidJoinThreshold == null ? current.automod_raid_join_threshold : args.raidJoinThreshold,
        automod_raid_window_seconds: args.raidWindowSeconds == null ? current.automod_raid_window_seconds : args.raidWindowSeconds,
        automod_lockdown_seconds: args.lockdownSeconds == null ? current.automod_lockdown_seconds : args.lockdownSeconds
      });
      await addActivity(guild.id, userId, enabled ? 'automod:enabled' : 'automod:disabled',
        'AutoMod ' + (enabled ? 'bật' : 'tắt') + ' · blocked domains=' + domains.length + ' · spam=' + config.automod_spam_threshold + '/' + config.automod_spam_window_seconds + 's.');
      const raidNote = enabled && !pool
        ? ' Lưu ý: raid lockdown yêu cầu PostgreSQL để tự khôi phục quyền sau restart.'
        : enabled && !me.permissions.has(PermissionFlagsBits.ManageChannels)
          ? ' Lưu ý: bot thiếu Manage Channels nên không thể khóa text khi phát hiện raid.'
          : '';
      return reply((enabled ? '🛡️ AutoMod đã bật.' : 'AutoMod đã tắt.') + ' Domain đang chặn: ' + (domains.join(', ') || 'chưa cấu hình') + '.' + raidNote);
    }
    case 'temp-voice-setup': {
      ensureMemberPermission(user, PermissionFlagsBits.ManageGuild);
      const current = await getConfig(guild.id);
      if (!args.enabled) {
        await setConfig(guild.id, { temp_voice_enabled: false });
        await addActivity(guild.id, userId, 'voice:temp-disabled', 'Đã tắt tạo voice room tạm.');
        return reply('🎧 Đã tắt voice room tạm. Phòng hiện có sẽ được dọn khi trống.');
      }
      const triggerId = args.triggerChannel || args.trigger_channel || current.temp_voice_trigger_channel_id;
      const trigger = triggerId ? await guild.channels.fetch(triggerId).catch(() => null) : null;
      if (!trigger || trigger.type !== ChannelType.GuildVoice || trigger.guild?.id !== guild.id) throw new Error('Khi bật tính năng, hãy chọn một kênh voice trigger hợp lệ.');
      const categoryId = args.categoryId || args.category || current.temp_voice_category_id || trigger.parentId || null;
      const category = categoryId ? await guild.channels.fetch(categoryId).catch(() => null) : null;
      if (categoryId && (!category || category.type !== ChannelType.GuildCategory || category.guild?.id !== guild.id)) throw new Error('Category chứa phòng tạm không hợp lệ.');
      const me = guild.members.me || await guild.members.fetchMe();
      if (!me.permissions.has([PermissionFlagsBits.ManageChannels,PermissionFlagsBits.MoveMembers,PermissionFlagsBits.Connect])) throw new Error('Bot cần Manage Channels, Move Members và Connect.');
      const perms = trigger.permissionsFor(me);
      if (!perms?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.Connect])) throw new Error('Bot cần View Channel và Connect trong kênh trigger.');
      await setConfig(guild.id, {
        temp_voice_enabled: true,
        temp_voice_trigger_channel_id: trigger.id,
        temp_voice_category_id: category?.id || null,
        temp_voice_user_limit: normalizeVoiceUserLimit(args.userLimit ?? args.user_limit ?? current.temp_voice_user_limit)
      });
      await addActivity(guild.id,userId,'voice:temp-enabled','Bật tạo voice room từ #' + trigger.name + '.');
      return reply('✅ Đã bật voice room tạm. Khi thành viên vào <#' + trigger.id + '>, bot sẽ tạo phòng tạm và xoá khi không còn người.');
    }
    case 'sell-setup': {
      ensureMemberPermission(user, PermissionFlagsBits.ManageGuild);
      const targetChannel = args.channel ? await guild.channels.fetch(args.channel).catch(() => null) : null;
      if (!targetChannel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(targetChannel.type) || targetChannel.guild?.id !== guild.id) throw new Error('Chọn kênh text thuộc đúng server.');
      const cooldown = normalizeSaleCooldownMinutes(args.cooldownMinutes ?? 30);
      const me = guild.members.me || await guild.members.fetchMe();
      if (!targetChannel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) throw new Error('Bot cần View Channel, Send Messages và Embed Links trong kênh đăng bán.');
      await setConfig(guild.id, { sale_channel_id: targetChannel.id, sale_cooldown_minutes: cooldown });
      await addActivity(guild.id, userId, 'sales:setup', 'Đặt kênh đăng bán #' + targetChannel.name + ' · cooldown ' + cooldown + ' phút.');
      return reply('🛍️ Đã cấu hình kênh đăng bán thành <#' + targetChannel.id + '> với cooldown ' + cooldown + ' phút.');
    }
    case 'tag': {
      const tagName = normalizeTagName(args.name);
      const item = await getGuildTag(guild.id,tagName);
      if (!item) throw new Error('Không tìm thấy tag "' + tagName + '" trong server.');
      return { content: item.content, allowedMentions: { parse: [] } };
    }
    case 'tag-set': {
      ensureMemberPermission(user, PermissionFlagsBits.ManageGuild);
      const tagName = normalizeTagName(args.name);
      const content = sanitizeCommunityContent(args.content,1500);
      await saveGuildTag(guild.id,tagName,content,userId);
      await addActivity(guild.id,userId,'tag:updated','Đã tạo/cập nhật tag "' + tagName + '".').catch(() => {});
      return reply('✅ Đã lưu tag "' + tagName + '". Dùng /tag name:' + tagName + ' để xem nội dung.');
    }
    case 'tag-delete': {
      ensureMemberPermission(user, PermissionFlagsBits.ManageGuild);
      const tagName = normalizeTagName(args.name);
      if (!await deleteGuildTag(guild.id,tagName)) throw new Error('Không tìm thấy tag "' + tagName + '".');
      await addActivity(guild.id,userId,'tag:deleted','Đã xoá tag "' + tagName + '".').catch(() => {});
      return reply('🗑️ Đã xoá tag "' + tagName + '".');
    }
    case 'faq-set': {
      ensureMemberPermission(user, PermissionFlagsBits.ManageGuild);
      const keyword = normalizeFaqKeyword(args.keyword);
      const response = sanitizeCommunityContent(args.response,1500);
      await saveFaqRule(guild.id,keyword,response,userId);
      await addActivity(guild.id,userId,'faq:updated','Đã tạo/cập nhật FAQ keyword "' + keyword + '".').catch(() => {});
      return reply('✅ Đã lưu FAQ cho từ khoá "' + keyword + '". Rule dài nhất sẽ được ưu tiên nếu nhiều rule cùng khớp.');
    }
    case 'faq-delete': {
      ensureMemberPermission(user, PermissionFlagsBits.ManageGuild);
      const keyword = normalizeFaqKeyword(args.keyword);
      if (!await deleteFaqRule(guild.id,keyword)) throw new Error('Không tìm thấy FAQ cho từ khoá "' + keyword + '".');
      await addActivity(guild.id,userId,'faq:deleted','Đã xoá FAQ keyword "' + keyword + '".').catch(() => {});
      return reply('🗑️ Đã xoá FAQ "' + keyword + '".');
    }
    case 'shop': {
      const profile = await ensureCommunityProfile(guild.id, userId);
      const rows = SHOP_ITEMS.map(item => '**' + item.id + '** · ' + item.roleName + ' · **' + item.price + ' xu**\n' + item.description).join('\n\n');
      return embedPayload(new EmbedBuilder().setColor(0xFEE75C).setTitle('🛒 Cửa hàng Aki · Xu của bạn: ' + Number(profile.coins || 0).toLocaleString('vi-VN'))
        .setDescription(rows).setFooter({ text: 'Mua bằng /buy item · Role shop chỉ có permission 0.' }).setTimestamp());
    }
    case 'buy': {
      if (!user) throw new Error('Bạn phải là thành viên trong server để mua role.');
      const item = getShopItem(args.item);
      if (!item) throw new Error('Mã hàng không hợp lệ. Dùng /shop để xem danh sách.');
      const role = guild.roles.cache.find(candidate => candidate.name === item.roleName);
      const me = guild.members.me || await guild.members.fetchMe();
      if (!isSafeShopRole(role, guild.id, me.roles.highest.position)) throw new Error('Role shop chưa tồn tại, có permission, do integration quản lý hoặc nằm trên/ngang role bot.');
      if (user.roles.cache.has(role.id)) throw new Error('Bạn đã có role ' + role.name + ' rồi.');
      const remaining = await spendCommunityCoins(guild.id, userId, item.price);
      if (remaining === null) throw new Error('Bạn không đủ xu. Giá món này là ' + item.price + ' xu.');
      try {
        await user.roles.add(role, 'Aki Community Shop purchase ' + item.id);
      } catch (error) {
        await refundCommunityCoins(guild.id, userId, item.price).catch(() => {});
        throw error;
      }
      await addActivity(guild.id, userId, 'shop:purchase', 'Đã mua ' + item.id + ' với ' + item.price + ' xu.').catch(() => {});
      return reply('✅ Đã mua role ' + role.name + ' với **' + item.price + ' xu**. Số dư còn **' + remaining.toLocaleString('vi-VN') + ' xu**.');
    }
    case 'suggest-setup': {
      ensureMemberPermission(user, PermissionFlagsBits.ManageGuild);
      const targetChannel = args.channel ? await guild.channels.fetch(args.channel).catch(() => null) : null;
      if (!targetChannel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(targetChannel.type) || targetChannel.guild?.id !== guild.id) throw new Error('Chọn kênh text thuộc đúng server.');
      await setConfig(guild.id, { suggestion_channel_id: targetChannel.id });
      await addActivity(guild.id, userId, 'suggestion:setup', 'Đặt kênh góp ý tại #' + targetChannel.name + '.');
      return reply('💡 Kênh góp ý đã được đặt thành <#' + targetChannel.id + '>.');
    }
    case 'suggest': {
      const text = normalizeSuggestionText(args.text, 1500);
      if (text.length < 5) throw new Error('Góp ý cần ít nhất 5 ký tự.');
      const config = await getConfig(guild.id);
      const targetChannel = config.suggestion_channel_id ? await guild.channels.fetch(config.suggestion_channel_id).catch(() => null) : channel;
      if (!targetChannel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(targetChannel.type) || targetChannel.guild?.id !== guild.id) throw new Error('Kênh góp ý chưa hợp lệ. Staff hãy chạy /suggest-setup.');
      const me = guild.members.me || await guild.members.fetchMe();
      if (!targetChannel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) throw new Error('Bot thiếu quyền View Channel, Send Messages hoặc Embed Links trong kênh góp ý.');
      const record = await createSuggestion({ guild_id: guild.id, channel_id: targetChannel.id, created_by: userId, text });
      try {
        const sent = await targetChannel.send({ embeds: [await suggestionEmbed(record)], components: suggestionComponents(record), allowedMentions: { parse: [] } });
        await setSuggestionMessageId(guild.id, record.id, sent.id);
        record.message_id = sent.id;
      } catch (error) {
        if (pool) await dbQuery('DELETE FROM suggestions WHERE guild_id=$1 AND id=$2', [guild.id,record.id]).catch(() => {});
        else memory.suggestions.delete(String(record.id));
        throw error;
      }
      await addActivity(guild.id, userId, 'suggestion:created', 'Đã gửi góp ý #' + record.id + ' tại #' + targetChannel.name + '.').catch(() => {});
      return reply('💡 Đã gửi góp ý #' + record.id + ' tới <#' + targetChannel.id + '>. Bạn có thể vote bằng các nút bên dưới.');
    }
    case 'giveaway': {
      ensureMemberPermission(user, PermissionFlagsBits.ManageGuild);
      const prize = String(args.prize || '').trim().slice(0, 300);
      const minutes = Number(args.minutes), winnerCount = Number(args.winners);
      if (!prize) throw new Error('Hãy nhập phần thưởng.');
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) throw new Error('Thời lượng giveaway phải từ 1 đến 10080 phút.');
      if (!Number.isInteger(winnerCount) || winnerCount < 1 || winnerCount > 10) throw new Error('Số người thắng phải từ 1 đến 10.');
      const targetChannel = args.channel ? await guild.channels.fetch(args.channel).catch(() => null) : channel;
      if (!targetChannel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(targetChannel.type) || targetChannel.guild?.id !== guild.id) throw new Error('Chọn kênh text thuộc đúng server.');
      const requiredRole = args.requiredRoleId ? await guild.roles.fetch(args.requiredRoleId).catch(() => null) : null;
      if (args.requiredRoleId && (!requiredRole || requiredRole.managed || requiredRole.id === guild.id)) throw new Error('Role điều kiện không hợp lệ.');
      const requiredLevel = Math.max(0, Math.min(1000, Number(args.requiredLevel) || 0));
      const me = guild.members.me || await guild.members.fetchMe();
      if (!targetChannel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) throw new Error('Bot thiếu quyền gửi embed trong kênh giveaway.');
      const item = await createGiveawayRecord({
        guild_id: guild.id, channel_id: targetChannel.id, created_by: userId,
        prize, ends_at: Date.now() + minutes * 60_000, winner_count: winnerCount,
        required_role_id: requiredRole?.id || null, required_level: requiredLevel
      });
      try {
        const sent = await targetChannel.send({ embeds: [giveawayEmbed(item)], components: [giveawayJoinRow(item.id)], allowedMentions: { parse: [] } });
        await setGiveawayMessageId(guild.id, item.id, sent.id);
        item.message_id = sent.id;
      } catch (error) {
        if (pool) await dbQuery('DELETE FROM giveaways WHERE guild_id=$1 AND id=$2', [guild.id, item.id]).catch(() => {});
        else { memory.giveaways.delete(String(item.id)); memory.giveawayEntries.delete(String(item.id)); }
        throw error;
      }
      await addActivity(guild.id, userId, 'giveaway:created', 'Tạo giveaway #' + item.id + ' tại #' + targetChannel.name + '.');
      return reply('🎁 Đã tạo giveaway #' + item.id + ' tại <#' + targetChannel.id + '>. Kết thúc sau ' + minutes + ' phút.');
    }
    case 'giveaway-reroll': {
      ensureMemberPermission(user, PermissionFlagsBits.ManageGuild);
      const id = String(args.giveawayId || '');
      if (!/^[0-9]{1,20}$/.test(id)) throw new Error('Giveaway ID không hợp lệ.');
      const item = await getGiveaway(guild.id, id);
      if (!item) throw new Error('Không tìm thấy giveaway trong server này.');
      if (!item.ended_at) throw new Error('Chỉ có thể reroll giveaway đã kết thúc.');
      const entries = await getGiveawayEntries(id);
      const winners = drawUniqueWinners(entries, item.winner_count, item.winners || []);
      if (!winners.length) throw new Error('Không còn người tham gia khác để reroll.');
      await saveGiveawayResults(guild.id, id, winners);
      item.winners = winners;
      await syncGiveawayMessage(item);
      const targetChannel = await guild.channels.fetch(item.channel_id).catch(() => null);
      if (targetChannel?.isTextBased?.()) await targetChannel.send({
        content: '🔁 Giveaway #' + id + ' · người thắng mới: ' + winners.map(user => '<@' + user + '>').join(', '),
        allowedMentions: { users: winners }
      });
      await addActivity(guild.id, userId, 'giveaway:reroll', 'Reroll giveaway #' + id + ' · ' + winners.join(',')).catch(() => {});
      return reply('🔁 Đã reroll giveaway #' + id + '.');
    }
    case 'verify-setup': {
      ensureMemberPermission(user, PermissionFlagsBits.ManageGuild);
      if (!args.enabled) {
        await setConfig(guild.id, { verification_enabled: false });
        await addActivity(guild.id, userId, 'verification:disable', 'Đã tắt cổng xác minh.');
        return reply('Đã tắt cổng xác minh. Auto-role cũ được khôi phục cho thành viên mới.');
      }
      const channel = args.channel ? await guild.channels.fetch(args.channel).catch(() => null) : null;
      if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) throw new Error('Khi bật xác minh, hãy chọn kênh text/announcement thuộc server.');
      const current = await getConfig(guild.id);
      const roleId = args.verifyRole || current.verification_role_id || current.auto_role_id || guild.roles.cache.find(role => role.name === '👥 Member')?.id;
      const verifiedRole = roleId ? await guild.roles.fetch(roleId).catch(() => null) : null;
      if (!verifiedRole || verifiedRole.managed || verifiedRole.id === guild.id) throw new Error('Không tìm thấy role Member hợp lệ. Hãy chọn member_role.');
      const minDays = Math.min(365, Math.max(0, Number.isInteger(args.minAccountDays) ? args.minAccountDays : Number(current.verification_min_account_days) || 0));
      const quarantineId = args.quarantineRole || current.verification_quarantine_role_id || null;
      const quarantineRole = quarantineId ? await guild.roles.fetch(quarantineId).catch(() => null) : null;
      if (minDays > 0 && (!quarantineRole || quarantineRole.managed || quarantineRole.id === guild.id)) throw new Error('Nếu đặt tuổi tài khoản tối thiểu lớn hơn 0, phải chọn quarantine_role hợp lệ.');
      const me = guild.members.me || await guild.members.fetchMe();
      if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('Bot cần quyền Manage Roles để cấp role xác minh.');
      if (verifiedRole.position >= me.roles.highest.position || (quarantineRole && quarantineRole.position >= me.roles.highest.position)) throw new Error('Role xác minh và role cách ly phải nằm dưới role cao nhất của bot.');
      const channelPerms = channel.permissionsFor(me);
      if (!channelPerms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) throw new Error('Bot cần View Channel, Send Messages và Embed Links trong kênh panel.');
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('aki:verify:member').setLabel('Xác minh và nhận Member').setStyle(ButtonStyle.Success));
      const message = await channel.send({
        embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('Cổng xác minh thành viên')
          .setDescription('Nhấn nút bên dưới để xác minh và nhận role Member. Tài khoản mới hơn ' + minDays + ' ngày sẽ được giữ ở role cách ly cho đến khi đủ tuổi.')
          .setFooter({ text: APP_NAME + ' · Verification Gate' }).setTimestamp()],
        components: [row], allowedMentions: { parse: [] }
      });
      await setConfig(guild.id, {
        verification_enabled: true, verification_channel_id: channel.id, verification_message_id: message.id,
        verification_role_id: verifiedRole.id, verification_quarantine_role_id: quarantineRole?.id || null,
        verification_min_account_days: minDays
      });
      await addActivity(guild.id, userId, 'verification:setup', 'Cổng xác minh tại #' + channel.name + ' · min account age ' + minDays + ' days.');
      return reply('Đã bật cổng xác minh tại <#' + channel.id + '>. Panel ID ' + message.id + '. Tài khoản mới sẽ không nhận auto-role.');
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
  if (['warn', 'kick', 'ban', 'tempban', 'timeout'].includes(interaction.commandName)) { out.user = getUserId(); }
  if (['warn', 'kick', 'ban', 'tempban', 'timeout'].includes(interaction.commandName)) out.reason = interaction.options.getString('reason');
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
  if (['vc-join', 'welcome-setup', 'goodbye-setup', 'verify-setup', 'giveaway'].includes(interaction.commandName)) out.channel = interaction.options.getChannel('channel')?.id;
  if (interaction.commandName === 'giveaway') {
    out.prize = interaction.options.getString('prize');
    out.minutes = interaction.options.getInteger('minutes');
    out.winners = interaction.options.getInteger('winners');
    out.requiredRoleId = interaction.options.getRole('required_role')?.id;
    out.requiredLevel = interaction.options.getInteger('required_level');
  }
  if (interaction.commandName === 'giveaway-reroll') out.giveawayId = interaction.options.getString('giveaway_id');
  if (interaction.commandName === 'suggest') out.text = interaction.options.getString('text');
  if (interaction.commandName === 'buy') out.item = interaction.options.getString('item');
  if (interaction.commandName === 'tag') out.name = interaction.options.getString('name');
  if (interaction.commandName === 'tag-set') { out.name = interaction.options.getString('name'); out.content = interaction.options.getString('content'); }
  if (interaction.commandName === 'tag-delete') out.name = interaction.options.getString('name');
  if (interaction.commandName === 'faq-set') { out.keyword = interaction.options.getString('keyword'); out.response = interaction.options.getString('response'); }
  if (interaction.commandName === 'faq-delete') out.keyword = interaction.options.getString('keyword');
  if (interaction.commandName === 'suggest-setup') out.channel = interaction.options.getChannel('channel')?.id;
  if (interaction.commandName === 'xp-setup') {
    out.enabled = interaction.options.getBoolean('enabled');
    out.ignoredChannels = interaction.options.getString('ignored_channels');
    out.ignoredRoles = interaction.options.getString('ignored_roles');
    out.roleMultipliers = interaction.options.getString('role_multipliers');
    out.levelRewards = interaction.options.getString('level_rewards');
  }
  if (interaction.commandName === 'automod-setup') {
    out.enabled = interaction.options.getBoolean('enabled');
    out.blockedDomains = interaction.options.getString('blocked_domains') ?? undefined;
    out.spamThreshold = interaction.options.getInteger('spam_threshold') ?? undefined;
    out.spamWindowSeconds = interaction.options.getInteger('spam_window_seconds') ?? undefined;
    out.maxMentions = interaction.options.getInteger('max_mentions') ?? undefined;
    out.raidJoinThreshold = interaction.options.getInteger('raid_join_threshold') ?? undefined;
    out.raidWindowSeconds = interaction.options.getInteger('raid_window_seconds') ?? undefined;
    out.lockdownSeconds = interaction.options.getInteger('lockdown_seconds') ?? undefined;
  }
  if (interaction.commandName === 'sell-setup') {
    out.channel = interaction.options.getChannel('channel')?.id;
    out.cooldownMinutes = interaction.options.getInteger('cooldown_minutes');
  }
  if (interaction.commandName === 'temp-voice-setup') {
    out.enabled = interaction.options.getBoolean('enabled');
    out.triggerChannel = interaction.options.getChannel('trigger_channel')?.id;
    out.categoryId = interaction.options.getChannel('category')?.id;
    out.userLimit = interaction.options.getInteger('user_limit');
  }
  if (interaction.commandName === 'verify-setup') {
    out.enabled = interaction.options.getBoolean('enabled');
    out.verifyRole = interaction.options.getRole('member_role')?.id;
    out.quarantineRole = interaction.options.getRole('quarantine_role')?.id;
    out.minAccountDays = interaction.options.getInteger('min_account_days');
  }
  if (interaction.commandName === 'auto-voice') { out.enabled = interaction.options.getBoolean('enabled'); out.channel = interaction.options.getChannel('channel')?.id; }
  return out;
}


/* Observe the same REST manager discord.js uses for /gateway/bot. Keep only safe metadata. */
bot.rest.on('rateLimited', info => {
  const diagnostic = normalizeRateLimitDiagnostics(info);
  runtimeDiagnostics.discord.lastRestRateLimit = diagnostic;
  runtimeDiagnostics.discord.lastEventAt = diagnostic.at;
  if (diagnostic.route === 'gateway_bot') {
    runtimeDiagnostics.discord.gatewayStage = 'gateway_rest_rate_limited';
  }
  console.warn('[discord-rest-rate-limit]', diagnostic);
});
bot.rest.on('response', (request, response) => {
  const status = Number(response?.status);
  if (!Number.isInteger(status) || status < 400) return;
  const diagnostic = normalizeDiscordRestResponseDiagnostics(request, response);
  runtimeDiagnostics.discord.lastRestResponse = diagnostic;
  const { route, method, at } = diagnostic;
  if (status === 429) {
    runtimeDiagnostics.discord.restRateLimitCount += 1;
    if (route === 'gateway_bot' && response?.clone) {
      // Read only structured, non-sensitive metadata; never expose raw error messages or bodies.
      void response.clone().json().then(body => {
        const bodyDiagnostic = normalizeDiscordRestErrorBody(body);
        if (runtimeDiagnostics.discord.lastRestResponse?.at !== at) return;
        Object.assign(runtimeDiagnostics.discord.lastRestResponse, bodyDiagnostic);
        if (runtimeDiagnostics.discord.lastRestResponse.retryAfterMs === null && bodyDiagnostic.bodyRetryAfterMs !== null) {
          runtimeDiagnostics.discord.lastRestResponse.retryAfterMs = normalizeRetryAfterBodyValue(body?.retry_after);
        }
        if (bodyDiagnostic.bodyGlobal !== null) {
          runtimeDiagnostics.discord.lastRestResponse.bodyGlobal = bodyDiagnostic.bodyGlobal;
        }
      }).catch(() => {
        if (runtimeDiagnostics.discord.lastRestResponse?.at === at) {
          runtimeDiagnostics.discord.lastRestResponse.bodyFormat = 'non_json_or_unreadable';
          runtimeDiagnostics.discord.lastRestResponse.bodyMessageClass = 'unknown';
          runtimeDiagnostics.discord.lastRestResponse.discordErrorCode = null;
          runtimeDiagnostics.discord.lastRestResponse.bodyGlobal = null;
        }
      });
    }
  }
  if (route === 'gateway_bot' && status === 401) {
    runtimeDiagnostics.discord.state = 'auth_rejected';
    runtimeDiagnostics.discord.lastErrorCode = 'HTTP_401';
    runtimeDiagnostics.discord.gatewayStage = 'auth_rejected';
  } else if (route === 'gateway_bot' && status === 429) {
    runtimeDiagnostics.discord.gatewayStage = 'gateway_rest_rate_limited';
  }
  console.warn('[discord-rest-http-error]', {
    status,
    method,
    route,
    ...(status === 429 ? {
      retryAfterMs: diagnostic.retryAfterMs,
      resetAfterMs: diagnostic.resetAfterMs,
      scope: diagnostic.scope,
      global: diagnostic.global
    } : {})
  });
});
bot.rest.on('invalidRequestWarning', info => {
  const count = Number(info?.count);
  const remainingTime = Number(info?.remainingTime);
  console.warn('[discord-rest-invalid-request-warning]', {
    count: Number.isFinite(count) ? count : null,
    remainingTimeMs: Number.isFinite(remainingTime) ? Math.min(Math.max(remainingTime, 0), 86_400_000) : null
  });
});

bot.on('error', error => {
  runtimeDiagnostics.discord.lastErrorCode = safeRuntimeErrorCode(error);
  runtimeDiagnostics.discord.gatewayStage = 'client_error';
  runtimeDiagnostics.discord.lastEventAt = new Date().toISOString();
  void reportRuntimeError(error, 'discord-client');
});
bot.on('shardConnecting', shardId => {
  runtimeDiagnostics.discord.state = 'connecting';
  runtimeDiagnostics.discord.gatewayStage = 'opening_socket';
  runtimeDiagnostics.discord.lastEventAt = new Date().toISOString();
  console.log('[discord-gateway] shard connecting', { shardId, nodeVersion: process.version });
});
bot.on('shardPreReady', shardId => {
  runtimeDiagnostics.discord.gatewayStage = 'loading_guilds';
  runtimeDiagnostics.discord.lastEventAt = new Date().toISOString();
  console.log('[discord-gateway] shard pre-ready', { shardId });
});
bot.on('shardReady', shardId => {
  runtimeDiagnostics.discord.state = 'ready';
  runtimeDiagnostics.discord.gatewayStage = 'ready';
  runtimeDiagnostics.discord.lastEventAt = new Date().toISOString();
  console.log('[discord-gateway] shard ready', { shardId });
});
bot.on('debug', message => {
  const stage = classifyGatewayDebugMessage(message);
  if (!stage) return;
  runtimeDiagnostics.discord.gatewayStage = stage;
  runtimeDiagnostics.discord.lastEventAt = new Date().toISOString();
  console.log('[discord-gateway-debug]', stage);
});
bot.on('shardError', error => {
  runtimeDiagnostics.discord.lastErrorCode = safeRuntimeErrorCode(error);
  runtimeDiagnostics.discord.gatewayStage = 'socket_error';
  runtimeDiagnostics.discord.lastEventAt = new Date().toISOString();
  void reportRuntimeError(error, 'discord-shard');
});
bot.on('shardDisconnect', (event, shardId) => {
  runtimeDiagnostics.discord.state = 'disconnected';
  runtimeDiagnostics.discord.gatewayStage = 'disconnected';
  runtimeDiagnostics.discord.lastGatewayCloseCode = Number.isInteger(event?.code) ? event.code : null;
  runtimeDiagnostics.discord.lastEventAt = new Date().toISOString();
  console.warn('[discord-gateway] shard disconnected', {
    shardId,
    closeCode: runtimeDiagnostics.discord.lastGatewayCloseCode
  });
});
bot.on('shardReconnecting', shardId => {
  runtimeDiagnostics.discord.state = 'reconnecting';
  runtimeDiagnostics.discord.gatewayStage = 'reconnecting';
  runtimeDiagnostics.discord.lastEventAt = new Date().toISOString();
  console.warn('[discord-gateway] shard reconnecting', { shardId });
});
bot.on('shardResume', (_replayedEvents, shardId) => {
  runtimeDiagnostics.discord.state = bot.isReady() ? 'ready' : 'connecting';
  runtimeDiagnostics.discord.gatewayStage = 'resumed';
  runtimeDiagnostics.discord.lastEventAt = new Date().toISOString();
  console.log('[discord-gateway] shard resumed', { shardId });
});
bot.on('invalidated', () => {
  runtimeDiagnostics.discord.state = 'invalidated';
  runtimeDiagnostics.discord.gatewayStage = 'invalidated';
  runtimeDiagnostics.discord.lastEventAt = new Date().toISOString();
  console.error('[discord-gateway] client session invalidated');
});
process.on('unhandledRejection', reason => { void reportRuntimeError(reason instanceof Error ? reason : new Error(String(reason)), 'unhandled-rejection'); });
process.on('uncaughtException', error => {
  // Best-effort remote report, then exit so the hosting platform can restart a possibly corrupted process.
  const timeout = new Promise(resolve => setTimeout(resolve, 2500));
  Promise.race([reportRuntimeError(error, 'uncaught-exception'), timeout]).finally(() => process.exit(1));
});

bot.on('ready', async () => {
  runtimeDiagnostics.discord.state = 'ready';
  runtimeDiagnostics.discord.lastErrorCode = null;
  runtimeDiagnostics.discord.lastGatewayCloseCode = null;
  runtimeDiagnostics.discord.gatewayStage = 'ready';
  runtimeDiagnostics.discord.lastEventAt = new Date().toISOString();
  runtimeDiagnostics.commands.total = commands.length;
  console.log(`Logged in as ${bot.user.tag}`);
  const presenceStatus = ['online','idle','dnd','invisible'].includes(String(process.env.BOT_PRESENCE_STATUS || 'online').toLowerCase())
    ? String(process.env.BOT_PRESENCE_STATUS || 'online').toLowerCase() : 'online';
  const presenceTypes = { Playing: ActivityType.Playing, Watching: ActivityType.Watching, Listening: ActivityType.Listening, Competing: ActivityType.Competing };
  const presenceType = presenceTypes[process.env.BOT_PRESENCE_TYPE || 'Watching'] ?? ActivityType.Watching;
  const presenceText = String(process.env.BOT_PRESENCE_TEXT || (APP_NAME + ' · /help')).trim().slice(0,128) || (APP_NAME + ' · /help');
  bot.user.setPresence({ status: presenceStatus, activities: [{ name: presenceText, type: presenceType }] });
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const guildId = String(process.env.DISCORD_GUILD_ID || '').trim();
  const registrationScopes = getCommandRegistrationScopes(guildId);
  if (guildId && !/^\d{17,20}$/.test(guildId)) {
    runtimeDiagnostics.commands.guild.state = 'invalid_guild_id';
    console.warn('DISCORD_GUILD_ID is invalid; registering global commands only.');
  }
  runtimeDiagnostics.commands.total = commands.length;
  // Register both scopes independently: an invalid optional test guild must not mask
  // a successful global registration, and vice versa.
  for (const scope of registrationScopes) {
    const scopeStatus = runtimeDiagnostics.commands[scope];
    scopeStatus.state = 'registering';
    scopeStatus.errorCode = null;
    scopeStatus.lastAttemptAt = new Date().toISOString();
    try {
      if (scope === 'guild') {
        await rest.put(Routes.applicationGuildCommands(bot.user.id, guildId), { body: commands });
        console.log(`Registered ${commands.length} guild commands in the configured development server.`);
      } else {
        await rest.put(Routes.applicationCommands(bot.user.id), { body: commands });
        console.log(`Registered ${commands.length} global commands.`);
      }
      scopeStatus.state = 'registered';
      scopeStatus.lastSuccessAt = new Date().toISOString();
    } catch (error) {
      const code = safeRuntimeErrorCode(error);
      scopeStatus.state = 'failed';
      scopeStatus.errorCode = code;
      runtimeDiagnostics.commands.lastErrorCode = code;
      console.error(`Command registration failed for ${scope} scope:`, code);
    }
  }
  for (const guild of bot.guilds.cache.values()) {
    await guild.channels.fetch().catch(() => {});
    for (const channel of guild.channels.cache.values()) {
      const ticket = parseAkiTicketTopic(channel.topic);
      if (ticket.status === 'closed' && ticket.closedAt) scheduleClosedTicketDeletion(channel, ticket.closedAt);
    }
    await cleanupTrackedTempVoiceRooms(guild).catch(error => reportRuntimeError(error, 'temporary-voice-startup-cleanup', guild.id));
    const cfg = await getConfig(guild.id);
    if (cfg.auto_voice_enabled && cfg.auto_voice_channel_id) joinGuildVoice(guild, cfg.auto_voice_channel_id, 'auto').catch(e => console.error(`Auto voice ${guild.id}:`, e.message));
  }
  await restorePendingRaidLockdowns().catch(error => reportRuntimeError(error, 'automod-restore-raid-lockdown'));
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
  if (interaction.isAutocomplete()) {
    try { await handleCommandAutocomplete(interaction); }
    catch (error) {
      await interaction.respond([]).catch(() => {});
      await reportRuntimeError(error,'command-autocomplete',interaction.guildId).catch(() => {});
    }
    return;
  }
  if (interaction.isUserContextMenuCommand() && interaction.guild) {
    try {
      if (interaction.commandName === 'Userinfo') {
        await interaction.deferReply({ ephemeral: true });
        const payload = await runCommand('userinfo', {
          guild: interaction.guild, userId: interaction.user.id,
          userName: interaction.user.globalName || interaction.user.username,
          channel: interaction.channel, args: { user: interaction.targetUser.id }, source: 'context-menu'
        });
        await interaction.editReply(payload);
      } else if (interaction.commandName === 'Warn') {
        const modal = new ModalBuilder().setCustomId('aki:context:warn:' + interaction.targetUser.id).setTitle('Cảnh cáo thành viên');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('details').setLabel('Lý do cảnh cáo').setStyle(TextInputStyle.Paragraph).setMinLength(5).setMaxLength(1000).setRequired(true)));
        await interaction.showModal(modal);
      } else if (interaction.commandName === 'Report') {
        const modal = new ModalBuilder().setCustomId('aki:context:report:' + interaction.targetUser.id).setTitle('Báo cáo thành viên');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('details').setLabel('Lý do / thông tin liên quan').setStyle(TextInputStyle.Paragraph).setMinLength(5).setMaxLength(1200).setRequired(true)));
        await interaction.showModal(modal);
      }
    } catch (error) {
      const message = '⚠️ ' + String(error.message || 'Không thể hoàn thành lệnh.');
      if (interaction.deferred || interaction.replied) await interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
      else await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
    }
    return;
  }
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
  if (interaction.commandName === 'sell') {
    const modal = new ModalBuilder().setCustomId('aki:sell:submit').setTitle('🛍️ Đăng bán sản phẩm/dịch vụ');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Tiêu đề').setStyle(TextInputStyle.Short).setMinLength(3).setMaxLength(100).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('price').setLabel('Giá / thương lượng').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Mô tả chi tiết').setStyle(TextInputStyle.Paragraph).setMinLength(10).setMaxLength(1600).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('contact').setLabel('Thông tin liên hệ (tuỳ chọn)').setStyle(TextInputStyle.Short).setMaxLength(120).setRequired(false))
    );
    await interaction.showModal(modal);
    return;
  }
  const ephemeralCommands = new Set(['sell-setup', 'xp-setup', 'automod-setup', 'shop', 'buy', 'suggest', 'suggest-setup', 'giveaway', 'giveaway-reroll', 'remind', 'reminders', 'reminder-cancel', 'warnings', 'role', 'warn', 'kick', 'ban', 'tempban', 'timeout', 'unban', 'untimeout', 'delwarn', 'case', 'modlog', 'scam-add', 'scamcheck', 'legit', 'role-panel', 'ticket-setup', 'auto-voice', 'vc-join', 'vc-leave', 'clear']);
  try {
    const args = extractInteractionArgs(interaction);
    if (interaction.commandName === 'poll') {
      // Native polls must reply immediately, so apply the shared cooldown inline instead of via runCommand.
      const cooldown = checkCommandCooldown(commandCooldowns, interaction.guildId + ':' + interaction.user.id + ':poll', Date.now(), COMMAND_COOLDOWN_MS);
      if (!cooldown.allowed) throw new Error('⏳ Chờ ' + Math.max(1, Math.ceil(cooldown.remainingMs / 1000)) + ' giây trước khi dùng lại /poll.');
      const payload = buildNativePollPayload(args);
      await interaction.reply(payload);
      await addActivity(interaction.guildId, interaction.user.id, '/poll', '✅ Đã đăng poll gốc Discord tại #' + (interaction.channel?.name || 'unknown-channel') + '.');
      return;
    }
    // Acknowledge all commands which may perform network/database work before running them.
    await interaction.deferReply({ ephemeral: ephemeralCommands.has(interaction.commandName) });
    const payload = await runCommand(interaction.commandName, { guild: interaction.guild, userId: interaction.user.id, userName: interaction.user.globalName || interaction.user.username, channel: interaction.channel, args, source: 'discord' });
    await interaction.editReply(payload);
    await addActivity(interaction.guildId, interaction.user.id, `/${interaction.commandName}`, `✅ Slash command bởi ${interaction.user.globalName || interaction.user.username} tại #${interaction.channel?.name || 'unknown-channel'}.`);
  } catch (error) {
    const msg = `⚠️ ${error.message}`;
    if (interaction.deferred) await interaction.editReply({ content: msg, embeds: [], components: [] }).catch(() => {});
    else if (interaction.replied) await interaction.followUp({ content: msg, ephemeral: true }).catch(() => {});
    else await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    addActivity(interaction.guildId, interaction.user.id, `error:/${interaction.commandName}`, `❌ Slash command thất bại bởi ${interaction.user.globalName || interaction.user.username}: ${error.message}`).catch(() => {});
    void reportRuntimeError(error, 'slash-command:' + interaction.commandName, interaction.guildId);
  }
});


bot.on('messageDelete', message => {
  if (!message.guild || message.author?.bot) return;
  const content = String(message.content || '').trim().slice(0, 700);
  addActivity(message.guild.id, message.author?.id || null, 'message:deleted',
    'Tin nhắn bị xoá tại #' + (message.channel?.name || message.channelId || 'unknown') +
    ' · message=' + (message.id || 'unknown') + (content ? ' · nội dung: ' + content : ' · nội dung không còn trong cache.')).catch(() => {});
});
bot.on('messageUpdate', (oldMessage, newMessage) => {
  if (!newMessage.guild || newMessage.author?.bot || String(oldMessage.content || '') === String(newMessage.content || '')) return;
  addActivity(newMessage.guild.id, newMessage.author?.id || null, 'message:edited',
    'Tin nhắn được sửa tại #' + (newMessage.channel?.name || newMessage.channelId || 'unknown') +
    ' · message=' + (newMessage.id || 'unknown') +
    ' · trước: ' + String(oldMessage.content || '[không có cache]').slice(0, 450) +
    ' · sau: ' + String(newMessage.content || '').slice(0, 450)).catch(() => {});
});
bot.on('guildMemberUpdate', (oldMember, newMember) => {
  const added = [...newMember.roles.cache.values()].filter(role => !oldMember.roles.cache.has(role.id)).map(role => role.name).slice(0, 10);
  const removed = [...oldMember.roles.cache.values()].filter(role => !newMember.roles.cache.has(role.id)).map(role => role.name).slice(0, 10);
  const changes = [];
  if (added.length) changes.push('role thêm: ' + added.join(', '));
  if (removed.length) changes.push('role gỡ: ' + removed.join(', '));
  if (oldMember.nickname !== newMember.nickname) changes.push('nickname: "' + String(oldMember.nickname || oldMember.user.username) + '" → "' + String(newMember.nickname || newMember.user.username) + '"');
  if (changes.length && !canControlGuild(newMember.id, newMember.guild.ownerId, newMember.permissions.bitfield)) {
    void revokeSocketGuildAccess(newMember.guild.id, newMember.id);
  }
  if (!changes.length) return;
  addActivity(newMember.guild.id, newMember.id, 'member:updated', changes.join(' · ')).catch(() => {});
});

bot.on('messageCreate', async message => {
  if (!message.guild || message.author.bot) return;
  if (await applyAutoModeration(message)) return;
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
    if (!message.content.startsWith(prefix)) {
      try { await maybeSendFaqReply(message,prefix); }
      catch (error) { void reportRuntimeError(error,'faq-auto-reply',message.guild.id); }
    }
    if (!message.content.startsWith(prefix) && message.content.trim().length >= 4) {
      try {
        const xpSettings = await getGuildXpSettings(message.guild.id);
        const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
        const roleIds = member ? [...member.roles.cache.keys()] : [];
        if (member && shouldAwardXpMessage({
          enabled: xpSettings.enabled, channelId: message.channel.id, memberRoleIds: roleIds,
          ignoredChannels: xpSettings.ignored_channel_ids, ignoredRoles: xpSettings.ignored_role_ids
        })) {
          const base = calculateMessageXp(Math.random(), XP_PER_MESSAGE_MIN, XP_PER_MESSAGE_MAX);
          const gain = applyRoleXpMultiplier(base, roleIds, xpSettings.role_multipliers);
          const profile = await awardCommunityXp(message.guild.id, message.author.id, gain);
          if (profile && Math.floor((profile.xp - profile.gain) / 100) < profile.level) {
            const granted = await awardConfiguredLevelRoles(message.guild, member, profile.level, xpSettings);
            const roleNotice = granted.length ? ' · role thưởng: ' + granted.join(', ') : '';
            await message.channel.send('🎉 <@' + message.author.id + '> lên **Level ' + profile.level + '**! Dùng `/rank` để xem tiến độ.' + roleNotice).catch(() => {});
            await addActivity(message.guild.id, message.author.id, 'level:up', '🎉 Đạt Level ' + profile.level + ' với ' + profile.xp + ' XP.' + roleNotice).catch(() => {});
          }
        }
      } catch (error) {
        void reportRuntimeError(error, 'community-xp', message.guild.id);
      }
    }
    if (!message.content.startsWith(prefix)) return;
    const [name, ...parts] = message.content.slice(prefix.length).trim().split(/\s+/);
    if (!name || !commands.some(c => c.name === name)) return;
    const basicMap = {
      ping: {}, help: {}, server: {}, botinfo: {}, shop: {}, tag: { name: parts.join(' ') }, coinflip: {},
      '8ball': { question: parts.join(' ') }, roll: { sides: Number(parts[0]) || 6 }, remind: { duration: parts[0], text: parts.slice(1).join(' ') },
      announce: { message: parts.join(' ') }, clear: { amount: Number(parts[0]) }, slowmode: { seconds: Number(parts[0]) }, lock: {}, unlock: {},
      rank: {}, balance: {}, daily: {}, work: {}, buy: { item: parts[0] }, leaderboard: { kind: parts[0] === 'coins' ? 'coins' : 'levels' },
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
    if (name === 'poll') {
      const rawPoll = message.content.slice(prefix.length).trim().replace(/^poll\s*/i, '');
      const pieces = rawPoll.split('|').map(value => value.trim()).filter(Boolean);
      if (pieces.length < 3 || pieces.length > 5) {
        await message.reply('Dùng: `!poll Câu hỏi | Lựa chọn 1 | Lựa chọn 2 | (Lựa chọn 3) | (Lựa chọn 4)`').catch(() => {});
        return;
      }
      basicMap.poll = { question: pieces[0], options: pieces.slice(1) };
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

async function applyAutoModeration(message) {
  if (!message?.guild || message.author?.bot) return false;
  let config;
  try { config = await getConfig(message.guild.id); }
  catch (error) {
    void reportRuntimeError(error, 'automod-config', message.guild.id);
    return false;
  }
  if (!config?.automod_enabled) return false;
  const now = Date.now();
  let reason = null;
  const blockedDomain = findBlockedDomain(message.content, config.automod_blocked_domains || []);
  if (blockedDomain) reason = 'blocked-link';
  else if (isMassMention(message, config.automod_max_mentions)) reason = 'mass-mention';
  const windowMs = Math.max(3, Number(config.automod_spam_window_seconds) || 10) * 1000;
  const spamThreshold = Math.max(3, Number(config.automod_spam_threshold) || 5);
  const spamKey = message.guild.id + ':' + message.channelId + ':' + message.author.id;
  const recent = recentTimestamps(automodMessageBuckets.get(spamKey) || [], now, windowMs);
  recent.push(now);
  automodMessageBuckets.set(spamKey, recent);
  if (!reason && recent.length >= spamThreshold) reason = 'spam-burst';
  if (!reason) return false;

  const me = message.guild.members.me || await message.guild.members.fetchMe().catch(() => null);
  if (!me || !message.channel?.permissionsFor(me)?.has(PermissionFlagsBits.ManageMessages)) {
    await addActivity(message.guild.id, message.author.id, 'automod:blocked-permission', 'AutoMod phát hiện ' + reason + ' nhưng bot thiếu Manage Messages tại #' + (message.channel?.name || 'unknown') + '.').catch(() => {});
    return false;
  }
  const deleted = await message.delete().then(() => true).catch(() => false);
  if (!deleted) {
    await addActivity(message.guild.id, message.author.id, 'automod:delete-failed', 'Không xoá được tin nhắn bị flag ' + reason + ' tại #' + (message.channel?.name || 'unknown') + '.').catch(() => {});
    return false;
  }
  await addActivity(message.guild.id, message.author.id, 'automod:' + reason,
    'Đã xoá tin nhắn vi phạm tại #' + (message.channel?.name || 'unknown') +
    (blockedDomain ? ' · domain=' + blockedDomain : '') + '.').catch(() => {});
  const warningKey = message.guild.id + ':' + message.channelId + ':' + reason;
  const lastWarning = automodWarningCooldowns.get(warningKey) || 0;
  if (now - lastWarning > 8000) {
    automodWarningCooldowns.set(warningKey, now);
    message.channel.send({
      content: reason === 'blocked-link'
        ? '🛡️ AutoMod đã xoá liên kết thuộc danh sách domain bị chặn.'
        : reason === 'mass-mention'
          ? '🛡️ AutoMod đã xoá tin nhắn mass mention.'
          : '🛡️ AutoMod đã xoá tin nhắn do gửi quá nhanh.',
      allowedMentions: { parse: [] }
    }).then(warning => {
      const timer = setTimeout(() => warning.delete().catch(() => {}), 8000);
      timer.unref?.();
    }).catch(() => {});
  }
  return true;
}

async function restoreRaidLockdown(guildId) {
  let entry = raidLockdowns.get(guildId);
  if (!entry && pool) {
    const saved = await dbQuery('SELECT expires_at,snapshots FROM raid_lockdowns WHERE guild_id=$1', [guildId]);
    if (saved.rowCount) entry = { expiresAt: Number(saved.rows[0].expires_at), snapshots: saved.rows[0].snapshots || [], timer: null };
  }
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  raidLockdowns.delete(guildId);
  const guild = bot.guilds.cache.get(guildId);
  if (guild) {
    for (const snapshot of entry.snapshots || []) {
      const channel = await guild.channels.fetch(snapshot.channelId).catch(() => null);
      if (!channel?.permissionOverwrites) continue;
      const current = channel.permissionOverwrites.cache.get(guild.roles.everyone.id);
      // Restore only channels that are still denied, so unrelated manual changes are less likely to be overwritten.
      if (!current?.deny.has(PermissionFlagsBits.SendMessages)) continue;
      await channel.permissionOverwrites.edit(guild.roles.everyone, {
        SendMessages: snapshot.previousValue === true ? true : snapshot.previousValue === false ? false : null
      }, 'Aki AutoMod raid lockdown expired').catch(() => {});
    }
    await addActivity(guildId, null, 'automod:raid-unlock', 'Đã khôi phục quyền gửi tin sau thời gian lockdown.').catch(() => {});
  }
  if (pool) await dbQuery('DELETE FROM raid_lockdowns WHERE guild_id=$1', [guildId]).catch(() => {});
}

function scheduleRaidLockdownRestore(guildId, entry) {
  if (entry.timer) clearTimeout(entry.timer);
  const delay = Math.max(0, Number(entry.expiresAt) - Date.now());
  entry.timer = setTimeout(() => restoreRaidLockdown(guildId).catch(error => console.warn('Raid unlock failed:', error?.message || 'unknown error')), delay);
  entry.timer.unref?.();
  raidLockdowns.set(guildId, entry);
}

async function beginRaidLockdown(guild, config, joinCount) {
  if (!guild || !config?.automod_enabled) return false;
  if (!pool) {
    await addActivity(guild.id, null, 'automod:raid-lockdown-unavailable', 'Không bật lockdown vì chưa có PostgreSQL để phục hồi quyền sau khi process khởi động lại.').catch(() => {});
    return false;
  }
  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await addActivity(guild.id, null, 'automod:raid-lockdown-unavailable', 'Phát hiện join burst (' + joinCount + ') nhưng bot thiếu Manage Channels.').catch(() => {});
    return false;
  }
  const durationMs = Math.max(30, Math.min(600, Number(config.automod_lockdown_seconds) || 60)) * 1000;
  let entry = raidLockdowns.get(guild.id);
  if (!entry) {
    const excluded = new Set([config.log_channel_id, config.welcome_channel_id, config.verification_channel_id, config.suggestion_channel_id].filter(Boolean));
    const snapshots = [];
    for (const channel of guild.channels.cache.values()) {
      if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) || excluded.has(channel.id)) continue;
      if (!channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)) continue;
      if (!channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageChannels)) continue;
      const previousOverwrite = channel.permissionOverwrites.cache.get(guild.roles.everyone.id);
      const previousValue = previousOverwrite
        ? previousOverwrite.allow.has(PermissionFlagsBits.SendMessages) ? true
          : previousOverwrite.deny.has(PermissionFlagsBits.SendMessages) ? false : null
        : null;
      if (previousValue === false) continue;
      try {
        await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }, 'Aki AutoMod detected a join raid');
        snapshots.push({ channelId: channel.id, previousValue });
      } catch {}
    }
    if (!snapshots.length) return false;
    entry = { snapshots, expiresAt: Date.now() + durationMs, timer: null };
  } else {
    entry.expiresAt = Date.now() + durationMs;
  }
  if (pool) {
    await dbQuery(
      'INSERT INTO raid_lockdowns(guild_id,expires_at,snapshots) VALUES($1,$2,$3::jsonb) ON CONFLICT(guild_id) DO UPDATE SET expires_at=EXCLUDED.expires_at,snapshots=EXCLUDED.snapshots',
      [guild.id, entry.expiresAt, JSON.stringify(entry.snapshots)]
    );
  }
  scheduleRaidLockdownRestore(guild.id, entry);
  await addActivity(guild.id, null, 'automod:raid-lockdown', 'Phát hiện join burst (' + joinCount + '). Đã khóa gửi tin công khai trong ' + Math.round(durationMs / 1000) + ' giây.').catch(() => {});
  return true;
}

async function restorePendingRaidLockdowns() {
  if (!pool) return;
  const rows = await dbQuery('SELECT guild_id,expires_at,snapshots FROM raid_lockdowns');
  for (const row of rows.rows) {
    const entry = { expiresAt: Number(row.expires_at), snapshots: row.snapshots || [], timer: null };
    raidLockdowns.set(row.guild_id, entry);
    if (entry.expiresAt <= Date.now()) await restoreRaidLockdown(row.guild_id);
    else scheduleRaidLockdownRestore(row.guild_id, entry);
  }
}

function recordRaidJoin(guildId, now, config) {
  const windowMs = Math.max(5, Number(config?.automod_raid_window_seconds) || 20) * 1000;
  const threshold = Math.max(5, Number(config?.automod_raid_join_threshold) || 8);
  const recent = recentTimestamps(raidJoinBuckets.get(guildId) || [], now, windowMs);
  recent.push(now);
  raidJoinBuckets.set(guildId, recent);
  return { triggered: recent.length >= threshold, count: recent.length };
}

bot.on('guildMemberAdd', async member => {
  let autoRoleName = null;
  let cfg = null;
  try { cfg = await getConfig(member.guild.id); }
  catch (error) { void reportRuntimeError(error, 'member-join-config', member.guild.id); }
  if (!member.user.bot && cfg?.automod_enabled) {
    const burst = recordRaidJoin(member.guild.id, Date.now(), cfg);
    if (burst.triggered) await beginRaidLockdown(member.guild, cfg, burst.count).catch(error => reportRuntimeError(error, 'automod-raid-lockdown', member.guild.id));
  }
  // Welcome failures must never prevent a new member receiving their automatic role.
  try {
    if (cfg?.welcome_channel_id) {
      const channel = await member.guild.channels.fetch(cfg.welcome_channel_id).catch(() => null);
      if (!channel?.isTextBased?.()) throw new Error('Kênh welcome đã bị xoá hoặc không phải kênh text.');
      const welcomeNextStep = cfg?.verification_enabled && cfg.verification_channel_id
        ? 'Hãy đến <#' + cfg.verification_channel_id + '> và nhấn nút xác minh để nhận role Member.'
        : '';
      const template = await getGuildMessageTemplate(member.guild.id,'welcome');
      const payload = template
        ? buildMessageTemplateEmbed('welcome',template,member,member.guild)
        : buildMessageTemplateEmbed('welcome',null,member,member.guild,'👋 Chào mừng thành viên mới!','Chào mừng {user} đến với **{server}**!\nHãy đọc nội quy và chọn role phù hợp nhé.');
      if (welcomeNextStep) {
        const embed = payload.embeds[0];
        const currentDescription = embed.data.description || '';
        embed.setDescription((currentDescription + '\n\n' + welcomeNextStep).slice(0,4000));
      }
      await channel.send(payload);
    }
  } catch (error) { void reportRuntimeError(error, 'welcome-message', member.guild.id); }
  try {
    if (cfg?.verification_enabled) {
      const minDays = Math.min(365, Math.max(0, Number(cfg.verification_min_account_days) || 0));
      const tooNew = isAccountTooNew(member.user.createdTimestamp, minDays);
      const quarantine = tooNew && cfg.verification_quarantine_role_id
        ? await member.guild.roles.fetch(cfg.verification_quarantine_role_id).catch(() => null) : null;
      if (tooNew && minDays > 0 && !quarantine) throw new Error('Verification is enabled, but quarantine role is missing.');
      if (quarantine) {
        const me = member.guild.members.me || await member.guild.members.fetchMe();
        if (!me.permissions.has(PermissionFlagsBits.ManageRoles) || quarantine.position >= me.roles.highest.position) throw new Error('Bot cannot manage the configured quarantine role.');
        await member.roles.add(quarantine, 'Verification gate: account too new');
        autoRoleName = quarantine.name + ' (quarantine)';
      } else {
        autoRoleName = 'verification-pending';
      }
      // When the gate is enabled, Member is never auto-assigned on join; the verified button grants it later.
    } else {
      const role = cfg?.auto_role_id ? await member.guild.roles.fetch(cfg.auto_role_id).catch(() => null) : null;
      const fallbackRole = role || member.guild.roles.cache.find(r => r.name === '👥 Member') || null;
      if (fallbackRole) {
        const me = member.guild.members.me || await member.guild.members.fetchMe();
        if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('Bot thiếu quyền Manage Roles để cấp auto-role.');
        if (fallbackRole.position >= me.roles.highest.position) throw new Error('Role auto-role đang ở trên role cao nhất của bot.');
        await member.roles.add(fallbackRole, 'Aki automatic join role');
        autoRoleName = fallbackRole.name;
      }
    }
  } catch (error) { void reportRuntimeError(error, 'auto-role-assignment', member.guild.id); }
  await addActivity(member.guild.id, member.id, 'member:join', `👋 ${member.user.globalName || member.user.username} đã tham gia server.` + (autoRoleName ? ` · auto-role: ${autoRoleName}` : '')).catch(() => {});
});
bot.on('guildMemberRemove', async member => {
  void revokeSocketGuildAccess(member.guild.id, member.id);
  try {
    const cfg = await getConfig(member.guild.id);
    if (cfg.goodbye_channel_id) {
      const channel = await member.guild.channels.fetch(cfg.goodbye_channel_id).catch(() => null);
      if (channel?.isTextBased?.()) {
        const template = await getGuildMessageTemplate(member.guild.id,'goodbye');
        const payload = template
          ? buildMessageTemplateEmbed('goodbye',template,member,member.guild)
          : buildMessageTemplateEmbed('goodbye',null,member,member.guild,'👋 Một thành viên đã rời đi','**{user}** đã rời khỏi **{server}**.');
        await channel.send(payload);
      }
    }
  } catch (error) { void reportRuntimeError(error, 'goodbye-message', member.guild.id); }
  addActivity(member.guild.id, member.id, 'member:leave', `👋 ${member.user.globalName || member.user.username} đã rời server.`).catch(() => {});
});
bot.on('voiceStateUpdate', async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild) return;
  if (bot.user && newState.id === bot.user.id) {
    const cfg = await getConfig(guild.id);
    if (cfg.auto_voice_enabled && cfg.auto_voice_channel_id && !newState.channelId) {
      scheduleAutoVoiceReconnect(guild, cfg.auto_voice_channel_id, 4_000);
    }
    return;
  }
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return;
  try {
    const cfg = await getConfig(guild.id);
    if (cfg.temp_voice_enabled && newState.channelId === cfg.temp_voice_trigger_channel_id && oldState.channelId !== newState.channelId) {
      await createTempVoiceRoom(member, cfg);
    }
    if (oldState.channelId && oldState.channelId !== newState.channelId) {
      await cleanupTempVoiceIfEmpty(guild, oldState.channelId);
    }
  } catch (error) {
    await reportRuntimeError(error, 'temporary-voice-state', guild.id).catch(() => {});
  }
});

app.get('/api/guilds/:guildId/message-templates/:kind', requireAuth, async (req,res) => {
  try {
    const { guild } = await requireGuildControl(req,res);
    const kind = String(req.params.kind || '');
    if (!['welcome','goodbye'].includes(kind)) return res.status(400).json({error:'TEMPLATE_KIND_INVALID'});
    const actorId = discordActorId(req.session);
    const actor = actorId ? await fetchGuildMember(guild,actorId,true) : null;
    if (!actor || (actor.id !== guild.ownerId && !actor.permissions.has(PermissionFlagsBits.ManageGuild))) return res.status(403).json({error:'MANAGE_GUILD_REQUIRED'});
    const saved = await getGuildMessageTemplate(guild.id,kind);
    const defaults = kind === 'welcome'
      ? {kind,title:'👋 Chào mừng thành viên mới!',message:'Chào mừng {user} đến với **{server}**!\nHãy đọc nội quy và chọn role phù hợp nhé.',image_url:null,button_label:null,button_url:null}
      : {kind,title:'👋 Một thành viên đã rời đi',message:'**{user}** đã rời khỏi **{server}**.',image_url:null,button_label:null,button_url:null};
    return res.json({template:saved || defaults, saved:Boolean(saved)});
  } catch(error) { return res.status(error.status || 500).json({error:error.message || 'TEMPLATE_LOAD_FAILED'}); }
});
app.put('/api/guilds/:guildId/message-templates/:kind', requireAuth, async (req,res) => {
  try {
    const { guild } = await requireGuildControl(req,res);
    const kind = String(req.params.kind || '');
    if (!['welcome','goodbye'].includes(kind)) return res.status(400).json({error:'TEMPLATE_KIND_INVALID'});
    const actorId = discordActorId(req.session);
    const actor = actorId ? await fetchGuildMember(guild,actorId,true) : null;
    if (!actor || (actor.id !== guild.ownerId && !actor.permissions.has(PermissionFlagsBits.ManageGuild))) return res.status(403).json({error:'MANAGE_GUILD_REQUIRED'});
    const template = normalizeMessageTemplate(kind,req.body || {});
    const saved = await saveGuildMessageTemplate(guild.id,kind,template,actorId);
    await addActivity(guild.id,actorId,'template:'+kind+':updated','Đã lưu template '+kind+' có preview/biến động cho server.');
    return res.json({ok:true,template:saved});
  } catch(error) { return res.status(error.status || 400).json({error:error.message || 'TEMPLATE_SAVE_FAILED'}); }
});
app.get('/api/commands', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ commands: commands.filter(command => (!command.type || command.type === ApplicationCommandType.ChatInput) && command.name !== 'sell').map(command => ({
    name: command.name,
    description: command.description || '',
    options: Array.isArray(command.options) ? command.options : [],
    defaultMemberPermissions: command.default_member_permissions || null
  })) });
});
app.get('/api/health', async (_req, res) => {
  let databaseCheck = pool ? (applicationReady ? 'not_checked' : 'starting') : 'memory_only';
  let databaseErrorCode = runtimeDiagnostics.database.lastErrorCode;
  if (pool && applicationReady) {
    try {
      await dbQuery('SELECT 1');
      databaseCheck = 'ok';
      runtimeDiagnostics.database.state = 'ready';
      runtimeDiagnostics.database.lastErrorCode = null;
      databaseErrorCode = null;
    } catch (error) {
      databaseCheck = 'failed';
      runtimeDiagnostics.database.state = 'failed';
      runtimeDiagnostics.database.lastErrorCode = safeRuntimeErrorCode(error);
      databaseErrorCode = runtimeDiagnostics.database.lastErrorCode;
    }
  }
  const commandCount = Array.isArray(commands) ? commands.length : 0;
  return res.json({
    ok: applicationReady,
    service: 'aki-discord-control',
    time: new Date().toISOString(),
    application: { ready: applicationReady, state: applicationReady ? 'ready' : 'starting' },
    persistence: pool ? 'postgres' : 'memory',
    sessionPersistence: Boolean(pool),
    database: {
      configured: Boolean(pool),
      state: runtimeDiagnostics.database.state,
      check: databaseCheck,
      errorCode: databaseErrorCode
    },
    bot: {
      ready: bot.isReady(),
      state: runtimeDiagnostics.discord.state,
      tokenConfigured: Boolean(process.env.DISCORD_TOKEN),
      gatewayStage: runtimeDiagnostics.discord.gatewayStage,
      lastRestResponse: runtimeDiagnostics.discord.lastRestResponse,
      lastRestRateLimit: runtimeDiagnostics.discord.lastRestRateLimit,
      restRateLimitCount: runtimeDiagnostics.discord.restRateLimitCount,
      gatewayShards: [...bot.ws.shards.values()].map(shard => ({ id: shard.id, status: String(shard.status) })),
      guilds: bot.guilds.cache.size,
      ping: bot.isReady() ? Math.round(bot.ws.ping) : null,
      lastErrorCode: runtimeDiagnostics.discord.lastErrorCode,
      lastGatewayCloseCode: runtimeDiagnostics.discord.lastGatewayCloseCode,
      lastEventAt: runtimeDiagnostics.discord.lastEventAt,
      nodeVersion: process.version
    },
    commands: {
      defined: commandCount,
      global: runtimeDiagnostics.commands.global,
      guild: runtimeDiagnostics.commands.guild,
      lastErrorCode: runtimeDiagnostics.commands.lastErrorCode
    }
  });
});
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
  const allowed = await getLiveManageableGuildIds(req.session);
  if (req.query.guildId && !allowed.has(String(req.query.guildId))) return res.status(403).json({ error: 'NO_GUILD_ACCESS' });
  const guildId = req.query.guildId ? String(req.query.guildId) : null;
  const query = String(req.query.q || '').trim().slice(0, 120);
  const { page, limit, offset } = parsePagination(req.query.page, req.query.limit, 20, 50);
  if (pool) {
    const clauses = ['guild_id = ANY($1)'];
    const values = [[...allowed]];
    if (guildId) { values.push(guildId); clauses.push(`guild_id = $${values.length}`); }
    if (query) { values.push('%' + query + '%'); const q = '$' + values.length; clauses.push(`(action ILIKE ${q} OR details ILIKE ${q} OR COALESCE(user_id,'') ILIKE ${q})`); }
    const where = clauses.join(' AND ');
    const totalResult = await dbQuery('SELECT COUNT(*)::int AS total FROM activity WHERE ' + where, values);
    const total = Number(totalResult.rows[0]?.total || 0);
    const pagedValues = [...values, limit, offset];
    const rows = await dbQuery('SELECT guild_id,user_id,action,details,created_at FROM activity WHERE ' + where + ' ORDER BY created_at DESC LIMIT $' + (values.length + 1) + ' OFFSET $' + (values.length + 2), pagedValues);
    return res.json({ items: rows.rows, page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) });
  }
  const matching = activityCache.filter(row => row.guild_id && allowed.has(row.guild_id) && (!guildId || row.guild_id === guildId) &&
    (!query || [row.action, row.details, row.user_id].some(value => String(value || '').toLowerCase().includes(query.toLowerCase()))));
  return res.json({ items: matching.slice(offset, offset + limit), page, limit, total: matching.length, pages: Math.max(1, Math.ceil(matching.length / limit)) });
});

app.get('/api/activity/export', requireAuth, async (req, res) => {
  const allowed = await getLiveManageableGuildIds(req.session);
  if (req.query.guildId && !allowed.has(String(req.query.guildId))) return res.status(403).json({ error: 'NO_GUILD_ACCESS' });
  const guildId = req.query.guildId ? String(req.query.guildId) : null;
  const query = String(req.query.q || '').trim().slice(0, 120);
  let rows = [];
  if (pool) {
    const clauses = ['guild_id = ANY($1)'];
    const values = [[...allowed]];
    if (guildId) { values.push(guildId); clauses.push(`guild_id = $${values.length}`); }
    if (query) { values.push('%' + query + '%'); const q = '$' + values.length; clauses.push(`(action ILIKE ${q} OR details ILIKE ${q} OR COALESCE(user_id,'') ILIKE ${q})`); }
    rows = (await dbQuery('SELECT guild_id,user_id,action,details,created_at FROM activity WHERE ' + clauses.join(' AND ') + ' ORDER BY created_at DESC LIMIT 5000', values)).rows;
  } else {
    rows = activityCache.filter(row => row.guild_id && allowed.has(row.guild_id) && (!guildId || row.guild_id === guildId) &&
      (!query || [row.action, row.details, row.user_id].some(value => String(value || '').toLowerCase().includes(query.toLowerCase())))).slice(0, 5000);
  }
  const lines = [['created_at','guild_id','user_id','action','details'].map(csvCell).join(',')];
  for (const row of rows) lines.push([row.created_at,row.guild_id,row.user_id,row.action,row.details].map(csvCell).join(','));
  const filename = 'aki-activity-' + new Date().toISOString().slice(0,10) + '.csv';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  res.setHeader('Cache-Control', 'no-store');
  return res.send('\uFEFF' + lines.join('\r\n'));
});
app.get('/api/guilds/:guildId/channels', requireAuth, async (req, res) => {
  try {
    const { guild } = await requireGuildControl(req, res);
    await guild.channels.fetch();
    return res.json({ channels: [...guild.channels.cache.values()].filter(c => [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(c.type)).sort((a,b) => a.position-b.position).map(c => ({ id: c.id, name: c.name, type: c.type })) });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'CHANNEL_LIST_UNAVAILABLE' });
  }
});
app.get('/api/guilds/:guildId/moderation/warnings', requireAuth, async (req, res) => {
  try {
    const { guild } = await requireGuildControl(req, res);
    const actorId = discordActorId(req.session);
    const actor = actorId ? await fetchGuildMember(guild, actorId) : null;
    if (!actor || (!actor.permissions.has(PermissionFlagsBits.ModerateMembers) && actor.id !== guild.ownerId)) return res.status(403).json({ error: 'MODERATOR_REQUIRED' });
    const query = String(req.query.q || '').trim().slice(0, 100);
    const { page, limit, offset } = parsePagination(req.query.page, req.query.limit, 20, 50);
    if (pool) {
      const clauses = ['guild_id=$1'];
      const values = [guild.id];
      if (query) { values.push('%' + query + '%'); const q = '$' + values.length; clauses.push(`(user_id ILIKE ${q} OR reason ILIKE ${q} OR moderator_id ILIKE ${q})`); }
      const where = clauses.join(' AND ');
      const totalRows = await dbQuery('SELECT COUNT(*)::int AS total FROM warnings WHERE ' + where, values);
      const total = Number(totalRows.rows[0]?.total || 0);
      const rows = await dbQuery('SELECT id,guild_id,user_id,moderator_id,reason,created_at FROM warnings WHERE ' + where + ' ORDER BY created_at DESC LIMIT $' + (values.length + 1) + ' OFFSET $' + (values.length + 2), [...values, limit, offset]);
      return res.json({ items: rows.rows, page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) });
    }
    const all = [...memory.warnings.values()].flat().filter(row => row.guild_id === guild.id && (!query || [row.user_id,row.moderator_id,row.reason].some(value => String(value || '').toLowerCase().includes(query.toLowerCase())))).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
    return res.json({ items: all.slice(offset, offset + limit), page, limit, total: all.length, pages: Math.max(1, Math.ceil(all.length / limit)) });
  } catch (error) { return res.status(error.status || 500).json({ error: error.message || 'WARNINGS_UNAVAILABLE' }); }
});
app.delete('/api/guilds/:guildId/moderation/warnings/:warningId', requireAuth, async (req, res) => {
  try {
    const { guild } = await requireGuildControl(req, res);
    const actorId = discordActorId(req.session);
    const actor = actorId ? await fetchGuildMember(guild, actorId) : null;
    if (!actor || (!actor.permissions.has(PermissionFlagsBits.ModerateMembers) && actor.id !== guild.ownerId)) return res.status(403).json({ error: 'MODERATOR_REQUIRED' });
    const warningId = Number(req.params.warningId);
    if (!Number.isSafeInteger(warningId) || warningId < 1) return res.status(400).json({ error: 'INVALID_WARNING_ID' });
    const deleted = await deleteWarning(guild.id, warningId);
    if (!deleted) return res.status(404).json({ error: 'WARNING_NOT_FOUND' });
    const record = await addModerationCase(guild.id, deleted.user_id, actorId, 'delwarn', formatAuditReason(actor.displayName || actor.user.username, 'Xoá cảnh cáo #' + warningId));
    return res.json({ ok: true, warningId, caseId: record.case_id });
  } catch (error) { return res.status(error.status || 500).json({ error: error.message || 'WARNING_DELETE_FAILED' }); }
});
app.get('/api/guilds/:guildId/moderation/cases', requireAuth, async (req, res) => {
  try {
    const { guild } = await requireGuildControl(req, res);
    const actorId = discordActorId(req.session);
    const actor = actorId ? await fetchGuildMember(guild, actorId) : null;
    if (!actor || (!actor.permissions.has(PermissionFlagsBits.ModerateMembers) && actor.id !== guild.ownerId)) return res.status(403).json({ error: 'MODERATOR_REQUIRED' });
    const query = String(req.query.q || '').trim().slice(0, 100);
    const { page, limit, offset } = parsePagination(req.query.page, req.query.limit, 20, 50);
    let all;
    if (pool) {
      const values = [guild.id];
      let where = 'guild_id=$1';
      if (query) { values.push('%' + query + '%'); const q = '$' + values.length; where += ` AND (target_user_id ILIKE ${q} OR moderator_id ILIKE ${q} OR action ILIKE ${q} OR reason ILIKE ${q})`; }
      const totalResult = await dbQuery('SELECT COUNT(*)::int AS total FROM moderation_cases WHERE ' + where, values);
      const total = Number(totalResult.rows[0]?.total || 0);
      const rows = await dbQuery('SELECT case_id,target_user_id,moderator_id,action,reason,created_at FROM moderation_cases WHERE ' + where + ' ORDER BY case_id DESC LIMIT $' + (values.length + 1) + ' OFFSET $' + (values.length + 2), [...values, limit, offset]);
      return res.json({ items: rows.rows, page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) });
    }
    all = memory.moderationCases.filter(row => row.guild_id === guild.id && (!query || [row.target_user_id,row.moderator_id,row.action,row.reason].some(value=>String(value||'').toLowerCase().includes(query.toLowerCase()))));
    return res.json({ items: all.slice(offset, offset+limit), page, limit, total: all.length, pages: Math.max(1,Math.ceil(all.length/limit)) });
  } catch (error) { return res.status(error.status || 500).json({ error: error.message || 'MODLOG_UNAVAILABLE' }); }
});
app.get('/api/guilds/:guildId/members', requireAuth, async (req, res) => {
  try {
    const { guild } = await requireGuildControl(req, res);
    await guild.members.fetch({ limit: 100 }).catch(() => {});
    const members = [...guild.members.cache.values()]
      .filter(member => !member.user.bot)
      .slice(0, 100)
      .map(member => ({ id: member.id, label: member.displayName || member.user.globalName || member.user.username, username: member.user.username }));
    return res.json({ members });
  } catch (error) {
    return res.status(error.status || 503).json({ error: error.message || 'MEMBER_LIST_UNAVAILABLE' });
  }
});
app.get('/api/guilds/:guildId/config', requireAuth, async (req, res) => {
  try {
    const { guild } = await requireGuildControl(req, res);
    return res.json({ config: await getConfig(guild.id), roles: [...guild.roles.cache.values()].filter(r => !r.managed && r.id !== guild.id).sort((a,b) => b.position-a.position).map(r => ({ id: r.id, name: r.name, position: r.position })), stats: { members: guild.memberCount, channels: guild.channels.cache.size, roles: guild.roles.cache.size, emojis: guild.emojis.cache.size, ping: Math.round(bot.ws.ping) } });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'GUILD_CONFIG_UNAVAILABLE' });
  }
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
  const actorId = discordActorId(req.session);
  if (!actorId) throw Object.assign(new Error('Hãy đăng nhập bằng Discord để điều khiển bot và server.'), { status: 409 });
  const guild = bot.guilds.cache.get(req.params.guildId);
  const meta = (req.session.guilds || []).find(item => item.id === req.params.guildId);
  if (!guild || !meta) throw Object.assign(new Error('Bot chưa có trong server này hoặc tài khoản Discord không có trong server.'), { status: 404 });
  const actor = await fetchGuildMember(guild, actorId, true);
  if (!actor) throw Object.assign(new Error('Bạn không còn là thành viên của server này hoặc Discord chưa xác nhận được quyền hiện tại.'), { status: 403 });
  if (!canControlGuild(actor.id, guild.ownerId, actor.permissions.bitfield)) {
    throw Object.assign(new Error('Bạn cần quyền Manage Server hoặc Administrator hiện tại.'), { status: 403 });
  }
  return { guild, meta: { ...meta, manageable: true }, actor };
}

async function getLiveManageableGuildIds(session) {
  const actorId = discordActorId(session);
  if (!actorId) return new Set();
  const candidates = (session.guilds || []).filter(meta =>
    canManageGuildFromOAuthMeta(meta) && bot.guilds.cache.has(meta.id)
  );
  const verified = await Promise.all(candidates.map(async meta => {
    const guild = bot.guilds.cache.get(meta.id);
    if (!guild) return null;
    const actor = await fetchGuildMember(guild, actorId, true);
    if (!actor || !canControlGuild(actor.id, guild.ownerId, actor.permissions.bitfield)) return null;
    return guild.id;
  }));
  return new Set(verified.filter(Boolean));
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

async function requireCurrentGuildMember(req, res) {
  const userId = discordActorId(req.session);
  if (!userId) {
    res.status(409).json({ error: 'DISCORD_LINK_REQUIRED' });
    return null;
  }
  const guild = bot.guilds.cache.get(req.params.guildId);
  if (!guild) {
    res.status(404).json({ error: 'BOT_NOT_IN_GUILD' });
    return null;
  }
  const member = await fetchGuildMember(guild, userId, true);
  if (!member || !isCurrentGuildMember(userId, guild.id, member.id, member.guild?.id)) {
    res.status(403).json({ error: 'CURRENT_GUILD_MEMBERSHIP_REQUIRED' });
    return null;
  }
  return { guild, member, userId };
}

app.get('/api/guilds/:guildId/afk', requireAuth, async (req, res) => {
  try {
    const access = await requireCurrentGuildMember(req, res);
    if (!access) return;
    const afk = await getAfk(access.guild.id, access.userId);
    return res.json({ active: Boolean(afk), afk });
  } catch (error) { return res.status(error.status || 500).json({ error: error.message }); }
});

app.put('/api/guilds/:guildId/afk', requireAuth, async (req, res) => {
  try {
    const access = await requireCurrentGuildMember(req, res);
    if (!access) return;
    const { guild, userId } = access;
    const { reason = '', media_url = '' } = req.body || {};
    const afk = await setAfk(guild.id, userId, reason, media_url || null);
    await addActivity(guild.id, userId, 'web:afk', media_url ? 'AFK profile updated with media' : 'AFK profile updated');
    const profile = await guild.client.users.fetch(userId).catch(() => null);
    if (!profile) return res.json({ ok: true, afk });
    return res.json({ ok: true, afk, preview: afkPayload(profile, afk) });
  } catch (error) { return res.status(error.status || 500).json({ error: error.message }); }
});

app.delete('/api/guilds/:guildId/afk', requireAuth, async (req, res) => {
  try {
    const access = await requireCurrentGuildMember(req, res);
    if (!access) return;
    const { guild, userId } = access;
    await clearAfk(guild.id, userId);
    await addActivity(guild.id, userId, 'web:afk:off', 'AFK cleared');
    return res.json({ ok: true });
  } catch (error) { return res.status(error.status || 500).json({ error: error.message }); }
});

app.post('/api/guilds/:guildId/command', requireAuth, async (req, res) => {
  try {
    const { guild } = await requireGuildControl(req, res);
    const name = String(req.body?.name || '').toLowerCase().replace(/^\//, '');
    if (!commands.some(c => c.name === name) || name === 'sell') return res.status(400).json({ error: name === 'sell' ? 'MODAL_COMMAND_DISCORD_ONLY' : 'UNKNOWN_COMMAND' });
    const channel = req.body?.channelId ? await guild.channels.fetch(req.body.channelId).catch(() => null) : guild.channels.cache.find(c => c.isTextBased() && c.type !== ChannelType.GuildVoice);
    const args = req.body?.args || {};
    const actorId = discordActorId(req.session);
    if (!actorId) return res.status(409).json({ error: 'DISCORD_LINK_REQUIRED' });
    const payload = await runCommand(name, { guild, userId: actorId, userName: req.session.user.username, channel, args, source: 'web' });
    const privateResult = keepsCommandResultPrivate(name);
    const sendable = channel?.isTextBased?.() && payload && !privateResult;
    let sent = null;
    if (sendable) sent = await channel.send(payload);
    await addActivity(guild.id, actorId, `web:${name}`, (privateResult ? '✅ Lệnh được xử lý riêng trong dashboard bởi ' : '✅ Chạy từ dashboard bởi ') + `${req.session.user.username || 'user'} tại #${channel?.name || 'unknown-channel'}.`);
    res.json({
      ok: true,
      command: name,
      payload: privateResult ? summarizeCommandResult(payload) : (typeof payload === 'string' ? payload : 'embed'),
      privateResult,
      delivery: privateResult ? 'dashboard-only' : 'discord-channel',
      channelId: sent?.channelId || channel?.id || null,
      messageId: sent?.id || null
    });
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
    const actorName = String(actor.displayName || actor.user.globalName || actor.user.username || 'thành viên').slice(0, 100);
    const title = String(req.body?.title || '📣 THÔNG BÁO').trim().slice(0, 256)
      .replaceAll('{user}', actorName).replaceAll('{server}', guild.name);
    const rawMessage = String(req.body?.message || '').trim();
    if (!rawMessage) return res.status(400).json({ error: 'ANNOUNCEMENT_MESSAGE_REQUIRED' });
    const messageText = rawMessage.replaceAll('{user}', actorName).replaceAll('{server}', guild.name);
    if (messageText.length > 4000) return res.status(400).json({ error: 'ANNOUNCEMENT_MESSAGE_TOO_LONG' });
    let imageUrl = null;
    try { imageUrl = normalizeMediaUrl(String(req.body?.imageUrl || '').trim()); }
    catch { return res.status(400).json({ error: 'ANNOUNCEMENT_IMAGE_URL_INVALID' }); }
    if (imageUrl && new URL(imageUrl).protocol !== 'https:') return res.status(400).json({ error: 'ANNOUNCEMENT_IMAGE_REQUIRES_HTTPS' });
    const buttonLabel = String(req.body?.buttonLabel || '').trim().slice(0, 80);
    const rawButtonUrl = String(req.body?.buttonUrl || '').trim();
    let buttonUrl = null;
    if (buttonLabel || rawButtonUrl) {
      if (!buttonLabel || !rawButtonUrl) return res.status(400).json({ error: 'ANNOUNCEMENT_BUTTON_FIELDS_REQUIRED' });
      try { buttonUrl = normalizeMediaUrl(rawButtonUrl); }
      catch { return res.status(400).json({ error: 'ANNOUNCEMENT_BUTTON_URL_INVALID' }); }
      if (!buttonUrl || new URL(buttonUrl).protocol !== 'https:') return res.status(400).json({ error: 'ANNOUNCEMENT_BUTTON_REQUIRES_HTTPS' });
    }

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
    if (imageUrl) embed.setImage(imageUrl);
    const components = buttonUrl && buttonLabel ? [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(buttonLabel).setURL(buttonUrl)
    )] : [];
    const sent = await channel.send({
      content: pingEveryone ? '@everyone' : undefined,
      embeds: [embed],
      components,
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
app.get('/activity', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'activity.html')));
app.get('/moderation/:guildId', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'moderation.html')));
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
  for (const [sid, session] of sessionStore) {
    if (now - session.lastSeen > 7 * 24 * 60 * 60_000) {
      sessionStore.delete(sid);
      io.in('session:' + sid).disconnectSockets(true);
    }
  }
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
setInterval(() => giveawayTick(), 10_000);

async function boot() {
  // Bind the public HTTP port before database migrations/session restoration so Render can
  // detect the listener even when startup dependencies are slow.
  await new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      console.log(`Aki Dev dashboard listening on 0.0.0.0:${PORT}`);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(PORT, '0.0.0.0');
  });
  await initDb();
  await restorePersistentSessions();
  await persistAllSessions(); // migrate any legacy plaintext OAuth fields to encrypted storage
  applicationReady = true;
  if (!pool) console.warn('DATABASE_URL missing. Login sessions will not survive Render restarts; configure a Render PostgreSQL DATABASE_URL.');
  if (process.env.DISCORD_TOKEN) {
    runtimeDiagnostics.discord.state = 'connecting';
    bot.login(process.env.DISCORD_TOKEN).catch(error => {
      runtimeDiagnostics.discord.state = 'login_failed';
      runtimeDiagnostics.discord.gatewayStage = 'login_failed';
      runtimeDiagnostics.discord.lastErrorCode = safeRuntimeErrorCode(error);
      runtimeDiagnostics.discord.lastEventAt = new Date().toISOString();
      console.error('Discord login failed:', runtimeDiagnostics.discord.lastErrorCode);
    });
  } else {
    runtimeDiagnostics.discord.state = 'token_missing';
    runtimeDiagnostics.discord.gatewayStage = 'token_missing';
    console.warn('DISCORD_TOKEN missing. Web server is running, bot is disabled.');
  }
}
boot().catch(error => {
  runtimeDiagnostics.database.state = pool ? 'failed' : 'memory';
  runtimeDiagnostics.database.lastErrorCode = safeRuntimeErrorCode(error);
  console.error('Application startup failed:', runtimeDiagnostics.database.lastErrorCode);
  process.exit(1);
});
