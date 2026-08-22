'use strict';
const path = require('path');
const { haGet } = require('./ha-api');
const { loadJSON } = require('./persistence');
const { DATA_DIR } = require('./constants');
const state = require('./state');

// ── Diagnóstico: qué está roto de verdad y qué es basura del registro ────────

// Una entidad 'unavailable' con restored:true es HUÉRFANA: sigue en el registro
// pero ninguna integración la sirve (cámara quitada de la cuenta, contenedor
// Docker que ya no existe, interfaz veth* del NAS que cambió de nombre...).
// No hay nada que reiniciar: es un registro zombi. Mezclarlas con los aparatos
// realmente caídos es lo que hacía que el log repitiera "124 no disponibles"
// eternamente sin decir nada accionable.
function classifyUnavailable(states) {
  const ignorar = e => e.entity_id.startsWith('automation.') || e.entity_id.startsWith('update.');
  const malas = states.filter(e => e.state === 'unavailable' && !ignorar(e));
  const huerfanas = malas.filter(e => e.attributes?.restored === true);
  const caidas    = malas.filter(e => e.attributes?.restored !== true);

  // Agrupar las huérfanas por prefijo del object_id: identifica de un vistazo
  // de qué dispositivo/integración es la basura (ezviz→c8c_lite, omv_compose...).
  const porGrupo = {};
  for (const e of huerfanas) {
    const obj = e.entity_id.split('.')[1] || '';
    const k = obj.split('_').slice(0, 2).join('_');
    porGrupo[k] = (porGrupo[k] || 0) + 1;
  }
  return {
    huerfanas,
    caidas,
    gruposHuerfanas: Object.entries(porGrupo).sort((a, b) => b[1] - a[1]),
  };
}

// Las entradas de configuración cambian poco: consultarlas en cada ciclo de 60s
// sería gasto inútil. 15 min basta para enterarse de que una ha entrado en bucle
// de reintentos.
const CONFIG_ENTRIES_TTL = 15 * 60_000;
let _entriesCache = { ts: 0, data: null };
const _brokenSeen = new Set();  // avisar solo de fallos NUEVOS, no en cada ciclo

async function getBrokenIntegrations() {
  if (_entriesCache.data !== undefined && Date.now() - _entriesCache.ts < CONFIG_ENTRIES_TTL) {
    return _entriesCache.data;
  }
  try {
    const entries = await haGet('/config/config_entries/entry');
    if (!Array.isArray(entries)) throw new Error('respuesta inesperada');
    // setup_retry / setup_error → la integración falla de verdad y reintenta en
    // bucle. not_loaded sin disabled_by suele ser un aparato apagado o una
    // entrada duplicada muerta: se reporta aparte y con menos ruido.
    const fallando  = entries.filter(e => e.state === 'setup_retry' || e.state === 'setup_error');
    const sinCargar = entries.filter(e => e.state === 'not_loaded' && !e.disabled_by);
    _entriesCache = { ts: Date.now(), data: { fallando, sinCargar } };
    return _entriesCache.data;
  } catch (err) {
    // Un token sin permisos de admin no puede leer config_entries. No es crítico:
    // el resto del diagnóstico sigue funcionando.
    console.log(`[live] No pude leer config_entries: ${err.message}`);
    _entriesCache = { ts: Date.now(), data: null };
    return null;
  }
}

