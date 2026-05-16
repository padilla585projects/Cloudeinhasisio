'use strict';
const { MODEL, BG_MODEL } = require('../utils/constants');

// ── Configuración de expertos NEXUS ──────────────────────────────────────────
// Cada experto define: modelo, tokens, iteraciones máximas, módulos activos.

const EXPERTS = {
  rapido: {
    model: BG_MODEL, maxTokens: 2048, maxIter: 6,
    modules: ['base', 'autonomy', 'optimization'],
    label: 'Rápido'
  },
  ha_control: {
    model: MODEL, maxTokens: 6144, maxIter: 15,
    modules: ['base', 'philosophy', 'ha_control', 'ha_internals', 'ha_config_engineering', 'autonomy', 'optimization', 'filesystem', 'inamovible'],
    label: 'Control HA'
  },
  diagnostico: {
    model: MODEL, maxTokens: 8192, maxIter: 20,
    modules: ['base', 'perseverance', 'ha_control', 'ha_internals', 'ha_config_engineering', 'diagnostico', 'optimization', 'filesystem', 'inamovible'],
    label: 'Diagnóstico'
  },
  automatizacion: {
    model: MODEL, maxTokens: 8192, maxIter: 15,
    modules: ['base', 'philosophy', 'automation', 'ha_internals', 'ha_config_engineering', 'ha_control', 'optimization', 'filesystem', 'inamovible'],
    label: 'Automatización'
  },
  archivo: {
    model: MODEL, maxTokens: 4096, maxIter: 10,
    modules: ['base', 'ha_config_engineering', 'filesystem', 'autonomy', 'optimization', 'inamovible'],
    label: 'Archivos'
  },
  emergencia: {
    model: MODEL, maxTokens: 8192, maxIter: 20,
    modules: ['base', 'perseverance', 'emergency', 'ha_config_engineering', 'diagnostico', 'ha_internals', 'ha_control', 'optimization', 'filesystem', 'inamovible'],
    label: 'Emergencia'
  },
  dev: {
    model: MODEL, maxTokens: 8192, maxIter: 20,
    modules: ['base', 'philosophy', 'dev', 'ha_internals', 'ha_config_engineering', 'filesystem', 'autonomy', 'optimization', 'inamovible'],
    label: 'Desarrollo'
  },
  multimedia: {
    model: MODEL, maxTokens: 4096, maxIter: 10,
    modules: ['base', 'autonomy', 'multimedia', 'ha_control', 'optimization', 'filesystem', 'inamovible'],
    label: 'Multimedia'
  },
  energia: {
    model: MODEL, maxTokens: 6144, maxIter: 15,
    modules: ['base', 'autonomy', 'energia', 'ha_control', 'optimization', 'filesystem', 'inamovible'],
    label: 'Energía'
  },
  seguridad: {
    model: MODEL, maxTokens: 6144, maxIter: 15,
    modules: ['base', 'autonomy', 'seguridad_casa', 'ha_control', 'diagnostico', 'optimization', 'filesystem', 'inamovible'],
    label: 'Seguridad'
  },
  red: {
    model: MODEL, maxTokens: 6144, maxIter: 15,
    modules: ['base', 'perseverance', 'red_infra', 'proxmox', 'diagnostico', 'optimization', 'filesystem', 'inamovible'],
    label: 'Red e Infra'
  },
  aprendizaje: {
    model: MODEL, maxTokens: 6144, maxIter: 15,
    modules: ['base', 'autonomy', 'aprendizaje', 'ha_control', 'optimization', 'filesystem', 'inamovible'],
    label: 'Aprendizaje'
  }
};

module.exports = { EXPERTS };
