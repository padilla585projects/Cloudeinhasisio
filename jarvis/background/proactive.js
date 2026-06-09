'use strict';
const path = require('path');
const fetch = require('node-fetch');
const { callLLM } = require('../utils/llm');
const { loadJSON, saveJSON } = require('../utils/persistence');
const { haGet, haPost } = require('../utils/ha-api');
const C = require('../utils/constants');
const state = require('../utils/state');

const PROACTIVE_STATE_FILE = path.join(C.DATA_DIR, 'proactive_state.json');

// ── Toolset del modo autónomo ─────────────────────────────────────────────────
// Bajo riesgo (Jarvis las ejecuta solo): lectura, diagnóstico, recargas, backups.
// Riesgo alto (NUNCA en autónomo, debe PROPONER con proactive_thought): instalar
// HACS, borrar, escribir ficheros críticos, exec, push, update_self, usuarios.
const ALWAYS_TOOLS = [
  'get_entities', 'get_entity_state', 'search_entities', 'get_history', 'get_logbook',
  'ha_knowledge', 'get_memory', 'template_render',
  'call_service', 'reload_config', 'save_memory', 'learn', 'proactive_thought',
];
const FOCUS_TOOLS = {
  system_health: ['get_system_logs', 'get_error_log', 'get_repairs', 'get_notifications', 'ha_supervisor', 'scan_installation', 'check_config', 'score_installation'],
  fallen_devices: ['get_system_logs', 'get_error_log', 'scan_installation', 'get_repairs', 'ha_supervisor', 'check_config', 'network'],
  dashboard: ['get_dashboards', 'get_dashboard_config', 'review_dashboard', 'get_installed_frontend', 'update_dashboard', 'search_hacs_resources'],
  security_maintenance: ['get_repairs', 'get_notifications', 'get_system_logs', 'ha_supervisor', 'scan_installation', 'get_logbook'],
  optimization: ['get_system_logs', 'scan_installation', 'check_config', 'get_repairs', 'score_installation', 'get_automations', 'simulate_automation', 'create_automation'],
};
const FOCUS_ORDER = ['system_health', 'fallen_devices', 'dashboard', 'security_maintenance', 'optimization'];

const FOCUS_BRIEF = {
  system_health: `FOCO: SALUD DEL SISTEMA. Revisa errores en logs (get_error_log/get_system_logs), reparaciones pendientes (get_repairs), notificaciones persistentes (get_notifications), estado del supervisor y add-ons (ha_supervisor), y puntúa la instalación (score_installation). Arregla lo que puedas (recargar integraciones, limpiar notificaciones obsoletas). Para lo que no puedas, propón la solución EXACTA.`,
  fallen_devices: `FOCO: DISPOSITIVOS CAÍDOS (RAÍZ, no parches). Hay muchas entidades 'unavailable'. NO te limites a recargar a ciegas. Investiga la CAUSA: agrupa por integración/dispositivo, mira config_entries y logs para ver si la integración está caída, el dispositivo físico offline, o la entidad es huérfana (entidad de una integración borrada). Recarga SOLO integraciones que el log confirme caídas. Para dispositivos físicos offline o entidades huérfanas, propón la acción concreta (revisar hardware X / borrar entidad huérfana Y).`,
  dashboard: `FOCO: DASHBOARD. Lee la config (get_dashboards/get_dashboard_config), evalúala (review_dashboard) y detecta frontend instalado (get_installed_frontend). Si está desorganizado o vacío, MEJÓRALO de verdad con update_dashboard (hace backup automático): vistas por habitación, cards útiles para los sensores/dispositivos reales que existen. Si falta una card de HACS que aportaría mucho, PROPÓN instalarla (no la instales tú).`,
  security_maintenance: `FOCO: SEGURIDAD Y MANTENIMIENTO. Revisa: backups (¿hay recientes?), updates pendientes (get_repairs/entidades update.*), salud de cámaras/cerraduras/alarmas, integraciones rotas, y configuraciones expuestas. Avisa de riesgos reales con prioridad alta. Arregla lo seguro; propón lo demás con pasos concretos.`,
  optimization: `FOCO: OPTIMIZACIÓN Y FLUIDEZ. Busca por qué el sistema puede ir lento: integraciones que sondean en exceso, automatizaciones que fallan o se disparan demasiado (get_automations + logs), tamaño del recorder/DB, entidades muertas. Propón o aplica mejoras de rendimiento concretas. Si detectas una automatización claramente útil y sensata para el hogar real, créala con YAML completo y válido.`,
};

function pushToAll(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of state.pushClients) {
    try { res.write(line); } catch { state.pushClients.delete(res); }
  }
}

