'use strict';
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { callLLM } = require('../utils/llm');
const { loadJSON, saveJSON, autoBackup } = require('../utils/persistence');
const { haGet, haPost } = require('../utils/ha-api');
const C = require('../utils/constants');
const state = require('../utils/state');

function pushToAll(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of state.pushClients) {
    try { res.write(line); } catch { state.pushClients.delete(res); }
  }
}

async function checkEmergencies() {
  try {
    const config = loadJSON(C.EMERGENCY_CONFIG_FILE, { enabled: false, triggers: [], actions: [] });
    if (!config.enabled || config.triggers.length === 0) return;

    for (const trigger of config.triggers) {
      try {
        const state = await haGet(`/states/${trigger.entity_id}`);
        if (state.state === trigger.state) {
          const emergencyKey = `${trigger.entity_id}_${trigger.state}`;
          const activeFile = path.join(C.DATA_DIR, 'active_emergencies.json');
          const active = loadJSON(activeFile, {});

          // Solo actuar una vez por emergencia (hasta que se resuelva)
          if (active[emergencyKey]) continue;
          active[emergencyKey] = new Date().toISOString();
          saveJSON(activeFile, active);

          console.log(`[EMERGENCIA] ${trigger.description || trigger.entity_id} → ${trigger.state}`);

          // Ejecutar todas las acciones pre-autorizadas
          const results = [];
          for (const action of config.actions) {
            try {
              await haPost(`/services/${action.domain}/${action.service}`, action.entity_id ? { entity_id: action.entity_id } : {});
              results.push(`✓ ${action.description || action.service}`);
              console.log(`[EMERGENCIA] Ejecutado: ${action.domain}.${action.service} → ${action.entity_id || ''}`);
            } catch (e) {
              results.push(`✗ ${action.description || action.service}: ${e.message}`);
            }
          }

          // Notificar siempre por Telegram
          const msg = `🚨 EMERGENCIA: ${trigger.description || trigger.entity_id}\n\nAcciones ejecutadas:\n${results.join('\n')}\n\nHora: ${new Date().toLocaleString('es-ES')}`;
          try {
            await haPost('/services/notify/telegram', { message: msg });
          } catch {}

          // Push al chat si hay alguien conectado
          pushToAll({ type: 'emergency', trigger, results, ts: new Date().toISOString() });
        } else {
          // Limpiar emergencia resuelta
          const activeFile = path.join(C.DATA_DIR, 'active_emergencies.json');
          const active = loadJSON(activeFile, {});
          const emergencyKey = `${trigger.entity_id}_${trigger.state}`;
          if (active[emergencyKey]) {
            delete active[emergencyKey];
            saveJSON(activeFile, active);
            console.log(`[EMERGENCIA] Resuelta: ${trigger.entity_id}`);
          }
        }
      } catch {}
    }
  } catch (e) {
    // Silencioso — no spamear logs si HA no responde
  }
}

