'use strict';
// ── NEXUS L0-L4 — Sistema de capas de prompt ─────────────────────────────────
//
// El prompt del sistema se divide en 5 capas con diferente frecuencia de cambio:
//
//  L0  IDENTIDAD ESTÁTICA    Quién es Jarvis. Nunca cambia. Cacheable en Anthropic.
//  L1  DOMINIO DEL EXPERTO   Módulos de conocimiento del experto activo.
//                            Cambia al cambiar de experto.
//  L2  CONTEXTO DINÁMICO     Memoria, learnings, pensamientos pendientes.
//                            Cambia con cada interacción del usuario.
//  L3  ESTADO LIVE           Estado actual de HA (sensores, dispositivos).
//                            Cambia con cada request.
//  L4  CATÁLOGO DE TOOLS     Solo las tools que usa este experto (scoped).
//                            Cambia al cambiar de experto.
//
// Para OpenAI:    systemPrompt = join(L0..L4)
// Para Anthropic: L0+L1 marcados con cache_control = { type: 'ephemeral' }
//                 L2+L3+L4 sin cache (cambian cada request)
// ─────────────────────────────────────────────────────────────────────────────

const state = require('../utils/state');
const { EXPERTS } = require('./experts');

// Lazy-loads para evitar ciclos
function getModules()  { return require('./modules');  }
function getHealth()   { return require('./health');   }
function getToolDefs() { return require('../tools/definitions'); }

// ── L0 — Identidad estática ───────────────────────────────────────────────────
// Se extrae del módulo 'base' + 'inamovible' (siempre presentes, nunca mutados).

function buildL0() {
  const { NEXUS_MODULES } = getModules();
  const parts = [];
  if (NEXUS_MODULES.base)      parts.push(NEXUS_MODULES.base);
  if (NEXUS_MODULES.inamovible) parts.push(NEXUS_MODULES.inamovible);
  return parts.join('\n\n');
}

// ── L1 — Dominio del experto ──────────────────────────────────────────────────

function buildL1(expertName) {
  const { NEXUS_MODULES } = getModules();
  const all = { ...EXPERTS, ...state.dynamicExperts };
  const expert = all[expertName] || EXPERTS.ha_control;
  const l0Modules = new Set(['base', 'inamovible']);
  const parts = expert.modules
    .filter(m => !l0Modules.has(m))
    .map(m => NEXUS_MODULES[m] || state.dynamicModules[m] || '')
    .filter(Boolean);
  let layer = parts.join('\n\n');
  if (state.dynamicExperts[expertName]) layer += `\n\n[Experto dinámico: ${expert.label}]`;
  return layer;
}

// ── L2 — Contexto dinámico (memoria, learnings, pensamientos) ─────────────────
// Se reutiliza buildDynamicContext() del módulo context.js

function buildL2() {
  const { buildDynamicContext } = require('../utils/context');
  return buildDynamicContext();
}

// ── L3 — Estado live de HA ───────────────────────────────────────────────────

function buildL3() {
  if (!state.liveContext) return '';
  return '\n\n' + state.liveContext;
}

// ── L4 — Catálogo de tools (scoped) ──────────────────────────────────────────

function buildL4(expertName) {
  const { tools } = getToolDefs();
  const all = { ...EXPERTS, ...state.dynamicExperts };
  const expert = all[expertName] || EXPERTS.ha_control;
  // undefined = todas | [] = ninguna | [...] = scoped
  const visible = expert.tools === undefined
    ? tools
    : expert.tools.length === 0
      ? []
      : tools.filter(t => new Set(expert.tools).has(t.name));

  let layer = `\nHERRAMIENTAS DISPONIBLES (${visible.length} de ${tools.length}):\n`;
  layer += visible.map(t => `- ${t.name}: ${t.description.split('.')[0]}`).join('\n');
  return layer;
}

// ── Ensamblado completo ───────────────────────────────────────────────────────

/**
 * Devuelve el prompt de sistema completo para un experto.
 * Para OpenAI: string único.
 */
function assembleSystemPrompt(expertName) {
  const L0 = buildL0();
  const L1 = buildL1(expertName);
  // L2 (buildDynamicContext) YA incluye el estado en vivo ("ESTADO EN TIEMPO REAL"):
  // añadir además L3 lo mandaba dos veces en cada petición.
  const L2 = buildL2();
  const L4 = buildL4(expertName);
  return [L0, L1, L2, L4].filter(Boolean).join('\n\n');
}

/**
 * Prompt de sistema ESTABLE para el pool local (prefijo cacheable).
 * L0 + L1 + contexto que cambia poco. Sin hora, sin nº de mensajes, sin estado en
 * vivo y sin el catálogo L4 (repite lo que ya dice el esquema de las tools, que
 * van aparte). Lo volátil viaja en el mensaje del usuario (ver buildTurnSnapshot).
 * Mientras la memoria/reglas no cambien, el resultado es idéntico byte a byte.
 */
function assembleStaticPrompt(expertName) {
  const { buildStableContext } = require('../utils/context');
  const L0 = buildL0();
  const L1 = buildL1(expertName);
  return [L0, L1, buildStableContext()].filter(Boolean).join('\n\n');
}

/**
 * Devuelve las openAITools filtradas al scope del experto.
 * @param {string} expertName
 * @param {Array}  allOpenAITools — lista completa de tools en formato OpenAI
 */
function getScopedTools(expertName, allOpenAITools) {
  const all = { ...EXPERTS, ...state.dynamicExperts };
  const expert = all[expertName] || EXPERTS.ha_control;
  if (expert.tools === undefined) return allOpenAITools;  // undefined = todas las tools
  if (expert.tools.length === 0) return [];               // [] = ninguna tool (ej: razonamiento R1)
  const allowed = new Set(expert.tools);
  return allOpenAITools.filter(t => allowed.has(t.function.name));
}

/**
 * Stats de un experto para logs.
 */
function layerStats(expertName) {
  const all = { ...EXPERTS, ...state.dynamicExperts };
  const expert = all[expertName] || EXPERTS.ha_control;
  const { tools } = getToolDefs();
  const visible = expert.tools === undefined
    ? tools
    : expert.tools.length === 0
      ? []
      : tools.filter(t => new Set(expert.tools).has(t.name));
  return {
    expert: expertName,
    model: expert.model,
    modules: (expert.modules || []).length,
    tools: visible.length,
    toolsTotal: tools.length,
    reduction: expert.tools !== undefined ? Math.round((1 - visible.length / tools.length) * 100) + '%' : '0%'
  };
}

module.exports = {
  buildL0, buildL1, buildL2, buildL3, buildL4,
  assembleSystemPrompt,
  assembleStaticPrompt,
  getScopedTools,
  layerStats
};
