'use strict';
const path = require('path');
const fetch = require('node-fetch');
const { callOpenAI } = require('../utils/llm');
const { loadJSON, saveJSON } = require('../utils/persistence');
const { haPost } = require('../utils/ha-api');
const { notify } = require('../utils/notify');
const C = require('../utils/constants');
const state = require('../utils/state');

async function checkSelfUpdate() {
  try {
    // Pedir al Supervisor que refresque la info del repositorio
    await fetch('http://supervisor/store/repositories', {
      method: 'POST',
      headers: { Authorization: `Bearer ${C.HA_TOKEN}`, 'Content-Type': 'application/json' }
    });

    // Comprobar si hay update disponible para este add-on
    const res = await fetch('http://supervisor/addons/self/info', {
      headers: { Authorization: `Bearer ${C.HA_TOKEN}` }
    });

    if (!res.ok) {
      // Fallback: intentar por slug
      const res2 = await fetch('http://supervisor/addons/local_jarvis_ai_agent/info', {
        headers: { Authorization: `Bearer ${C.HA_TOKEN}` }
      });
      if (!res2.ok) return;
      var info = await res2.json();
    } else {
      var info = await res.json();
    }

    const current = info.data?.version;
    const latest = info.data?.version_latest;

    if (!current || !latest || current === latest) return;

    console.log(`[update] Nueva versión disponible: ${current} → ${latest}`);

    // POST /addons/self/update no existe en la API del Supervisor ("self" solo vale
    // para lecturas como /addons/self/info), y el intento directo contra
    // /store/addons/<slug real, ej. "207a78ec_jarvis_ai_agent">/update devuelve 403
    // — el Supervisor parece no dejar que un add-on se auto-actualice a sí mismo
    // por esa vía mientras sigue corriendo. En cambio, pedirle a HA Core que llame
    // al servicio update.install sobre la entidad "update" del add-on sí funciona
    // (mismo mecanismo que /api/deploy-update, ya validado manualmente).
    const updateRes = await fetch(`${C.HA_URL}/api/services/update/install`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${C.HA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_id: 'update.jarvis_ai_agent_actualizar' })
    });

    if (updateRes.ok) {
      console.log(`[update] Actualización a v${latest} iniciada. El add-on se reiniciará.`);

      // Por el canal comun. Antes iba con un haPost suelto al servicio de
      // Telegram de HA envuelto en un catch vacio: si ese servicio no existe,
      // el aviso desaparecia sin dejar rastro.
      await notify(
        `Jarvis se esta actualizando solo: v${current} -> v${latest}. Vuelvo en un momento.`,
        { title: 'Jarvis - auto-actualizacion', source: 'update' }
      );
    } else {
      const errText = await updateRes.text().catch(() => '');
      console.log(`[update] Error al actualizar via update.install: ${updateRes.status} ${errText.slice(0, 150)}`);
    }
  } catch (err) {
    // Silencioso — no spamear logs si el supervisor no responde bien
    if (err.message && !err.message.includes('ECONNREFUSED')) {
      console.log(`[update] ${err.message}`);
    }
  }
}

