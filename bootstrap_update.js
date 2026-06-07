#!/usr/bin/env node
/**
 * bootstrap_update.js
 * -------------------
 * Fuerza la actualización de Jarvis desde esta máquina sin tocar la UI de HA.
 * Úsalo UNA VEZ para saltar de la versión actual a la que tiene el auto-deploy.
 *
 * Uso: node bootstrap_update.js
 *
 * Después de esto, para futuros updates:
 *   curl -s -X POST http://192.168.10.36:3000/api/deploy-update | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d)))"
 *
 * O simplemente:
 *   curl -s -X POST http://192.168.10.36:3000/api/deploy-update
 */
'use strict';
const http = require('http');

const JARVIS = { host: '192.168.10.36', port: 3000 };
const REPO_URL = 'https://github.com/padilla585projects/Cloudeinhasisio';
const ADDON_SLUG = 'jarvis_ai_agent';

function callJarvisChat(message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ messages: [{ role: 'user', content: message }] });
    const req = http.request({
      ...JARVIS, path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(120000);
    req.write(body);
    req.end();
  });
}

function checkDeployEndpoint() {
  return new Promise((resolve) => {
    const req = http.request({
      ...JARVIS, path: '/api/deploy-update', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '2' }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ ok: true, body: JSON.parse(data) }); }
        catch { resolve({ ok: res.statusCode < 400, raw: data }); }
      });
    });
    req.on('error', () => resolve({ ok: false }));
    req.setTimeout(60000, () => req.destroy());
    req.write('{}');
    req.end();
  });
}

function parseSse(raw) {
  let text = '';
  raw.split('data: ').forEach(part => {
    try {
      const j = JSON.parse(part.trim());
      if (j.type === 'text') text += j.text;
    } catch {}
  });
  return text;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Jarvis Bootstrap Update — instalación sin UI');
  console.log('═══════════════════════════════════════════════════════\n');

  // 1. Comprobar si ya tenemos el endpoint /api/deploy-update (versión nueva instalada)
  console.log('[1/3] Comprobando si el endpoint /api/deploy-update ya existe...');
  const endpointCheck = await checkDeployEndpoint().catch(() => ({ ok: false }));

  if (endpointCheck.ok && endpointCheck.body) {
    console.log('✅ El endpoint ya existe! Usando /api/deploy-update directamente.');
    console.log('Respuesta:', JSON.stringify(endpointCheck.body, null, 2));
    return;
  }

  console.log('   Endpoint no disponible (versión vieja instalada). Usando chat API...\n');

  // 2. Bootstrap via exec_command en el chat
  console.log('[2/3] Enviando instrucción a Jarvis para refrescar el repo via bash...');

  // El mensaje contiene "docker" y "contenedor" para que el router capa-1 lo mande
  // al experto "red" que tiene exec_command. También tiene instrucciones muy explícitas.
  const message = [
    'Necesito que ejecutes en bash (exec_command) el siguiente ciclo para actualizar el addon de jarvis en el supervisor docker:',
    '',
    'Paso 1: Lista repos disponibles',
    `curl -sf -H "Authorization: Bearer $HA_TOKEN" http://supervisor/store/repositories`,
    '',
    'Paso 2: Con el slug del repo "padilla585projects" que aparezca en el resultado, bórralo (reemplaza SLUG_AQUI):',
    `curl -sf -X DELETE -H "Authorization: Bearer $HA_TOKEN" http://supervisor/store/repositories/SLUG_AQUI`,
    '',
    'Paso 3: Re-añade el repo:',
    `curl -sf -X POST -H "Authorization: Bearer $HA_TOKEN" -H "Content-Type: application/json" -d '{"repository":"${REPO_URL}"}' http://supervisor/store/repositories`,
    '',
    'Paso 4: Espera 7 segundos (sleep 7) y lanza el update:',
    `sleep 7 && curl -sf -X POST -H "Authorization: Bearer $HA_TOKEN" http://supervisor/addons/${ADDON_SLUG}/update`,
    '',
    'Ejecuta los pasos 1, 2, 3 y 4 en orden usando exec_command. Usa el slug real del paso 1.',
    'El contenedor del supervisor está en la red interna accesible desde aquí.'
  ].join('\n');

  let response;
  try {
    process.stdout.write('   Esperando respuesta de Jarvis (puede tardar 30-60s)... ');
    response = await callJarvisChat(message);
    console.log('OK\n');
  } catch (err) {
    console.error('\n❌ Error llamando al chat API:', err.message);
    console.log('\nAlternativa manual (en Jarvis chat):');
    printManualInstructions();
    process.exit(1);
  }

  const text = parseSse(response);
  if (text) {
    console.log('Respuesta de Jarvis:');
    console.log('─'.repeat(50));
    console.log(text);
    console.log('─'.repeat(50));
  }

  // 3. Esperar y verificar
  console.log('\n[3/3] Esperando 15s a que Jarvis reinicie...');
  await new Promise(r => setTimeout(r, 15000));

  const verify = await checkDeployEndpoint().catch(() => ({ ok: false }));
  if (verify.ok && verify.body) {
    console.log('\n✅ ¡Actualización completada! El endpoint /api/deploy-update ya está activo.');
    console.log('   Versión instalada:', verify.body.note || 'nueva versión detectada');
    console.log('\n📌 Para futuros updates, solo ejecuta:');
    console.log('   curl -s -X POST http://192.168.10.36:3000/api/deploy-update');
  } else {
    console.log('\n⚠️  Jarvis no responde aún (puede estar reiniciando).');
    console.log('   Espera 30s más y prueba: curl http://192.168.10.36:3000/api/health');
    console.log('\nSi sigue sin funcionar, instrucciones manuales:');
    printManualInstructions();
  }
}

function printManualInstructions() {
  console.log([
    '',
    '  En el chat de Jarvis, escribe exactamente:',
    '  "usa exec_command bash para refrescar el repo del supervisor y actualizar jarvis"',
    '',
    '  O en HA → Add-on Store → ⋮ → Repositories → borrar y re-añadir:',
    `  ${REPO_URL}`,
  ].join('\n'));
}

main().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