async function bootRecoverScripts() {
  const scriptsYaml = path.join(C.HA_CONFIG, 'scripts.yaml');
  const cfgPath = path.join(C.HA_CONFIG, 'configuration.yaml');

  // Dar tiempo a HA para que cargue los estados
  await new Promise(r => setTimeout(r, 8000));

  // Verificar si los scripts están en estado "restored" (dominio no cargó)
  let scriptsRestored = false;
  try {
    const states = await haGet('/states');
    const scriptEntities = states.filter(e => e.entity_id.startsWith('script.'));
    scriptsRestored = scriptEntities.length > 0 && scriptEntities.every(e => e.attributes?.restored === true);
    if (scriptEntities.length === 0) {
      // Sin entidades de script — también puede ser que el dominio no cargó
      // Verificar si hay un include roto en configuration.yaml
      if (fs.existsSync(cfgPath)) {
        const cfgContent = fs.readFileSync(cfgPath, 'utf8');
        const hasScriptInclude = cfgContent.split('\n').some(l => /^script\s*:/.test(l.trim()) && !l.trim().startsWith('#'));
        if (hasScriptInclude && !fs.existsSync(scriptsYaml)) {
          scriptsRestored = true; // include existe pero el archivo no → el dominio falla
        }
      }
    }
  } catch (e) {
    console.log(`[boot-recover] No pude verificar estados: ${e.message}`);
    return;
  }

  if (!scriptsRestored) {
    console.log('[boot-recover] Scripts OK — no se necesita recuperación.');
    return;
  }

  console.log('[boot-recover] ⚠️ Scripts en estado "restored" o archivo faltante — buscando backup...');

  // Buscar el backup más reciente de scripts.yaml
  if (!fs.existsSync(C.BACKUPS_DIR)) {
    console.log('[boot-recover] No hay directorio de backups. Creando scripts.yaml vacío como mínimo...');
    fs.writeFileSync(scriptsYaml, '# Scripts de Home Assistant\n');
    return;
  }

  const backupFiles = fs.readdirSync(C.BACKUPS_DIR)
    .filter(f => f.includes('scripts.yaml') && f.endsWith('.bak'))
    .sort()
    .reverse(); // más reciente primero

  if (backupFiles.length === 0) {
    // No hay backup — crear archivo mínimo para que el include no falle
    console.log('[boot-recover] Sin backups de scripts.yaml. Creando archivo mínimo...');
    if (!fs.existsSync(scriptsYaml)) {
      fs.writeFileSync(scriptsYaml, '# Scripts de Home Assistant\n');
    }
    // Recargar scripts
    await haPost('/services/script/reload', {}).catch(() => {});
    console.log('[boot-recover] ✓ scripts.yaml mínimo creado y dominio recargado.');
    return;
  }

  // Restaurar el backup más reciente
  const bestBackup = backupFiles[0];
  const backupPath = path.join(C.BACKUPS_DIR, bestBackup);
  const backupContent = fs.readFileSync(backupPath, 'utf8');

  // Validar que el backup tiene contenido real (no vacío o solo comentarios)
  const hasContent = backupContent.replace(/#[^\n]*/g, '').trim().length > 0;
  if (!hasContent) {
    // El backup está vacío — buscar uno anterior con contenido
    for (const bf of backupFiles.slice(1)) {
      const bc = fs.readFileSync(path.join(C.BACKUPS_DIR, bf), 'utf8');
      if (bc.replace(/#[^\n]*/g, '').trim().length > 0) {
        autoBackup(scriptsYaml);
        fs.copyFileSync(path.join(C.BACKUPS_DIR, bf), scriptsYaml);
        console.log(`[boot-recover] ✓ scripts.yaml restaurado desde backup: ${bf}`);
        await haPost('/services/script/reload', {}).catch(() => {});
        return;
      }
    }
    // Todos los backups están vacíos — crear mínimo
    fs.writeFileSync(scriptsYaml, '# Scripts de Home Assistant\n');
    await haPost('/services/script/reload', {}).catch(() => {});
    return;
  }

  // Restaurar backup con contenido
  if (fs.existsSync(scriptsYaml)) autoBackup(scriptsYaml);
  fs.copyFileSync(backupPath, scriptsYaml);
  console.log(`[boot-recover] ✓ scripts.yaml restaurado desde backup: ${bestBackup}`);

  // Recargar el dominio script
  await haPost('/services/script/reload', {}).catch(() => {});
  console.log('[boot-recover] ✓ Dominio script recargado. Scripts recuperados.');
}

async function bootSelfCheck() {
  try {
    console.log('[self-check] Leyendo mis logs previos para detectar errores...');
    // "jarvis_ai_agent" no es el slug real del add-on instalado (los add-ons locales
    // suelen llevar el prefijo "local_", y puede variar) — /addons/<addon>/logs no
    // acepta "self" como slug, así que hay que resolver el slug real primero via
    // /addons/self/info (ese sí soporta self) antes de pedir los logs.
    const infoRes = await fetch('http://supervisor/addons/self/info', {
      headers: { Authorization: `Bearer ${C.HA_TOKEN}` }
    });
    if (!infoRes.ok) { console.log(`[self-check] No pude resolver mi slug (${infoRes.status})`); return; }
    const selfInfo = await infoRes.json();
    const slug = selfInfo.data?.slug;
    if (!slug) { console.log('[self-check] Slug no disponible en /addons/self/info'); return; }

    const res = await fetch(`http://supervisor/addons/${slug}/logs`, {
      headers: { Authorization: `Bearer ${C.HA_TOKEN}` }
    });
    if (!res.ok) { console.log(`[self-check] Logs no disponibles (${res.status})`); return; }
    const logs = await res.text();

    const hasErrors = /SyntaxError|TypeError|ReferenceError|Cannot find module|^\^$/m.test(logs);
    const bootCount = (logs.match(/Iniciando Jarvis AI Agent/g) || []).length;

    if (!hasErrors && bootCount < 3) {
      console.log('[self-check] Sin errores críticos detectados. OK.');
      return;
    }

    console.log(`[self-check] ⚠️ ${bootCount} reinicios detectados, errores en logs. Autoreparación en 30s...`);

    saveJSON(path.join(C.DATA_DIR, 'self_repair_needed.json'), {
      detectedAt: new Date().toISOString(), bootCount, hasErrors,
      logSnippet: logs.slice(-3000), status: 'pending'
    });

    setTimeout(() => autoRepair(logs), 30_000);
  } catch (e) {
    console.log(`[self-check] Error: ${e.message}`);
  }
}

async function autoRepair(logs) {
  if (!C.OPENAI_API_KEY) return;
  console.log('[self-repair] Iniciando autoreparación automática...');
  try {
    let ownCode = '';
    try { ownCode = fs.readFileSync('/app/server.js', 'utf8'); } catch {}

    const repairPrompt = `Soy Jarvis. Mi servidor Node.js tiene un error que me impide arrancar. Analiza el log y el código y dame el fix.

LOG DE ERROR (últimas líneas):
${logs.slice(-2500)}

${ownCode ? `MI CÓDIGO (server.js, inicio y final):\n${ownCode.slice(0, 1500)}\n[...]\n${ownCode.slice(-2000)}` : ''}

Responde ÚNICAMENTE con este JSON (sin texto extra):
{
  "analysis": "descripción del error",
  "errorLine": "el texto exacto a buscar y reemplazar en server.js",
  "fixedLine": "el texto corregido que lo reemplaza",
  "confidence": "high|medium|low"
}`;

    let repairResult;
    try {
      repairResult = await callLLM(C.BG_MODEL, null, [{ role: 'user', content: repairPrompt }], null, 1024);
    } catch (err) {
      console.log(`[self-repair] API error: ${err.message}`);
      return;
    }
    const text = repairResult.text;
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) { console.log('[self-repair] No pude parsear respuesta:', text.slice(0, 200)); return; }

    const fix = JSON.parse(match[0]);
    console.log(`[self-repair] Análisis: ${fix.analysis} (confianza: ${fix.confidence})`);

    if (fix.confidence !== 'low' && fix.errorLine && fix.fixedLine && ownCode && ownCode.includes(fix.errorLine)) {
      const fixed = ownCode.replace(fix.errorLine, fix.fixedLine);
      fs.writeFileSync('/app/server.js', fixed, 'utf8');
      console.log('[self-repair] ✅ Patch aplicado. Reiniciando en 3s...');

      state.learnings.push({ type: 'self_repair', context: 'Autoreparación de boot', lesson: fix.analysis, solution: fix.errorLine + ' → ' + fix.fixedLine, learnedAt: new Date().toISOString() });
      saveJSON(C.LEARNINGS_FILE, state.learnings);
      saveJSON(path.join(C.DATA_DIR, 'self_repair_needed.json'), { repairedAt: new Date().toISOString(), analysis: fix.analysis, status: 'repaired' });

      setTimeout(async () => {
        try {
          // "jarvis_ai_agent" no es el slug real instalado (suele llevar prefijo
          // "local_") — resolver contra /addons/self/info antes de reiniciar.
          const infoRes = await fetch('http://supervisor/addons/self/info', {
            headers: { Authorization: `Bearer ${C.HA_TOKEN}` }
          });
          const slug = infoRes.ok ? (await infoRes.json()).data?.slug : null;
          if (!slug) { console.log('[self-repair] No pude resolver mi slug para reiniciar.'); return; }
          await fetch(`http://supervisor/addons/${slug}/restart`, {
            method: 'POST', headers: { Authorization: `Bearer ${C.HA_TOKEN}` }
          });
        } catch (e) { console.log('[self-repair] Reinicio:', e.message); }
      }, 3000);
    } else {
      console.log('[self-repair] Confianza baja o fragmento no encontrado — creando pensamiento para revisión.');
      const thoughtsFile = path.join(C.DATA_DIR, 'pending_thoughts.json');
      let thoughts = loadJSON(thoughtsFile, []).filter(t => t.type !== 'self_repair');
      thoughts.push({
        id: Date.now(), type: 'self_repair', priority: 'critical', status: 'pending',
        title: 'Detecté errores en mis logs — necesito revisarme',
        detail: `He detectado errores al arrancar pero no pude autorrepararme automáticamente.\n\nAnálisis: ${fix.analysis}\n\nLog:\n${logs.slice(-1500)}\n\nUSA: get_system_logs → read_file /app/server.js → update_self patch_code → ha_supervisor restart_addon`,
        created: new Date().toISOString()
      });
      saveJSON(thoughtsFile, thoughts);
    }
  } catch (e) {
    console.log(`[self-repair] Error: ${e.message}`);
  }
}

// ── Boot Learn HA — Jarvis estudia la documentación de HA al arrancar ──────

const HA_DOCS_URLS = [
  { url: 'https://www.home-assistant.io/docs/configuration/', topic: 'HA configuration.yaml estructura' },
  { url: 'https://www.home-assistant.io/docs/automation/yaml/', topic: 'HA automatizaciones YAML formato' },
  { url: 'https://www.home-assistant.io/docs/scripts/', topic: 'HA scripts YAML estructura' },
  { url: 'https://www.home-assistant.io/docs/scene/', topic: 'HA scenes YAML estructura' },
  { url: 'https://www.home-assistant.io/integrations/automation/', topic: 'HA automation integration completa' },
  { url: 'https://www.home-assistant.io/docs/configuration/splitting_configuration/', topic: 'HA split configuration includes packages' },
  { url: 'https://www.home-assistant.io/docs/configuration/troubleshooting/', topic: 'HA troubleshooting configuration errores' },
  { url: 'https://www.home-assistant.io/docs/configuration/templating/', topic: 'HA Jinja2 templates avanzado' },
  { url: 'https://developers.home-assistant.io/docs/config_entries_index/', topic: 'HA config entries integraciones internals' },
  { url: 'https://developers.home-assistant.io/docs/entity_registry_index/', topic: 'HA entity registry internals' },
  { url: 'https://developers.home-assistant.io/docs/dev_101_services/', topic: 'HA services internals' },
  { url: 'https://developers.home-assistant.io/docs/api/supervisor/endpoints/', topic: 'HA Supervisor API endpoints completa' },
  { url: 'https://www.home-assistant.io/docs/configuration/events/', topic: 'HA event bus state_changed events' },
  { url: 'https://www.home-assistant.io/integrations/lovelace/', topic: 'HA Lovelace dashboards config modes' },
  { url: 'https://developers.home-assistant.io/docs/add-ons/configuration/', topic: 'HA add-on development config' },
  { url: 'https://www.home-assistant.io/common-tasks/os/#restoring-a-backup', topic: 'HA backup restore proceso' },
  { url: 'https://www.home-assistant.io/docs/mqtt/discovery/', topic: 'HA MQTT discovery auto-config' },
  { url: 'https://www.home-assistant.io/integrations/rest/', topic: 'HA REST integration sensors commands' },
  { url: 'https://www.home-assistant.io/docs/configuration/secrets/', topic: 'HA secrets.yaml gestión segura' },
  { url: 'https://www.home-assistant.io/integrations/recorder/', topic: 'HA recorder database history purge' }
];

const HA_LEARN_STATE_FILE = path.join(C.DATA_DIR, 'ha_learn_state.json');

async function bootLearnHA() {
  try {
    if (!C.ANTHROPIC_API_KEY && !C.OPENAI_API_KEY) return;

    // Comprobar qué docs ya hemos estudiado
    const learnState = loadJSON(HA_LEARN_STATE_FILE, { studied: [], lastRun: null, totalPages: 0 });

    // Estudiar máximo 3 páginas por boot (no sobrecargar)
    const pending = HA_DOCS_URLS.filter(d => !learnState.studied.includes(d.url));
    if (pending.length === 0) {
      console.log(`[ha-learn] Ya he estudiado las ${HA_DOCS_URLS.length} páginas de docs de HA. ✓`);
      return;
    }

    const batch = pending.slice(0, 3);
    console.log(`[ha-learn] Estudiando ${batch.length}/${pending.length} páginas pendientes de docs HA...`);

    for (const doc of batch) {
      try {
        // Fetch la página
        const res = await fetch(doc.url, {
          headers: { 'User-Agent': 'Jarvis-HA-Agent/1.0 (learning)' },
          timeout: 15000
        });
        if (!res.ok) {
          console.log(`[ha-learn] ${doc.topic}: HTTP ${res.status}, saltando.`);
          continue;
        }
        const html = await res.text();

        // Extraer texto principal (eliminar HTML)
        const textContent = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
          .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
          .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&[a-z]+;/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 6000); // Máximo 6000 chars por página

        if (textContent.length < 200) {
          console.log(`[ha-learn] ${doc.topic}: contenido muy corto, saltando.`);
          learnState.studied.push(doc.url);
          continue;
        }

        // Usar LLM para extraer conocimiento estructurado
        const extractPrompt = `Lee esta documentación de Home Assistant y extrae el conocimiento más importante y práctico.
Tema: ${doc.topic}
URL: ${doc.url}

Contenido:
${textContent}

Genera UNA entrada de knowledge_db con:
- title: título descriptivo del tema
- category: "domotica" o "integraciones" o "soluciones"
- content: resumen PRÁCTICO de lo más importante (máximo 800 chars). Incluye: qué hace, cómo configurar, errores comunes, tips.
- tags: 5-8 tags relevantes
- importance: "high"
- source: "${doc.url}"

Solo la llamada a knowledge_db. Español.`;

        const knowledgeTools = state.openAITools.filter(t => t.function.name === 'knowledge_db');
        const result = await callLLM(C.BG_MODEL,
          'Eres Jarvis, experto en Home Assistant. Extrae conocimiento práctico de documentación técnica. Responde SOLO con knowledge_db. Español.',
          [{ role: 'user', content: extractPrompt }],
          knowledgeTools, 1000
        );

        for (const tc of result.toolCalls) {
          if (tc.name === 'knowledge_db') await state.executeTool('knowledge_db', tc.input);
        }

        learnState.studied.push(doc.url);
        learnState.totalPages++;
        console.log(`[ha-learn] ✓ ${doc.topic} — almacenado en knowledge_db`);

        // Pausa entre páginas para no saturar
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        console.log(`[ha-learn] Error en ${doc.topic}: ${e.message}`);
      }
    }

    learnState.lastRun = new Date().toISOString();
    saveJSON(HA_LEARN_STATE_FILE, learnState);
    console.log(`[ha-learn] Sesión completada. ${learnState.studied.length}/${HA_DOCS_URLS.length} páginas estudiadas total.`);
  } catch (e) {
    console.log(`[ha-learn] Error general: ${e.message}`);
  }
}

