'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// NASGUARD — Vigilancia del NAS (OpenMediaVault)
//
// El NAS vive fuera de la red de HA y HA no tiene sensores fiables suyos: la
// integración OMV lleva caída desde que las redes se separaron. Esto lo vigila
// directamente contra la API RPC de OMV.
//
// Vigila:
//   · Salud SMART por disco (veredicto de OMV + contadores de sectores)
//   · Discos con la monitorización SMART desactivada (no avisarían de nada)
//   · Ocupación de volúmenes
//   · Servicios de OMV habilitados pero caídos
//   · Contenedores Docker que no estén "running"
//   · El propio NAS sin responder
//
// IMPACTO DE TOKENS: CERO. Todas las comparaciones son en código, sin LLM. Solo
// se emite texto cuando algo EMPEORA respecto al último ciclo, y ese texto va a
// Telegram y a pending_thoughts, no a un modelo. Un NAS sano no genera nada.
// Frecuencia: 6 h (4 ciclos/día).
// ─────────────────────────────────────────────────────────────────────────────
const path = require('path');
const { loadJSON, saveJSON } = require('../utils/persistence');
const { haPost } = require('../utils/ha-api');
const omv = require('../utils/omv-api');

const STATE_FILE    = path.join(require('../utils/constants').DATA_DIR, 'nasguard_state.json');
const THOUGHTS_FILE = path.join(require('../utils/constants').DATA_DIR, 'pending_thoughts.json');

const DISK_USAGE_WARN = 85;   // % de ocupación a partir del cual avisamos
const UNREACHABLE_CONFIRMS = 2; // ciclos seguidos sin respuesta antes de alertar

// Contadores SMART cuyo aumento significa daño físico real
const DAMAGE_ATTRS = {
  5:   'sectores reasignados',
  197: 'sectores pendientes',
  198: 'sectores no corregibles',
};

function recordThought(t) {
  try {
    const thoughts = loadJSON(THOUGHTS_FILE, []);
    thoughts.push({
      id: Date.now(), type: 'nasguard', status: 'pending',
      created: new Date().toISOString(), ...t,
    });
    saveJSON(THOUGHTS_FILE, thoughts);
  } catch {}
}

async function notify(msg) {
  try { await haPost('/services/notify/telegram', { message: msg }); } catch {}
}

// Emite una alerta solo si no la habíamos emitido ya (evita repetir lo mismo
// cada 6 h para un problema que sigue ahí sin cambiar).
function shouldAlert(st, key, signature) {
  if (st.alerts[key] === signature) return false;
  st.alerts[key] = signature;
  return true;
}

function clearAlert(st, key) {
  if (st.alerts[key]) delete st.alerts[key];
}