function pickFocus() {
  const st = loadJSON(PROACTIVE_STATE_FILE, { focusIndex: 0, runs: 0 });
  const focus = FOCUS_ORDER[st.focusIndex % FOCUS_ORDER.length];
  st.focusIndex = (st.focusIndex + 1) % FOCUS_ORDER.length;
  st.runs = (st.runs || 0) + 1;
  st.lastRun = new Date().toISOString();
  st.lastFocus = focus;
  saveJSON(PROACTIVE_STATE_FILE, st);
  return focus;
}

function scopedTools(focus) {
  const names = new Set([...ALWAYS_TOOLS, ...(FOCUS_TOOLS[focus] || [])]);
  return state.openAITools.filter(t => names.has(t.function.name));
}

// Auto-fix previo: si hay caída masiva simultánea, recargar integraciones reloadables.
async function autoFixMassCrash(unavailable) {
  const log = [];
  try {
    const configEntries = await haGet('/config/config_entries').catch(() => []);
    const reloadDomains = ['alexa_media_player', 'pvpc_energyhourly', 'tp_link', 'rest', 'reolink', 'alfa_romeo', 'awattar', 'mqtt'];
    const zigbeeDown = unavailable.filter(e =>
      e.entity_id.startsWith('light.') || e.entity_id.startsWith('sensor.') ||
      e.entity_id.startsWith('binary_sensor.') || e.entity_id.startsWith('switch.'));
    if (zigbeeDown.length > 3) {
      try {
        await fetch('http://supervisor/addons/45df7312_zigbee2mqtt/restart', {
          method: 'POST',
          headers: { Authorization: `Bearer ${C.HA_TOKEN}`, 'Content-Type': 'application/json' }
        });
        log.push(`Zigbee2MQTT reiniciado (${zigbeeDown.length} entidades Zigbee caídas)`);
        await new Promise(r => setTimeout(r, 8000));
      } catch (e) { log.push(`Zigbee2MQTT restart falló: ${e.message}`); }
    }
    for (const domain of reloadDomains) {
      for (const entry of configEntries.filter(e => e.domain === domain)) {
        try {
          await haPost('/services/homeassistant/reload_config_entry', { entry_id: entry.entry_id });
          log.push(`Recargada integración ${entry.title || domain}`);
        } catch { /* ignora individuales */ }
      }
    }
    if (log.length) await new Promise(r => setTimeout(r, 4000));
  } catch (e) { log.push(`auto-fix error: ${e.message}`); }
  return log;
}

async function gatherSeed(focus) {
  const states = await haGet('/states');
  const unavailable = states.filter(e =>
    e.state === 'unavailable' &&
    !e.entity_id.startsWith('automation.') &&
    !e.entity_id.startsWith('update.'));

  const now = new Date();
  const hora = now.getHours();
  let momento = 'madrugada';
  if (hora >= 7 && hora < 12) momento = 'mañana';
  else if (hora >= 12 && hora < 15) momento = 'mediodía';
  else if (hora >= 15 && hora < 20) momento = 'tarde';
  else if (hora >= 20) momento = 'noche';

  // Agrupar caídos por integración (heurística sobre el entity_id/atributos)
  const groups = {};
  for (const e of unavailable) {
    let g = 'otros';
    const id = e.entity_id;
    if (id.includes('shuffle') || id.includes('repeat') || id.startsWith('media_player.echo')) g = 'alexa';
    else if (id.startsWith('sensor.omv_') || id.startsWith('binary_sensor.omv_')) g = 'omv_nas';
    else if (id.includes('esp_') || id.includes('esphome')) g = 'esphome';
    else if (id.includes('pvpc') || id.includes('esios')) g = 'energia';
    else if (id.includes('reolink') || id.includes('camera')) g = 'camaras';
    else if (id.startsWith('light.') || id.startsWith('binary_sensor.') || id.startsWith('switch.') || id.startsWith('sensor.')) g = 'zigbee_o_sensores';
    (groups[g] = groups[g] || []).push(e.attributes?.friendly_name || id);
  }

  // ¿Caída masiva simultánea?
  let massCrash = '';
  if (unavailable.length > 5) {
    const ts = unavailable.map(e => new Date(e.last_changed).getTime());
    if (Math.max(...ts) - Math.min(...ts) < 3 * 60_000) {
      massCrash = `CAÍDA MASIVA: ${unavailable.length} entidades cayeron en <3min (~${new Date(Math.min(...ts)).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}). Probable reinicio de HA o corte de red.`;
    }
  }

  let seed = `Momento: ${momento} (${now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}). Total entidades: ${states.length}.
Entidades NO disponibles: ${unavailable.length}` +
    (unavailable.length ? `\n  Por grupo: ${Object.entries(groups).map(([g, l]) => `${g}(${l.length})`).join(', ')}` : '') +
    (massCrash ? `\n${massCrash}` : '');

  if (state.userMemory?.length) {
    seed += `\n\nMEMORIA DEL USUARIO (preferencias reales):\n${state.userMemory.slice(-8).map(m => `- (${m.category}) ${m.note}`).join('\n')}`;
  }

  return { seed, unavailable };
}

