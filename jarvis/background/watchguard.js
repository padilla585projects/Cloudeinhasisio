'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// WATCHGUARD — vigila DOS cosas que Jarvis no miraba y que costaron caras:
//
//   1. Dispositivos que llevan CAÍDOS (unavailable/unknown) demasiado tiempo.
//   2. El LOG de HA, buscando errores que se REPITEN (no el ruido de una vez).
//
// POR QUE EXISTE (incidente del 01-10-2026): seis enchufes —incluida la
// impresora— y varios ESPHome se quedaron unavailable durante DÍAS tras un
// backup de Proxmox, y nadie avisó. Había un escáner de salud, pero:
//   · avisaba por un haPost suelto al bot de Telegram envuelto en un catch {}
//     vacío — el mismo fallo que ya costó en v3.38.4 — así que el aviso se
//     perdía en silencio;
//   · no tenía memoria entre vueltas: no sabía si algo llevaba 5 minutos o 5
//     días caído, así que no podía distinguir un parpadeo de una avería.
//
// WATCHGUARD guarda estado en disco: sabe DESDE CUÁNDO está caído cada
// dispositivo, avisa UNA vez cuando cruza el umbral y otra cuando se recupera,
// todo por utils/notify.js (Telegram del add-on o de HA, y campana de HA como
// red de seguridad). Nunca un catch vacío.
//
// IMPACTO DE TOKENS: CERO. Son lecturas REST a HA y comparación en código. No
// hay ninguna llamada a LLM. Frecuencia: cada 15 min.
// ─────────────────────────────────────────────────────────────────────────────
const path = require('path');
const { loadJSON, saveJSON } = require('../utils/persistence');
const { haGet } = require('../utils/ha-api');
const { notify: notifyChannel } = require('../utils/notify');
const C = require('../utils/constants');

const STATE_FILE = path.join(C.DATA_DIR, 'watchguard_state.json');

// ── Umbrales ────────────────────────────────────────────────────────────────
const DOWN_MIN_MS      = 30 * 60_000;   // caído >30 min antes de avisar
const RECHECK_MS       = 24 * 3600_000; // si sigue caído, recordar una vez al día
const LOG_WINDOW_MS    = 60 * 60_000;   // errores del log de la última hora
const LOG_MIN_REPEATS  = 10;            // un error tiene que repetirse 10+ veces
// Dominios cuyo "unavailable" es ruido, no avería: automatizaciones, scripts,
// escenas, helpers, y los botones/updates que están "unknown" por diseño.
const IGNORAR_PREFIJOS = ['automation.', 'script.', 'scene.', 'input_', 'button.',
                          'update.', 'tts.', 'stt.', 'conversation.', 'persistent_notification.',
                          'device_tracker.', 'person.'];

async function notify(msg) {
  await notifyChannel(msg, { title: 'Jarvis — Dispositivos', source: 'watchguard' });
}

function nombre(e) {
  return (e.attributes && e.attributes.friendly_name) || e.entity_id;
}

function esVigilable(e) {
  if (!e || !e.entity_id) return false;
  if (IGNORAR_PREFIJOS.some(p => e.entity_id.startsWith(p))) return false;
  return true;
}

// ── 1) Dispositivos caídos ──────────────────────────────────────────────────
// Devuelve el nº de avisos emitidos (para las pruebas y el log).
async function revisarCaidos(st, estados, ahora, avisar) {
  st.down = st.down || {};              // entity_id -> { since, avisado, nombre, reavisado }
  const vivos = new Set();
  let emitidos = 0;

  for (const e of estados) {
    if (!esVigilable(e)) continue;
    const caido = e.state === 'unavailable' || e.state === 'unknown';

    if (caido) {
      vivos.add(e.entity_id);
      const prev = st.down[e.entity_id];
      if (!prev) {
        st.down[e.entity_id] = { since: ahora, avisado: false, reavisado: 0, nombre: nombre(e) };
      } else {
        prev.nombre = nombre(e);        // por si cambió el friendly_name
      }
    }
    // si no está caído, se limpia abajo (en el barrido de recuperados)
  }

  // Recuperados: estaban en la lista y ya no están caídos.
  for (const id of Object.keys(st.down)) {
    if (vivos.has(id)) continue;
    const info = st.down[id];
    if (info.avisado) {
      const min = Math.round((ahora - info.since) / 60_000);
      await avisar(`✅ Jarvis: *${info.nombre}* ha vuelto (estuvo caído ${min >= 120 ? Math.round(min/60)+' h' : min+' min'}).`);
      emitidos++;
    }
    delete st.down[id];
  }

  // Avisar de los que cruzan el umbral, o recordar los que siguen caídos.
  const nuevos = [];
  for (const id of Object.keys(st.down)) {
    const info = st.down[id];
    const edad = ahora - info.since;
    if (edad < DOWN_MIN_MS) continue;

    if (!info.avisado) {
      info.avisado = true;
      info.reavisado = ahora;
      nuevos.push(info.nombre);
    } else if (ahora - info.reavisado >= RECHECK_MS) {
      info.reavisado = ahora;
      const h = Math.round(edad / 3600_000);
      await avisar(`⚠️ Jarvis: *${info.nombre}* sigue caído (${h} h ya).`);
      emitidos++;
    }
  }

  // Los nuevos se agrupan en un solo aviso (evita una ráfaga tras un reinicio).
  if (nuevos.length === 1) {
    await avisar(`⚠️ Jarvis: *${nuevos[0]}* lleva más de 30 min caído y no vuelve.`);
    emitidos++;
  } else if (nuevos.length > 1) {
    const lista = nuevos.slice(0, 8).map(n => `  · ${n}`).join('\n');
    const resto = nuevos.length > 8 ? `\n  …y ${nuevos.length - 8} más` : '';
    await avisar(`⚠️ Jarvis: ${nuevos.length} dispositivos llevan más de 30 min caídos:\n${lista}${resto}`);
    emitidos++;
  }

  return emitidos;
}