async function nasGuardLoop() {
  if (!omv.omvConfigured()) return;

  const st = loadJSON(STATE_FILE, { disks: {}, alerts: {}, unreachable: 0 });
  st.alerts = st.alerts || {};

  let disks, filesystems, services, containers;
  try {
    [disks, filesystems, services] = await Promise.all([
      omv.getDisks(), omv.getFilesystems(), omv.getServices(),
    ]);
    // Los contenedores dependen del plugin compose; si no está, no es un fallo.
    try { containers = await omv.getContainers(); } catch { containers = []; }
  } catch (e) {
    // Se loguea SIEMPRE, no solo al alertar: si no, un fallo de credenciales
    // permanece invisible 12h (dos ciclos) — que es justo el tipo de fallo
    // silencioso que tuvo los sensores del NAS mintiendo durante meses.
    console.log(`[nasguard] No pude consultar el NAS: ${e.message}`);
    st.unreachable = (st.unreachable || 0) + 1;
    if (st.unreachable === UNREACHABLE_CONFIRMS) {
      recordThought({
        priority: 'critical',
        title: 'El NAS no responde',
        detail: `Llevo ${UNREACHABLE_CONFIRMS} ciclos sin poder hablar con el NAS: ${e.message}`,
      });
      await notify(`🚨 Jarvis: el NAS no responde (${e.message}).`);
    }
    saveJSON(STATE_FILE, st);
    return;
  }

  if (st.unreachable >= UNREACHABLE_CONFIRMS) {
    await notify('✅ Jarvis: el NAS vuelve a responder.');
  }
  st.unreachable = 0;

  // ── 1) Salud de discos ────────────────────────────────────────────────────
  for (const d of disks) {
    const prev = st.disks[d.device] || {};
    const key  = `disk:${d.device}`;

    if (d.status && d.status !== 'GOOD') {
      if (shouldAlert(st, key, d.status)) {
        recordThought({
          priority: 'critical',
          title: `Disco ${d.device} con salud "${d.status}"`,
          detail: `${d.model} (nº serie ${d.serial}) reporta ${d.status} en el NAS. ` +
                  `Conviene sacar los datos y planificar el reemplazo.`,
        });
        await notify(`🚨 Jarvis: el disco *${d.device}* del NAS (${d.model}) está en estado ${d.status}. Saca los datos.`);
      }
    } else {
      clearAlert(st, key);
    }

    // Un disco sin monitorización SMART no avisaría nunca por su cuenta.
    if (d.status === 'GOOD' && !d.monitored) {
      if (shouldAlert(st, `unmonitored:${d.device}`, 'off')) {
        recordThought({
          priority: 'medium',
          title: `Disco ${d.device} sin monitorización SMART`,
          detail: `${d.model} está sano pero tiene la vigilancia SMART desactivada en OMV. ` +
                  `Si empieza a fallar, nadie se enterará.`,
        });
      }
    } else {
      clearAlert(st, `unmonitored:${d.device}`);
    }

    // Evolución de los contadores de daño físico
    let attrs = [];
    try { attrs = await omv.getDiskAttributes(`/dev/${d.device}`); } catch {}
    const counters = {};
    for (const a of attrs) {
      if (DAMAGE_ATTRS[a.id] != null) counters[a.id] = Number(a.raw) || 0;
    }
    for (const [id, label] of Object.entries(DAMAGE_ATTRS)) {
      const now  = counters[id];
      const then = prev.counters?.[id];
      if (now == null || then == null || now <= then) continue;
      recordThought({
        priority: 'critical',
        title: `El disco ${d.device} está empeorando`,
        detail: `Los ${label} han subido de ${then} a ${now} desde el último chequeo. ` +
                `Eso es daño nuevo, no histórico.`,
      });
      await notify(`🚨 Jarvis: *${d.device}* empeorando — ${label}: ${then} → ${now}. Es daño nuevo.`);
    }

    st.disks[d.device] = { status: d.status, counters, tempC: d.tempC };
  }

  // ── 2) Ocupación de volúmenes ─────────────────────────────────────────────
  for (const f of filesystems) {
    const key = `fs:${f.device}`;
    if (f.usedPct >= DISK_USAGE_WARN) {
      // Firma por tramos de 5% para no repetir la alerta en cada punto porcentual
      if (shouldAlert(st, key, String(Math.floor(f.usedPct / 5) * 5))) {
        recordThought({
          priority: f.usedPct >= 95 ? 'critical' : 'high',
          title: `Volumen ${f.device} al ${f.usedPct}%`,
          detail: `${f.mountpoint} está al ${f.usedPct}% (quedan ${f.availableGB} GB).`,
        });
        await notify(`⚠️ Jarvis: el volumen *${f.device}* del NAS está al ${f.usedPct}% (quedan ${f.availableGB} GB).`);
      }
    } else {
      clearAlert(st, key);
    }
  }

  // ── 3) Servicios habilitados pero caídos ──────────────────────────────────
  for (const s of services) {
    const key = `svc:${s.name}`;
    if (s.enabled && !s.running) {
      if (shouldAlert(st, key, 'down')) {
        recordThought({
          priority: 'high',
          title: `Servicio "${s.name}" caído en el NAS`,
          detail: `${s.name} está habilitado en OMV pero no se está ejecutando.`,
        });
        await notify(`⚠️ Jarvis: el servicio *${s.name}* del NAS está habilitado pero caído.`);
      }
    } else {
      clearAlert(st, key);
    }
  }

  // ── 4) Contenedores que no están corriendo ────────────────────────────────
  for (const c of containers) {
    const key = `ctr:${c.name}`;
    const bad = c.state && c.state !== 'running';
    if (bad) {
      if (shouldAlert(st, key, c.state)) {
        recordThought({
          priority: c.state === 'restarting' ? 'high' : 'medium',
          title: `Contenedor "${c.name}" en estado ${c.state}`,
          detail: `${c.name} (${c.image}) está en "${c.status}" en el NAS.`,
        });
        await notify(`⚠️ Jarvis: el contenedor *${c.name}* del NAS está en estado ${c.state}.`);
      }
    } else {
      clearAlert(st, key);
    }
  }

  const problemas =
    disks.filter(d => d.status && d.status !== 'GOOD').length +
    filesystems.filter(f => f.usedPct >= DISK_USAGE_WARN).length +
    services.filter(s => s.enabled && !s.running).length +
    containers.filter(c => c.state && c.state !== 'running').length;
  console.log(`[nasguard] NAS consultado: ${disks.length} discos, ${filesystems.length} volúmenes, ` +
              `${containers.length} contenedores — ${problemas} problema(s)`);

  saveJSON(STATE_FILE, st);
}

module.exports = { nasGuardLoop };