async function proactiveThinkingLoop() {
  try {
    if (!C.ANTHROPIC_API_KEY && !C.OPENAI_API_KEY) return;

    const focus = pickFocus();
    console.log(`[proactive] Ciclo autónomo — foco: ${focus}`);

    const { seed, unavailable } = await gatherSeed(focus);

    // Pensamientos ya registrados (para reforzar el NO-repetir — todos, no solo los últimos)
    const existing = loadJSON(path.join(C.DATA_DIR, 'pending_thoughts.json'), [])
      .filter(t => t.status === 'pending');
    const recentTitles = existing.map(t => `- ${t.title}`).join('\n');

    // Auto-fix de caída masiva antes de pensar (solo en focos relevantes)
    let autoFixLog = [];
    if ((focus === 'fallen_devices' || focus === 'system_health') && unavailable.length > 5) {
      autoFixLog = await autoFixMassCrash(unavailable);
      if (autoFixLog.length) console.log(`[proactive] auto-fix: ${autoFixLog.join(' | ')}`);
    }

    const model = state.saverMode ? C.BG_MODEL : C.MODEL;

    const system = `Eres Jarvis: un ingeniero domótico experto que vigila esta casa 24/7. No eres un chatbot — eres autónomo y RESUELVES.

REGLAS DE ORO:
1. ACTÚA, no solo describas. Si algo de bajo riesgo está roto y puedes arreglarlo con tus tools (recargar integración, limpiar notificación, reorganizar dashboard con backup), HAZLO ahora. Luego reporta con proactive_thought lo que hiciste.
2. Lo de ALTO riesgo (instalar HACS, borrar, tocar ficheros críticos, reiniciar el host) NO lo ejecutas: lo PROPONES con proactive_thought incluyendo los pasos exactos.
3. Cada proactive_thought debe ser CONCRETO y ACCIONABLE. Si propones una automatización, incluye el YAML completo (trigger/condition/action) en 'detail'. Prohibido el relleno vago tipo "se sugiere optimizar el consumo".
4. NO repitas ideas que ya existen (te paso la lista). Si tu conclusión es la misma de siempre, no la registres.
5. Si tras investigar NO hay nada útil y nuevo que aportar en este foco, responde solo "OK" sin registrar nada. Es perfectamente válido no encontrar nada.
6. Prioridad: arreglar roto > seguridad > optimización/fluidez > mejoras estéticas.
7. Investiga primero con las tools de lectura, diagnostica, y SOLO entonces actúa o propone. Idioma: español. Sé directo y técnico.`;

    let userPrompt = `${FOCUS_BRIEF[focus]}\n\nESTADO ACTUAL:\n${seed}\n`;
    if (autoFixLog.length) userPrompt += `\nYA EJECUTÉ AUTOMÁTICAMENTE (antes de pensar):\n${autoFixLog.map(l => `- ${l}`).join('\n')}\nMenciónalo si es relevante.\n`;
    userPrompt += `\nIDEAS YA REGISTRADAS (NO repetir nada parecido a esto):\n${recentTitles || '(ninguna)'}\n\nInvestiga este foco con tus tools, actúa en lo seguro y reporta/propón lo demás. Si no hay nada nuevo, di "OK".`;

    const tools = scopedTools(focus);
    let messages = [{ role: 'user', content: userPrompt }];
    const MAX_ITER = 5;
    let actions = 0;

    for (let iter = 0; iter < MAX_ITER; iter++) {
      let result;
      try {
        result = await callLLM(model, system, messages, tools, 1500);
      } catch (err) {
        console.log(`[proactive] Error API iter=${iter}: ${err.message}`);
        break;
      }

      if (result.toolCalls.length === 0) break; // terminó (texto/"OK")

      messages.push(result.message);
      const results = [];
      for (const tc of result.toolCalls) {
        try {
          const r = await Promise.race([
            state.executeTool(tc.name, tc.input),
            new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout 45s`)), 45000)),
          ]);
          results.push(r);
          actions++;
        } catch (e) {
          results.push({ error: e.message });
        }
      }
      for (let i = 0; i < result.toolCalls.length; i++) {
        const raw = JSON.stringify(results[i]);
        messages.push({
          role: 'tool',
          tool_call_id: result.toolCalls[i].id,
          content: raw.length > 2000 ? raw.slice(0, 2000) + '…[truncado]' : raw,
        });
      }

      // tracking centralizado en llm.js
    }

    console.log(`[proactive] Foco ${focus} completado. ${actions} acciones de tool.`);
    pushToAll({ type: 'proactive_cycle', focus, actions, ts: new Date().toISOString() });
  } catch (err) {
    console.log(`[proactive] Error: ${err.message}`);
  }
}

module.exports = { proactiveThinkingLoop };
