'use strict';
const fs   = require('fs');
const path = require('path');
const { loadJSON, saveJSON } = require('../utils/persistence');
const { DATA_DIR } = require('../utils/constants');
const state = require('../utils/state');

// ── NEXUS Health scores ───────────────────────────────────────────────────────

const NEXUS_HEALTH_DIR  = path.join(DATA_DIR, 'nexus');
const NEXUS_HEALTH_FILE = path.join(NEXUS_HEALTH_DIR, 'health.json');

function nexusLoadHealth() {
  try {
    if (!fs.existsSync(NEXUS_HEALTH_DIR)) fs.mkdirSync(NEXUS_HEALTH_DIR, { recursive: true });
    if (!fs.existsSync(NEXUS_HEALTH_FILE)) return {};
    return JSON.parse(fs.readFileSync(NEXUS_HEALTH_FILE, 'utf8'));
  } catch { return {}; }
}

function nexusSaveHealth(health) {
  try {
    if (!fs.existsSync(NEXUS_HEALTH_DIR)) fs.mkdirSync(NEXUS_HEALTH_DIR, { recursive: true });
    fs.writeFileSync(NEXUS_HEALTH_FILE, JSON.stringify(health, null, 2));
  } catch (e) { console.log('[nexus] health save error:', e.message); }
}

// Inicializar desde disco
state.nexusHealth = nexusLoadHealth();

// ── Expertos y módulos dinámicos (creados por Jarvis en runtime) ─────────────
state.dynamicExperts = loadJSON(path.join(DATA_DIR, 'nexus/dynamic_experts.json'), {});
state.dynamicModules = loadJSON(path.join(DATA_DIR, 'nexus/dynamic_modules.json'), {});

function nexusReloadDynamic() {
  state.dynamicExperts = loadJSON(path.join(DATA_DIR, 'nexus/dynamic_experts.json'), {});
  state.dynamicModules = loadJSON(path.join(DATA_DIR, 'nexus/dynamic_modules.json'), {});
  console.log(`[nexus] Recargado: ${Object.keys(state.dynamicExperts).length} expertos, ${Object.keys(state.dynamicModules).length} módulos dinámicos`);
}

function nexusGetScore(expertName) {
  return state.nexusHealth[expertName]?.score ?? 75;
}

function nexusUpdateHealth(expertName, success, hadCorrection) {
  if (!state.nexusHealth[expertName]) state.nexusHealth[expertName] = { score: 75, uses: 0, corrections: 0 };
  const h = state.nexusHealth[expertName];
  h.uses = (h.uses || 0) + 1;
  if (hadCorrection) { h.corrections = (h.corrections || 0) + 1; h.score = Math.max(0, h.score - 8); }
  else if (success)  { h.score = Math.min(100, h.score + 2); }
  else               { h.score = Math.max(0, h.score - 3); }
  h.lastUsed = new Date().toISOString();
  nexusSaveHealth(state.nexusHealth);
}

function nexusEvolutionTick(expertName, success, hadCorrection) {
  try {
    nexusUpdateHealth(expertName, success, hadCorrection);
    if (hadCorrection) console.log(`[nexus] Corrección → health[${expertName}]=${nexusGetScore(expertName)}`);
    else if (success)  console.log(`[nexus] Éxito → health[${expertName}]=${nexusGetScore(expertName)}`);
  } catch (e) { console.log('[nexus] evolution error:', e.message); }
}

function nexusWatchers() {
  try {
    const unavailCount = Object.values(state.entityCache || {}).filter(e => e && e.state === 'unavailable').length;
    if (unavailCount > 20 && !state.nexusHealth._thermal_warned) {
      console.log(`[nexus:thermal] ⚠️ ${unavailCount} entidades no disponibles`);
      state.nexusHealth._thermal_warned = true;
      nexusSaveHealth(state.nexusHealth);
    } else if (unavailCount < 5 && state.nexusHealth._thermal_warned) {
      console.log('[nexus:thermal] Sistema recuperado');
      state.nexusHealth._thermal_warned = false;
      nexusSaveHealth(state.nexusHealth);
    }
  } catch { /* silencioso */ }
}

module.exports = {
  nexusLoadHealth, nexusSaveHealth,
  nexusReloadDynamic,
  nexusGetScore, nexusUpdateHealth,
  nexusEvolutionTick, nexusWatchers,
  NEXUS_HEALTH_DIR, NEXUS_HEALTH_FILE,
};
