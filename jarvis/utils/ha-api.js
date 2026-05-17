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

module.exports = { haGet, haPost, supervisorGet };
