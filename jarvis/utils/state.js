'use strict';
// ── Estado compartido mutable de Jarvis ──────────────────────────────────────
// Este módulo exporta UN SOLO OBJETO que todos los módulos comparten.
// Al ser un objeto por referencia en Node.js, las mutaciones son visibles
// en todos los módulos que lo importen — equivalente a las variables globales
// del monolito original, sin cambiar comportamiento.

const fs = require('fs');
const { API_USAGE_FILE } = require('./constants');

// ── Cost-guard persistente ────────────────────────────────────────────────────
// apiUsage vivía solo en memoria y se reseteaba en cada reinicio del proceso
// (self-update cada 2min, auto-repair, reinicios manuales durante desarrollo),
// lo que anulaba el límite de gasto diario (DAILY_COST_LIMIT). Ahora se
// restaura desde disco al arrancar si el registro es de HOY; si es de un día
// anterior, se arranca en cero (igual que haría el reset de medianoche).
function loadPersistedApiUsage() {
  const fresh = {
    calls: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0, costUSD: 0,
    lastReset: new Date().toISOString()
  };
  try {
    if (fs.existsSync(API_USAGE_FILE)) {
      const persisted = JSON.parse(fs.readFileSync(API_USAGE_FILE, 'utf8'));
      const sameDay = persisted.apiUsage?.lastReset &&
        new Date(persisted.apiUsage.lastReset).toDateString() === new Date().toDateString();
      if (sameDay) {
        console.log(`[cost-guard] Uso de API restaurado tras reinicio: $${(persisted.apiUsage.costUSD || 0).toFixed(4)} gastados hoy (saverMode=${!!persisted.saverMode})`);
        return { apiUsage: persisted.apiUsage, saverMode: !!persisted.saverMode };
      }
    }
  } catch (e) {
    console.log(`[cost-guard] Error restaurando uso de API: ${e.message}`);
  }
  return { apiUsage: fresh, saverMode: false };
}

const _restoredUsage = loadPersistedApiUsage();

const state = {
  // ── Persistencia en memoria ──────────────────────────────────────────────
  userMemory: [],
  conversationHistory: [],
  learnings: [],
  installationMap: {},

  // ── Contexto de la casa ──────────────────────────────────────────────────
  houseContext: '',
  liveContext: null,

  // ── Caché de entidades HA ────────────────────────────────────────────────
  entitiesCache: null,
  entityCache: null,          // caché 3D map / background

  // ── Modos de operación ───────────────────────────────────────────────────
  saverMode: _restoredUsage.saverMode,
  lastUserActivity: Date.now(), // ms — se actualiza en cada mensaje del usuario

  // ── NEXUS dinámico ───────────────────────────────────────────────────────
  dynamicExperts: {},
  dynamicModules: {},
  nexusHealth: {},

  // ── Uso de API (restaurado de disco si es de hoy — ver loadPersistedApiUsage) ──
  apiUsage: _restoredUsage.apiUsage,

  // ── Logs internos (ring buffer) ──────────────────────────────────────────
  internalLogs: [],

  // ── SSE / push en tiempo real ────────────────────────────────────────────
  currentSendEvent: null,
  pendingLocalRequests: new Map(),
  pushClients: new Set(),

  // ── Tareas programadas ───────────────────────────────────────────────────
  scheduledTasks: {},

  // ── Versión ──────────────────────────────────────────────────────────────
  JARVIS_VERSION: '3.36.4',
};

module.exports = state;
