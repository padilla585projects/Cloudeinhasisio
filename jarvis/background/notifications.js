'use strict';
// ── Smart Notification Batching System ──────────────────────────────────────
// Groups similar alerts, applies cooldowns, and prioritizes before sending.
// Zero LLM cost — all logic is rule-based.

const path = require('path');
const state = require('../utils/state');
const { loadJSON, saveJSON } = require('../utils/persistence');
const { DATA_DIR } = require('../utils/constants');

const NOTIF_LOG_FILE = path.join(DATA_DIR, 'notification_log.json');
const COOLDOWNS = {
  battery_low: 6 * 3600_000,     // 6h between same battery alerts
  device_down: 30 * 60_000,      // 30min between same device-down alerts
  emergency: 0,                   // no cooldown for emergencies
  health_scan: 4 * 3600_000,     // 4h
  update_available: 12 * 3600_000, // 12h
  default: 60 * 60_000           // 1h default
};

let notifLog = [];
let pendingBatch = [];
let batchTimer = null;

function init() {
  notifLog = loadJSON(NOTIF_LOG_FILE, []);
  // Clean old entries (> 7 days)
  const weekAgo = Date.now() - 7 * 86400_000;
  notifLog = notifLog.filter(n => new Date(n.ts).getTime() > weekAgo);
  saveJSON(NOTIF_LOG_FILE, notifLog);
}

/**
 * Queue a notification. Similar notifications within the batch window (30s)
 * are grouped together before sending.
 * @param {string} type - battery_low|device_down|emergency|health_scan|update_available|info
 * @param {string} title - Short title
 * @param {string} message - Full message
 * @param {string} priority - urgent|high|medium|low
 */
function queueNotification(type, title, message, priority = 'medium') {
  // Check cooldown
  const cooldown = COOLDOWNS[type] || COOLDOWNS.default;
  if (cooldown > 0) {
    const lastSame = notifLog.filter(n => n.type === type).sort((a, b) => new Date(b.ts) - new Date(a.ts))[0];
    if (lastSame && (Date.now() - new Date(lastSame.ts).getTime()) < cooldown) {
      return false; // suppressed by cooldown
    }
  }

  pendingBatch.push({ type, title, message, priority, ts: new Date().toISOString() });

  // Urgent notifications send immediately
  if (priority === 'urgent') {
    flushBatch();
    return true;
  }

  // Otherwise batch for 30 seconds
  if (!batchTimer) {
    batchTimer = setTimeout(flushBatch, 30_000);
  }
  return true;
}

function flushBatch() {
  if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
  if (pendingBatch.length === 0) return;

  const batch = [...pendingBatch];
  pendingBatch = [];

  // Group by type
  const groups = {};
  for (const n of batch) {
    if (!groups[n.type]) groups[n.type] = [];
    groups[n.type].push(n);
  }

  // Build grouped message
  const lines = [];
  const priorityOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
  let topPriority = 'low';

  for (const [type, items] of Object.entries(groups)) {
    const best = items.reduce((a, b) => (priorityOrder[a.priority] || 3) < (priorityOrder[b.priority] || 3) ? a : b);
    if ((priorityOrder[best.priority] || 3) < (priorityOrder[topPriority] || 3)) {
      topPriority = best.priority;
    }

    if (items.length === 1) {
      lines.push(`${priorityIcon(items[0].priority)} ${items[0].message}`);
    } else {
      // Group: "3 dispositivos con batería baja: sensor_A (5%), sensor_B (8%), sensor_C (12%)"
      lines.push(`${priorityIcon(best.priority)} ${items[0].title} (×${items.length}):\n${items.map(i => `  · ${i.message}`).join('\n')}`);
    }
  }

  const finalMessage = batch.length > 1
    ? `🔔 *Jarvis — ${batch.length} alertas*\n\n${lines.join('\n\n')}`
    : `🔔 ${lines[0]}`;

  // Log all notifications
  for (const n of batch) {
    notifLog.push({ type: n.type, title: n.title, priority: n.priority, ts: n.ts });
  }
  if (notifLog.length > 500) notifLog = notifLog.slice(-500);
  saveJSON(NOTIF_LOG_FILE, notifLog);

  // Send via push SSE to connected clients
  if (state.pushClients && state.pushClients.size > 0) {
    const line = `data: ${JSON.stringify({ type: 'notification', priority: topPriority, count: batch.length, message: finalMessage })}\n\n`;
    for (const res of state.pushClients) {
      try { res.write(line); } catch { state.pushClients.delete(res); }
    }
  }

  // Send via Telegram if configured and priority is high+
  if (process.env.TELEGRAM_BOT_TOKEN && (topPriority === 'urgent' || topPriority === 'high')) {
    try {
      const { haPost } = require('../utils/ha-api');
      haPost('/services/telegram_bot/send_message', { message: finalMessage, parse_mode: 'markdown' }).catch(() => {});
    } catch {}
  }

  console.log(`[notifications] Batch enviado: ${batch.length} alertas (${topPriority})`);
}

function priorityIcon(p) {
  switch (p) {
    case 'urgent': return '🚨';
    case 'high': return '🔴';
    case 'medium': return '🟡';
    case 'low': return '🔵';
    default: return '📌';
  }
}

/**
 * Get recent notifications for the UI
 */
function getRecentNotifications(limit = 20) {
  return notifLog.slice(-limit).reverse();
}

module.exports = { init, queueNotification, flushBatch, getRecentNotifications };