async function bootLearnOwnProject() {
  try {
    if (!C.ANTHROPIC_API_KEY && !C.OPENAI_API_KEY) return;

    const ownLearnFile = path.join(C.DATA_DIR, 'own_project_learned.json');
    const learnState = loadJSON(ownLearnFile, { learned: false, version: '' });

    // Solo re-aprender si la versión cambió
    const currentVersion = (() => {
      try { return fs.readFileSync('/app/server.js', 'utf8').match(/JARVIS_VERSION\s*=\s*['"]([^'"]+)/)?.[1] || ''; } catch { return ''; }
    })();

    if (learnState.learned && learnState.version === currentVersion) return;

    console.log('[own-project] Estudiando mi propio código para auto-conocimiento...');

    // Leer archivos clave del proyecto
    const filesToStudy = [
      { path: '/app/server.js', name: 'server.js (backend principal)' },
      { path: '/app/index.html', name: 'index.html (UI del chat)' },
      { path: '/config/configuration.yaml', name: 'configuration.yaml (config HA del usuario)' }
    ];

    const projectKnowledge = [];
    for (const file of filesToStudy) {
      try {
        if (!fs.existsSync(file.path)) continue;
        const content = fs.readFileSync(file.path, 'utf8');
        const stats = {
          name: file.name,
          lines: content.split('\n').length,
          size: content.length,
          hasAutomationInclude: file.name.includes('configuration') ? content.includes('automation:') : null
        };
        projectKnowledge.push(stats);
      } catch {}
    }

    // Estudiar la instalación de HA del usuario
    try {
      const configContent = fs.readFileSync(path.join(C.HA_CONFIG, 'configuration.yaml'), 'utf8');
      const includes = [];
      const lines = configContent.split('\n');
      for (const line of lines) {
        if (line.includes('!include') && !line.trim().startsWith('#')) {
          includes.push(line.trim());
        }
      }

      // Guardar como self-knowledge
      const selfKnowledge = loadJSON(path.join(C.DATA_DIR, 'self_knowledge.json'), []);
      const existingIdx = selfKnowledge.findIndex(s => s.title === 'Estructura configuration.yaml del usuario');
      const entry = {
        title: 'Estructura configuration.yaml del usuario',
        content: `Includes activos: ${includes.join(', ') || 'NINGUNO (⚠️ posible problema)'}. Total líneas: ${lines.length}. ${!includes.some(l => l.includes('automation')) ? '⚠️ FALTA automation: !include automations.yaml' : '✓ automation include presente'}`
      };
      if (existingIdx >= 0) selfKnowledge[existingIdx] = entry;
      else selfKnowledge.push(entry);
      saveJSON(path.join(C.DATA_DIR, 'self_knowledge.json'), selfKnowledge);
    } catch (e) {
      console.log(`[own-project] No pude leer configuration.yaml: ${e.message}`);
    }

    saveJSON(ownLearnFile, { learned: true, version: currentVersion, learnedAt: new Date().toISOString(), files: projectKnowledge });
    console.log('[own-project] Auto-conocimiento actualizado. ✓');
  } catch (e) {
    console.log(`[own-project] Error: ${e.message}`);
  }
}

module.exports = { checkEmergencies, bootRecoverScripts, bootSelfCheck, bootLearnHA, bootLearnOwnProject };
