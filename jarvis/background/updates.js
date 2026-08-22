'use strict';
const path = require('path');
const fetch = require('node-fetch');
const { callOpenAI } = require('../utils/llm');
const { loadJSON, saveJSON } = require('../utils/persistence');
const { haPost } = require('../utils/ha-api');
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
    const slug = info.data?.slug;

    if (!current || !latest || current === latest) return;

    console.log(`[update] Nueva versión disponible: ${current} → ${latest}`);

    if (!slug) {
      console.log('[update] No pude determinar el slug real del add-on — abortando auto-update.');
      return;
    }

    // POST /addons/self/update no existe en la API del Supervisor ("self" solo vale
    // para lecturas como /addons/self/info) y /addons/<addon>/update está deprecado
    // en favor de /store/addons/<addon>/update. Se usa el slug real devuelto por
    // /addons/self/info en vez de adivinarlo (evita 404 si el slug local difiere).
    const updateRes = await fetch(`http://supervisor/store/addons/${slug}/update`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${C.HA_TOKEN}`, 'Content-Type': 'application/json' }
    });

    if (updateRes.ok) {
      console.log(`[update] Actualización a v${latest} iniciada. El add-on se reiniciará.`);

      // Notificar por Telegram
      try {
        await haPost('/services/telegram_bot/send_message', {
          message: `🔄 *JARVIS — AUTO-UPDATE*\n\nActualización: v${current} → v${latest}\nEl add-on se está reiniciando...`,
          parse_mode: 'markdown'
        });
      } catch {}
    } else {
      console.log(`[update] Error al actualizar (slug=${slug}): ${updateRes.status}`);
    }
  } catch (err) {
    // Silencioso — no spamear logs si el supervisor no responde bien
    if (err.message && !err.message.includes('ECONNREFUSED')) {
      console.log(`[update] ${err.message}`);
    }
  }
}

async function checkSystemUpdates() {
  try {
    if (!C.ANTHROPIC_API_KEY) return;
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
      }
    } else {
      console.log('[updates] Sistema al día, sin actualizaciones pendientes.');
    }
  } catch (err) {
    console.log(`[updates] Error: ${err.message}`);
  }
}

module.exports = { checkSelfUpdate, checkSystemUpdates };
