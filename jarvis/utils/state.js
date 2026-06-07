'use strict';
// ── Estado compartido mutable de Jarvis ──────────────────────────────────────
// Este módulo exporta UN SOLO OBJETO que todos los módulos comparten.
// Al ser un objeto por referencia en Node.js, las mutaciones son visibles
// en todos los módulos que lo importen — equivalente a las variables globales
// del monolito original, sin cambiar comportamiento.

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
  saverMode: false,

  // ── NEXUS dinámico ───────────────────────────────────────────────────────
  dynamicExperts: {},
  dynamicModules: {},
  nexusHealth: {},

  // ── Uso de API ───────────────────────────────────────────────────────────
  apiUsage: {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    lastReset: new Date().toISOString()
  },

  // ── Logs internos (ring buffer) ──────────────────────────────────────────
  internalLogs: [],

  // ── SSE / push en tiempo real ────────────────────────────────────────────
  currentSendEvent: null,
  pendingLocalRequests: new Map(),
  pushClients: new Set(),

  // ── Tareas programadas ───────────────────────────────────────────────────
  scheduledTasks: {},

  // ── Versión ──────────────────────────────────────────────────────────────
  JARVIS_VERSION: '3.33.15',
};

module.exports = state;
