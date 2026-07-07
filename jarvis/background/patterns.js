'use strict';
const path = require('path');
const { callLLM } = require('../utils/llm');
const { loadJSON, saveJSON } = require('../utils/persistence');
const { haGet } = require('../utils/ha-api');
const C = require('../utils/constants');
const state = require('../utils/state');

const PATTERNS_FILE = path.join(C.DATA_DIR, 'state_snapshots.json');
const ROUTINES_FILE = path.join(C.DATA_DIR, 'detected_routines.json');

async function captureStateSnapshot() {
  try {
    const states = await haGet('/states');
    const now = new Date();

    // Capturar solo lo relevante para detectar rutinas
    const snapshot = {
      ts: now.toISOString(),
      hour: now.getHours(),
      minute: now.getMinutes(),
      dayOfWeek: now.getDay(), // 0=domingo
      lights: states.filter(e => e.entity_id.startsWith('light.') && e.state === 'on')
        .map(e => e.entity_id),
      switches: states.filter(e => e.entity_id.startsWith('switch.') && e.state === 'on')
        .map(e => e.entity_id),
      climate: states.filter(e => e.entity_id.startsWith('climate.'))
        .map(e => ({ id: e.entity_id, state: e.state, temp: e.attributes?.current_temperature })),
      media: states.filter(e => e.entity_id.startsWith('media_player.') && e.state === 'playing')
        .map(e => ({ id: e.entity_id, source: e.attributes?.media_title || e.attributes?.source })),
      presence: states.filter(e => e.entity_id.startsWith('person.'))
        .map(e => ({ id: e.entity_id, state: e.state })),
      covers: states.filter(e => e.entity_id.startsWith('cover.'))
        .map(e => ({ id: e.entity_id, state: e.state }))
    };

    // Guardar en array (máx 1000 snapshots = ~7 días a 10min)
    let snapshots = loadJSON(PATTERNS_FILE, []);
    snapshots.push(snapshot);
    if (snapshots.length > 1000) snapshots = snapshots.slice(-1000);
    saveJSON(PATTERNS_FILE, snapshots);

  } catch (err) {
    console.log(`[patterns] Error capturando snapshot: ${err.message}`);
  }
}

async function analyzePatterns() {
  try {
    if (!C.ANTHROPIC_API_KEY) return;

    const snapshots = loadJSON(PATTERNS_FILE, []);
    if (snapshots.length < 50) {
      console.log(`[patterns] Solo ${snapshots.length} snapshots, necesito al menos 50 para analizar.`);
      return;
    }

    console.log(`[patterns] Analizando ${snapshots.length} snapshots para detectar rutinas...`);

    // Agrupar por hora del día para detectar patrones
    const byHour = {};
    for (const snap of snapshots) {
      const h = snap.hour;
      if (!byHour[h]) byHour[h] = [];
      byHour[h].push(snap);
    }

    // Generar resumen estadístico (no enviar todos los snapshots a Claude)
    let summary = 'ANÁLISIS DE ACTIVIDAD DEL HOGAR (snapshots cada 10min):\n\n';

    for (let h = 0; h < 24; h++) {
      const hourSnaps = byHour[h] || [];
      if (hourSnaps.length === 0) continue;

      // Entidades más frecuentes encendidas a esa hora
      const lightFreq = {};
      const switchFreq = {};
      let presenceHome = 0;
      let mediaPlaying = 0;

      for (const snap of hourSnaps) {
        for (const l of snap.lights) { lightFreq[l] = (lightFreq[l] || 0) + 1; }
        for (const s of snap.switches) { switchFreq[s] = (switchFreq[s] || 0) + 1; }
        if (snap.presence.some(p => p.state === 'home')) presenceHome++;
        if (snap.media.length > 0) mediaPlaying++;
      }

      const total = hourSnaps.length;
      const topLights = Object.entries(lightFreq).filter(([,c]) => c > total * 0.5).map(([id, c]) => `${id}(${Math.round(c/total*100)}%)`);
      const topSwitches = Object.entries(switchFreq).filter(([,c]) => c > total * 0.5).map(([id, c]) => `${id}(${Math.round(c/total*100)}%)`);

      if (topLights.length > 0 || topSwitches.length > 0 || presenceHome > total * 0.3) {
        summary += `${String(h).padStart(2,'0')}:00 — `;
        if (presenceHome > 0) summary += `casa:${Math.round(presenceHome/total*100)}% `;
        if (topLights.length > 0) summary += `luces:[${topLights.slice(0, 3).join(', ')}] `;
        if (topSwitches.length > 0) summary += `switches:[${topSwitches.slice(0, 3).join(', ')}] `;
        if (mediaPlaying > total * 0.3) summary += `media:${Math.round(mediaPlaying/total*100)}% `;
        summary += '\n';
      }
    }

    // Rutinas ya detectadas (para no repetir)
    const existingRoutines = loadJSON(ROUTINES_FILE, []);
    const existingTitles = existingRoutines.map(r => r.title).join(', ');

    summary += `\nRUTINAS YA DETECTADAS: ${existingTitles || '(ninguna todavía)'}\n`;
    summary += `\nDatos: ${snapshots.length} snapshots en ${Math.round((Date.now() - new Date(snapshots[0].ts).getTime()) / 3600_000)}h\n`;

    const patternToolNames = ['proactive_thought', 'save_memory', 'learn'];
    const patternTools = state.openAITools.filter(t => patternToolNames.includes(t.function.name));

    let patResult;
    try {
      patResult = await callLLM(C.BG_MODEL, 'Eres Jarvis analizando patrones de vida del hogar. Detecta rutinas de los habitantes. Si encuentras un patrón claro y accionable (se podría automatizar), usa proactive_thought para sugerir la automatización. Si detectas algo que memorizar, usa save_memory. Solo patrones CLAROS con >60% de consistencia. Español. Breve.', [{ role: 'user', content: summary }], patternTools, 600);
    } catch (err) {
      console.log(`[patterns] Error API: ${err.message}`);
      return;
    }

    for (const tc of patResult.toolCalls) {
      await state.executeTool(tc.name, tc.input);
      if (tc.name === 'proactive_thought') {
        existingRoutines.push({ title: tc.input.title, detectedAt: new Date().toISOString(), detail: tc.input.detail });
        saveJSON(ROUTINES_FILE, existingRoutines.slice(-50));
      }
    }

    console.log(`[patterns] Análisis completo. ${patResult.toolCalls.length} patrones/acciones detectados.`);
  } catch (err) {
    console.log(`[patterns] Error: ${err.message}`);
  }
}

module.exports = { captureStateSnapshot, analyzePatterns };
