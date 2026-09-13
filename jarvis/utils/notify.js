'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// NOTIFY — Canal de avisos de los vigilantes de background
//
// POR QUE EXISTE: netguard, infraguard y nasguard tenian los tres esta misma
// linea copiada:
//
//     try { await haPost('/services/notify/telegram', { message: msg }); } catch {}
//
// Si el servicio notify.telegram no existe, eso lanza, el catch vacio se lo
// traga, y el aviso desaparece sin dejar rastro ni en el log. Resultado real:
// el 29-08-2026 el disco sdd del NAS se paso a solo lectura por errores de E/S,
// nasguard lo detecto, y el aviso no llego a ninguna parte. Se descubrio 14
// dias despues, y de casualidad.
//
// CORREGIDO EN v3.38.4: la version anterior preguntaba por TELEGRAM_BOT_TOKEN
// —que es el bot PROPIO del add-on— y a continuacion llamaba a notify.telegram,
// que es el bot de la INTEGRACION de Home Assistant. Dos bots distintos. Con el
// bot de HA configurado pero sin telegram_bot_token, esta funcion ni lo
// intentaba: los avisos del NAS y de los add-ons se quedaban en la campana.
// Ahora se prueban los dos de verdad, en orden, y se dice cual funciono.
//
// Hay TRES bots de Telegram en juego y conviene no confundirlos:
//   1. El de la integracion de HA  → servicios telegram_bot.* / notify.telegram
//   2. El propio del add-on        → opcion telegram_bot_token (conversar)
//   3. El del centinela externo    → vive en Cloudflare, NO se toca desde aqui,
//      que para eso esta fuera de la casa.
//
// IMPACTO DE TOKENS: cero. Aqui no hay ninguna llamada a LLM.
// ─────────────────────────────────────────────────────────────────────────────
const path = require('path');
const fetch = require('node-fetch');
const { haPost } = require('./ha-api');
const { loadJSON } = require('./persistence');
const C = require('./constants');

// El bot de HA puede estar publicado con cualquiera de estos dos servicios,
// segun como este configurada la integracion. Se prueban ambos: preguntar
// antes por /services cuesta una respuesta enorme en cada aviso.
const SERVICIOS_DE_HA = [
  '/services/telegram_bot/send_message',
  '/services/notify/telegram',
];

// A que chat escribe el bot PROPIO del add-on. Si Adrian fijo ids permitidos,
// el primero; si no, el que telegram_bot.js aprendio la primera vez que le
// escribieron.
function chatDelBotPropio() {
  const ids = String(C.TELEGRAM_ALLOWED_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (ids.length) return ids[0];
  try {
    const st = loadJSON(path.join(C.DATA_DIR, 'telegram_bot_state.json'), {});
    return st.learnedChatId ? String(st.learnedChatId) : '';
  } catch {
    return '';
  }
}

/**
 * Intenta entregar por Telegram, por cualquiera de los dos bots.
 * @returns {Promise<string|null>} Como se entrego, o null si no se pudo.
 */
async function notifyTelegram(msg, fallos = []) {
  for (const ruta of SERVICIOS_DE_HA) {
    try {
      await haPost(ruta, { message: msg });
      return `bot de HA (${ruta.split('/services/')[1]})`;
    } catch (e) {
      fallos.push(`${ruta}: ${e.message}`);
    }
  }

  if (!C.TELEGRAM_BOT_TOKEN) {
    fallos.push('bot propio: sin telegram_bot_token configurado');
    return null;
  }
  const chatId = chatDelBotPropio();
  if (!chatId) {
    fallos.push('bot propio: no se a que chat escribir (escribele al bot una vez)');
    return null;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${C.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: msg }),
      timeout: 10_000,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return 'bot propio del add-on';
  } catch (e) {
    fallos.push(`bot propio: ${e.message}`);
    return null;
  }
}

/**
 * Envía un aviso por el mejor canal disponible.
 * @param {string} msg        Texto del aviso.
 * @param {object} [opts]
 * @param {string} [opts.title]  Título para la notificación de HA.
 * @param {string} [opts.source] Quién avisa (para el log): 'nasguard', etc.
 * @returns {Promise<string>} Canal que funcionó: 'telegram' | 'ha' | 'ninguno'.
 */
async function notify(msg, opts = {}) {
  const title  = opts.title  || 'Jarvis';
  const source = opts.source || 'notify';
  const fallos = [];

  const via = await notifyTelegram(msg, fallos);
  if (via) {
    console.log(`[${source}] aviso enviado por Telegram, ${via}: ${msg}`);
    return 'telegram';
  }

  // Notificación persistente de HA: no requiere configuración y se queda en la
  // campana hasta que se descarta. Es la red de seguridad.
  try {
    await haPost('/services/persistent_notification/create', {
      title,
      message: msg,
      notification_id: `jarvis_${source}_${Date.now()}`,
    });
    console.log(`[${source}] aviso en notificaciones de HA (${fallos.join('; ')}): ${msg}`);
    return 'ha';
  } catch (e) {
    fallos.push(`ha: ${e.message}`);
  }

  // Ni Telegram ni HA. Al menos que quede constancia.
  console.log(`[${source}] ⚠️ NO PUDE AVISAR POR NINGUN CANAL (${fallos.join('; ')}). Aviso: ${msg}`);
  return 'ninguno';
}

module.exports = { notify, notifyTelegram };
