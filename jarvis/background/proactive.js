'use strict';
const path = require('path');
const fetch = require('node-fetch');
const { callOpenAI } = require('../utils/llm');
const { loadJSON, saveJSON } = require('../utils/persistence');
const { haGet, haPost } = require('../utils/ha-api');
const C = require('../utils/constants');
const state = require('../utils/state');

function pushToAll(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of state.pushClients) {
    try { res.write(line); } catch { state.pushClients.delete(res); }
  }
}

async function proactiveThinkingLoop() {
  try {
    if (!C.OPENAI_API_KEY) return;
    console.log('[proactive] Jarvis pensando...');

    // Recopilar TODO el contexto
    const states = await haGet('/states');

    // Estado general
    const unavailable = states.filter(e =>
      e.state === 'unavailable' &&
      !e.entity_id.startsWith('automation.') &&
      !e.entity_id.startsWith('update.')
    );
    const lightsOn = states.filter(e => e.entity_id.startsWith('light.') && e.state === 'on');
    const switchesOn = states.filter(e => e.entity_id.startsWith('switch.') && e.state === 'on');
    const climates = states.filter(e => e.entity_id.startsWith('climate.'));
    const automations = states.filter(e => e.entity_id.startsWith('automation.'));
    const automationsOff = automations.filter(e => e.state === 'off');

    // Agrupar unavailable por integración (para diagnóstico inteligente)
    const unavailableGroups = {};
    for (const e of unavailable) {
      let group = 'otros';
      if (e.entity_id.includes('shuffle') || e.entity_id.includes('repeat') || e.entity_id.startsWith('media_player.echo')) group = 'alexa';
      else if (e.entity_id.startsWith('sensor.omv_') || e.entity_id.startsWith('binary_sensor.omv_')) group = 'omv_nas';
      else if (e.entity_id.includes('esp_') || e.entity_id.includes('esphome')) group = 'esphome';
      else if (e.entity_id.includes('pvpc') || e.entity_id.includes('esios') || e.entity_id.includes('energy_cost')) group = 'energia';
      else if (e.entity_id.includes('archer') || e.entity_id.includes('router')) group = 'router';
      else if (e.entity_id.includes('giulietta') || e.entity_id.includes('_car_')) group = 'coche';
      else if (e.attributes?.via_device || e.attributes?.manufacturer === 'IKEA' || e.attributes?.manufacturer === 'Philips' || String(e.attributes?.via_device || '').length > 0) group = 'zigbee';
      else if (e.entity_id.startsWith('light.') || e.entity_id.startsWith('sensor.') || e.entity_id.startsWith('binary_sensor.') || e.entity_id.startsWith('switch.')) group = 'zigbee';
      if (!unavailableGroups[group]) unavailableGroups[group] = [];
      unavailableGroups[group].push(e.attributes?.friendly_name || e.entity_id);
    }
    const zigbeeUnavailable = unavailableGroups['zigbee'] || [];

    // Detectar patrón de caída masiva (mismo timestamp ±2min)
    let massCrashInfo = '';
    if (unavailable.length > 5) {
      const timestamps = unavailable.map(e => new Date(e.last_changed).getTime());
      const minT = Math.min(...timestamps);
      const maxT = Math.max(...timestamps);
      if (maxT - minT < 3 * 60_000) {
        const crashTime = new Date(minT).toLocaleTimeString('es-ES', {hour:'2-digit', minute:'2-digit'});
        massCrashInfo = `ALERTA: ${unavailable.length} dispositivos cayeron todos a las ${crashTime} (en menos de 3 min). Esto indica reinicio de HA o caída de red a esa hora.`;
      }
    }

    // Hora y contexto temporal
    const now = new Date();
    const hora = now.getHours();
    let momento = 'madrugada';
    if (hora >= 7 && hora < 12) momento = 'mañana';
    else if (hora >= 12 && hora < 15) momento = 'mediodía';
    else if (hora >= 15 && hora < 20) momento = 'tarde';
    else if (hora >= 20 && hora < 24) momento = 'noche';

    // Leer errores recientes
    let recentErrors = '';
    try {
      const logRes = await fetch('http://supervisor/core/logs', {
        headers: { Authorization: `Bearer ${C.HA_TOKEN}` }
      });
      if (logRes.ok) {
        const logText = await logRes.text();
        const errorLines = logText.split('\n').filter(l => l.includes('ERROR')).slice(-5);
        if (errorLines.length > 0) recentErrors = errorLines.join('\n');
      }
    } catch {}

    // Historial de conversación reciente (para contexto)
    const recentChat = state.conversationHistory.slice(-6).map(m =>
      `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 100) : '[tool]'}`
    ).join('\n');

    // Pensamientos ya registrados (para no repetir)
    const thoughtsFile = path.join(C.DATA_DIR, 'pending_thoughts.json');
    const existingThoughts = loadJSON(thoughtsFile, []);
    const recentTitles = existingThoughts.slice(-10).map(t => t.title).join(', ');

    // Análisis del dashboard principal
    let dashboardSummary = '';
    try {
      const dashRes = await haGet('/lovelace/config');
      if (dashRes && dashRes.views) {
        const views = dashRes.views;
        const totalCards = views.reduce((acc, v) => acc + (v.cards ? v.cards.length : 0), 0);
        const viewNames = views.map(v => v.title || v.path || 'sin título').join(', ');
        dashboardSummary = `Dashboard principal: ${views.length} vistas (${viewNames}), ${totalCards} cards en total.`;
        if (totalCards < 5) dashboardSummary += ' AVISO: muy pocas cards — dashboard probablemente vacío o sin configurar.';
        if (views.length === 1) dashboardSummary += ' Solo hay 1 vista — no está organizado por habitaciones.';
      }
    } catch { dashboardSummary = 'No se pudo leer el dashboard.'; }

    // Construir prompt de análisis COMPLETO
    const analysisPrompt = `Eres Jarvis en modo pensamiento autónomo. Es ${momento} (${now.toLocaleTimeString('es-ES', {hour:'2-digit',minute:'2-digit'})}).

ESTADO ACTUAL DEL SISTEMA:
- Luces encendidas: ${lightsOn.length} (${lightsOn.slice(0, 5).map(e => e.attributes?.friendly_name || e.entity_id).join(', ')})
- Switches activos: ${switchesOn.length}
- Dispositivos no disponibles: ${unavailable.length}${unavailable.length > 0 ? '\n  Por integración: ' + Object.entries(unavailableGroups).map(([g,items]) => `${g}(${items.length})`).join(', ') : ''}
${massCrashInfo ? `- ${massCrashInfo}` : ''}
- Clima: ${climates.map(c => (c.attributes?.friendly_name || c.entity_id) + '=' + c.state + ' ' + (c.attributes?.current_temperature || '') + '°C').join(', ') || 'sin climatización'}
- Automatizaciones desactivadas: ${automationsOff.length}${automationsOff.length > 0 ? ' (' + automationsOff.slice(0, 3).map(e => e.attributes?.friendly_name || e.entity_id).join(', ') + ')' : ''}
- Total entidades: ${states.length}
${recentErrors ? `- ERRORES recientes en logs:\n${recentErrors}` : '- Sin errores recientes'}

MEMORIA DEL USUARIO:
${state.userMemory.slice(-10).map(m => `- (${m.category}) ${m.note}`).join('\n') || '(vacía)'}

ÚLTIMO HISTORIAL DE CHAT:
${recentChat || '(sin conversación reciente)'}

ESTADO DEL DASHBOARD:
${dashboardSummary}

PENSAMIENTOS YA REGISTRADOS (NO repetir estos):
${recentTitles || '(ninguno)'}

TU MISIÓN: Piensa como un ingeniero domótico experto que vigila la casa 24/7.
ANALIZA TAMBIÉN: ¿El dashboard tiene sentido? ¿Está organizado? ¿Faltan vistas importantes? ¿Hay cards útiles que no tiene?
Pregúntate:
1. ¿Hay algo que no esté bien? (dispositivos caídos, luces encendidas sin sentido, errores)
2. ¿Se podría crear una automatización útil basada en lo que veo?
3. ¿Hay alguna optimización de energía? (luces/switches encendidos de madrugada, clima innecesario)
4. ¿El usuario pidió algo en el chat que puedo mejorar proactivamente?
5. ¿Hay un patrón que debería recordar o aprender?
6. ¿Debería sugerir instalar alguna herramienta/integración que falta?
7. ¿Hay algo que yo pueda hacer para que la casa funcione mejor?

REGLAS CRÍTICAS:
- Cada pensamiento que registres DEBE incluir en el campo "detail" la solución EXACTA y concreta.
  NO solo describas el problema — dí QUÉ HAY QUE HACER y cómo.
  Ejemplo MALO: "Hay 3 luces encendidas en la madrugada"
  Ejemplo BUENO: "Hay 3 luces encendidas en la madrugada (salón, cocina, baño). Puedo apagarlas ahora con call_service light.turn_off o crear una automatización que las apague a las 2:00."
- Si es algo que puedes ejecutar → incluye auto_execute_if_approved con descripción de la acción
- Si implica crear una automatización → describe el trigger, condition y action exactos en el detail
- Si detectas un dispositivo caído y PUEDES arreglarlo → usa call_service para arreglarlo AHORA
- Si no puedes arreglarlo tú (hardware físico) → proactive_thought con detalle de qué hace falta
- Si lo arreglaste → proactive_thought con el resultado ("He recargado X, Y dispositivos recuperados")
- ZIGBEE caídos: usa call_service hassio/addon_restart con addon=45df7312_zigbee2mqtt para reiniciar Z2M
- MQTT caído: recarga la integración mqtt con reload_config_entry
- Alexa caída: recarga alexa_media_player con reload_config_entry

RESPONDE ejecutando acciones (call_service para recargas) y luego proactive_thought con el resumen.
Si no hay nada útil que hacer, responde solo "OK".
NO repitas pensamientos que ya existen. Actúa primero, reporta después.
Prioridad: arreglar cosas rotas > optimizar > sugerir mejoras.`;

    // ── Auto-fix previo al LLM: si hay caída masiva, recargar integraciones conocidas ──
    let autoFixLog = '';
    const hayCaidaMasiva = unavailable.length > 5;
    if (hayCaidaMasiva) {
      console.log('[proactive] Caída masiva detectada — intentando auto-fix de integraciones...');
      try {
        const configEntries = await haGet('/config/config_entries').catch(() => []);
        const autoReloadDomains = ['alexa_media_player', 'pvpc_energyhourly', 'tp_link', 'rest', 'reolink', 'alfa_romeo', 'awattar', 'mqtt'];
        const fixResults = [];

        // Auto-fix Zigbee2MQTT: si hay muchos dispositivos Zigbee caídos, reiniciar el add-on
        if (zigbeeUnavailable.length > 3) {
          try {
            console.log(`[auto-fix] ${zigbeeUnavailable.length} dispositivos Zigbee caídos — reiniciando Zigbee2MQTT...`);
            await fetch('http://supervisor/addons/45df7312_zigbee2mqtt/restart', {
              method: 'POST',
              headers: { Authorization: `Bearer ${C.HA_TOKEN}`, 'Content-Type': 'application/json' }
            });
            fixResults.push(`✓ Zigbee2MQTT reiniciado (${zigbeeUnavailable.length} dispositivos afectados)`);
            await new Promise(r => setTimeout(r, 8000)); // Esperar que Z2M arranque
          } catch (err) {
            fixResults.push(`✗ Zigbee2MQTT restart: ${err.message}`);
          }
        }

        for (const domain of autoReloadDomains) {
          const entries = configEntries.filter(e => e.domain === domain);
          for (const entry of entries) {
            try {
              await haPost(`/services/homeassistant/reload_config_entry`, { entry_id: entry.entry_id });
              fixResults.push(`✓ ${entry.title || domain}`);
              console.log(`[auto-fix] Recargada integración: ${entry.title || domain} (${entry.entry_id})`);
            } catch (err) {
              fixResults.push(`✗ ${entry.title || domain}: ${err.message}`);
            }
          }
        }

        if (fixResults.length > 0) {
          autoFixLog = `\n\nAUTO-FIX EJECUTADO (antes de este análisis):\n${fixResults.join('\n')}\nInforma al usuario de estas acciones en tu proactive_thought.`;
          await new Promise(r => setTimeout(r, 5000));
        }
      } catch (err) {
        console.log(`[auto-fix] Error: ${err.message}`);
      }
    }

    const bgToolNames = ['proactive_thought', 'learn', 'save_memory', 'call_service', 'get_entity_state'];
    const bgTools = state.openAITools.filter(t => bgToolNames.includes(t.function.name));

    let proResult;
    try {
      proResult = await callOpenAI(C.BG_MODEL, 'Eres Jarvis en modo autónomo. ACTÚAS primero (call_service para arreglar cosas), luego reportas con proactive_thought. Si no hay nada útil, di solo "OK". Español. Sé directo.', [{ role: 'user', content: analysisPrompt + autoFixLog }], bgTools, 1024);
    } catch (err) {
      console.log(`[proactive] Error API: ${err.message}`);
      return;
    }

    for (const tc of proResult.toolCalls) {
      await state.executeTool(tc.name, tc.input);
    }

    console.log(`[proactive] Ciclo completo. ${proResult.toolCalls.length} acciones tomadas.`);
  } catch (err) {
    console.log(`[proactive] Error: ${err.message}`);
  }
}

module.exports = { proactiveThinkingLoop };