function idEntrada(e) {
  return `${e.domain}:${e.entry_id || e.title || ''}`;
}

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

    // Alertas: separar fallo activo de basura del registro
    const { huerfanas, caidas, gruposHuerfanas } = classifyUnavailable(states);
    const integraciones = await getBrokenIntegrations();

    if (integraciones?.fallando?.length) {
      ctx += `🔴 INTEGRACIONES FALLANDO (${integraciones.fallando.length}): ` +
        integraciones.fallando.slice(0, 5).map(e =>
          `${e.domain}${e.title ? ` "${e.title}"` : ''} → ${e.reason || e.state}`
        ).join(' | ') + '\n';
    }
    if (caidas.length > 0) {
      ctx += `⚠️ DISPOSITIVOS CAÍDOS (${caidas.length}): ` +
        caidas.slice(0, 10).map(e => e.attributes?.friendly_name || e.entity_id).join(', ') + '\n';
    }
    if (huerfanas.length > 0) {
      ctx += `🗑️ ENTIDADES HUÉRFANAS (${huerfanas.length} — registros zombis, NO es un fallo activo; ` +
        `se limpian borrándolas del registro de entidades): ` +
        gruposHuerfanas.slice(0, 6).map(([g, n]) => `${g}(${n})`).join(', ') + '\n';
    }

    // Avisar solo de las integraciones que ACABAN de romperse. queueNotification
    // ya aplica cooldown por tipo, pero sin este filtro se encolaría un aviso por
    // cada ciclo de 60s mientras la integración siga rota.
    if (integraciones?.fallando?.length) {
      try {
        const { queueNotification } = require('../background/notifications');
        for (const e of integraciones.fallando) {
          const id = idEntrada(e);
          if (_brokenSeen.has(id)) continue;
          _brokenSeen.add(id);
          queueNotification(
            'integracion_caida',
            `Integración caída: ${e.domain}`,
            `${e.title || e.domain} está en ${e.state}${e.reason ? ` — ${e.reason}` : ''}`,
            'high'
          );
        }
        // Olvidar las que ya se recuperaron, para poder volver a avisar si recaen
        const vivas = new Set(integraciones.fallando.map(idEntrada));
        for (const id of [..._brokenSeen]) if (!vivas.has(id)) _brokenSeen.delete(id);
      } catch (e) {
        console.log(`[live] No pude encolar aviso de integración caída: ${e.message}`);
      }
    } else if (integraciones) {
      _brokenSeen.clear();
    }

    // Switches encendidos
    const switchesOn = states.filter(e => e.entity_id.startsWith('switch.') && e.state === 'on');
    if (switchesOn.length > 0) {
      ctx += `SWITCHES ON (${switchesOn.length}): ${switchesOn.map(s => s.attributes?.friendly_name || s.entity_id).join(', ')}\n`;
    }

    state.liveContext = ctx;
    const resumen = [
      `${persons.length} personas`,
      `${lightsOn.length} luces on`,
      `${caidas.length} caídos`,
      `${huerfanas.length} huérfanas`,
    ];
    if (integraciones?.fallando?.length) {
      resumen.push(`INTEGRACIONES FALLANDO: ${integraciones.fallando.map(e => e.domain).join(',')}`);
    }
    console.log(`[live] Contexto actualizado: ${resumen.join(', ')}`);
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
    // Selección inteligente: recientes (10) + relevantes al mensaje actual (10)
    const MAX_CONTEXT = 20;
    const recent = state.userMemory.slice(-10);
    // Buscar notas relevantes al último mensaje del usuario
    const lastUserMsg = (state.conversationHistory.filter(m => m.role === 'user').pop()?.content || '').toLowerCase();
    const words = lastUserMsg.split(/\s+/).filter(w => w.length > 3);
    let relevant = [];
    if (words.length > 0) {
      const scored = state.userMemory.map((m, idx) => {
        const text = (m.note + ' ' + (m.category || '')).toLowerCase();
        const score = words.reduce((s, w) => s + (text.includes(w) ? 1 : 0), 0);
        return { ...m, idx, score };
      }).filter(m => m.score > 0 && !recent.includes(state.userMemory[m.idx]));
      scored.sort((a, b) => b.score - a.score);
      relevant = scored.slice(0, MAX_CONTEXT - recent.length);
    }
    const memSlice = [...relevant, ...recent];
    if (memSlice.length > 0) {
      ctx += `\nMEMORIA (${memSlice.length} seleccionadas / ${state.userMemory.length} total):\n`;
      for (const m of memSlice) ctx += `(${m.category || '?'}) ${m.note}\n`;
    }
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