// OJO: esta funcion NO llama a ningun LLM. Son cuatro consultas REST al
// Supervisor y una comparacion de versiones. Hasta v3.38.9 empezaba con
// `if (!C.ANTHROPIC_API_KEY) return;`, asi que sin esa clave —que no pinta nada
// aqui— no se comprobaba NUNCA si habia actualizaciones. Guarda eliminada.
async function checkSystemUpdates() {
  try {
    console.log('[updates] Verificando actualizaciones del sistema...');

    const [core, os, sup, addons] = await Promise.all([
      fetch('http://supervisor/core/info', { headers: { Authorization: `Bearer ${C.HA_TOKEN}` } }).then(r => r.json()).catch(() => ({})),
      fetch('http://supervisor/os/info', { headers: { Authorization: `Bearer ${C.HA_TOKEN}` } }).then(r => r.json()).catch(() => ({})),
      fetch('http://supervisor/supervisor/info', { headers: { Authorization: `Bearer ${C.HA_TOKEN}` } }).then(r => r.json()).catch(() => ({})),
      fetch('http://supervisor/addons', { headers: { Authorization: `Bearer ${C.HA_TOKEN}` } }).then(r => r.json()).catch(() => ({ data: { addons: [] } }))
    ]);

    const updates = [];
    const coreData = core.data || core;
    const osData = os.data || os;
    const supData = sup.data || sup;
    const addonList = (addons.data || addons).addons || [];

    // Si el Supervisor no responde, los cuatro `.catch(() => ({}))` de arriba
    // devuelven objetos vacios y el codigo de abajo concluiria "sistema al dia":
    // una tranquilidad falsa, que es peor que un error. Hay que distinguir
    // "no hay nada pendiente" de "no he podido mirar".
    if (!coreData.version && !supData.version && addonList.length === 0) {
      console.log('[updates] No pude consultar al Supervisor. NO se ha comprobado nada — esto no significa que el sistema este al dia.');
      return;
    }

    if (coreData.update_available) updates.push(`HA Core: ${coreData.version} → ${coreData.version_latest}`);
    if (osData.update_available) updates.push(`HA OS: ${osData.version} → ${osData.version_latest}`);
    if (supData.update_available) updates.push(`Supervisor: ${supData.version} → ${supData.version_latest}`);
    const updatableAddons = addonList.filter(a => a.update_available);
    for (const a of updatableAddons) updates.push(`Add-on ${a.name}: ${a.version} → ${a.version_latest}`);

    if (updates.length > 0) {
      console.log(`[updates] ${updates.length} actualizaciones disponibles`);
      const thoughtsFile = path.join(C.DATA_DIR, 'pending_thoughts.json');
      let thoughts = loadJSON(thoughtsFile, []);
      // No duplicar si ya hay un pensamiento de updates reciente
      const recentUpdate = thoughts.find(t => t.title && t.title.includes('actualizaciones') && t.status === 'pending' && (Date.now() - new Date(t.created).getTime()) < 24 * 3600_000);
      if (!recentUpdate) {
        thoughts.push({
          id: Date.now(), type: 'optimization', priority: 'medium', status: 'pending',
          title: `${updates.length} actualizaciones disponibles`,
          detail: updates.join('\n') + '\n\nPuedo actualizarlas automáticamente. Los add-ons se actualizan sin interrupciones. El Core y OS reinician brevemente. ¿Quieres que lo haga?',
          created: new Date().toISOString()
        });
        if (thoughts.length > 50) thoughts = thoughts.slice(-50);
        saveJSON(thoughtsFile, thoughts);
        console.log(`[updates] Pensamiento creado con las ${updates.length} actualizaciones.`);

        // Y AVISAR. Antes solo se apuntaba en pending_thoughts, que hay que
        // entrar al panel para leer: detectaba y se callaba. El pensamiento
        // sigue guardandose con el detalle completo; esto es el aviso.
        const MAX_EN_AVISO = 5;
        const SALTO = String.fromCharCode(10);
        const lista = updates.slice(0, MAX_EN_AVISO).map(u => '- ' + u).join(SALTO);
        const resto = updates.length > MAX_EN_AVISO
          ? SALTO + '...y ' + (updates.length - MAX_EN_AVISO) + ' mas.'
          : '';
        await notify(
          'Jarvis: hay ' + updates.length + ' actualizaciones pendientes.' + SALTO + lista + resto,
          { title: 'Jarvis - actualizaciones', source: 'updates' }
        );
      }
    } else {
      console.log('[updates] Sistema al día, sin actualizaciones pendientes.');
    }
  } catch (err) {
    console.log(`[updates] Error: ${err.message}`);
  }
}

module.exports = { checkSelfUpdate, checkSystemUpdates };
