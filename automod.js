
// AutoMod (ESM) for discord.js v14+
// Implements per-user spam rules with channel-scoped bursts and cross-channel duplication.
// All persistent moderation notices go to LOG_CHANNEL_ID. Per-channel notices auto-delete after 10s.

import {
  ChannelType,
  EmbedBuilder,
  PermissionsBitField,
} from 'discord.js';

/** ===== CONFIG ===== */
const LOG_CHANNEL_ID = "1421196548833935510";

// Windows
const SAME_MSG_WINDOW_MS = 2000;     // 2s window for identical-message spam (single channel)
const BURST_WINDOW_MS = 2000;        // 2s window for generic burst spam (single channel)
const MULTI_CH_WINDOW_MS = 3500;     // 3.5s window for multi-channel duplication

// Thresholds
const IDENTICAL_COUNT = 3;           // 3x same message in <2s
const BURST_COUNT = 5;               // 5+ messages in <2s same channel
const MULTI_CH_COUNT = 3;            // same text across 3+ channels

// Regex for links (loose on purpose)
const LINK_REGEX = /(?:https?:\/\/[^\s]+|www\.[^\s]+|\S+\.(?:com|org|net|pl|eu|xyz|me|io|gg)(?:\/\S*)?)/i;

// Action cooldown (avoid duplicate actions within short time)
const ACTION_COOLDOWN_MS = 6_000;

/** ===== State =====
 * userLog: userId -> array of recent events:
 * { ts, channelId, content, isLink, messageId }
 */
const userLog = new Map();  // Map<string, Array<...>>
const lastAction = new Map(); // Map<string, { ts: number, kind: string }>

/** ===== Helpers ===== */
function normTxt(s = '') {
  return s.trim();
}
function hasLink(s='') {
  return LINK_REGEX.test((s || '').replace(/\s+/g, ''));
}
function record(userId, channelId, content, ts, messageId) {
  const arr = userLog.get(userId) ?? [];
  arr.push({ ts, channelId, content, isLink: hasLink(content), messageId });
  // prune to ~8s history max to limit memory
  const cutoff = ts - Math.max(MULTI_CH_WINDOW_MS, BURST_WINDOW_MS, SAME_MSG_WINDOW_MS) - 1000;
  const kept = arr.filter(e => e.ts >= cutoff).slice(-200);
  userLog.set(userId, kept);
  return kept;
}
async function sendTemp(channel, text, seconds = 10) {
  try {
    const msg = await channel.send(text);
    setTimeout(() => msg.delete().catch(() => {}), seconds * 1000);
  } catch {}
}
async function sendLog(guild, payload) {
  try {
    const ch = await guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (!ch || ch.type !== ChannelType.GuildText) return;
    if (typeof payload === 'string') return void ch.send(payload);
    return void ch.send({ embeds: [payload] });
  } catch {}
}
async function ensureMutedRole(guild) {
  let role = guild.roles.cache.find(r => r.name === 'Muted');
  if (!role) {
    try {
      role = await guild.roles.create({ name: 'Muted', permissions: [] , reason: 'AutoMod: create mute role'});
      for (const [, c] of guild.channels.cache) {
        if (!c?.permissionOverwrites) continue;
        await c.permissionOverwrites.edit(role, {
          SendMessages: false,
          AddReactions: false,
          Speak: false,
          CreatePublicThreads: false,
          CreatePrivateThreads: false,
        }).catch(() => {});
      }
    } catch (e) {
      console.error('[AutoMod] cannot create Muted role:', e?.message || e);
      return null;
    }
  }
  return role;
}
async function mute(member, minutes, reason) {
  const role = await ensureMutedRole(member.guild);
  if (!role) return false;
  try {
    await member.roles.add(role, reason ?? 'AutoMod mute');
    setTimeout(() => member.roles.remove(role, 'AutoMod auto-unmute').catch(() => {}), Math.max(1, minutes) * 60_000);
    return true;
  } catch (e) {
    console.error('[AutoMod] mute error:', e?.message || e);
    return false;
  }
}
async function bulkDeleteByIds(guild, channelId, ids) {
  const ch = await guild.channels.fetch(channelId).catch(() => null);
  if (!ch || ch.type !== ChannelType.GuildText) return;
  try {
    // Prefer bulkDelete when possible; for really fresh messages
    await ch.bulkDelete(ids, true).catch(async () => {
      for (const id of ids) {
        try {
          const m = await ch.messages.fetch(id).catch(() => null);
          if (m?.deletable) await m.delete().catch(() => {});
        } catch {}
      }
    });
  } catch {}
}

