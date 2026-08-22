'use strict';
const fetch = require('node-fetch');
const { HA_TOKEN, HA_URL } = require('./constants');

const HA_TIMEOUT = 15000;
const HA_RETRIES = 2;

async function haFetch(url, opts, retries = HA_RETRIES) {
  for (let i = 0; i <= retries; i++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HA_TIMEOUT);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timeoutId);
      return res;
    } catch (err) {
      clearTimeout(timeoutId);
      if (i === retries) throw err;
      if (err.name === 'AbortError') throw new Error(`HA timeout (${HA_TIMEOUT}ms): ${url}`);
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

async function haGet(endpoint) {
  const res = await haFetch(`${HA_URL}/api${endpoint}`, {
    headers: { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' }
  });
  if (!res.ok) throw new Error(`HA GET ${endpoint} → ${res.status}`);
  return res.json();
}

async function haPost(endpoint, body = {}) {
  const res = await haFetch(`${HA_URL}/api${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`HA POST ${endpoint} → ${res.status}`);
  return res.json();
}

async function supervisorGet(endpoint) {
  const res = await haFetch(`http://supervisor${endpoint}`, {
    headers: { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' }
  });
  if (!res.ok) throw new Error(`Supervisor GET ${endpoint} → ${res.status}`);
  return res.json();
}

async function supervisorPost(endpoint, body = {}) {
  const res = await haFetch(`http://supervisor${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Supervisor POST ${endpoint} → ${res.status}`);
  // Algunas respuestas del Supervisor no tienen cuerpo JSON
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { ok: true }; }
}

// Resuelve el slug real del propio add-on instalado. Los add-ons instalados desde
// un repositorio local llevan el prefijo "local_" (p.ej. "local_jarvis_ai_agent"),
// que no coincide con el nombre declarado en config.yaml — adivinarlo a mano en
// cada sitio del código es lo que causaba 403/404 en varias llamadas al Supervisor.
// "self" SÍ es válido para /addons/self/info (a diferencia de otras acciones del
// Supervisor), así que se resuelve aquí una vez y se cachea en memoria.
let _selfSlugCache = null;
async function getSelfSlug() {
  if (_selfSlugCache) return _selfSlugCache;
  try {
    const info = await supervisorGet('/addons/self/info');
    if (info?.data?.slug) _selfSlugCache = info.data.slug;
    return _selfSlugCache;
  } catch (e) {
    console.log(`[ha-api] No pude resolver mi slug: ${e.message}`);
    return null;
  }
}

module.exports = { haGet, haPost, supervisorGet, supervisorPost, getSelfSlug };
