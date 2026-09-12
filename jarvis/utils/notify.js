'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// NOTIFY — Canal de avisos de los vigilantes de background
//
// POR QUE EXISTE: netguard, infraguard y nasguard tenian los tres esta misma
// linea copiada:
//
//     try { await haPost('/services/notify/telegram', { message: msg }); } catch {}
//
// Si el servicio notify.telegram no existe (telegram_bot_token sin configurar),
// eso lanza, el catch vacio se lo traga, y el aviso desaparece sin dejar rastro
// ni en el log. Resultado real: el 29-08-2026 el disco sdd del NAS se paso a
// solo lectura por errores de E/S, nasguard lo detecto, y el aviso no llego a
// ninguna parte. Se descubrio 14 dias despues, y de casualidad.
//
// Un vigilante que no puede avisar no es un vigilante. Asi que aqui:
//   1. Se intenta Telegram (si esta configurado).
//   2. Si no hay Telegram o falla, se crea una notificacion persistente en HA
//      — que SIEMPRE esta disponible, no necesita configuracion, y se queda
//      visible en la campana hasta que el usuario la descarta.
//   3. Pase lo que pase, se escribe en el log. Un aviso nunca se pierde en
//      silencio.
//
// IMPACTO DE TOKENS: cero. Aqui no hay ninguna llamada a LLM.
// ─────────────────────────────────────────────────────────────────────────────
const { haPost } = require('./ha-api');
const C = require('./constants');

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

  if (C.TELEGRAM_BOT_TOKEN) {
    try {
      await haPost('/services/notify/telegram', { message: msg });
      console.log(`[${source}] aviso enviado por Telegram: ${msg}`);
      return 'telegram';
    } catch (e) {
      fallos.push(`telegram: ${e.message}`);
    }
  } else {
    fallos.push('telegram: sin telegram_bot_token configurado');
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

module.exports = { notify };