/** ===== Detection ===== */
function detectIdentical(arr, now, channelId) {
  const windowed = arr.filter(e => now - e.ts <= SAME_MSG_WINDOW_MS && e.channelId === channelId);
  if (windowed.length < IDENTICAL_COUNT) return null;
  // Group by normalized text
  const byText = new Map();
  for (const e of windowed) {
    const key = normTxt(e.content);
    const list = byText.get(key) ?? [];
    list.push(e);
    byText.set(key, list);
  }
  for (const [key, list] of byText) {
    if (key && list.length >= IDENTICAL_COUNT) {
      const anyLink = list.some(e => e.isLink);
      return { content: key, events: list, anyLink };
    }
  }
  return null;
}

function detectBurst(arr, now, channelId) {
  const windowed = arr.filter(e => now - e.ts <= BURST_WINDOW_MS && e.channelId === channelId);
  if (windowed.length < BURST_COUNT) return null;
  const anyLink = windowed.some(e => e.isLink);
  return { events: windowed, anyLink };
}

function detectMultiChannel(arr, now) {
  const windowed = arr.filter(e => now - e.ts <= MULTI_CH_WINDOW_MS);
  // Group by normalized text
  const byText = new Map();
  for (const e of windowed) {
    const key = normTxt(e.content);
    if (!key) continue;
    const set = byText.get(key) ?? new Set();
    set.add(e.channelId);
    byText.set(key, set);
  }
  let winner = null;
  for (const [key, chSet] of byText) {
    if (chSet.size >= MULTI_CH_COUNT) {
      // determine if any of the matching windowed messages with this key has link
      const matches = windowed.filter(e => normTxt(e.content) === key);
      const anyLink = matches.some(e => e.isLink);
      winner = { content: key, channels: [...chSet], anyLink, matches };
      break;
    }
  }
  return winner; // or null
}

