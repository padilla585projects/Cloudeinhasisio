'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// LATIDO — señal de vida hacia el centinela externo.
//
// POR QUE EXISTE: Jarvis vive dentro de Home Assistant, que es una VM de
// Proxmox, cuyos backups viven en el NAS, que es lo que Jarvis vigila. Un
// vigilante dentro de lo que vigila no puede avisar de que lo que lo contiene
// se ha caído. El 29-08-2026 un corte de luz a las 05:40 dejó todo muerto y no
// se supo hasta catorce días después.
//
// La solución no es que Jarvis grite más fuerte, es que alguien de fuera note
// su silencio. Este módulo manda un latido cada 5 minutos a un Worker de
// Cloudflare que vive fuera de la casa y fuera del ISP. Si los latidos paran
// —da igual el motivo: HA caído, NAS apagado, luz cortada, fibra caída— el
// centinela avisa al móvil por un canal que no depende de nada de aquí.
//
// Además del "sigo vivo", el latido lleva los problemas que YA han detectado
// netguard, infraguard y nasguard. Así sus hallazgos salen de casa aunque el
// canal interno falle, que es exactamente lo que pasó.
//
// IMPACTO DE TOKENS: CERO. Ni una llamada a LLM. Es un POST de unos cientos de
// bytes cada 5 minutos: 288 peticiones al día, dentro del plan gratuito de
// Cloudflare (100.000/día) con cuatro órdenes de magnitud de margen.
// ─────────────────────────────────────────────────────────────────────────────
const fetch = require('node-fetch');
const path = require('path');
const { loadJSON } = require('../utils/persistence');
const C = require('../utils/constants');
const state = require('../utils/state');

const THOUGHTS_FILE = path.join(C.DATA_DIR, 'pending_thoughts.json');
const VENTANA_MS = 24 * 3600_000;   // problemas de las últimas 24h
const MAX_PROBLEMAS = 8;            // no saturar el aviso

let fallosSeguidos = 0;

function latidoConfigurado() {
  return Boolean(C.CENTINELA_URL);
}

// Reúne los problemas vivos que ya detectaron los vigilantes internos.
function problemasActuales() {
  try {
    const thoughts = loadJSON(THOUGHTS_FILE, []);
    const desde = Date.now() - VENTANA_MS;
    return thoughts
      .filter(t => ['nasguard', 'infraguard', 'netguard'].includes(t.type))
      .filter(t => t.status === 'pending')
      .filter(t => ['critical', 'high'].includes(t.priority))
      .filter(t => new Date(t.created).getTime() >= desde)
      .map(t => t.title)
      .filter((v, i, a) => a.indexOf(v) === i)      // sin duplicados
      .slice(-MAX_PROBLEMAS);
  } catch {
    return [];
  }
}

async function latidoLoop() {
  if (!latidoConfigurado()) return;

  const cuerpo = {
    version: state.JARVIS_VERSION,
    ha_conectado: Boolean(C.HA_TOKEN),
    uptime_min: Math.round(process.uptime() / 60),
    problemas: problemasActuales(),
  };

  try {
    const res = await fetch(`${C.CENTINELA_URL.replace(/\/$/, '')}/latido?fuente=jarvis`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(C.CENTINELA_CLAVE ? { 'X-Jarvis-Clave': C.CENTINELA_CLAVE } : {}),
      },
      body: JSON.stringify(cuerpo),
      timeout: 10_000,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    if (fallosSeguidos > 0) {
      console.log(`[latido] recuperado tras ${fallosSeguidos} fallos`);
      fallosSeguidos = 0;
    }
  } catch (e) {
    // Se loguea SIEMPRE. Un latido que falla en silencio nos devolvería justo
    // al problema que este módulo existe para resolver.
    fallosSeguidos += 1;
    console.log(`[latido] no pude avisar al centinela (${fallosSeguidos} seguidos): ${e.message}`);
  }
}

module.exports = { latidoLoop, latidoConfigurado };
