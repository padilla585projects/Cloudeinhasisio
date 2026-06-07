#!/usr/bin/env node
/**
 * bootstrap_update.js — Actualiza Jarvis sin tocar la UI de HA
 * ─────────────────────────────────────────────────────────────
 * Funciona con el token de larga duración (no necesita SUPERVISOR_TOKEN).
 * Uso:  node bootstrap_update.js
 *
 * Workflow definitivo para futuros updates (una vez v3.33.13+ instalada):
 *   1. git push
 *   2. node bootstrap_update.js          ← espera detección + instala
 *   O si ya está detectada:
 *      curl -s -X POST http://192.168.10.36:3000/api/deploy-update
 */
'use strict';
const http = require('http');
const https = require('https');

const HA_HOST  = '192.168.10.36';
const HA_PORT  = 8123;
const HA_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiI5MzYxN2MyZWU0ZmQ0ZWJmOWExNjEwMDUzMjhhN2RjOCIsImlhdCI6MTc4MDYwNjM0OSwiZXhwIjoyMDk1OTY2MzQ5fQ.VSSK0YLWpc_AEnmSJgoYyIVNbdCKrq1-3G8R-GDFl6c';

const JARVIS_HOST  = '192.168.10.36';
const JARVIS_PORT  = 3000;
const UPDATE_ENTITY = 'update.jarvis_ai_agent_actualizar';
const ADDON_SLUG    = 'jarvis_ai_agent';
const REPO_URL      = 'https://github.com/padilla585projects/Cloudeinhasisio';

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function haGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: HA_HOST, port: HA_PORT, path,
      headers: { Authorization: `Bearer ${HA_TOKEN}` }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

function haPost(path, body = {}) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: HA_HOST, port: HA_PORT, path, method: 'POST',
      headers: { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.write(payload);
    req.end();
  });
}

function jarvisGet(path) {
  return new Promise((resolve) => {
    const req = http.request({ hostname: JARVIS_HOST, port: JARVIS_PORT, path }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function jarvisPost(path, body = {}) {
  const payload = JSON.stringify(body);
  return new Promise((resolve) => {
    const req = http.request({
      hostname: JARVIS_HOST, port: JARVIS_PORT, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(60000, () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Jarvis Bootstrap Update');
  console.log('═══════════════════════════════════════════════════════\n');

  // 1. Intentar /api/deploy-update (si ya está instalada la versión con el endpoint)
  console.log('[1] Probando /api/deploy-update en Jarvis...');
  const deployResult = await jarvisPost('/api/deploy-update');
  if (deployResult && deployResult.status < 400) {
    console.log('✅ Endpoint disponible. Respuesta:');
    console.log(JSON.stringify(deployResult.body, null, 2));
    console.log('\n📌 Workflow para futuros updates:');
    console.log('   curl -s -X POST http://192.168.10.36:3000/api/deploy-update');
    return;
  }
  console.log('   No disponible (versión vieja). Usando HA service API...\n');

  // 2. Ver estado actual del update entity
  console.log('[2] Consultando estado del update entity en HA...');
  const updateState = await haGet(`/api/states/${UPDATE_ENTITY}`);
  if (!updateState || !updateState.attributes) {
    console.log('❌ No se pudo consultar el estado de HA. ¿Está accesible?');
    return;
  }
  const { installed_version, latest_version, in_progress } = updateState.attributes;
  const entityState = updateState.state;
  console.log(`   Instalada: ${installed_version} | Disponible: ${latest_version} | Estado: ${entityState} | En progreso: ${in_progress}`);

  // 3. Si hay update disponible, instalarlo
  if (entityState === 'on' && !in_progress) {
    console.log(`\n[3] Instalando ${latest_version}...`);
    const result = await haPost('/api/services/update/install', { entity_id: UPDATE_ENTITY });
    if (result && result.status < 400) {
      console.log('   ✅ Update lanzado! Monitoreando...\n');
      await monitorInstall(installed_version);
    } else {
      console.log(`   ❌ Error: ${result?.status} ${JSON.stringify(result?.body).slice(0, 200)}`);
    }
    return;
  }

  // 4. Si ya está al día o en progreso
  if (in_progress) {
    console.log('\n[3] Ya hay un update en progreso. Monitoreando...\n');
    await monitorInstall(installed_version);
    return;
  }

  if (entityState === 'off') {
    console.log('\n[3] Ya estás en la última versión detectada por el Supervisor.');
    console.log('    Si acabas de hacer push, el Supervisor puede tardar minutos en detectarla.');
    console.log('    Espera 5 minutos y vuelve a ejecutar este script.\n');
    console.log('    Si quieres forzar la detección ahora, el add-on debe estar corriendo:');
    console.log(`    curl -s -X POST http://${JARVIS_HOST}:${JARVIS_PORT}/api/deploy-update`);
  }
}

async function monitorInstall(previousVersion) {
  for (let i = 0; i < 30; i++) {
    await sleep(8000);
    const st = await haGet(`/api/states/${UPDATE_ENTITY}`).catch(() => null);
    if (!st) { process.stdout.write('.'); continue; }
    const { installed_version, in_progress, update_percentage } = st.attributes;
    const pct = update_percentage !== null ? ` (${update_percentage}%)` : '';
    console.log(`   ${new Date().toLocaleTimeString()} instalada=${installed_version} en_progreso=${in_progress}${pct}`);
    if (!in_progress && installed_version !== previousVersion) {
      console.log(`\n✅ Actualización completada → ${installed_version}`);
      await sleep(15000);
      const health = await jarvisGet('/api/health');
      if (health) {
        console.log('✅ Jarvis respondiendo en puerto 3000:', JSON.stringify(health));
        console.log('\n📌 Workflow para futuros updates:');
        console.log('   curl -s -X POST http://192.168.10.36:3000/api/deploy-update');
      } else {
        console.log('⚠️  Jarvis aún no responde en puerto 3000 (puede estar arrancando npm install).');
        console.log('   Espera 1-2 min y prueba: curl http://192.168.10.36:3000/api/health');
      }
      return;
    }
  }
  console.log('\n⚠️  Tiempo de espera agotado. Comprueba en HA → Add-ons → Jarvis.');
}

main().catch(err => { console.error('Error fatal:', err); process.exit(1); });