/** ===== Main entry ===== */
export async function handleSpamDetection(message) {
  try {
    if (!message.guild || message.author.bot) return;
    const guild = message.guild;
    const member = message.member;
    if (!member) return;

    const now = message.createdTimestamp ?? Date.now();
    const userId = message.author.id;
    const channelId = message.channel.id;
    const content = (message.toString?.() || message.content || '');

    // Record event
    const arr = record(userId, channelId, content, now, message.id);

    // Cooldown guard
    const la = lastAction.get(userId);
    if (la && (now - la.ts) < ACTION_COOLDOWN_MS) return;

    // === Multi-channel duplication (highest priority) ===
    const multi = detectMultiChannel(arr, now);
    if (multi) {
      if (multi.anyLink) {
        // Immediate ban
        try {
          await guild.members.ban(member.id, { reason: 'AutoMod: spam linkami w wielu kanałach' });
        } catch (e) {
          console.error('[AutoMod] ban failed:', e?.message || e);
        }
        lastAction.set(userId, { ts: now, kind: 'multi_link_ban' });

        // Temp notices in spammed channels
        for (const chId of multi.channels) {
          const ch = await guild.channels.fetch(chId).catch(() => null);
          if (ch?.type === ChannelType.GuildText) {
            await sendTemp(ch, `🚫 **ANTI-SPAM** Użytkownik <@${userId}> został zbanowany za spam linkami na wielu kanałach.`, 10);
          }
        }
        // Persistent log
        const embed = new EmbedBuilder()
          .setTitle('🚫 BAN: Spam linkami na wielu kanałach')
          .setDescription(`Użytkownik: <@${userId}> (${member.user.tag})\nKanały: ${multi.channels.map(id => `<#${id}>`).join(', ')}`)
          .addFields({ name: 'Treść', value: multi.content.slice(0, 256) })
          .setColor(0xB00020);
        await sendLog(guild, embed);
        return;
      } else {
        // 24h mute, level-3 warning
        const ok = await mute(member, 24 * 60, 'AutoMod: ten sam tekst na wielu kanałach');
        lastAction.set(userId, { ts: now, kind: 'multi_text_mute' });
        // Temp notices on those channels
        for (const chId of multi.channels) {
          const ch = await guild.channels.fetch(chId).catch(() => null);
          if (ch?.type === ChannelType.GuildText) {
            await sendTemp(ch, `🚫 **ANTI-SPAM** <@${userId}> — mute 24h (tekst duplikowany w wielu kanałach).`, 10);
          }
        }
        // Log
        const embed = new EmbedBuilder()
          .setTitle('🚫 ANTI-SPAM: Tekst w wielu kanałach (mute 24h, ostrzeżenie 3 stopnia)')
          .setDescription(`Użytkownik: <@${userId}> (${member.user.tag})\nKanały: ${multi.channels.map(id => `<#${id}>`).join(', ')}`)
          .addFields({ name: 'Treść', value: multi.content.slice(0, 1024) },
                     { name: 'Akcja', value: ok ? 'Mute 24h (Muted)' : 'Mute nieudany' })
          .setColor(0xD11A2A);
        await sendLog(guild, embed);
        return;
      }
    }

    // === Single-channel identical message spam ===
    const ident = detectIdentical(arr, now, channelId);
    if (ident) {
      // delete all identical messages in window
      const ids = ident.events.map(e => e.messageId).filter(Boolean);
      if (ids.length) await bulkDeleteByIds(guild, channelId, ids);

      if (ident.anyLink) {
        // Level-2 warning + 1h mute
        const ok = await mute(member, 60, 'AutoMod: 3x to samo z linkiem w <2s');
        lastAction.set(userId, { ts: now, kind: 'ident_link_mute' });
        await sendTemp(message.channel, `⚠️ (L2) <@${userId}> — 1h mute za powtarzanie tej samej wiadomości z linkiem.`, 10);
        const embed = new EmbedBuilder()
          .setTitle('⚠️ (L2) Identical spam + link (1h mute)')
          .setDescription(`Użytkownik: <@${userId}> (${member.user.tag})\nKanał: <#${channelId}>`)
          .addFields({ name: 'Treść', value: ident.content.slice(0, 1024) },
                     { name: 'Akcja', value: ok ? 'Mute 1h' : 'Mute nieudany' })
          .setColor(0xE67E22);
        await sendLog(guild, embed);
      } else {
        // Warning + 15m mute
        const ok = await mute(member, 15, 'AutoMod: 3x to samo w <2s');
        lastAction.set(userId, { ts: now, kind: 'ident_text_mute' });
        await sendTemp(message.channel, `⚠️ <@${userId}> otrzymał(a) mute 15 min za wysyłanie 3x tej samej wiadomości w <2s.`, 10);
        const embed = new EmbedBuilder()
          .setTitle('⚠️ Identical spam (15m mute)')
          .setDescription(`Użytkownik: <@${userId}> (${member.user.tag})\nKanał: <#${channelId}>`)
          .addFields({ name: 'Treść', value: ident.content.slice(0, 1024) },
                     { name: 'Akcja', value: ok ? 'Mute 15 min' : 'Mute nieudany' })
          .setColor(0xF39C12);
        await sendLog(guild, embed);
      }
      return;
    }

    // === Single-channel burst spam (>=5 in <2s) ===
    const burst = detectBurst(arr, now, channelId);
    if (burst) {
      // delete all messages in the burst window for this channel
      const ids = burst.events.map(e => e.messageId).filter(Boolean);
      if (ids.length) await bulkDeleteByIds(guild, channelId, ids);

      if (burst.anyLink) {
        // Level-2 warning + 3h mute
        const ok = await mute(member, 3 * 60, 'AutoMod: >=5 wiadomości z linkiem w <2s');
        lastAction.set(userId, { ts: now, kind: 'burst_link_mute' });
        await sendTemp(message.channel, `⚠️ (L2) <@${userId}> — 3h mute za spam z linkami (>=5/2s).`, 10);
        const embed = new EmbedBuilder()
          .setTitle('⚠️ (L2) Burst spam + link (3h mute)')
          .setDescription(`Użytkownik: <@${userId}> (${member.user.tag})\nKanał: <#${channelId}>`)
          .addFields({ name: 'Ilość', value: String(burst.events.length) },
                     { name: 'Akcja', value: ok ? 'Mute 3h' : 'Mute nieudany' })
          .setColor(0xE67E22);
        await sendLog(guild, embed);
      } else {
        // Level-1 warning + 30m mute
        const ok = await mute(member, 30, 'AutoMod: >=5 wiadomości w <2s');
        lastAction.set(userId, { ts: now, kind: 'burst_text_mute' });
        await sendTemp(message.channel, `⚠️ (L1) <@${userId}> — 30 min mute za spam (>=5/2s).`, 10);
        const embed = new EmbedBuilder()
          .setTitle('⚠️ (L1) Burst spam (30m mute)')
          .setDescription(`Użytkownik: <@${userId}> (${member.user.tag})\nKanał: <#${channelId}>`)
          .addFields({ name: 'Ilość', value: String(burst.events.length) },
                     { name: 'Akcja', value: ok ? 'Mute 30 min' : 'Mute nieudany' })
          .setColor(0xF39C12);
        await sendLog(guild, embed);
      }
      return;
    }

    // otherwise: no action
  } catch (e) {
    console.error('[AutoMod] handleSpamDetection error:', e?.stack || e?.message || e);
  }
}

export default { handleSpamDetection };