// ── 2) Errores repetidos en el log de HA ────────────────────────────────────
// Agrupa por "firma" (la línea sin timestamp ni IDs volátiles) y avisa de los
// que se repiten mucho en la última hora. Avisa UNA vez por firma al día.
function firmaDeLog(linea) {
  return linea
    .replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}[.,]?\d*/g, '')  // timestamp
    .replace(/0x[0-9a-fA-F]+/g, '0x?')                               // handles ZCL
    .replace(/\b\d+\b/g, '#')                                        // números
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

async function revisarLog(st, textoLog, ahora, avisar) {
  st.logSeen = st.logSeen || {};        // firma -> último aviso (ts)
  if (!textoLog) return 0;

  const conteo = {};
  const ejemplo = {};
  for (const linea of textoLog.split('\n')) {
    if (!/ERROR|CRITICAL/.test(linea)) continue;
    const f = firmaDeLog(linea);
    if (f.length < 20) continue;        // demasiado corta para ser útil
    conteo[f] = (conteo[f] || 0) + 1;
    if (!ejemplo[f]) ejemplo[f] = linea.trim().slice(0, 220);
  }

  let emitidos = 0;
  for (const [f, n] of Object.entries(conteo)) {
    if (n < LOG_MIN_REPEATS) continue;
    const ultimo = st.logSeen[f] || 0;
    if (ahora - ultimo < RECHECK_MS) continue;   // ya avisé de esta hoy
    st.logSeen[f] = ahora;
    await avisar(`🪵 Jarvis: un error se repite en el log de HA (${n} veces/hora):\n\`${ejemplo[f]}\``);
    emitidos++;
  }

  // Limpiar firmas viejas para que el estado no crezca sin fin.
  for (const f of Object.keys(st.logSeen)) {
    if (ahora - st.logSeen[f] > 7 * RECHECK_MS) delete st.logSeen[f];
  }
  return emitidos;
}

// ── Bucle principal ─────────────────────────────────────────────────────────
// `deps` permite probarlo sin tocar HA.
async function watchGuardLoop(deps = {}) {
  const getStates = deps.getStates || (() => haGet('/states'));
  const getLog    = deps.getLog    || (async () => {
    try {
      const res = await require('node-fetch')(`http://supervisor/core/logs`, {
        headers: { Authorization: `Bearer ${C.HA_TOKEN}` },
      });
      return res.ok ? await res.text() : '';
    } catch { return ''; }
  });
  const ahora   = deps.now ? deps.now() : Date.now();
  const avisar  = deps.notify || notify;
  const cargar  = deps.load || (() => loadJSON(STATE_FILE, {}));
  const guardar = deps.save || ((st) => saveJSON(STATE_FILE, st));

  const st = cargar();
  try {
    let estados;
    try { estados = await getStates(); }
    catch (e) { console.log(`[watchguard] no pude leer /states: ${e.message}`); return; }
    if (!Array.isArray(estados)) return;

    const nCaidos = await revisarCaidos(st, estados, ahora, avisar);

    let nLog = 0;
    try { nLog = await revisarLog(st, await getLog(), ahora, avisar); }
    catch (e) { console.log(`[watchguard] log: ${e.message}`); }

    guardar(st);
    const caidosAhora = Object.keys(st.down || {}).length;
    console.log(`[watchguard] ${caidosAhora} caídos en seguimiento, ${nCaidos} avisos de dispositivos, ${nLog} de log`);
  } catch (e) {
    console.log(`[watchguard] Error: ${e.message}`);
  }
}

module.exports = { watchGuardLoop, revisarCaidos, revisarLog, firmaDeLog, esVigilable };
