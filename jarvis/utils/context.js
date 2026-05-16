'use strict';
const path = require('path');
const { haGet } = require('./ha-api');
const { loadJSON } = require('./persistence');
const { DATA_DIR } = require('./constants');
const state = require('./state');

// ── Contexto en tiempo real ───────────────────────────────────────────────────

async function updateLiveContext() {
  try {
    const states = await haGet('/states');
    let ctx = '';

    // Presencia: quién está en casa
    const persons = states.filter(e => e.entity_id.startsWith('person.'));
    if (persons.length > 0) {
      ctx += 'PRESENCIA: ';
      ctx += persons.map(p => `${p.attributes?.friendly_name || p.entity_id} → ${p.state}`).join(' | ');
      ctx += '\n';
    }

    // Luces encendidas
    const lightsOn = states.filter(e => e.entity_id.startsWith('light.') && e.state === 'on');
    if (lightsOn.length > 0) {
      ctx += `LUCES ENCENDIDAS (${lightsOn.length}): ${lightsOn.map(l => l.attributes?.friendly_name || l.entity_id).join(', ')}\n`;
    } else {
      ctx += 'LUCES: todas apagadas\n';
    }

    // Clima
    const climates = states.filter(e => e.entity_id.startsWith('climate.'));
    if (climates.length > 0) {
      ctx += 'CLIMA: ' + climates.map(c =>
        `${c.attributes?.friendly_name || c.entity_id}: ${c.state} ${c.attributes?.current_temperature ? c.attributes.current_temperature + '°C' : ''}`
      ).join(' | ') + '\n';
    }

    // Temperaturas
    const tempSensors = states.filter(e =>
      e.entity_id.startsWith('sensor.') &&
      (e.attributes?.device_class === 'temperature' || e.attributes?.unit_of_measurement === '°C') &&
      e.state !== 'unavailable' && e.state !== 'unknown'
    );
    if (tempSensors.length > 0) {
      ctx += 'TEMPERATURAS: ' + tempSensors.slice(0, 10).map(s =>
        `${s.attributes?.friendly_name || s.entity_id}: ${s.state}°C`
      ).join(' | ') + '\n';
    }

    // Media players activos
    const mediaOn = states.filter(e => e.entity_id.startsWith('media_player.') && e.state === 'playing');
    if (mediaOn.length > 0) {
      ctx += 'REPRODUCIENDO: ' + mediaOn.map(m =>
        `${m.attributes?.friendly_name}: ${m.attributes?.media_title || m.state}`
      ).join(' | ') + '\n';
    }

    // Alertas: dispositivos no disponibles
    const unavailable = states.filter(e =>
      e.state === 'unavailable' &&
      !e.entity_id.startsWith('automation.') &&
      !e.entity_id.startsWith('update.')
    );
    if (unavailable.length > 0 && unavailable.length < 20) {
      ctx += `⚠️ NO DISPONIBLES (${unavailable.length}): ${unavailable.slice(0, 10).map(e => e.attributes?.friendly_name || e.entity_id).join(', ')}\n`;
    }

    // Switches encendidos
    const switchesOn = states.filter(e => e.entity_id.startsWith('switch.') && e.state === 'on');
    if (switchesOn.length > 0) {
      ctx += `SWITCHES ON (${switchesOn.length}): ${switchesOn.map(s => s.attributes?.friendly_name || s.entity_id).join(', ')}\n`;
    }

    state.liveContext = ctx;
    console.log(`[live] Contexto actualizado: ${persons.length} personas, ${lightsOn.length} luces on, ${unavailable.length} no disponibles`);
  } catch (err) {
    console.log(`[live] Error: ${err.message}`);
  }
}

// ── Contexto dinámico para el prompt ─────────────────────────────────────────

function buildDynamicContext() {
  let ctx = '';
  const now = new Date();
  const dias = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const hora = now.getHours();
  let momento = 'madrugada';
  if (hora >= 7  && hora < 12) momento = 'mañana';
  else if (hora >= 12 && hora < 15) momento = 'mediodía';
  else if (hora >= 15 && hora < 20) momento = 'tarde';
  else if (hora >= 20 && hora < 24) momento = 'noche';

  ctx += `\nCONTEXTO ACTUAL: ${dias[now.getDay()]} ${now.toLocaleDateString('es-ES')} | ${now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })} (${momento}) | ${state.conversationHistory.length} msgs en sesión | ${state.userMemory.length} notas | ${state.learnings.length} learnings\n`;

  if (state.liveContext)    ctx += `\nESTADO EN TIEMPO REAL:\n${state.liveContext}`;
  if (state.houseContext)   ctx += `\nINSTALACIÓN:\n${state.houseContext}`;

  if (state.userMemory.length > 0) {
    ctx += `\nMEMORIA DEL USUARIO:\n`;
    for (let i = 0; i < state.userMemory.length; i++)
      ctx += `[${i}] (${state.userMemory[i].category}) ${state.userMemory[i].note}\n`;
  }

  const distilledRules = loadJSON(path.join(DATA_DIR, 'distilled_rules.json'), []);
  if (distilledRules.length > 0) {
    ctx += `\nREGLAS APRENDIDAS:\n`;
    for (const r of distilledRules.slice(-15)) ctx += `• ${r}\n`;
  } else if (state.learnings.length > 0) {
    ctx += `\nAPRENDIZAJES RECIENTES:\n`;
    for (const l of state.learnings.slice(-10)) {
      if (l.type === 'error')   ctx += `⚠ NO REPETIR: ${l.context} → ${l.lesson}${l.solution ? ' | FIX: ' + l.solution : ''}\n`;
      else if (l.type === 'success') ctx += `✓ FUNCIONA: ${l.lesson}\n`;
      else ctx += `→ ${l.lesson}\n`;
    }
  }

  const pendingThoughts = loadJSON(path.join(DATA_DIR, 'pending_thoughts.json'), []).filter(t => t.status === 'pending');
  if (pendingThoughts.length > 0) {
    ctx += `\n⚠️ ASUNTOS PENDIENTES (${pendingThoughts.length}):\n`;
    for (const t of pendingThoughts.slice(0, 5)) {
      const icon = t.priority === 'critical' ? '🔴' : t.priority === 'high' ? '🟠' : '🟡';
      ctx += `${icon} [${t.type}] ${t.title}: ${t.detail}\n`;
    }
    ctx += `INSTRUCCIÓN: Menciona los asuntos pendientes relevantes (especialmente high/critical) antes de responder.\n`;
  }

  const selfKnowledge = loadJSON(path.join(DATA_DIR, 'self_knowledge.json'), []);
  if (selfKnowledge.length > 0) {
    ctx += `\nCONOCIMIENTO PROPIO (auto-actualizado):\n`;
    for (const section of selfKnowledge) ctx += `--- ${section.title} ---\n${section.content}\n`;
  }

  return ctx;
}

module.exports = { updateLiveContext, buildDynamicContext };
