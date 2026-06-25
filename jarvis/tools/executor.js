'use strict';
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const crypto = require('crypto');
const { exec } = require('child_process');
const net = require('net');
const dgram = require('dgram');
const { EdgeTTS } = require('node-edge-tts');
let yaml; try { yaml = require('js-yaml'); } catch { yaml = null; }

const state = require('../utils/state');
const { loadJSON, saveJSON, validateYamlSyntax, validateHAStructure, autoBackup } = require('../utils/persistence');
const { haGet, haPost, supervisorGet } = require('../utils/ha-api');
const { callOpenAI, callImageEdit } = require('../utils/llm');
const { execSync, spawnSync } = require('child_process');
const C = require('../utils/constants');
const { scanInstallation } = require('../utils/scan');

// Lazy-load to avoid circular deps
function getNexus() { return require('../nexus/modules'); }

// Local helper: save conversation history
function saveHistory() {
  const histLimit = state.saverMode ? 15 : 30;
  if (state.conversationHistory.length > histLimit)
    state.conversationHistory = state.conversationHistory.slice(-histLimit);
  saveJSON(C.HISTORY_FILE, state.conversationHistory);
}

// Local helper: push SSE event to all connected clients
function pushToAll(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of state.pushClients) {
    try { res.write(line); } catch { state.pushClients.delete(res); }
  }
}

async function executeTool(name, input) {
  try {
    switch (name) {

      // ─── Dispositivos ───
      case 'get_entities': {
        const now = Date.now();
        if (!state.entitiesCache || now > state.entitiesCache.expiresAt) {
          const raw = await haGet('/states');
          state.entitiesCache = {
            data: raw.map(e => ({ entity_id: e.entity_id, state: e.state, friendly_name: e.attributes?.friendly_name || e.entity_id })),
            expiresAt: now + 30_000
          };
        }
        const filtered = input.domain
          ? state.entitiesCache.data.filter(e => e.entity_id.startsWith(input.domain + '.'))
          : state.entitiesCache.data;
        const limited = filtered.slice(0, 100);
        return { entities: limited, total: filtered.length, note: filtered.length > 100 ? `Mostrando 100/${filtered.length}. Filtra por dominio.` : undefined };
      }

      case 'search_entities': {
        const now = Date.now();
        if (!state.entitiesCache || now > state.entitiesCache.expiresAt) {
          const raw = await haGet('/states');
          state.entitiesCache = { data: raw.map(e => ({ entity_id: e.entity_id, state: e.state, friendly_name: e.attributes?.friendly_name || e.entity_id })), expiresAt: now + 30_000 };
        }
        const q = (input.query || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        const results = state.entitiesCache.data.filter(e => {
          const name = (e.friendly_name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
          const id = e.entity_id.toLowerCase();
          return name.includes(q) || id.includes(q);
        });
        return { entities: results.slice(0, 50), total: results.length };
      }

      case 'get_entity_state': {
        const entityState = await haGet(`/states/${input.entity_id}`);
        return { entity_id: entityState.entity_id, state: entityState.state, attributes: entityState.attributes, last_changed: entityState.last_changed };
      }

      case 'call_service': {
        // Validar formato domain y service (solo letras, números, guión bajo)
        if (!input.domain || !/^[a-z0-9_]+$/.test(input.domain)) {
          return { error: `Dominio inválido: "${input.domain}". Solo se permiten letras minúsculas, números y guiones bajos.` };
        }
        if (!input.service || !/^[a-z0-9_]+$/.test(input.service)) {
          return { error: `Servicio inválido: "${input.service}". Solo se permiten letras minúsculas, números y guiones bajos.` };
        }
        const body = { ...(input.service_data || {}) };
        if (input.entity_id) body.entity_id = input.entity_id;
        await haPost(`/services/${input.domain}/${input.service}`, body);
        return { success: true, message: `${input.domain}.${input.service} ejecutado OK` };
      }

      case 'get_history': {
        const hours = Math.min(input.hours || 6, 48);
        const maxRec = input.max_records || 200; // antes hardcodeado a 30 — ahora configurable
        const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
        const history = await haGet(`/history/period/${since}?filter_entity_id=${input.entity_id}&minimal_response=true`);
        const records = (history[0] || []).slice(-maxRec);
        return records.map(h => ({ state: h.state, time: h.last_changed }));
      }

      case 'get_logbook': {
        const lbHours = Math.min(input.hours || 24, 72);
        const lbSince = new Date(Date.now() - lbHours * 3600 * 1000).toISOString();
        let lbUrl = `/logbook/${lbSince}?`;
        if (input.entity_id) lbUrl += `entity=${encodeURIComponent(input.entity_id)}&`;
        const entries = await haGet(lbUrl.replace(/\?$|&$/, ''));
        let filtered = Array.isArray(entries) ? entries : [];
        if (input.domain && !input.entity_id) {
          filtered = filtered.filter(e => e.entity_id && e.entity_id.startsWith(input.domain + '.'));
        }
        return filtered.slice(-300).map(e => ({
          time: e.when, entity: e.entity_id, name: e.name, message: e.message, domain: e.domain
        }));
      }

      // ─── Automatizaciones ───
      case 'get_automations': {
        const states = await haGet('/states');
        return states.filter(e => e.entity_id.startsWith('automation.')).map(e => ({
          entity_id: e.entity_id, name: e.attributes?.friendly_name || e.entity_id, state: e.state
        }));
      }

      case 'create_automation': {
        const automationsPath = path.join(C.HA_CONFIG, 'automations.yaml');
        const configYamlPath = path.join(C.HA_CONFIG, 'configuration.yaml');

        // 1. Validar YAML del contenido antes de tocar nada
        const newEntry = '\n- ' + input.yaml_content.replace(/\n/g, '\n  ') + '\n';
        const yamlValidErr = validateYamlSyntax(input.yaml_content);
        if (yamlValidErr) {
          return { error: `YAML inválido — automatización NO creada: ${yamlValidErr}`, hint: 'Revisa indentación (2 espacios), que trigger: y action: existen, y que no hay tabs.' };
        }
        const structErr = validateHAStructure(input.yaml_content, 'automations');
        if (structErr) {
          return { error: `Estructura inválida — automatización NO creada: ${structErr}` };
        }

        // 2. Verificar include en configuration.yaml
        let configFixed = false;
        try {
          if (fs.existsSync(configYamlPath)) {
            const configContent = fs.readFileSync(configYamlPath, 'utf8');
            const hasLine = configContent.split('\n').some(l => /^automation\s*:/.test(l.trim()) && !l.trim().startsWith('#'));
            if (!hasLine) {
              autoBackup(configYamlPath);
              fs.appendFileSync(configYamlPath, '\nautomation: !include automations.yaml\n');
              configFixed = true;
              console.log('[automation] Añadido include a configuration.yaml');
              try { await haPost('/services/homeassistant/reload_core_config', {}); } catch {}
            }
          }
        } catch (e) { console.log(`[automation] Error cfg: ${e.message}`); }

        // 3. Leer archivo actual, validar resultado completo, escribir
        let existing = '';
        if (fs.existsSync(automationsPath)) {
          autoBackup(automationsPath);
          existing = fs.readFileSync(automationsPath, 'utf8');
        }
        const proposed = existing + newEntry;
        const proposedErr = validateYamlSyntax(proposed);
        if (proposedErr) {
          return { error: `El archivo resultante tendría YAML inválido: ${proposedErr}. Automatización NO creada.` };
        }
        fs.writeFileSync(automationsPath, proposed);
        console.log(`[automation] Creada: ${input.description}`);

        // 4. Reload y verificar que no hay "restored"
        try { await haPost('/services/automation/reload', {}); } catch {}
        await new Promise(r => setTimeout(r, 2500));
        let restoredWarning = '';
        try {
          const states = await haGet('/states');
          const restored = states.filter(e => e.entity_id.startsWith('automation.') && e.attributes?.restored === true);
          if (restored.length > 0) restoredWarning = ` ⚠ ${restored.length} automatizaciones en estado "restored" — verifica que el include existe en configuration.yaml`;
        } catch {}

        const fixMsg = configFixed ? ' [Añadido include en configuration.yaml]' : '';
        return { success: true, message: `Automatización creada: ${input.description}. Config recargada.${fixMsg}${restoredWarning}` };
      }

      case 'reload_config': {
        const reloads = {
          automations: '/services/automation/reload',
          scripts: '/services/script/reload',
          scenes: '/services/scene/reload',
          groups: '/services/group/reload',
          core: '/services/homeassistant/reload_core_config',
          all: '/services/homeassistant/reload_all'
        };
        const endpoint = reloads[input.target];
        if (!endpoint) return { error: `Target inválido: ${input.target}` };
        await haPost(endpoint, {});
        return { success: true, message: `${input.target} recargado` };
      }

      // ─── Filesystem ───
      case 'read_file': {
        // Bloqueo de seguridad inamovible: /proc expone variables del sistema operativo
        if (input.filepath.startsWith('/proc/') || input.filepath.startsWith('/sys/')) {
          console.log(`[SECURITY] Intento de leer ruta de sistema bloqueado: ${input.filepath}`);
          return { error: 'ACCESO DENEGADO: Las rutas /proc/ y /sys/ están bloqueadas por seguridad. Esta restricción es inamovible.' };
        }
        const resolvedFp = path.resolve(input.filepath);
        const allowed = [C.HA_CONFIG, C.HA_ADDONS, C.HA_SHARE, C.HA_MEDIA, C.DATA_DIR].map(p => path.resolve(p));
        if (!allowed.some(p => resolvedFp.startsWith(p + path.sep) || resolvedFp === p)) {
          return { error: `Ruta no permitida. Usa: ${allowed.join(', ')}` };
        }
        if (!fs.existsSync(resolvedFp)) return { error: `Archivo no existe: ${input.filepath}` };
        const content = fs.readFileSync(resolvedFp, 'utf8');
        const lines = content.split('\n');
        // Default 500 líneas (antes: 200 — insuficiente para automations.yaml de ~1200 líneas)
        // Usar offset para paginar ficheros grandes: read_file(path, lines:500, offset:500)
        const maxLines  = input.lines  || 500;
        const startLine = input.offset || 0;
        const slice     = lines.slice(startLine, startLine + maxLines);
        return {
          content: slice.join('\n'),
          totalLines: lines.length,
          startLine,
          endLine: startLine + slice.length,
          truncated: (startLine + slice.length) < lines.length,
          hint_pagination: lines.length > maxLines
            ? `Archivo tiene ${lines.length} líneas. Leídas ${startLine+1}–${startLine+slice.length}. Para continuar: read_file(path, lines:500, offset:${startLine+maxLines})`
            : undefined
        };
      }

      case 'write_file': {
        const allowedWrite = [C.HA_CONFIG, C.HA_SHARE, C.DATA_DIR];
        if (!allowedWrite.some(p => input.filepath.startsWith(p))) {
          return { error: `Escritura no permitida en esa ruta. Usa: ${allowedWrite.join(', ')}` };
        }
        // Protección de archivos críticos de HA — sobreescritura completa requiere confirmación
        const CRITICAL_FILES = ['automations.yaml', 'configuration.yaml', 'scripts.yaml', 'scenes.yaml', 'secrets.yaml'];
        const basename = path.basename(input.filepath);
        if (CRITICAL_FILES.includes(basename) && input.filepath.startsWith(C.HA_CONFIG)) {
          if (!input.adrian_confirmed) {
            return {
              error: `PROTECCIÓN: ${basename} es un archivo crítico de HA. Sobreescribirlo borra TODO su contenido actual. Para crear automatizaciones usa create_automation (que AÑADE sin borrar). Si realmente necesitas sobreescribir el archivo completo, pide confirmación a Adrián y repite con adrian_confirmed:true.`,
              backup_hint: 'Los backups están en /data/backups/ si necesitas recuperar.'
            };
          }
          console.log(`[CRITICAL] Sobreescritura confirmada de ${basename}`);
        }
        // Validación YAML automática para archivos .yaml de HA
        if ((input.filepath.endsWith('.yaml') || input.filepath.endsWith('.yml')) && input.filepath.startsWith(C.HA_CONFIG)) {
          const yamlErr = validateYamlSyntax(input.content);
          if (yamlErr) return { error: `ESCRITURA BLOQUEADA: YAML inválido — ${yamlErr}`, hint: 'Corrige el error antes de volver a intentarlo.' };
        }
        const backupMade = autoBackup(input.filepath);
        const dir = path.dirname(input.filepath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(input.filepath, input.content);
        console.log(`[fs] Escrito: ${input.filepath} (${input.content.length} chars)`);
        return { success: true, message: `Archivo escrito: ${input.filepath}${backupMade ? ` (backup: ${path.basename(backupMade)})` : ''}` };
      }

      case 'append_file': {
        const allowedAppend = [C.HA_CONFIG, C.HA_SHARE, C.DATA_DIR];
        if (!allowedAppend.some(p => input.filepath.startsWith(p))) {
          return { error: `Escritura no permitida en esa ruta` };
        }
        // Protección de archivos críticos — igual que write_file
        const CRITICAL_FILES_APPEND = ['automations.yaml', 'configuration.yaml', 'scripts.yaml', 'scenes.yaml', 'secrets.yaml'];
        const basenameAppend = path.basename(input.filepath);
        if (CRITICAL_FILES_APPEND.includes(basenameAppend) && input.filepath.startsWith(C.HA_CONFIG)) {
          if (!input.adrian_confirmed) {
            return {
              error: `PROTECCIÓN: ${basenameAppend} es un archivo crítico de HA. Para añadir contenido necesito confirmación de Adrián. Muéstrale qué quieres añadir y espera a que diga "sí, hazlo" antes de repetir con adrian_confirmed:true.`,
              backup_hint: 'Los backups están en /data/backups/ si necesitas recuperar.'
            };
          }
          console.log(`[CRITICAL] Append confirmado en ${basenameAppend}`);
        }
        // Validar que el resultado completo (existente + nuevo) sea YAML válido
        if ((input.filepath.endsWith('.yaml') || input.filepath.endsWith('.yml')) && input.filepath.startsWith(C.HA_CONFIG)) {
          const existingContent = fs.existsSync(input.filepath) ? fs.readFileSync(input.filepath, 'utf8') : '';
          const combined = existingContent + input.content;
          const yamlErr = validateYamlSyntax(combined);
          if (yamlErr) return { error: `APPEND BLOQUEADO: el archivo resultante tendría YAML inválido — ${yamlErr}`, hint: 'Revisa la indentación y sintaxis del contenido que quieres añadir.' };
        }
        const backupMadeAppend = autoBackup(input.filepath);
        fs.appendFileSync(input.filepath, input.content);
        console.log(`[fs] Append: ${input.filepath} (+${input.content.length} chars)`);
        return { success: true, message: `Contenido añadido a: ${input.filepath}${backupMadeAppend ? ` (backup: ${path.basename(backupMadeAppend)})` : ''}` };
      }

      case 'patch_file': {
        const allowedPatch = [C.HA_CONFIG, C.HA_SHARE, C.DATA_DIR];
        if (!allowedPatch.some(p => input.filepath.startsWith(p)))
          return { error: `Ruta no permitida para patch_file: ${input.filepath}` };
        if (!fs.existsSync(input.filepath))
          return { error: `Archivo no existe: ${input.filepath}. Usa write_file para crearlo.` };

        const patchContent = fs.readFileSync(input.filepath, 'utf8');
        const oldStr = input.old_str;
        const newStr = input.new_str;
        const expected = input.expected_replacements || 1;

        // Contar ocurrencias
        let count = 0, idx = patchContent.indexOf(oldStr);
        while (idx !== -1) { count++; idx = patchContent.indexOf(oldStr, idx + 1); }

        if (count === 0) {
          const preview = patchContent.split('\n').slice(0, 25).join('\n');
          return {
            error: `PATCH FALLIDO: old_str no encontrado en el archivo.`,
            hint: 'Usa read_file primero y copia el texto exactamente como aparece, incluyendo espacios e indentación.',
            file_preview_25_lines: preview
          };
        }
        if (count !== expected) {
          return {
            error: `PATCH ABORTADO: esperaba ${expected} ocurrencia(s) pero encontré ${count}. Añade más contexto a old_str para hacerlo único.`,
            occurrences_found: count
          };
        }

        // Validar YAML resultado antes de escribir
        if (input.filepath.endsWith('.yaml') || input.filepath.endsWith('.yml')) {
          const proposed = patchContent.replace(oldStr, newStr);
          const yamlErr = validateYamlSyntax(proposed);
          if (yamlErr) return { error: `PATCH ABORTADO: el resultado tendría YAML inválido — ${yamlErr}`, hint: 'Revisa la indentación (2 espacios en HA) y la sintaxis antes de reintentar.' };
        }

        const patchBackup = autoBackup(input.filepath);
        const patched = patchContent.replace(oldStr, newStr);
        fs.writeFileSync(input.filepath, patched);
        console.log(`[patch] ${path.basename(input.filepath)}: ${oldStr.length}→${newStr.length} chars`);
        return { success: true, message: `Patch aplicado en ${path.basename(input.filepath)}`, backup: patchBackup ? path.basename(patchBackup) : null };
      }

      case 'validate_yaml': {
        const syntaxErr = validateYamlSyntax(input.content);
        if (syntaxErr) return { valid: false, error: syntaxErr, type: 'syntax_error' };
        const structErr = validateHAStructure(input.content, input.file_type);
        if (structErr) return { valid: false, error: structErr, type: 'structure_error' };
        return { valid: true, message: 'YAML válido — sintaxis y estructura correctas para HA' };
      }

      case 'list_directory': {
        const allowed = [C.HA_CONFIG, C.HA_ADDONS, C.HA_SHARE, C.HA_MEDIA, C.DATA_DIR];
        if (!allowed.some(p => input.dirpath.startsWith(p))) {
          return { error: `Ruta no permitida` };
        }
        if (!fs.existsSync(input.dirpath)) return { error: `Directorio no existe: ${input.dirpath}` };

        if (input.recursive) {
          const walk = (dir, prefix = '') => {
            let results = [];
            const items = fs.readdirSync(dir, { withFileTypes: true });
            for (const item of items) {
              const rel = prefix ? `${prefix}/${item.name}` : item.name;
              if (item.isDirectory()) {
                results.push({ name: rel + '/', type: 'dir' });
                results = results.concat(walk(path.join(dir, item.name), rel));
              } else {
                const stat = fs.statSync(path.join(dir, item.name));
                results.push({ name: rel, type: 'file', size: stat.size });
              }
            }
            return results;
          };
          const items = walk(input.dirpath).slice(0, 200);
          return { items, total: items.length };
        } else {
          const items = fs.readdirSync(input.dirpath, { withFileTypes: true }).map(item => ({
            name: item.name,
            type: item.isDirectory() ? 'dir' : 'file',
            size: item.isFile() ? fs.statSync(path.join(input.dirpath, item.name)).size : undefined
          }));
          return { items, path: input.dirpath };
        }
      }

      // ─── Internet ───
      case 'web_search': {
        // Primario: Serper (Google). Fallback: DuckDuckGo
        if (C.SERPER_API_KEY) {
          try {
            const serperRes = await fetch('https://google.serper.dev/search', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-API-KEY': C.SERPER_API_KEY },
              body: JSON.stringify({ q: input.query, num: 8, hl: 'es' })
            });
            if (serperRes.ok) {
              const serperData = await serperRes.json();
              const results = (serperData.organic || []).slice(0, 8).map(r => ({
                url: r.link, title: r.title, snippet: r.snippet || ''
              }));
              if (serperData.answerBox) results.unshift({ url: '', title: 'Respuesta directa', snippet: serperData.answerBox.answer || serperData.answerBox.snippet || '' });
              return { query: input.query, results, source: 'google', count: results.length };
            }
          } catch (e) {
            console.log('[search] Serper falló, usando DuckDuckGo:', e.message);
          }
        }
        // Fallback DuckDuckGo
        const encoded = encodeURIComponent(input.query);
        const res = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HABot/1.0)' }
        });
        const html = await res.text();
        const results = [];
        const regex = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        let match;
        while ((match = regex.exec(html)) && results.length < 8) {
          results.push({
            url: match[1],
            title: match[2].replace(/<[^>]+>/g, '').trim(),
            snippet: match[3].replace(/<[^>]+>/g, '').trim()
          });
        }
        return { query: input.query, results, source: 'duckduckgo', count: results.length };
      }

      case 'fetch_url': {
        // Bloqueo de seguridad inamovible: no registrarse en servicios externos sin permiso
        const method = (input.method || 'GET').toUpperCase();
        if (['POST', 'PUT', 'PATCH'].includes(method)) {
          console.log(`[SECURITY] Intento de ${method} externo bloqueado: ${input.url}`);
          return { error: `ACCESO DENEGADO: fetch_url solo permite GET. Los métodos POST/PUT/PATCH a servicios externos (registros, formularios, APIs) requieren confirmación explícita de Adrián. Esta restricción es inamovible.` };
        }
        // Solo HTTP/HTTPS — prevenir file://, gopher://, etc.
        try {
          const parsedUrl = new URL(input.url);
          if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            return { error: `Protocolo no permitido: "${parsedUrl.protocol}". Solo HTTP y HTTPS están permitidos.` };
          }
        } catch {
          return { error: `URL inválida: ${input.url}` };
        }
        const res = await fetch(input.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HABot/1.0)' },
          timeout: 10000
        });
        let text = await res.text();
        // Limpiar HTML básico
        text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
        text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
        text = text.replace(/<[^>]+>/g, ' ');
        text = text.replace(/\s+/g, ' ').trim();
        const maxChars = input.max_chars || 5000;
        return { url: input.url, content: text.slice(0, maxChars), truncated: text.length > maxChars };
      }

      // ─── Memoria y aprendizaje ───
      case 'save_memory': {
        // Dedup: si ya existe una nota muy similar (>80% overlap), actualizarla en vez de duplicar
        const newNote = input.note.toLowerCase().trim();
        const dupIdx = state.userMemory.findIndex(m => {
          const existing = m.note.toLowerCase().trim();
          if (existing === newNote) return true;
          const shorter = existing.length < newNote.length ? existing : newNote;
          const longer = existing.length < newNote.length ? newNote : existing;
          return shorter.length > 20 && longer.includes(shorter);
        });
        if (dupIdx >= 0) {
          state.userMemory[dupIdx] = { note: input.note, category: input.category, savedAt: new Date().toISOString() };
          saveJSON(C.MEMORY_FILE, state.userMemory);
          return { success: true, action: 'updated_existing', total: state.userMemory.length };
        }
        state.userMemory.push({ note: input.note, category: input.category, savedAt: new Date().toISOString() });
        // Cap: máximo 500 notas — elimina las más antiguas si se supera
        const MEMORY_CAP = 500;
        if (state.userMemory.length > MEMORY_CAP) {
          const removed = state.userMemory.length - MEMORY_CAP;
          state.userMemory.splice(0, removed);
          console.log(`[memory] Cap alcanzado — eliminadas ${removed} notas antiguas`);
        }
        saveJSON(C.MEMORY_FILE, state.userMemory);
        console.log(`[memory] +${input.category}: "${input.note}"`);
        return { success: true, total: state.userMemory.length };
      }

      case 'get_memory': {
        let filtered = state.userMemory;
        if (input.category) filtered = filtered.filter(m => m.category === input.category);
        if (input.search) {
          const s = input.search.toLowerCase();
          filtered = filtered.filter(m => m.note.toLowerCase().includes(s));
        }
        return { memories: filtered, total: filtered.length };
      }

      case 'delete_memory': {
        if (input.index >= 0 && input.index < state.userMemory.length) {
          const removed = state.userMemory.splice(input.index, 1)[0];
          saveJSON(C.MEMORY_FILE, state.userMemory);
          return { success: true, removed: removed.note };
        }
        return { error: 'Índice fuera de rango' };
      }

      case 'learn': {
        const learning = {
          type: input.type,
          context: input.context,
          lesson: input.lesson,
          solution: input.solution || null,
          learnedAt: new Date().toISOString()
        };
        state.learnings.push(learning);
        // Limitar a 200 learnings
        if (state.learnings.length > 200) state.learnings = state.learnings.slice(-200);
        saveJSON(C.LEARNINGS_FILE, state.learnings);
        console.log(`[learn] ${input.type}: ${input.lesson}`);
        return { success: true, total_learnings: state.learnings.length };
      }

      // ─── Instalación ───
      case 'scan_installation': {
        const map = await scanInstallation();
        return { success: true, totalEntities: map.totalEntities, integrations: (map.integrations || []).length, addons: (map.addons || []).length, message: 'Instalación escaneada y mapa actualizado' };
      }

      case 'check_config': {
        try {
          const result = await haPost('/services/homeassistant/check_config', {});
          const isValid = result.result === 'valid';
          return {
            ...result,
            safe_to_reload: isValid,
            summary: isValid
              ? '✓ Configuración válida — seguro hacer reload'
              : `✗ ERRORES DETECTADOS — NO recargar hasta corregir: ${JSON.stringify(result.errors || result)}`
          };
        } catch (err) {
          try {
            const check = await supervisorGet('/core/check');
            const d = check.data || {};
            return { ...d, safe_to_reload: !d.error, summary: d.error ? `✗ ${d.error}` : '✓ OK según supervisor' };
          } catch {
            return { error: err.message, safe_to_reload: false };
          }
        }
      }

      // ─── Dashboards / Lovelace ───
      case 'get_dashboards': {
        // Listar dashboards desde .storage o API
        try {
          const res = await fetch(`${C.HA_URL}/api/lovelace/dashboards`, {
            headers: { Authorization: `Bearer ${C.HA_TOKEN}`, 'Content-Type': 'application/json' }
          });
          if (res.ok) {
            const dashboards = await res.json();
            // Añadir siempre el default
            const result = [{ id: 'lovelace', title: 'Default Dashboard', mode: 'storage' }];
            for (const d of dashboards) {
              result.push({ id: d.url_path || d.id, title: d.title, mode: d.mode, icon: d.icon });
            }
            return { dashboards: result, total: result.length };
          }
          // Fallback: leer .storage
          const storageDir = path.join(C.HA_CONFIG, '.storage');
          if (fs.existsSync(storageDir)) {
            const files = fs.readdirSync(storageDir).filter(f => f.startsWith('lovelace'));
            return { dashboards: files.map(f => ({ id: f.replace('lovelace.', '').replace('lovelace', 'lovelace'), file: f })), total: files.length };
          }
          return { dashboards: [], note: 'No se encontraron dashboards' };
        } catch (err) {
          return { error: err.message };
        }
      }

      case 'get_dashboard_config': {
        const dashId = input.dashboard_id || 'lovelace';
        try {
          // Intentar via API primero
          const endpoint = dashId === 'lovelace' ? '/api/lovelace/config' : `/api/lovelace/config/${dashId}`;
          const res = await fetch(`${C.HA_URL}${endpoint}`, {
            headers: { Authorization: `Bearer ${C.HA_TOKEN}`, 'Content-Type': 'application/json' }
          });
          if (res.ok) {
            const config = await res.json();
            // Resumir para no saturar el contexto
            const summary = {
              title: config.title,
              views: (config.views || []).map(v => ({
                title: v.title || v.path || 'Sin nombre',
                path: v.path,
                icon: v.icon,
                cards_count: (v.cards || []).length,
                cards: (v.cards || []).map(c => ({
                  type: c.type,
                  title: c.title || c.name,
                  entities: c.entities ? c.entities.length : (c.entity ? 1 : 0)
                }))
              })),
              total_views: (config.views || []).length
            };
            return { dashboard_id: dashId, config: summary, raw_available: true };
          }
          // Fallback: leer de .storage
          const storageFile = dashId === 'lovelace'
            ? path.join(C.HA_CONFIG, '.storage', 'lovelace')
            : path.join(C.HA_CONFIG, '.storage', `lovelace.${dashId}`);
          if (fs.existsSync(storageFile)) {
            const raw = JSON.parse(fs.readFileSync(storageFile, 'utf8'));
            const config = raw.data?.config || raw;
            const summary = {
              title: config.title,
              views: (config.views || []).map(v => ({
                title: v.title || v.path || 'Sin nombre',
                path: v.path,
                cards_count: (v.cards || []).length,
                cards: (v.cards || []).slice(0, 20).map(c => ({
                  type: c.type,
                  title: c.title || c.name,
                  entities: c.entities ? c.entities.slice(0, 5) : (c.entity ? [c.entity] : [])
                }))
              }))
            };
            return { dashboard_id: dashId, config: summary, source: 'storage_file' };
          }
          // YAML mode
          const yamlFile = path.join(C.HA_CONFIG, 'ui-lovelace.yaml');
          if (fs.existsSync(yamlFile)) {
            const content = fs.readFileSync(yamlFile, 'utf8');
            return { dashboard_id: dashId, yaml_content: content.slice(0, 8000), source: 'yaml_file', truncated: content.length > 8000 };
          }
          return { error: `Dashboard '${dashId}' no encontrado` };
        } catch (err) {
          return { error: err.message };
        }
      }

      case 'update_dashboard': {
        const dashId = input.dashboard_id || 'lovelace';
        try {
          // Backup antes de modificar
          const backupDir = path.join(C.DATA_DIR, 'backups');
          if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

          // Intentar leer config actual para backup
          const endpoint = dashId === 'lovelace' ? '/api/lovelace/config' : `/api/lovelace/config/${dashId}`;
          try {
            const currentRes = await fetch(`${C.HA_URL}${endpoint}`, {
              headers: { Authorization: `Bearer ${C.HA_TOKEN}`, 'Content-Type': 'application/json' }
            });
            if (currentRes.ok) {
              const currentConfig = await currentRes.json();
              const backupFile = path.join(backupDir, `dashboard_${dashId}_${Date.now()}.json`);
              fs.writeFileSync(backupFile, JSON.stringify(currentConfig, null, 2));
              console.log(`[dashboard] Backup guardado: ${backupFile}`);
            }
          } catch {}

          // Aplicar nueva config via API
          const saveRes = await fetch(`${C.HA_URL}${endpoint}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${C.HA_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(input.config)
          });

          if (saveRes.ok) {
            console.log(`[dashboard] Dashboard '${dashId}' actualizado`);
            return { success: true, message: `Dashboard '${dashId}' actualizado. Backup guardado.` };
          } else {
            const errText = await saveRes.text();
            return { error: `Error al guardar dashboard: ${saveRes.status} - ${errText}` };
          }
        } catch (err) {
          return { error: err.message };
        }
      }

      case 'get_installed_frontend': {
        const resources = [];
        try {
          // Leer recursos Lovelace registrados
          const res = await fetch(`${C.HA_URL}/api/lovelace/resources`, {
            headers: { Authorization: `Bearer ${C.HA_TOKEN}`, 'Content-Type': 'application/json' }
          });
          if (res.ok) {
            const data = await res.json();
            for (const r of data) {
              resources.push({ url: r.url, type: r.type, id: r.id });
            }
          }
        } catch {}

        // HACS frontend
        try {
          const hacsDir = path.join(C.HA_CONFIG, 'custom_components', 'hacs');
          const hacsInstalled = fs.existsSync(hacsDir);

          if (hacsInstalled) {
            // Leer carpeta www/community para cards HACS
            const wwwCommunity = path.join(C.HA_CONFIG, 'www', 'community');
            if (fs.existsSync(wwwCommunity)) {
              const folders = fs.readdirSync(wwwCommunity, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name);
              resources.push({ source: 'hacs_frontend', cards: folders });
            }
          }

          // Custom cards sueltas en www
          const wwwDir = path.join(C.HA_CONFIG, 'www');
          if (fs.existsSync(wwwDir)) {
            const jsFiles = fs.readdirSync(wwwDir).filter(f => f.endsWith('.js'));
            if (jsFiles.length > 0) {
              resources.push({ source: 'www_custom', files: jsFiles });
            }
          }
        } catch {}

        // Temas
        try {
          const themesDir = path.join(C.HA_CONFIG, 'themes');
          if (fs.existsSync(themesDir)) {
            const themes = fs.readdirSync(themesDir);
            resources.push({ source: 'themes', items: themes });
          }
        } catch {}

        return { resources, total: resources.length, hacs_installed: fs.existsSync(path.join(C.HA_CONFIG, 'custom_components', 'hacs')) };
      }

      case 'search_hacs_resources': {
        const type = input.type || 'all';
        const searchQuery = `home assistant ${type === 'frontend' ? 'lovelace card' : type === 'integration' ? 'custom integration' : ''} ${input.query} HACS`;
        const encoded = encodeURIComponent(searchQuery);
        try {
          const res = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HABot/1.0)' }
          });
          const html = await res.text();
          const results = [];
          const regex = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
          let match;
          while ((match = regex.exec(html)) && results.length < 10) {
            results.push({
              url: match[1],
              title: match[2].replace(/<[^>]+>/g, '').trim(),
              snippet: match[3].replace(/<[^>]+>/g, '').trim()
            });
          }
          return { query: input.query, type, results, count: results.length, note: 'Usa fetch_url para ver detalles de instalación de cualquier resultado' };
        } catch (err) {
          return { error: err.message };
        }
      }

      case 'install_hacs_resource': {
        try {
          if (input.type === 'frontend') {
            // Descargar JS a /config/www/
            const wwwDir = path.join(C.HA_CONFIG, 'www');
            if (!fs.existsSync(wwwDir)) fs.mkdirSync(wwwDir, { recursive: true });

            const filename = input.name.endsWith('.js') ? input.name : `${input.name}.js`;
            const filePath = path.join(wwwDir, filename);

            // Descargar archivo
            const res = await fetch(input.url, {
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HABot/1.0)' },
              timeout: 30000
            });
            if (!res.ok) return { error: `Error descargando: ${res.status}` };

            const buffer = await res.buffer();
            fs.writeFileSync(filePath, buffer);
            console.log(`[install] Card descargada: ${filePath} (${buffer.length} bytes)`);

            // Registrar como recurso Lovelace
            try {
              const resourceUrl = `/local/${filename}`;
              await fetch(`${C.HA_URL}/api/lovelace/resources`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${C.HA_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: resourceUrl, res_type: 'module' })
              });
              console.log(`[install] Recurso registrado: ${resourceUrl}`);
            } catch (regErr) {
              console.log(`[install] No se pudo registrar automáticamente: ${regErr.message}`);
            }

            return { success: true, message: `Card '${input.name}' instalada en ${filePath}. Registrada como recurso Lovelace. Puede necesitar recargar el navegador.`, path: filePath };
          } else if (input.type === 'integration') {
            // Para integraciones necesitamos descargar el repo/zip
            const ccDir = path.join(C.HA_CONFIG, 'custom_components', input.name);
            if (!fs.existsSync(ccDir)) fs.mkdirSync(ccDir, { recursive: true });

            // Si es un zip de GitHub
            const res = await fetch(input.url, {
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HABot/1.0)' },
              timeout: 60000
            });
            if (!res.ok) return { error: `Error descargando: ${res.status}` };

            const content = await res.text();
            // Si es un solo archivo Python, guardarlo directamente
            if (input.url.endsWith('.py')) {
              fs.writeFileSync(path.join(ccDir, path.basename(input.url)), content);
            } else {
              // Guardar como referencia, el usuario necesitará instalar manualmente o via HACS
              fs.writeFileSync(path.join(ccDir, 'INSTALL_NOTES.txt'),
                `Integración: ${input.name}\nFuente: ${input.url}\nFecha: ${new Date().toISOString()}\n\nNOTA: Para integraciones complejas, usa HACS o descarga el repo manualmente.`);
              return { success: false, message: `Integración '${input.name}' es compleja. Recomiendo instalarla via HACS. Repo: ${input.url}`, suggestion: 'Instalar HACS primero si no lo tienes, luego añadir el repo como repositorio custom.' };
            }
            return { success: true, message: `Integración '${input.name}' instalada. Reinicia HA para activarla.` };
          }
          return { error: 'Tipo no válido. Usa "frontend" o "integration".' };
        } catch (err) {
          return { error: err.message };
        }
      }

      case 'ha_knowledge': {
        // Buscar en documentación oficial de HA + blogs + foros
        const topic = input.topic;
        const version = input.version || '';
        const searches = [
          `site:home-assistant.io ${topic} ${version}`,
          `home assistant ${topic} documentation ${version}`
        ];

        const allResults = [];
        for (const query of searches) {
          try {
            const encoded = encodeURIComponent(query);
            const res = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HABot/1.0)' }
            });
            const html = await res.text();
            const regex = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
            let match;
            while ((match = regex.exec(html)) && allResults.length < 8) {
              const url = match[1];
              if (!allResults.some(r => r.url === url)) {
                allResults.push({
                  url,
                  title: match[2].replace(/<[^>]+>/g, '').trim(),
                  snippet: match[3].replace(/<[^>]+>/g, '').trim()
                });
              }
            }
          } catch {}
        }

        // Intentar obtener contenido del primer resultado de docs oficial
        let docContent = '';
        const officialDoc = allResults.find(r => r.url.includes('home-assistant.io'));
        if (officialDoc) {
          try {
            const res = await fetch(officialDoc.url, {
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HABot/1.0)' },
              timeout: 10000
            });
            let text = await res.text();
            // Limpiar HTML
            text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
            text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
            text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
            text = text.replace(/<header[\s\S]*?<\/header>/gi, '');
            text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
            text = text.replace(/<[^>]+>/g, ' ');
            text = text.replace(/\s+/g, ' ').trim();
            docContent = text.slice(0, 4000);
          } catch {}
        }

        return {
          topic,
          results: allResults,
          official_doc: docContent || null,
          note: 'Usa fetch_url para profundizar en cualquier enlace. Registra lo importante con learn().'
        };
      }

      // ─── Proxmox ───
      case 'proxmox_api': {
        if (!C.PROXMOX_URL || !C.PROXMOX_TOKEN) {
          return { error: 'Proxmox no configurado. Añade PROXMOX_URL y PROXMOX_TOKEN en la configuración del add-on.' };
        }

        const node = C.PROXMOX_NODE;
        // Parse token: puede ser "user@pam!tokenid=secret" o ya formateado
        const authHeader = C.PROXMOX_TOKEN.includes('=')
          ? `PVEAPIToken=${C.PROXMOX_TOKEN}`
          : `PVEAPIToken=${C.PROXMOX_TOKEN}`;

        const proxGet = async (endpoint) => {
          const res = await fetch(`${C.PROXMOX_URL}/api2/json${endpoint}`, {
            headers: { Authorization: authHeader },
            // Proxmox usa self-signed certs normalmente
            ...(C.PROXMOX_URL.startsWith('https') ? {} : {})
          });
          if (!res.ok) throw new Error(`Proxmox ${endpoint} → ${res.status}: ${await res.text()}`);
          return res.json();
        };

        const proxPost = async (endpoint, body = {}) => {
          const params = new URLSearchParams(body);
          const res = await fetch(`${C.PROXMOX_URL}/api2/json${endpoint}`, {
            method: 'POST',
            headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
          });
          if (!res.ok) throw new Error(`Proxmox POST ${endpoint} → ${res.status}: ${await res.text()}`);
          return res.json();
        };

        try {
          switch (input.action) {
            case 'get_status': {
              const status = await proxGet(`/nodes/${node}/status`);
              return { node, status: status.data };
            }
            case 'list_vms': {
              const qemu = await proxGet(`/nodes/${node}/qemu`);
              const lxc = await proxGet(`/nodes/${node}/lxc`);
              return {
                vms: (qemu.data || []).map(v => ({ vmid: v.vmid, name: v.name, status: v.status, mem: v.mem, maxmem: v.maxmem, cpu: v.cpu })),
                containers: (lxc.data || []).map(c => ({ vmid: c.vmid, name: c.name, status: c.status, mem: c.mem, maxmem: c.maxmem }))
              };
            }
            case 'vm_status': {
              if (!input.vmid) return { error: 'vmid requerido' };
              const vmStatus = await proxGet(`/nodes/${node}/qemu/${input.vmid}/status/current`);
              return { vmid: input.vmid, ...vmStatus.data };
            }
            case 'start_vm': {
              if (!input.vmid) return { error: 'vmid requerido' };
              const result = await proxPost(`/nodes/${node}/qemu/${input.vmid}/status/start`);
              return { success: true, vmid: input.vmid, task: result.data };
            }
            case 'stop_vm': {
              if (!input.vmid) return { error: 'vmid requerido' };
              const result = await proxPost(`/nodes/${node}/qemu/${input.vmid}/status/shutdown`);
              return { success: true, vmid: input.vmid, task: result.data, note: 'Shutdown graceful enviado' };
            }
            case 'snapshot_vm': {
              if (!input.vmid) return { error: 'vmid requerido' };
              const snapName = `jarvis_${Date.now()}`;
              const result = await proxPost(`/nodes/${node}/qemu/${input.vmid}/snapshot`, {
                snapname: snapName,
                description: `Snapshot creado por Jarvis - ${new Date().toISOString()}`
              });
              return { success: true, vmid: input.vmid, snapshot: snapName, task: result.data };
            }
            case 'get_resources': {
              const resources = await proxGet('/cluster/resources');
              return { resources: resources.data };
            }
            case 'get_storage': {
              const storage = await proxGet(`/nodes/${node}/storage`);
              return { storage: (storage.data || []).map(s => ({ storage: s.storage, type: s.type, total: s.total, used: s.used, avail: s.avail, content: s.content })) };
            }
            case 'get_network': {
              const network = await proxGet(`/nodes/${node}/network`);
              return { interfaces: network.data };
            }
            case 'custom': {
              if (!input.endpoint) return { error: 'endpoint requerido para action=custom' };
              const blocked = ['/access/users', '/access/roles', '/access/acl', '/access/domains',
                '/nodes/' + node + '/qemu/*/destroy', '/pool', '/sdn'];
              if (blocked.some(b => input.endpoint.includes(b.replace('*', ''))))
                return { error: `Endpoint bloqueado por seguridad: ${input.endpoint}` };
              const result = await proxGet(input.endpoint);
              return result.data || result;
            }
            default:
              return { error: `Acción Proxmox no válida: ${input.action}` };
          }
        } catch (err) {
          return { error: `Proxmox: ${err.message}` };
        }
      }

      // ─── Logs del sistema ───
      case 'get_system_logs': {
        const maxLines = Math.min(input.lines || 100, 500);
        let logText = '';

        try {
          switch (input.source) {
            case 'core': {
              const res = await fetch(`http://supervisor/core/logs`, {
                headers: { Authorization: `Bearer ${C.HA_TOKEN}` }
              });
              logText = await res.text();
              break;
            }
            case 'supervisor': {
              const res = await fetch(`http://supervisor/supervisor/logs`, {
                headers: { Authorization: `Bearer ${C.HA_TOKEN}` }
              });
              logText = await res.text();
              break;
            }
            case 'host': {
              const res = await fetch(`http://supervisor/host/logs`, {
                headers: { Authorization: `Bearer ${C.HA_TOKEN}` }
              });
              logText = await res.text();
              break;
            }
            case 'addon': {
              const slug = input.addon_slug || 'jarvis_ai_agent';
              const res = await fetch(`http://supervisor/addons/${slug}/logs`, {
                headers: { Authorization: `Bearer ${C.HA_TOKEN}` }
              });
              logText = await res.text();
              break;
            }
            default:
              return { error: `Fuente no válida: ${input.source}` };
          }
        } catch (err) {
          return { error: `Error obteniendo logs: ${err.message}` };
        }

        // Procesar: últimas N líneas + filtro opcional
        let lines = logText.split('\n');
        if (input.filter) {
          const f = input.filter.toLowerCase();
          lines = lines.filter(l => l.toLowerCase().includes(f));
        }
        lines = lines.slice(-maxLines);

        return {
          source: input.source,
          lines_count: lines.length,
          filter: input.filter || null,
          logs: lines.join('\n')
        };
      }

      case 'get_error_log': {
        // Leer home-assistant.log directamente del filesystem
        const logPath = path.join(C.HA_CONFIG, 'home-assistant.log');
        if (!fs.existsSync(logPath)) {
          // Fallback: intentar via API
          try {
            const res = await fetch(`${C.HA_URL}/api/error_log`, {
              headers: { Authorization: `Bearer ${C.HA_TOKEN}` }
            });
            if (res.ok) {
              let text = await res.text();
              const maxLines = input.lines || 100;
              let lines = text.split('\n');
              if (input.filter) {
                const f = input.filter.toLowerCase();
                lines = lines.filter(l => l.toLowerCase().includes(f));
              }
              lines = lines.slice(-maxLines);
              return { source: 'api', lines_count: lines.length, logs: lines.join('\n') };
            }
          } catch {}
          return { error: 'No se encuentra home-assistant.log' };
        }

        const content = fs.readFileSync(logPath, 'utf8');
        let lines = content.split('\n');
        if (input.filter) {
          const f = input.filter.toLowerCase();
          lines = lines.filter(l => l.toLowerCase().includes(f));
        }
        const maxLines = input.lines || 100;
        lines = lines.slice(-maxLines);

        // Resumen de errores/warnings
        const errors = lines.filter(l => l.includes('ERROR')).length;
        const warnings = lines.filter(l => l.includes('WARNING')).length;

        return {
          source: 'file',
          lines_count: lines.length,
          errors_found: errors,
          warnings_found: warnings,
          filter: input.filter || null,
          logs: lines.join('\n')
        };
      }

      // ─── Notificaciones y Reparaciones ───
      case 'get_notifications': {
        try {
          // Si piden descartar una notificación
          if (input.dismiss) {
            await haPost('/services/persistent_notification/dismiss', {
              notification_id: input.dismiss
            });
            return { dismissed: input.dismiss, success: true };
          }

          // Obtener todas las notificaciones persistentes
          const allStates = await haGet('/states');
          const notifications = allStates
            .filter(s => s.entity_id.startsWith('persistent_notification.'))
            .map(s => ({
              id: s.entity_id.replace('persistent_notification.', ''),
              title: s.attributes.title || '(sin título)',
              message: s.attributes.message || s.state,
              created: s.last_changed,
              notification_id: s.attributes.notification_id || s.entity_id.replace('persistent_notification.', '')
            }));

          return {
            count: notifications.length,
            notifications,
            tip: notifications.length > 0
              ? 'Usa get_notifications con dismiss:"ID" para descartar una notificación'
              : 'No hay notificaciones pendientes'
          };
        } catch (e) {
          return { error: e.message };
        }
      }

      case 'get_repairs': {
        try {
          const result = { issues: [], unhealthy: [], unsupported: [], sources: [] };

          // 1. Intentar API del Supervisor: /resolution/info
          try {
            const resolution = await supervisorGet('/resolution/info');
            const data = resolution.data || resolution;
            result.sources.push('supervisor');
            result.unhealthy = data.unhealthy || [];
            result.unsupported = data.unsupported || [];
            if (data.issues) {
              result.issues.push(...data.issues.map(issue => ({
                uuid: issue.uuid,
                type: issue.type,
                context: issue.context,
                reference: issue.reference,
                severity: issue.severity || 'warning',
                source: 'supervisor',
                suggestions: (issue.suggestions || []).map(s => ({
                  uuid: s.uuid, type: s.type, context: s.context, reference: s.reference
                }))
              })));
            }
          } catch (e1) {
            // Supervisor no disponible, probar alternativas
            result.sources.push('supervisor:error(' + e1.message + ')');
          }

          // 2. Intentar API de HA Core: /api/repairs/issues
          try {
            const repairs = await haGet('/repairs/issues');
            const repairIssues = repairs.issues || repairs.data?.issues || (Array.isArray(repairs) ? repairs : []);
            result.sources.push('core_repairs');
            for (const r of repairIssues) {
              result.issues.push({
                type: r.domain || r.type || 'unknown',
                context: r.issue_id || r.context,
                reference: r.translation_key || r.reference,
                severity: r.severity || r.is_fixable ? 'fixable' : 'warning',
                source: 'core',
                learn_more: r.learn_more_url || null,
                is_fixable: r.is_fixable || false,
                dismissed: r.dismissed_version ? true : false,
                created: r.created || null
              });
            }
          } catch (e2) {
            result.sources.push('core_repairs:error(' + e2.message + ')');
          }

          // 3. Buscar entidades de tipo "issue_registry" o "repairs" como fallback
          try {
            const states = await haGet('/states');
            const repairEntities = states.filter(s =>
              s.entity_id.startsWith('repair.') ||
              (s.attributes && s.attributes.device_class === 'problem')
            );
            if (repairEntities.length > 0) {
              result.sources.push('entities');
              for (const e of repairEntities.slice(0, 20)) {
                result.issues.push({
                  type: 'entity_problem',
                  context: e.entity_id,
                  reference: e.attributes.friendly_name || e.entity_id,
                  severity: e.state === 'on' ? 'active' : 'resolved',
                  source: 'entity'
                });
              }
            }
          } catch {}

          return {
            issues_count: result.issues.length,
            issues: result.issues,
            unhealthy_reasons: result.unhealthy,
            unsupported_reasons: result.unsupported,
            system_healthy: result.unhealthy.length === 0,
            system_supported: result.unsupported.length === 0,
            sources_checked: result.sources,
            tip: result.issues.length > 0
              ? 'Revisa cada issue y sugiere al usuario cómo resolver. Algunos se arreglan con call_service o reload_config.'
              : 'No hay reparaciones pendientes — el sistema está limpio ✓'
          };
        } catch (e) {
          return { error: e.message };
        }
      }

      // ─── Voz / TTS ───
      case 'speak': {
        const { message: ttsMsg, target = 'ha_tts', language: ttsLang = 'es' } = input;
        if (!ttsMsg) return { error: 'message es requerido' };

        // Mapeo de alias a entity_id de Alexa
        const alexaMap = {
          alexa_salon:      'media_player.echo_salon',
          alexa_cocina:     'media_player.echo_cocina',
          alexa_dormitorio: 'media_player.echo_dormitorio',
          alexa_garaje:     'media_player.echo_pop_garaje',
          alexa_show:       'media_player.echo_show_5',
          alexa_flex:       'media_player.echo_flex',
        };

        try {
          if (target === 'all_alexa') {
            // Hablar por todos los Echo
            const targets = Object.values(alexaMap);
            await haPost('/services/notify/alexa_media', { message: ttsMsg, target: targets, data: { type: 'tts' } });
            return { spoken: true, target: 'all_alexa', message: ttsMsg };
          }

          if (target === 'ha_tts' || !alexaMap[target]) {
            // Usar TTS nativo de HA (Piper en español)
            await haPost('/services/tts/speak', {
              entity_id: 'tts.piper',
              media_player_entity_id: 'media_player.ha_default_player',
              message: ttsMsg,
              language: ttsLang === 'es' ? 'es_ES' : 'en_US',
            });
            return { spoken: true, target: 'ha_tts', message: ttsMsg };
          }

          // Echo específico
          const entityId = alexaMap[target];
          await haPost('/services/notify/alexa_media', { message: ttsMsg, target: [entityId], data: { type: 'tts' } });
          return { spoken: true, target, entity_id: entityId, message: ttsMsg };
        } catch (e) {
          return { error: `TTS fallido: ${e.message}` };
        }
      }

      // ─── Telegram ───
      case 'telegram_send': {
        // Usar el servicio notify de HA (ya tiene bot configurado)
        try {
          // Primero intentar detectar el servicio de notify de Telegram
          const services = await haGet('/services');
          const telegramNotify = services.find(s =>
            s.domain === 'notify' && (
              (s.services && Object.keys(s.services).some(k => k.includes('telegram'))) ||
              s.domain === 'telegram_bot'
            )
          );

          // Intentar notify.telegram o telegram_bot.send_message
          const msgData = {
            message: input.message,
            ...(input.title ? { title: input.title } : {}),
            ...(input.parse_mode ? { data: { parse_mode: input.parse_mode } } : {})
          };

          // Probar diferentes servicios de Telegram
          const attempts = [
            { domain: 'telegram_bot', service: 'send_message', data: { message: input.message, title: input.title || '', parse_mode: input.parse_mode || 'html', ...(input.target ? { target: input.target } : {}) } },
            { domain: 'notify', service: 'telegram', data: msgData },
            { domain: 'notify', service: 'notify', data: msgData }
          ];

          for (const attempt of attempts) {
            try {
              await haPost(`/services/${attempt.domain}/${attempt.service}`, attempt.data);
              console.log(`[telegram] Mensaje enviado via ${attempt.domain}.${attempt.service}`);
              return { success: true, method: `${attempt.domain}.${attempt.service}`, message: 'Mensaje enviado por Telegram' };
            } catch (e) {
              continue;
            }
          }

          return { error: 'No se encontró servicio de Telegram. Verifica que telegram_bot o notify.telegram está configurado en HA.' };
        } catch (err) {
          return { error: `Telegram: ${err.message}` };
        }
      }

      case 'telegram_send_image': {
        try {
          const data = {
            caption: input.caption || '',
          };

          if (input.entity_id && input.entity_id.startsWith('camera.')) {
            // Snapshot de cámara
            data.url = `${C.HA_URL}/api/camera_proxy/${input.entity_id}`;
          } else if (input.url) {
            if (input.url.startsWith('/config/www/')) {
              data.url = input.url.replace('/config/www/', '/local/');
            } else {
              data.url = input.url;
            }
          }

          // Intentar enviar foto
          const attempts = [
            { domain: 'telegram_bot', service: 'send_photo', data: { url: data.url, caption: data.caption, ...(input.entity_id ? { entity_id: input.entity_id } : {}) } },
            { domain: 'notify', service: 'telegram', data: { message: data.caption, data: { photo: [{ url: data.url, caption: data.caption }] } } }
          ];

          for (const attempt of attempts) {
            try {
              await haPost(`/services/${attempt.domain}/${attempt.service}`, attempt.data);
              return { success: true, method: `${attempt.domain}.${attempt.service}` };
            } catch { continue; }
          }

          return { error: 'No se pudo enviar imagen. Verifica telegram_bot en HA.' };
        } catch (err) {
          return { error: err.message };
        }
      }

      case 'telegram_get_updates': {
        // Leer últimos mensajes/eventos de Telegram via HA states
        try {
          const states = await haGet('/states');
          const telegramEntities = states.filter(e =>
            e.entity_id.includes('telegram') || e.entity_id.includes('last_message')
          );

          // También buscar en eventos recientes si hay
          let lastMessages = [];
          try {
            const events = await haGet('/events');
            const telegramEvents = events.filter(e => e.event_type && e.event_type.includes('telegram'));
            lastMessages = telegramEvents.slice(0, input.limit || 10);
          } catch {}

          return {
            telegram_entities: telegramEntities.map(e => ({
              entity_id: e.entity_id,
              state: e.state,
              attributes: e.attributes
            })),
            recent_events: lastMessages,
            note: 'Para recibir comandos de Telegram, configura una automatización que escuche telegram_command o telegram_text events.'
          };
        } catch (err) {
          return { error: err.message };
        }
      }

      // ─── Herramientas custom ───
      case 'create_custom_tool': {
        try {
          const scriptsDir = path.join(C.HA_CONFIG, 'scripts', 'jarvis');
          if (!fs.existsSync(scriptsDir)) fs.mkdirSync(scriptsDir, { recursive: true });

          const extensions = { shell: '.sh', python: '.py', node: '.js' };
          const ext = extensions[input.language] || '.sh';
          const filePath = path.join(scriptsDir, input.name + ext);

          // Añadir shebang si no lo tiene
          let code = input.code;
          if (input.language === 'shell' && !code.startsWith('#!')) code = '#!/bin/bash\n' + code;
          if (input.language === 'python' && !code.startsWith('#!')) code = '#!/usr/bin/env python3\n' + code;
          if (input.language === 'node' && !code.startsWith('#!')) code = '#!/usr/bin/env node\n' + code;

          fs.writeFileSync(filePath, code);
          // Hacer ejecutable
          try { fs.chmodSync(filePath, '755'); } catch {}

          console.log(`[custom-tool] Creado: ${filePath} (${input.language})`);

          // Guardar metadata
          const metaFile = path.join(scriptsDir, 'tools_meta.json');
          let meta = {};
          if (fs.existsSync(metaFile)) meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
          meta[input.name] = {
            language: input.language,
            description: input.description,
            schedule: input.schedule || null,
            created: new Date().toISOString(),
            path: filePath
          };
          fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));

          // Si tiene schedule, crear un shell_command en HA para poder ejecutarlo
          const result = { success: true, path: filePath, message: `Herramienta '${input.name}' creada.` };
          if (input.schedule) {
            result.schedule = input.schedule;
            result.note = 'Para activar el cron, crea una automatización con time_pattern trigger o usa el sistema de tareas de HA.';
          }
          return result;
        } catch (err) {
          return { error: err.message };
        }
      }

      case 'run_custom_tool': {
        try {
          const scriptsDir = path.join(C.HA_CONFIG, 'scripts', 'jarvis');
          const metaFile = path.join(scriptsDir, 'tools_meta.json');

          if (!fs.existsSync(metaFile)) return { error: 'No hay herramientas custom creadas' };
          const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
          const tool = meta[input.name];
          if (!tool) return { error: `Herramienta '${input.name}' no encontrada. Disponibles: ${Object.keys(meta).join(', ')}` };

          const filePath = tool.path;
          if (!fs.existsSync(filePath)) return { error: `Archivo no encontrado: ${filePath}` };

          // Ejecutar según lenguaje
          const { execSync } = require('child_process');
          let cmd;
          if (tool.language === 'shell') cmd = `bash ${filePath} ${input.args || ''}`;
          else if (tool.language === 'python') cmd = `python3 ${filePath} ${input.args || ''}`;
          else if (tool.language === 'node') cmd = `node ${filePath} ${input.args || ''}`;
          else return { error: `Lenguaje no soportado: ${tool.language}` };

          const output = execSync(cmd, { timeout: 30000, encoding: 'utf8', cwd: scriptsDir });
          return { success: true, tool: input.name, output: output.slice(0, 5000) };
        } catch (err) {
          if (err.stdout) return { error: err.message, stdout: err.stdout.slice(0, 2000), stderr: (err.stderr || '').slice(0, 2000) };
          return { error: err.message };
        }
      }

      // ─── Crear add-ons ───
      case 'create_addon': {
        try {
          // El repo de add-ons está mapeado. Los add-ons van cada uno en su carpeta.
          // Desde dentro del container, el repo está en /addons o necesitamos escribir en /share
          // Para desarrollo: escribimos la estructura en /share/addons_dev/[slug]/
          const addonDir = path.join(C.HA_SHARE, 'addons_dev', input.slug);
          if (!fs.existsSync(addonDir)) fs.mkdirSync(addonDir, { recursive: true });

          // config.yaml del nuevo add-on
          const configYaml = `name: "${input.name}"
description: "${input.description}"
version: "1.0.0"
slug: "${input.slug}"
init: false
arch:
  - aarch64
  - amd64
  - armhf
  - armv7
startup: application
boot: auto${input.port ? `
ports:
  ${input.port}/tcp: ${input.port}
ports_description:
  ${input.port}/tcp: "Interfaz web"
ingress: ${input.needs_ingress ? 'true' : 'false'}${input.needs_ingress ? `\ningress_port: ${input.port}` : ''}` : ''}
homeassistant_api: true
map:
  - config:rw
  - share:rw
`;
          fs.writeFileSync(path.join(addonDir, 'config.yaml'), configYaml);

          // build.yaml
          fs.writeFileSync(path.join(addonDir, 'build.yaml'), `build_from:
  aarch64: ghcr.io/home-assistant/aarch64-base:latest
  amd64: ghcr.io/home-assistant/amd64-base:latest
  armhf: ghcr.io/home-assistant/armhf-base:latest
  armv7: ghcr.io/home-assistant/armv7-base:latest
`);

          // Dockerfile según lenguaje
          let dockerfile, mainFile, runScript;
          const deps = input.dependencies || {};

          if (input.language === 'node') {
            dockerfile = `ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:latest
FROM $BUILD_FROM
RUN apk add --no-cache nodejs npm${deps.apk ? ' ' + deps.apk.join(' ') : ''}
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY . ./
COPY run.sh /run.sh
RUN chmod +x /run.sh
CMD ["/run.sh"]`;
            mainFile = 'server.js';
            runScript = `#!/usr/bin/with-contenv bashio
export HA_TOKEN="\${SUPERVISOR_TOKEN}"
export HA_URL="http://supervisor/core"
bashio::log.info "Iniciando ${input.name}..."
node /app/server.js`;
            // package.json
            const pkgDeps = { express: '^4.18.2', 'node-fetch': '^2.7.0' };
            if (deps.npm) deps.npm.forEach(d => { pkgDeps[d] = '*'; });
            fs.writeFileSync(path.join(addonDir, 'package.json'), JSON.stringify({
              name: input.slug, version: '1.0.0', main: 'server.js', dependencies: pkgDeps
            }, null, 2));

          } else if (input.language === 'python') {
            dockerfile = `ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:latest
FROM $BUILD_FROM
RUN apk add --no-cache python3 py3-pip${deps.apk ? ' ' + deps.apk.join(' ') : ''}
WORKDIR /app
${deps.pip ? `COPY requirements.txt ./\nRUN pip3 install -r requirements.txt` : ''}
COPY . ./
COPY run.sh /run.sh
RUN chmod +x /run.sh
CMD ["/run.sh"]`;
            mainFile = 'main.py';
            runScript = `#!/usr/bin/with-contenv bashio
export HA_TOKEN="\${SUPERVISOR_TOKEN}"
export HA_URL="http://supervisor/core"
bashio::log.info "Iniciando ${input.name}..."
python3 /app/main.py`;
            if (deps.pip) {
              fs.writeFileSync(path.join(addonDir, 'requirements.txt'), deps.pip.join('\n'));
            }

          } else {
            dockerfile = `ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:latest
FROM $BUILD_FROM
${deps.apk ? `RUN apk add --no-cache ${deps.apk.join(' ')}` : ''}
WORKDIR /app
COPY . ./
COPY run.sh /run.sh
RUN chmod +x /run.sh
CMD ["/run.sh"]`;
            mainFile = 'run.sh';
            runScript = `#!/usr/bin/with-contenv bashio
export HA_TOKEN="\${SUPERVISOR_TOKEN}"
export HA_URL="http://supervisor/core"
bashio::log.info "Iniciando ${input.name}..."
${input.code}`;
          }

          fs.writeFileSync(path.join(addonDir, 'Dockerfile'), dockerfile);
          fs.writeFileSync(path.join(addonDir, 'run.sh'), runScript);
          if (mainFile !== 'run.sh') {
            fs.writeFileSync(path.join(addonDir, mainFile), input.code);
          }

          // LICENSE blindada
          fs.writeFileSync(path.join(addonDir, 'LICENSE'), `CC BY-NC-ND 4.0 — All Rights Reserved.
Copyright (c) ${new Date().getFullYear()} Adrian (padilla585projects)
Prohibida la copia, redistribucion y uso comercial.`);

          console.log(`[addon] Creado: ${addonDir} (${input.language})`);

          return {
            success: true,
            path: addonDir,
            slug: input.slug,
            files: fs.readdirSync(addonDir),
            message: `Add-on '${input.name}' creado en ${addonDir}. Para publicarlo: copiar la carpeta al repo GitHub junto a jarvis/ y hacer push.`,
            next_steps: [
              'Copiar carpeta al repo de GitHub (al mismo nivel que jarvis/)',
              'Hacer push al repo',
              'En HA: actualizar repo → el nuevo add-on aparecerá en la tienda'
            ]
          };
        } catch (err) {
          return { error: err.message };
        }
      }

      // ─── Pensamiento proactivo ───
      case 'proactive_thought': {
        try {
          // Guardar pensamiento en cola
          const thoughtsFile = path.join(C.DATA_DIR, 'pending_thoughts.json');
          let thoughts = loadJSON(thoughtsFile, []);

          // Fix doble-encoding UTF-8 (mojibake tipo "CaÃ­dos" → "Caídos")
          const fixEnc = (s) => {
            if (typeof s !== 'string' || !/[ÃÂ][\x80-\xBF]/.test(s)) return s;
            try { return Buffer.from(s, 'latin1').toString('utf8'); } catch { return s; }
          };
          const title = fixEnc(input.title || '');
          const detail = fixEnc(input.detail || '');

          // ── Dedup mejorado: Jaccard por tokens + dedup por área/tema ────────────
          // Palabras funcionales a ignorar (NO incluir luces/automatizacion — son discriminadoras)
          const STOPWORDS = new Set(['para','como','segun','sobre','desde','hasta','este','esta',
            'esto','control','mediante','usando','cuando','donde','todos','todas','cada',
            'tener','hacer','crear','nuevo','nueva','entre','dentro','fuera']);
          const norm = (s) => (s || '').toLowerCase()
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 3 && !STOPWORDS.has(w));

          // Palabras de área/zona de la casa — si coincide la zona Y hay pensamiento similar → dedup
          const AREA_WORDS = ['garaje','salon','dormitorio','cocina','bano','terraza','entrada',
            'pasillo','jardin','habitacion','comedor','biblioteca','oficina','trastero'];
          const getArea = (s) => AREA_WORDS.find(a => (s||'').toLowerCase()
            .normalize('NFD').replace(/[̀-ͯ]/g,'').includes(a)) || null;

          const newTokens = new Set(norm(title));
          const newArea   = getArea(title);

          const pending = thoughts.filter(t => t.status === 'pending');
          const isDup = pending.some(t => {
            const exTokens = new Set(norm(t.title));
            // Jaccard: umbral 0.4 (antes 0.55 era demasiado estricto)
            if (newTokens.size > 0 && exTokens.size > 0) {
              let inter = 0;
              for (const w of newTokens) if (exTokens.has(w)) inter++;
              const union = new Set([...newTokens, ...exTokens]).size;
              if (union > 0 && (inter / union) >= 0.4) return true;
            }
            // Si la zona es la misma Y el tipo es el mismo → es duplicado de área
            if (newArea && getArea(t.title) === newArea &&
                (input.type || '') === (t.type || '')) return true;
            // Si el título normalizado es subcadena del existente o viceversa → duplicado
            const nNew = norm(title).join(' ');
            const nEx  = norm(t.title).join(' ');
            if (nNew.length > 5 && nEx.length > 5 &&
                (nEx.includes(nNew) || nNew.includes(nEx))) return true;
            return false;
          });

          if (isDup) {
            console.log(`[proactive] Descartado duplicado (área/Jaccard): ${title}`);
            return { success: true, skipped: true, message: 'Idea muy similar a una ya pendiente — descartada para no repetir.' };
          }

          const thought = {
            id: Date.now(),
            type: input.type,
            title,
            detail,
            priority: input.priority,
            status: 'pending',
            created: new Date().toISOString(),
            auto_execute: input.auto_execute_if_approved || null
          };
          thoughts.push(thought);

          // Limitar a 20 pensamientos pendientes (antes 50 — demasiados)
          // Rotación inteligente: eliminar los más viejos de menor prioridad
          const priorityRank = { critical: 4, high: 3, medium: 2, low: 1 };
          const MAX_THOUGHTS = 20;
          if (thoughts.length > MAX_THOUGHTS) {
            const pending2 = thoughts
              .filter(t => t.status === 'pending')
              .sort((a, b) => (priorityRank[a.priority]||0) - (priorityRank[b.priority]||0)
                           || new Date(a.created) - new Date(b.created));
            // Eliminar el de menor prioridad más antiguo
            const toRemove = pending2[0];
            if (toRemove) thoughts = thoughts.filter(t => t.id !== toRemove.id);
          }
          saveJSON(thoughtsFile, thoughts);

          // Notificar por Telegram si es high/critical o si se pide explícitamente
          const shouldNotify = input.notify_telegram || input.priority === 'high' || input.priority === 'critical';
          if (shouldNotify) {
            const emoji = { low: '💡', medium: '🔔', high: '⚠️', critical: '🚨' };
            const msg = `${emoji[input.priority] || '💭'} *JARVIS — ${(input.type || 'idea').toUpperCase()}*\n\n*${title}*\n${detail}\n\n_Prioridad: ${input.priority}_\n_Responde "sí" o "no" para aprobar/rechazar._`;

            // Intentar enviar por Telegram
            try {
              const attempts = [
                { domain: 'telegram_bot', service: 'send_message', data: { message: msg, parse_mode: 'markdown' } },
                { domain: 'notify', service: 'telegram', data: { message: msg } }
              ];
              for (const attempt of attempts) {
                try {
                  await haPost(`/services/${attempt.domain}/${attempt.service}`, attempt.data);
                  thought.notified_via = 'telegram';
                  break;
                } catch { continue; }
              }
            } catch {}
          }

          saveJSON(thoughtsFile, thoughts);
          console.log(`[proactive] ${input.priority}: ${title}`);

          return {
            success: true,
            thought_id: thought.id,
            notified: thought.notified_via || 'chat_only',
            message: `Pensamiento registrado. ${shouldNotify ? 'Notificación enviada por Telegram.' : 'Se mostrará en el próximo chat.'}`
          };
        } catch (err) {
          return { error: err.message };
        }
      }

      // ─── Comunicación entre agentes ───
      case 'agent_communicate': {
        try {
          const headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'JarvisAgent/2.7.0'
          };
          if (input.auth_header) {
            headers['Authorization'] = input.auth_header;
          }

          const options = { method: input.method, headers };
          if (input.method === 'POST') {
            options.body = JSON.stringify({
              from: 'jarvis',
              message: input.message || '',
              data: input.data || {},
              timestamp: new Date().toISOString()
            });
          }

          const res = await fetch(input.target_url, { ...options, timeout: 15000 });
          const contentType = res.headers.get('content-type') || '';
          let responseData;
          if (contentType.includes('json')) {
            responseData = await res.json();
          } else {
            responseData = await res.text();
          }

          return {
            success: res.ok,
            status: res.status,
            response: typeof responseData === 'string' ? responseData.slice(0, 5000) : responseData,
            target: input.target_url
          };
        } catch (err) {
          return { error: `Comunicación fallida: ${err.message}`, target: input.target_url };
        }
      }

      // ─── GitHub / Proyectos ───
      case 'analyze_github_repos': {
        try {
          const username = input.username;

          if (input.repo) {
            // Analizar un repo específico en detalle
            const repoRes = await fetch(`https://api.github.com/repos/${username}/${input.repo}`, {
              headers: { 'User-Agent': 'JarvisBot/1.0', Accept: 'application/vnd.github.v3+json' }
            });
            if (!repoRes.ok) return { error: `Repo no encontrado: ${username}/${input.repo}` };
            const repoData = await repoRes.json();

            // Leer README
            let readme = '';
            try {
              const readmeRes = await fetch(`https://api.github.com/repos/${username}/${input.repo}/readme`, {
                headers: { 'User-Agent': 'JarvisBot/1.0', Accept: 'application/vnd.github.v3+json' }
              });
              if (readmeRes.ok) {
                const readmeData = await readmeRes.json();
                readme = Buffer.from(readmeData.content, 'base64').toString('utf8').slice(0, 3000);
              }
            } catch {}

            // Listar archivos raíz para detectar tecnología
            let files = [];
            try {
              const contentsRes = await fetch(`https://api.github.com/repos/${username}/${input.repo}/contents`, {
                headers: { 'User-Agent': 'JarvisBot/1.0', Accept: 'application/vnd.github.v3+json' }
              });
              if (contentsRes.ok) {
                const contents = await contentsRes.json();
                files = contents.map(f => f.name);
              }
            } catch {}

            // Detectar tecnologías y compatibilidad con HA
            const haCompatible = [];
            if (files.includes('config.yaml') || files.includes('configuration.yaml')) haCompatible.push('Es un add-on/config de HA');
            if (files.includes('custom_components')) haCompatible.push('Tiene custom components para HA');
            if (files.includes('esphome') || readme.toLowerCase().includes('esphome')) haCompatible.push('Usa ESPHome (compatible con HA)');
            if (files.includes('docker-compose.yml') || files.includes('Dockerfile')) haCompatible.push('Tiene Docker (se puede integrar como add-on)');
            if (readme.toLowerCase().includes('mqtt')) haCompatible.push('Usa MQTT (integrable con HA)');
            if (readme.toLowerCase().includes('home assistant') || readme.toLowerCase().includes('hassio')) haCompatible.push('Menciona Home Assistant directamente');
            if (readme.toLowerCase().includes('api') || readme.toLowerCase().includes('rest')) haCompatible.push('Tiene API REST (integrable via rest/command_line)');
            if (files.includes('platformio.ini') || readme.toLowerCase().includes('esp32') || readme.toLowerCase().includes('arduino')) haCompatible.push('Proyecto IoT/microcontrolador (ESPHome/MQTT compatible)');
            if (readme.toLowerCase().includes('python')) haCompatible.push('Python (puede ser custom_component o AppDaemon)');
            if (readme.toLowerCase().includes('node') || files.includes('package.json')) haCompatible.push('Node.js (puede ser add-on)');
            if (readme.toLowerCase().includes('telegram')) haCompatible.push('Usa Telegram (integrable con notify)');
            if (readme.toLowerCase().includes('camera') || readme.toLowerCase().includes('frigate')) haCompatible.push('Cámaras/visión (integrable con HA)');

            return {
              repo: `${username}/${input.repo}`,
              description: repoData.description,
              language: repoData.language,
              topics: repoData.topics,
              updated_at: repoData.updated_at,
              files: files.slice(0, 30),
              readme_preview: readme.slice(0, 2000),
              ha_compatibility: haCompatible,
              suggestions: haCompatible.length > 0
                ? 'Este proyecto tiene elementos integrables con Home Assistant. Puedo ayudarte a conectarlo.'
                : 'No detecto integración directa con HA, pero puedo buscar formas de conectarlo.'
            };
          } else {
            // Listar todos los repos del usuario
            const reposRes = await fetch(`https://api.github.com/users/${username}/repos?per_page=100&sort=updated`, {
              headers: { 'User-Agent': 'JarvisBot/1.0', Accept: 'application/vnd.github.v3+json' }
            });
            if (!reposRes.ok) return { error: `Usuario no encontrado: ${username}` };
            const repos = await reposRes.json();

            const repoList = repos.map(r => ({
              name: r.name,
              description: r.description,
              language: r.language,
              topics: r.topics,
              updated: r.updated_at,
              url: r.html_url
            }));

            return {
              username,
              repos: repoList,
              total: repoList.length,
              note: 'Usa analyze_github_repos con el campo "repo" para analizar uno en detalle y ver compatibilidad con HA.'
            };
          }
        } catch (err) {
          return { error: err.message };
        }
      }

      // ─── Base de conocimiento ───
      case 'knowledge_db': {
        const KB_DIR = path.join(C.DATA_DIR, 'knowledge');
        const KB_INDEX = path.join(KB_DIR, 'index.json');
        if (!fs.existsSync(KB_DIR)) fs.mkdirSync(KB_DIR, { recursive: true });

        let index = loadJSON(KB_INDEX, { entries: [], categories: {}, totalEntries: 0 });

        switch (input.action) {
          case 'add': {
            if (!input.entry || !input.entry.title) return { error: 'Se requiere entry.title' };
            const id = `kb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const entry = {
              id,
              title: input.entry.title,
              category: input.entry.category || 'otro',
              content: input.entry.content || '',
              tags: input.entry.tags || [],
              connections: input.entry.connections || [],
              images: input.entry.images || [],
              source: input.entry.source || 'experiencia',
              importance: input.entry.importance || 'medium',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            };

            // Guardar entrada individual como archivo
            saveJSON(path.join(KB_DIR, `${id}.json`), entry);

            // Actualizar índice
            index.entries.push({ id, title: entry.title, category: entry.category, tags: entry.tags, importance: entry.importance });
            if (!index.categories[entry.category]) index.categories[entry.category] = 0;
            index.categories[entry.category]++;
            index.totalEntries++;
            saveJSON(KB_INDEX, index);

            console.log(`[knowledge] +${entry.title} (${entry.category}) [${entry.tags.join(',')}]`);
            return { success: true, id, message: `Conocimiento guardado: "${entry.title}" en ${entry.category}` };
          }

          case 'query': {
            const q = (input.query || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
            const cat = input.category;
            let results = index.entries;

            if (cat) results = results.filter(e => e.category === cat);
            if (q) {
              results = results.filter(e => {
                const text = `${e.title} ${(e.tags || []).join(' ')}`.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
                return text.includes(q) || q.split(' ').some(word => text.includes(word));
              });
            }

            // Cargar contenido completo de los resultados (máx 20)
            const detailed = results.slice(0, 20).map(e => {
              try {
                return loadJSON(path.join(KB_DIR, `${e.id}.json`), e);
              } catch { return e; }
            });

            return { results: detailed, total: results.length, showing: detailed.length };
          }

          case 'update': {
            if (!input.id) return { error: 'Se requiere id' };
            const filePath = path.join(KB_DIR, `${input.id}.json`);
            if (!fs.existsSync(filePath)) return { error: 'Entrada no encontrada' };
            const existing = loadJSON(filePath, {});
            const updated = { ...existing, ...input.entry, id: input.id, updatedAt: new Date().toISOString() };
            saveJSON(filePath, updated);

            // Actualizar índice
            const idx = index.entries.findIndex(e => e.id === input.id);
            if (idx !== -1) {
              index.entries[idx] = { id: input.id, title: updated.title, category: updated.category, tags: updated.tags, importance: updated.importance };
              saveJSON(KB_INDEX, index);
            }
            return { success: true, message: `Actualizado: "${updated.title}"` };
          }

          case 'delete': {
            if (!input.id) return { error: 'Se requiere id' };
            const fp = path.join(KB_DIR, `${input.id}.json`);
            if (fs.existsSync(fp)) fs.unlinkSync(fp);
            const oldCat = (index.entries.find(e => e.id === input.id) || {}).category;
            index.entries = index.entries.filter(e => e.id !== input.id);
            if (oldCat && index.categories[oldCat]) index.categories[oldCat]--;
            index.totalEntries = index.entries.length;
            saveJSON(KB_INDEX, index);
            return { success: true, message: 'Entrada eliminada' };
          }

          case 'connect': {
            if (!input.id || !input.connect_to) return { error: 'Se requiere id y connect_to' };
            const fp1 = path.join(KB_DIR, `${input.id}.json`);
            const fp2 = path.join(KB_DIR, `${input.connect_to}.json`);
            if (!fs.existsSync(fp1)) return { error: 'Entrada origen no encontrada' };

            const e1 = loadJSON(fp1, {});
            if (!e1.connections) e1.connections = [];
            if (!e1.connections.includes(input.connect_to)) e1.connections.push(input.connect_to);
            saveJSON(fp1, e1);

            // Conexión bidireccional
            if (fs.existsSync(fp2)) {
              const e2 = loadJSON(fp2, {});
              if (!e2.connections) e2.connections = [];
              if (!e2.connections.includes(input.id)) e2.connections.push(input.id);
              saveJSON(fp2, e2);
            }
            return { success: true, message: `Conectado: "${e1.title}" ↔ "${input.connect_to}"` };
          }

          case 'list_categories': {
            return { categories: index.categories, totalEntries: index.totalEntries };
          }

          case 'export': {
            // Exportar toda la base como resumen
            const all = index.entries.map(e => {
              try { return loadJSON(path.join(KB_DIR, `${e.id}.json`), e); }
              catch { return e; }
            });
            const byCat = {};
            for (const e of all) {
              if (!byCat[e.category]) byCat[e.category] = [];
              byCat[e.category].push({ title: e.title, tags: e.tags, importance: e.importance, connections: e.connections });
            }
            return { knowledge_base: byCat, totalEntries: all.length, categories: Object.keys(byCat).length };
          }

          default:
            return { error: `Acción desconocida: ${input.action}` };
        }
      }

      // ─── Auto-evolución ───
      case 'update_self': {
        const SK_FILE = path.join(C.DATA_DIR, 'self_knowledge.json');
        let sk = loadJSON(SK_FILE, []);

        switch (input.action) {
          case 'list_knowledge':
            return { sections: sk, total: sk.length };

          case 'add_knowledge': {
            if (!input.title || !input.content) return { error: 'title y content requeridos' };
            const exists = sk.findIndex(s => s.title === input.title);
            if (exists >= 0) {
              sk[exists] = { title: input.title, content: input.content, updatedAt: new Date().toISOString() };
              console.log(`[self] Conocimiento actualizado: "${input.title}"`);
            } else {
              sk.push({ title: input.title, content: input.content, addedAt: new Date().toISOString() });
              console.log(`[self] Nuevo conocimiento añadido: "${input.title}"`);
            }
            saveJSON(SK_FILE, sk);
            return { success: true, title: input.title, total_sections: sk.length, note: 'Este conocimiento se inyectará en tu prompt en cada conversación.' };
          }

          case 'update_knowledge': {
            if (!input.title || !input.content) return { error: 'title y content requeridos' };
            const idx = sk.findIndex(s => s.title === input.title);
            if (idx < 0) return { error: `Sección "${input.title}" no encontrada. Usa add_knowledge para crearla.` };
            sk[idx].content = input.content;
            sk[idx].updatedAt = new Date().toISOString();
            saveJSON(SK_FILE, sk);
            console.log(`[self] Conocimiento actualizado: "${input.title}"`);
            return { success: true, title: input.title };
          }

          case 'remove_knowledge': {
            if (!input.title) return { error: 'title requerido' };
            const before = sk.length;
            sk = sk.filter(s => s.title !== input.title);
            saveJSON(SK_FILE, sk);
            return { success: true, removed: before - sk.length, remaining: sk.length };
          }

          case 'patch_code': {
            if (!input.code_patch) return { error: 'code_patch requerido' };
            // Guardar el patch en /data para que Adrián lo revise y aplique
            const patchFile = path.join(C.DATA_DIR, `patch_${Date.now()}.js`);
            const patchContent = `// Patch propuesto por Jarvis — ${new Date().toISOString()}\n// Razón: ${input.reason || 'No especificada'}\n// REVISAR ANTES DE APLICAR\n\n${input.code_patch}`;
            fs.writeFileSync(patchFile, patchContent);
            console.log(`[self] Patch guardado en ${patchFile}`);
            // Intentar localizar server.js propio
            const selfPaths = ['/app/server.js', '/usr/src/app/server.js'];
            let selfPath = selfPaths.find(p => fs.existsSync(p));
            return {
              success: true,
              patch_saved: patchFile,
              self_path: selfPath || 'no encontrado',
              note: 'El patch está guardado para revisión. Si quieres que lo aplique directamente, dímelo explícitamente y lo haré.'
            };
          }

          case 'restart_self': {
            console.log('[self] Reiniciando Jarvis...');
            const r = await fetch('http://supervisor/addons/jarvis_ai_agent/restart', {
              method: 'POST',
              headers: { Authorization: `Bearer ${C.HA_TOKEN}` }
            }).catch(() => null);
            return { initiated: true, note: 'Reinicio iniciado. Esta conexión se cerrará en segundos.' };
          }

          default:
            return { error: `Acción desconocida: ${input.action}` };
        }
      }

      // ─── Supervisor / Sistema HA ───
      case 'ha_supervisor': {
        const svPost = async (endpoint, body = {}) => {
          const r = await fetch(`http://supervisor${endpoint}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${C.HA_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          const text = await r.text();
          try { return JSON.parse(text); } catch { return { raw: text, ok: r.ok }; }
        };
        const svGet = async (endpoint) => {
          const r = await fetch(`http://supervisor${endpoint}`, {
            headers: { Authorization: `Bearer ${C.HA_TOKEN}`, 'Content-Type': 'application/json' }
          });
          const text = await r.text();
          try { return JSON.parse(text); } catch { return { raw: text }; }
        };

        switch (input.action) {
          case 'check_updates': {
            const [core, os, sup, addons] = await Promise.all([
              svGet('/core/info').catch(() => ({})),
              svGet('/os/info').catch(() => ({})),
              svGet('/supervisor/info').catch(() => ({})),
              svGet('/addons').catch(() => ({ data: { addons: [] } }))
            ]);
            const coreData = core.data || core;
            const osData = os.data || os;
            const supData = sup.data || sup;
            const addonList = (addons.data || addons).addons || [];
            const updatableAddons = addonList.filter(a => a.update_available);
            return {
              core: { version: coreData.version, latest: coreData.version_latest, update: coreData.update_available },
              os: { version: osData.version, latest: osData.version_latest, update: osData.update_available },
              supervisor: { version: supData.version, latest: supData.version_latest, update: supData.update_available },
              addons_with_updates: updatableAddons.map(a => ({ name: a.name, slug: a.slug, version: a.version, latest: a.version_latest })),
              total_updates: (coreData.update_available ? 1 : 0) + (osData.update_available ? 1 : 0) + (supData.update_available ? 1 : 0) + updatableAddons.length
            };
          }

          case 'list_addons': {
            const r = await svGet('/addons');
            const addonList = (r.data || r).addons || [];
            return { addons: addonList.map(a => ({ name: a.name, slug: a.slug, state: a.state, version: a.version, update_available: a.update_available })), total: addonList.length };
          }

          case 'get_addon_info': {
            if (!input.addon_slug) return { error: 'addon_slug requerido' };
            const r = await svGet(`/addons/${input.addon_slug}/info`);
            return r.data || r;
          }

          case 'update_addon': {
            if (!input.addon_slug) return { error: 'addon_slug requerido' };
            console.log(`[supervisor] Actualizando add-on: ${input.addon_slug}`);
            const r = await svPost(`/addons/${input.addon_slug}/update`);
            return { success: r.result === 'ok', addon: input.addon_slug, response: r };
          }

          case 'update_all_addons': {
            const r = await svGet('/addons');
            const updatable = ((r.data || r).addons || []).filter(a => a.update_available);
            if (updatable.length === 0) return { message: 'No hay add-ons con actualizaciones pendientes.' };
            const results = [];
            for (const addon of updatable) {
              try {
                const res = await svPost(`/addons/${addon.slug}/update`);
                results.push({ name: addon.name, slug: addon.slug, success: res.result === 'ok' });
                console.log(`[supervisor] Add-on actualizado: ${addon.name}`);
              } catch (e) {
                results.push({ name: addon.name, slug: addon.slug, success: false, error: e.message });
              }
            }
            return { updated: results, total: results.length };
          }

          case 'update_core': {
            if (!input.confirm) return { warning: 'Actualizar HA Core reiniciará el sistema brevemente. Llama de nuevo con confirm:true para proceder.' };
            console.log('[supervisor] Actualizando HA Core...');
            const r = await svPost('/core/update');
            return { success: r.result === 'ok', response: r };
          }

          case 'update_os': {
            if (!input.confirm) return { warning: 'Actualizar el OS puede tardar varios minutos y reiniciará el sistema. Llama de nuevo con confirm:true.' };
            console.log('[supervisor] Actualizando HA OS...');
            const r = await svPost('/os/update');
            return { success: r.result === 'ok', response: r };
          }

          case 'update_supervisor': {
            console.log('[supervisor] Actualizando Supervisor...');
            const r = await svPost('/supervisor/update');
            return { success: r.result === 'ok', response: r };
          }

          case 'restart_addon': {
            if (!input.addon_slug) return { error: 'addon_slug requerido' };
            console.log(`[supervisor] Reiniciando add-on: ${input.addon_slug}`);
            const r = await svPost(`/addons/${input.addon_slug}/restart`);
            return { success: r.result === 'ok', addon: input.addon_slug };
          }

          case 'start_addon': {
            if (!input.addon_slug) return { error: 'addon_slug requerido' };
            const r = await svPost(`/addons/${input.addon_slug}/start`);
            return { success: r.result === 'ok', addon: input.addon_slug };
          }

          case 'stop_addon': {
            if (!input.addon_slug) return { error: 'addon_slug requerido' };
            const r = await svPost(`/addons/${input.addon_slug}/stop`);
            return { success: r.result === 'ok', addon: input.addon_slug };
          }

          case 'install_addon': {
            if (!input.addon_slug) return { error: 'addon_slug requerido' };
            console.log(`[supervisor] Instalando add-on: ${input.addon_slug}`);
            const r = await svPost(`/addons/${input.addon_slug}/install`);
            return { success: r.result === 'ok', addon: input.addon_slug, response: r };
          }

          case 'uninstall_addon': {
            if (!input.addon_slug || !input.confirm) return { warning: `Esto desinstalará "${input.addon_slug}" permanentemente. Llama con confirm:true.` };
            const r = await svPost(`/addons/${input.addon_slug}/uninstall`);
            return { success: r.result === 'ok', addon: input.addon_slug };
          }

          case 'get_core_info': {
            const r = await svGet('/core/info');
            return r.data || r;
          }

          case 'get_os_info': {
            const r = await svGet('/os/info');
            return r.data || r;
          }

          case 'restart_core': {
            if (!input.confirm) return { warning: 'Esto reiniciará Home Assistant. Todos los usuarios se desconectarán ~30s. Llama con confirm:true.' };
            console.log('[supervisor] Reiniciando HA Core...');
            const r = await svPost('/core/restart');
            return { success: r.result === 'ok' };
          }

          case 'get_config_entries': {
            const r = await haGet('/config/config_entries');
            return { entries: r, total: r.length };
          }

          case 'reload_integration': {
            if (!input.integration_domain) return { error: 'integration_domain requerido' };
            const entries = await haGet('/config/config_entries').catch(() => []);
            const matching = entries.filter(e => e.domain === input.integration_domain);
            if (matching.length === 0) return { error: `No se encontró ninguna config entry para el dominio: ${input.integration_domain}` };
            const results = [];
            for (const entry of matching) {
              try {
                await haPost(`/services/homeassistant/reload_config_entry`, { entry_id: entry.entry_id });
                results.push({ title: entry.title, entry_id: entry.entry_id, success: true });
                console.log(`[supervisor] Integración recargada: ${entry.title} (${input.integration_domain})`);
              } catch (e) {
                results.push({ title: entry.title, entry_id: entry.entry_id, success: false, error: e.message });
              }
            }
            return { domain: input.integration_domain, results, reloaded: results.filter(r => r.success).length };
          }

          case 'reload_all_integrations': {
            const entries = await haGet('/config/config_entries').catch(() => []);
            const results = [];
            for (const entry of entries) {
              try {
                await haPost(`/services/homeassistant/reload_config_entry`, { entry_id: entry.entry_id });
                results.push({ domain: entry.domain, title: entry.title, success: true });
              } catch {}
            }
            return { reloaded: results.filter(r => r.success).length, total: entries.length, results: results.slice(0, 20) };
          }

          case 'get_hacs_updates': {
            try {
              const states = await haGet('/states');
              const hacsEntities = states.filter(e => e.entity_id.startsWith('update.') && e.state === 'on');
              return { pending_updates: hacsEntities.map(e => ({ entity: e.entity_id, name: e.attributes?.friendly_name, installed: e.attributes?.installed_version, latest: e.attributes?.latest_version })), total: hacsEntities.length };
            } catch (e) {
              return { error: e.message };
            }
          }

          case 'update_hacs_repo': {
            if (!input.addon_slug) return { error: 'addon_slug (entity_id del update) requerido' };
            await haPost('/services/update/install', { entity_id: input.addon_slug });
            return { success: true, updated: input.addon_slug };
          }

          // ── Gestión de repositorios de add-ons ──────────────────────────────
          // NOTA: la API del Supervisor devuelve data como array directo:
          //   {"result":"ok","data":[{slug,name,source,url,...},...]}
          case 'list_repos': {
            const r = await svGet('/store/repositories');
            const repos = Array.isArray(r.data) ? r.data : ((r.data || r).repositories || []);
            return { repositories: repos.map(rp => ({ slug: rp.slug, name: rp.name, url: rp.source || rp.url })), total: repos.length };
          }

          case 'refresh_repo': {
            // Ciclo completo: encuentra el repo, lo borra y vuelve a añadirlo.
            // Esto fuerza al Supervisor a descargar la versión más reciente del GitHub.
            const repoUrl = input.repo_url || 'https://github.com/padilla585projects/Cloudeinhasisio';
            const slugOverride = input.repo_slug; // si se conoce el slug, se puede saltar el listado

            // 1. Obtener slug del repo
            let repoSlug = slugOverride;
            if (!repoSlug) {
              const reposData = await svGet('/store/repositories').catch(() => ({}));
              const allRepos = Array.isArray(reposData.data) ? reposData.data : ((reposData.data || reposData).repositories || []);
              const found = allRepos.find(rp => (rp.source || rp.url || '').includes('padilla585projects'));
              if (!found) {
                // Si no está en la lista, solo intentamos añadirlo
                console.log('[supervisor] Repo no encontrado — añadiendo directamente');
                const addR = await svPost('/store/repositories', { repository: repoUrl });
                await new Promise(r => setTimeout(r, 4000));
                return { action: 'added', url: repoUrl, response: addR };
              }
              repoSlug = found.slug;
              console.log(`[supervisor] Repo encontrado: slug=${repoSlug}`);
            }

            // 2. Borrar el repo
            const delR = await fetch(`http://supervisor/store/repositories/${repoSlug}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${C.HA_TOKEN}`, 'Content-Type': 'application/json' }
            });
            const delText = await delR.text();
            console.log(`[supervisor] Repo borrado (${repoSlug}): ${delText}`);

            // 3. Esperar un momento
            await new Promise(r => setTimeout(r, 2000));

            // 4. Volver a añadir
            const addR = await svPost('/store/repositories', { repository: repoUrl });
            console.log(`[supervisor] Repo re-añadido: ${repoUrl}`);

            // 5. Esperar a que el Supervisor cargue el índice
            await new Promise(r => setTimeout(r, 5000));

            return {
              success: true,
              steps: ['repo_deleted', 'repo_readded'],
              repo_url: repoUrl,
              repo_slug: repoSlug,
              note: 'El Supervisor ya tiene la versión más reciente del repo. Llama ahora a ha_supervisor action=update_addon addon_slug=jarvis_ai_agent para instalar.'
            };
          }

          case 'deploy_update': {
            // Ciclo completo: refresh_repo + update_addon en una sola llamada.
            // Usa después de un github_push para que la actualización se instale sola.
            const deployRepoUrl = input.repo_url || 'https://github.com/padilla585projects/Cloudeinhasisio';
            const addonSlug = input.addon_slug || 'jarvis_ai_agent';

            console.log('[supervisor] deploy_update: iniciando ciclo refresh+update...');

            // Paso 1: Obtener repos y borrar
            const reposData = await svGet('/store/repositories').catch(() => ({}));
            const allRepos = Array.isArray(reposData.data) ? reposData.data : ((reposData.data || reposData).repositories || []);
            const found = allRepos.find(rp => (rp.source || rp.url || '').includes('padilla585projects'));

            if (found) {
              await fetch(`http://supervisor/store/repositories/${found.slug}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${C.HA_TOKEN}`, 'Content-Type': 'application/json' }
              }).catch(() => {});
              console.log(`[supervisor] Repo borrado: ${found.slug}`);
              await new Promise(r => setTimeout(r, 2000));
            }

            // Paso 2: Re-añadir repo
            await svPost('/store/repositories', { repository: deployRepoUrl }).catch(() => {});
            console.log('[supervisor] Repo re-añadido');

            // Paso 3: Esperar que el Supervisor indexe
            await new Promise(r => setTimeout(r, 6000));

            // Paso 4: Instalar actualización
            console.log(`[supervisor] Instalando actualización de ${addonSlug}...`);
            const updateR = await svPost(`/addons/${addonSlug}/update`).catch(e => ({ error: e.message }));

            return {
              success: updateR.result === 'ok' || !updateR.error,
              steps_completed: ['repo_deleted', 'repo_readded', 'update_triggered'],
              addon: addonSlug,
              update_response: updateR,
              note: updateR.result === 'ok'
                ? '¡Actualización en curso! Jarvis se reiniciará en unos segundos.'
                : 'Repo actualizado. Si el update no arrancó, espera 10s y prueba update_addon.'
            };
          }

          case 'list_backups': {
            const r = await svGet('/backups');
            const backups = (r.data || r).backups || [];
            return {
              backups: backups.map(b => ({
                slug: b.slug, name: b.name, date: b.date,
                size_mb: b.size ? (b.size / 1024 / 1024).toFixed(1) : null,
                type: b.type, protected: b.protected
              })).sort((a, b) => new Date(b.date) - new Date(a.date)),
              total: backups.length
            };
          }

          case 'create_backup': {
            const backupName = input.name || `Jarvis_backup_${new Date().toISOString().slice(0, 10)}`;
            console.log(`[supervisor] Creando backup: ${backupName}`);
            const r = await svPost('/backups/new/full', { name: backupName });
            return { success: r.result === 'ok', slug: (r.data || r).slug, name: backupName, response: r };
          }

          default:
            return { error: `Acción desconocida: ${input.action}` };
        }
      }

      // ─── Red local ───
      case 'network': {
        const { action: netAction, host, subnet, ports, method, url: netUrl, body: netBody, headers: netHeaders, mac } = input;

        switch (netAction) {
          case 'arp_table': {
            return new Promise((resolve) => {
              exec('arp -n 2>/dev/null || ip neigh show 2>/dev/null', (err, stdout) => {
                if (err && !stdout) return resolve({ error: 'No se pudo leer la tabla ARP', raw: err?.message });
                const lines = stdout.trim().split('\n').filter(l => l && !l.startsWith('Address') && !l.startsWith('('));
                const devices = lines.map(line => {
                  const parts = line.split(/\s+/);
                  return { ip: parts[0], mac: parts[2] || parts[4] || '?', iface: parts[parts.length - 1] };
                }).filter(d => d.ip && /^\d+\.\d+\.\d+\.\d+$/.test(d.ip));
                resolve({ devices, count: devices.length });
              });
            });
          }

          case 'scan_subnet': {
            const sub = subnet || await new Promise(r => {
              exec("ip route | grep src | awk '{print $NF}' | head -1", (err, out) => {
                const ip = out.trim();
                r(ip && /^\d+\.\d+\.\d+/.test(ip) ? ip.split('.').slice(0, 3).join('.') : '192.168.1');
              });
            });
            const promises = Array.from({ length: 254 }, (_, i) => new Promise(r => {
              exec(`ping -c 1 -W 1 ${sub}.${i + 1} 2>/dev/null`, err => r(err ? null : `${sub}.${i + 1}`));
            }));
            const alive = (await Promise.all(promises)).filter(Boolean);
            return { subnet: sub, alive, count: alive.length };
          }

          case 'ping': {
            if (!host) return { error: 'host es requerido' };
            if (!/^[a-zA-Z0-9.\-]+$/.test(host) || host.length > 253) {
              return { error: `Host inválido: "${host}". Solo se permiten IPs o nombres de host alfanuméricos.` };
            }
            return new Promise(r => {
              exec(`ping -c 3 -W 2 ${host} 2>/dev/null`, (err, stdout) => {
                if (err && !stdout) return r({ alive: false, host });
                const m = stdout.match(/(\d+\.\d+)\/(\d+\.\d+)\/(\d+\.\d+)/);
                r({ alive: !err, host, latency_ms: m ? parseFloat(m[2]) : null });
              });
            });
          }

          case 'port_scan': {
            if (!host) return { error: 'host es requerido' };
            const portsToScan = ports || [22, 80, 443, 8080, 8123, 3000, 3001, 5000, 8888, 9000, 9090, 11434, 1234];
            const results = await Promise.all(portsToScan.map(port => new Promise(r => {
              const s = new net.Socket();
              s.setTimeout(1200);
              s.on('connect', () => { s.destroy(); r({ port, open: true }); });
              s.on('timeout', () => { s.destroy(); r({ port, open: false }); });
              s.on('error', () => r({ port, open: false }));
              s.connect(port, host);
            })));
            return { host, open_ports: results.filter(r => r.open).map(r => r.port), scanned: portsToScan.length };
          }

          case 'http_request': {
            if (!netUrl) return { error: 'url es requerido' };
            // Bloquear loopback para evitar que se llame a la propia API de HA o del servidor
            try {
              const parsedNetUrl = new URL(netUrl);
              if (!['http:', 'https:'].includes(parsedNetUrl.protocol)) {
                return { error: `Protocolo no permitido: ${parsedNetUrl.protocol}` };
              }
              const loopback = ['127.0.0.1', '::1', '0.0.0.0'];
              if (loopback.includes(parsedNetUrl.hostname) || parsedNetUrl.hostname === 'localhost') {
                return { error: `Acceso a loopback bloqueado. Para acceder a la API de HA usa haGet/haPost internamente.` };
              }
            } catch {
              return { error: `URL inválida: ${netUrl}` };
            }
            const opts = { method: method || 'GET', headers: { 'Content-Type': 'application/json', ...(netHeaders || {}) }, timeout: 8000 };
            if (netBody && method !== 'GET') opts.body = JSON.stringify(netBody);
            const res = await fetch(netUrl, opts);
            const ct = res.headers.get('content-type') || '';
            const resBody = ct.includes('json') ? await res.json() : (await res.text()).slice(0, 5000);
            return { status: res.status, ok: res.ok, body: resBody };
          }

          case 'discover_agents': {
            const AGENT_SIGS = [
              { name: 'Ollama', port: 11434, path: '/api/tags', type: 'ollama' },
              { name: 'LM Studio', port: 1234, path: '/v1/models', type: 'openai_compatible' },
              { name: 'LocalAI', port: 8080, path: '/v1/models', type: 'openai_compatible' },
              { name: 'Text Gen WebUI', port: 5000, path: '/v1/models', type: 'openai_compatible' },
              { name: 'AnythingLLM', port: 3001, path: '/api/ping', type: 'custom' },
              { name: 'Open WebUI', port: 8080, path: '/api/version', type: 'custom' },
              { name: 'Jarvis', port: 3000, path: '/api/health', type: 'jarvis' },
            ];
            const arpHosts = await new Promise(r => {
              exec('arp -n 2>/dev/null || ip neigh show 2>/dev/null', (err, out) => {
                const ips = (out || '').trim().split('\n').map(l => l.split(/\s+/)[0]).filter(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
                r([...new Set(ips)]);
              });
            });
            console.log(`[discover_agents] ${arpHosts.length} hosts en la ARP table: ${arpHosts.join(', ') || '(ninguno)'}`);
            const found = [];
            for (const h of arpHosts) {
              for (const sig of AGENT_SIGS) {
                try {
                  const res = await fetch(`http://${h}:${sig.port}${sig.path}`, { timeout: 2000 });
                  if (res.ok) {
                    const info = await res.json().catch(() => ({}));
                    found.push({ name: sig.name, host: h, port: sig.port, type: sig.type, url: `http://${h}:${sig.port}`, info });
                    console.log(`[discover_agents] ✓ ${sig.name} encontrado en ${h}:${sig.port}`);
                  }
                } catch { /* not reachable */ }
              }
            }
            console.log(`[discover_agents] Resultado: ${found.length} agente(s) encontrado(s)`);
            return { agents: found, count: found.length, scanned_hosts: arpHosts.length };
          }

          case 'wol': {
            if (!mac) return { error: 'mac es requerido (formato AA:BB:CC:DD:EE:FF)' };
            const macBytes = mac.replace(/[:\-]/g, '').match(/../g).map(h => parseInt(h, 16));
            const magic = Buffer.alloc(102);
            magic.fill(0xff, 0, 6);
            for (let i = 0; i < 16; i++) Buffer.from(macBytes).copy(magic, 6 + i * 6);
            return new Promise(r => {
              const sock = dgram.createSocket('udp4');
              sock.once('error', err => { sock.close(); r({ error: err.message }); });
              sock.bind(() => {
                sock.setBroadcast(true);
                sock.send(magic, 0, magic.length, 9, '255.255.255.255', () => {
                  sock.close();
                  r({ sent: true, mac, message: 'Magic packet enviado — el dispositivo debería encenderse en unos segundos.' });
                });
              });
            });
          }

          default:
            return { error: `Acción de red desconocida: ${netAction}` };
        }
      }

      // ─── Archivos del PC del usuario (vía browser) ───
      case 'local_file': {
        if (!state.currentSendEvent) return { error: 'No hay sesión activa. Esta tool requiere que el usuario esté en el chat.' };
        const requestId = `lf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        try {
          return await new Promise((resolve, reject) => {
            state.pendingLocalRequests.set(requestId, { resolve, reject });
            state.currentSendEvent({ type: 'local_request', requestId, action: input.action, path: input.path || '.', query: input.query || '', maxDepth: input.max_depth || 2 });
            setTimeout(() => {
              if (state.pendingLocalRequests.has(requestId)) {
                state.pendingLocalRequests.delete(requestId);
                reject(new Error('El usuario no tiene una carpeta conectada o no respondió. Dile que haga clic en "📁 Conectar PC" en la interfaz.'));
              }
            }, 30000);
          });
        } catch (e) {
          return { error: e.message };
        }
      }

      // ─── Chat con otros agentes IA ───
      case 'agent_chat': {
        const { agent_url, agent_type, model: agentModel, message: agentMsg, system_prompt } = input;
        const sysBlock = system_prompt ? [{ role: 'system', content: system_prompt }] : [];
        try {
          if (agent_type === 'ollama') {
            const res = await fetch(`${agent_url}/api/chat`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 60000,
              body: JSON.stringify({ model: agentModel || 'llama3.2', messages: [...sysBlock, { role: 'user', content: agentMsg }], stream: false })
            });
            const data = await res.json();
            return { response: data.message?.content || data.response, model: data.model, agent_url };
          } else if (agent_type === 'jarvis') {
            const res = await fetch(`${agent_url}/api/chat`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 120000,
              body: JSON.stringify({ messages: [{ role: 'user', content: agentMsg }] })
            });
            const text = await res.text();
            const textParts = text.split('\n').filter(l => l.startsWith('data: '))
              .map(l => { try { const d = JSON.parse(l.slice(6)); return d.type === 'text' ? d.text : ''; } catch { return ''; } }).join('');
            return { response: textParts, agent_type: 'jarvis', agent_url };
          } else {
            // openai_compatible / custom
            const res = await fetch(`${agent_url}/v1/chat/completions`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 60000,
              body: JSON.stringify({ model: agentModel || 'default', messages: [...sysBlock, { role: 'user', content: agentMsg }] })
            });
            const data = await res.json();
            return { response: data.choices?.[0]?.message?.content || JSON.stringify(data), model: data.model, agent_url };
          }
        } catch (e) {
          return { error: `Error comunicando con agente: ${e.message}`, agent_url };
        }
      }

      // ─── GitHub self-evolution ───
      case 'github_push': {
        if (!C.GITHUB_TOKEN) {
          return { error: 'GITHUB_TOKEN no configurado. Añade el token en la configuración del add-on.' };
        }
        const ghHeaders = {
          'Authorization': `token ${C.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'Jarvis-HA-Agent'
        };
        const ghBase = `https://api.github.com/repos/${C.GITHUB_REPO}/contents/${input.path}`;

        try {
          if (input.action === 'list_files') {
            const r = await fetch(ghBase, { headers: ghHeaders });
            if (!r.ok) return { error: `GitHub ${r.status}: ${await r.text()}` };
            const items = await r.json();
            return { files: items.map(f => ({ name: f.name, path: f.path, type: f.type, size: f.size })) };
          }

          if (input.action === 'read_file') {
            const r = await fetch(ghBase, { headers: ghHeaders });
            if (!r.ok) return { error: `GitHub ${r.status}: ${await r.text()}` };
            const data = await r.json();
            const content = Buffer.from(data.content, 'base64').toString('utf8');
            return { content, sha: data.sha, size: data.size };
          }

          if (input.action === 'write_file') {
            if (!input.content) return { error: 'content requerido para write_file' };
            if (!input.commit_message) return { error: 'commit_message requerido para write_file' };
            // Bloqueo de seguridad inamovible: publicar al repo requiere confirmación explícita de Adrián
            if (!input.adrian_confirmed) {
              console.log(`[SECURITY] Intento de github_push write_file bloqueado sin confirmación: ${input.path}`);
              return { error: 'PUBLICACIÓN BLOQUEADA: github_push write_file requiere confirmación explícita de Adrián. Muéstrale el contenido preparado y espera a que diga "sí, publícalo" o similar. Esta restricción es inamovible.' };
            }

            // Obtener SHA actual (necesario para actualizar)
            let sha;
            try {
              const existing = await fetch(ghBase, { headers: ghHeaders });
              if (existing.ok) {
                const d = await existing.json();
                sha = d.sha;
              }
            } catch (_) {}

            const body = {
              message: input.commit_message,
              content: Buffer.from(input.content, 'utf8').toString('base64'),
              branch: C.GITHUB_BRANCH
            };
            if (sha) body.sha = sha;

            const r = await fetch(ghBase, {
              method: 'PUT',
              headers: ghHeaders,
              body: JSON.stringify(body)
            });
            if (!r.ok) return { error: `GitHub ${r.status}: ${await r.text()}` };
            const result = await r.json();
            return {
              success: true,
              commit: result.commit?.sha?.slice(0, 7),
              path: input.path,
              action: sha ? 'updated' : 'created'
            };
          }

          return { error: `Acción desconocida: ${input.action}` };
        } catch (err) {
          return { error: `GitHub: ${err.message}` };
        }
      }

      // ─── Rollback ───
      case 'rollback': {
        if (!fs.existsSync(C.BACKUPS_DIR)) return { error: 'No hay backups todavía.' };
        const safeName = input.filepath.replace(/[/\\:]/g, '_');
        const allBackups = fs.readdirSync(C.BACKUPS_DIR)
          .filter(f => f.startsWith(safeName + '.'))
          .sort().reverse();
        if (allBackups.length === 0) return { error: `No hay backups para ${input.filepath}` };

        if (input.action === 'list') {
          return { backups: allBackups, filepath: input.filepath, count: allBackups.length };
        }

        if (input.action === 'restore') {
          if (!input.adrian_confirmed) return { error: 'BLOQUEADO: Restaurar un backup requiere confirmación explícita de Adrián. Muéstrale los backups disponibles primero.' };
          if (!input.backup_name) return { error: 'backup_name requerido para restaurar.' };
          const backupPath = path.join(C.BACKUPS_DIR, input.backup_name);
          if (!fs.existsSync(backupPath)) return { error: `Backup no encontrado: ${input.backup_name}` };
          autoBackup(input.filepath); // backup del estado actual antes de restaurar
          fs.copyFileSync(backupPath, input.filepath);
          console.log(`[rollback] Restaurado: ${input.filepath} ← ${input.backup_name}`);
          return { success: true, message: `Restaurado ${input.filepath} desde ${input.backup_name}` };
        }
        return { error: `Acción desconocida: ${input.action}` };
      }

      // ─── Análisis de patrones manual ───
      case 'analyze_patterns': {
        const PATTERNS_FILE = path.join(C.DATA_DIR, 'state_snapshots.json');
        const ROUTINES_FILE = path.join(C.DATA_DIR, 'detected_routines.json');
        if (input.action === 'show_routines') {
          const routines = loadJSON(ROUTINES_FILE, []);
          const snapshots = loadJSON(PATTERNS_FILE, []);
          return {
            routines_detected: routines.length,
            routines,
            snapshots_collected: snapshots.length,
            analysis_note: snapshots.length < 50 ? `Faltan ${50 - snapshots.length} snapshots para análisis (se recogen cada 10 min)` : 'Datos suficientes para análisis'
          };
        }
        if (input.action === 'force_analysis') {
          const snapshots = loadJSON(PATTERNS_FILE, []);
          if (snapshots.length < 10) return { error: `Solo hay ${snapshots.length} snapshots. Necesito al menos 10 para analizar.` };
          // analyzePatterns is defined in server.js — call it if available
          try {
            const { analyzePatterns } = require('../background/patterns');
            analyzePatterns().catch(() => {});
          } catch {
            // If patterns module not available, just note it
            return { success: true, message: 'Análisis de patrones solicitado pero el módulo de patrones no está disponible como módulo separado todavía.' };
          }
          return { success: true, message: 'Análisis de patrones lanzado en background. Las sugerencias aparecerán en proactive_thought y requerirán tu aprobación.' };
        }
        return { error: `Acción desconocida: ${input.action}` };
      }

      // ─── Voz bidireccional Alexa ───
      case 'alexa_bidirectional': {
        if (input.action === 'setup') {
          // Crear input_text en HA y la automatización que enruta voz → Jarvis
          const addonUrl = 'http://localhost:3000';
          const automationYaml = `alias: "Jarvis - Voz bidireccional Alexa"
description: "Escucha comandos de voz dirigidos a Jarvis y los enruta al agente"
trigger:
  - platform: state
    entity_id: input_text.jarvis_voice_command
    not_to: ""
condition:
  - condition: template
    value_template: "{{ trigger.to_state.state != trigger.from_state.state }}"
action:
  - variables:
      command: "{{ trigger.to_state.state }}"
      source_echo: "{{ trigger.to_state.attributes.source_echo | default('alexa_salon') }}"
  - service: rest_command.jarvis_voice
    data:
      command: "{{ command }}"
      source_echo: "{{ source_echo }}"
  - service: input_text.set_value
    target:
      entity_id: input_text.jarvis_voice_command
    data:
      value: ""
mode: single`;

          const restCommandYaml = `rest_command:
  jarvis_voice:
    url: "${addonUrl}/api/alexa-voice"
    method: POST
    headers:
      Content-Type: application/json
    payload: '{"command": "{{ command }}", "source_echo": "{{ source_echo }}"}'`;

          const inputTextYaml = `input_text:
  jarvis_voice_command:
    name: "Jarvis - Comando de voz"
    max: 255
    initial: ""`;

          // Escribir rest_command si no existe
          const restPath = path.join(C.HA_CONFIG, 'rest_command.yaml');
          if (!fs.existsSync(restPath)) {
            fs.writeFileSync(restPath, restCommandYaml);
          }

          // Crear automatización
          const automationsPath = path.join(C.HA_CONFIG, 'automations.yaml');
          let existing = '';
          if (fs.existsSync(automationsPath)) { autoBackup(automationsPath); existing = fs.readFileSync(automationsPath, 'utf8'); }
          if (!existing.includes('Jarvis - Voz bidireccional')) {
            fs.writeFileSync(automationsPath, existing + '\n- ' + automationYaml.replace(/\n/g, '\n  ') + '\n');
          }

          return {
            success: true,
            message: 'Automatización de voz creada. Pasos manuales restantes en Alexa:',
            steps: [
              '1. En la app Alexa → Rutinas → Nueva rutina',
              '2. Cuando: "Cuando dices: Jarvis [pausa] *"',
              '3. Acción: Casa Inteligente → input_text.jarvis_voice_command → Valor: el texto dicho',
              '4. Guarda la rutina',
              '5. Prueba: "Alexa, Jarvis, ¿qué temperatura hace en el salón?"'
            ],
            files_created: ['rest_command.yaml', 'automatización en automations.yaml'],
            note: 'El campo input_text.jarvis_voice_command necesita añadirse a configuration.yaml manualmente o Jarvis lo hará con write_file si lo pides.'
          };
        }

        if (input.action === 'check') {
          const pending = loadJSON(C.ALEXA_VOICE_FILE, []);
          return { pending_commands: pending.length, commands: pending };
        }

        if (input.action === 'respond') {
          if (!input.message) return { error: 'message requerido' };
          const target = input.target_echo || 'media_player.echo_salon';
          await haPost('/services/notify/alexa_media', {
            message: input.message,
            target: target,
            data: { type: 'tts' }
          });
          return { success: true, message: `Respuesta enviada a ${target}: "${input.message}"` };
        }

        if (input.action === 'status') {
          const pending = loadJSON(C.ALEXA_VOICE_FILE, []);
          const automationsPath = path.join(C.HA_CONFIG, 'automations.yaml');
          const hasAutomation = fs.existsSync(automationsPath) && fs.readFileSync(automationsPath, 'utf8').includes('Jarvis - Voz bidireccional');
          return { configured: hasAutomation, pending_commands: pending.length, endpoint: '/api/alexa-voice' };
        }

        return { error: `Acción desconocida: ${input.action}` };
      }

      // ─── Multiusuario ───
      case 'manage_users': {
        let users = loadJSON(C.USERS_FILE, {
          adrian: { display_name: 'Adrián', permissions: 'admin', preferences: {}, created: new Date().toISOString() }
        });

        if (input.action === 'list') {
          return { users: Object.entries(users).map(([u, d]) => ({ username: u, ...d })) };
        }

        if (['add', 'remove', 'set_permissions'].includes(input.action)) {
          if (!input.adrian_confirmed) return { error: 'BLOQUEADO: Gestionar usuarios requiere confirmación explícita de Adrián.' };
        }

        if (input.action === 'add') {
          if (!input.username) return { error: 'username requerido' };
          if (users[input.username]) return { error: `Usuario "${input.username}" ya existe` };
          users[input.username] = {
            display_name: input.display_name || input.username,
            permissions: 'read',
            preferences: input.preferences || {},
            created: new Date().toISOString()
          };
          saveJSON(C.USERS_FILE, users);
          return { success: true, message: `Usuario "${input.username}" creado con permisos de solo lectura.` };
        }

        if (input.action === 'remove') {
          if (input.username === 'adrian') return { error: 'No se puede eliminar al usuario principal (adrian).' };
          if (!users[input.username]) return { error: `Usuario "${input.username}" no existe` };
          delete users[input.username];
          saveJSON(C.USERS_FILE, users);
          return { success: true, message: `Usuario "${input.username}" eliminado.` };
        }

        if (input.action === 'set_permissions') {
          if (!input.username || !input.permissions) return { error: 'username y permissions requeridos' };
          if (!users[input.username]) return { error: `Usuario "${input.username}" no existe` };
          if (input.permissions === 'admin' && input.username !== 'adrian') return { error: 'Solo adrian puede tener permisos admin.' };
          users[input.username].permissions = input.permissions;
          saveJSON(C.USERS_FILE, users);
          return { success: true, message: `Permisos de "${input.username}" actualizados a "${input.permissions}".` };
        }

        if (input.action === 'get_profile') {
          if (!input.username) return { error: 'username requerido' };
          if (!users[input.username]) return { error: `Usuario "${input.username}" no existe` };
          return { profile: { username: input.username, ...users[input.username] } };
        }

        return { error: `Acción desconocida: ${input.action}` };
      }

      // ─── Emergencias autónomas ───
      case 'emergency_config': {
        let config = loadJSON(C.EMERGENCY_CONFIG_FILE, {
          enabled: false,
          triggers: [],
          actions: [],
          notify_telegram: true,
          last_updated: null
        });

        if (input.action === 'get_config') {
          return { config, status: config.enabled ? 'ACTIVO' : 'DESACTIVADO' };
        }

        if (['set_triggers', 'set_actions', 'enable'].includes(input.action)) {
          if (!input.adrian_confirmed) return { error: 'BLOQUEADO: Configurar emergencias requiere confirmación explícita de Adrián.' };
        }

        if (input.action === 'set_triggers') {
          if (!input.triggers) return { error: 'triggers requerido' };
          config.triggers = input.triggers;
          config.last_updated = new Date().toISOString();
          saveJSON(C.EMERGENCY_CONFIG_FILE, config);
          return { success: true, message: `${input.triggers.length} triggers de emergencia configurados.`, triggers: config.triggers };
        }

        if (input.action === 'set_actions') {
          if (!input.actions) return { error: 'actions requerido' };
          config.actions = input.actions;
          config.last_updated = new Date().toISOString();
          saveJSON(C.EMERGENCY_CONFIG_FILE, config);
          return { success: true, message: `${input.actions.length} acciones de emergencia pre-autorizadas.`, actions: config.actions };
        }

        if (input.action === 'enable') {
          if (config.triggers.length === 0) return { error: 'Define triggers primero con set_triggers.' };
          if (config.actions.length === 0) return { error: 'Define acciones pre-autorizadas primero con set_actions.' };
          config.enabled = true;
          config.last_updated = new Date().toISOString();
          saveJSON(C.EMERGENCY_CONFIG_FILE, config);
          return { success: true, message: 'Modo emergencias ACTIVADO. Jarvis monitorizará los triggers definidos y actuará con las acciones pre-autorizadas sin esperar confirmación.' };
        }

        if (input.action === 'disable') {
          config.enabled = false;
          saveJSON(C.EMERGENCY_CONFIG_FILE, config);
          return { success: true, message: 'Modo emergencias DESACTIVADO.' };
        }

        if (input.action === 'test') {
          return {
            simulation: true,
            triggers: config.triggers,
            actions_that_would_execute: config.actions,
            status: config.enabled ? 'Se ejecutarían automáticamente' : 'NO se ejecutarían (modo desactivado)',
            note: 'Simulación sin ejecución real.'
          };
        }

        return { error: `Acción desconocida: ${input.action}` };
      }

      // ─── Plano SVG de la instalación ───
      case 'render_floorplan': {
        const FLOORPLAN_FILE = path.join(C.DATA_DIR, 'floorplan_layout.json');

        if (input.action === 'get_layout') {
          return { layout: fs.existsSync(FLOORPLAN_FILE) ? JSON.parse(fs.readFileSync(FLOORPLAN_FILE, 'utf8')) : {} };
        }
        if (input.action === 'save_layout') {
          if (!input.layout) return { error: 'layout requerido' };
          fs.writeFileSync(FLOORPLAN_FILE, JSON.stringify(input.layout, null, 2));
          return { success: true };
        }

        // action === 'render'
        let areas = [];
        try {
          const tmplRes = await fetch(`${C.HA_URL}/api/template`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${C.HA_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ template: `{% set ns = namespace(r=[]) %}{% for a in areas() %}{% set ns.r = ns.r + [{'id': a, 'name': area_name(a), 'entities': area_entities(a)|list}] %}{% endfor %}{{ ns.r | tojson }}` })
          });
          areas = JSON.parse(await tmplRes.text());
        } catch (e) {
          return { error: `No se pudieron obtener las áreas de HA: ${e.message}` };
        }

        let stateMap = {};
        try {
          const states = await haGet('/states');
          for (const s of states) stateMap[s.entity_id] = s.state;
        } catch {}

        const includeEntities = input.include_entities !== false;
        const cols = Math.min(Math.ceil(Math.sqrt(Math.max(areas.length, 1))), 4);
        const CW = 188, CH = 148, PAD = 14;
        const svgW = cols * CW + (cols + 1) * PAD;
        const svgH = Math.ceil(areas.length / cols) * CH + (Math.ceil(areas.length / cols) + 1) * PAD + 28;

        let roomsSVG = '';
        areas.forEach((area, i) => {
          const col = i % cols;
          const row = Math.floor(i / cols);
          const x = PAD + col * (CW + PAD);
          const y = PAD + row * (CH + PAD);
          const entities = area.entities || [];
          const lights = entities.filter(id => id.startsWith('light.') && stateMap[id] === 'on');
          const occupied = entities.some(id => (id.startsWith('binary_sensor.') && stateMap[id] === 'on') || (id.startsWith('person.') && stateMap[id] === 'home'));
          const active = entities.filter(id => ['on', 'home', 'playing', 'open'].includes(stateMap[id])).length;
          const fill = occupied ? '#0f2744' : '#0d1117';
          const stroke = lights.length > 0 ? '#fbbf24' : (occupied ? '#3b82f6' : '#21262d');
          let dots = '';
          if (includeEntities) {
            entities.slice(0, 12).forEach((eid, di) => {
              const dx = x + 10 + (di % 6) * 28;
              const dy = y + CH - 22 + Math.floor(di / 6) * 15;
              const isActive = ['on', 'home', 'playing', 'open'].includes(stateMap[eid]);
              dots += `<circle cx="${dx}" cy="${dy}" r="5" fill="${isActive ? '#34d399' : '#374151'}"><title>${eid}: ${stateMap[eid] || '?'}</title></circle>`;
            });
          }
          roomsSVG += `<rect x="${x}" y="${y}" width="${CW}" height="${CH}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>
${lights.length > 0 ? `<rect x="${x}" y="${y}" width="${CW}" height="${CH}" rx="10" fill="rgba(251,191,36,0.04)"/>` : ''}
<text x="${x+10}" y="${y+20}" font-family="ui-monospace,monospace" font-size="13" fill="#e6edf3" font-weight="600">${area.name}</text>
<text x="${x+10}" y="${y+35}" font-family="ui-monospace,monospace" font-size="9" fill="#8b949e">${entities.length} entidades${active > 0 ? ` · ${active} activas` : ''}</text>
${lights.length > 0 ? `<text x="${x + CW - 10}" y="${y + 20}" font-family="ui-monospace,monospace" font-size="11" fill="#fbbf24" text-anchor="end">${lights.length}💡</text>` : ''}
${occupied ? `<text x="${x + CW - 10}" y="${y + 35}" font-family="ui-monospace,monospace" font-size="10" fill="#60a5fa" text-anchor="end">●</text>` : ''}
${dots}`;
        });

        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgW} ${svgH}" style="background:#010409;border-radius:12px;border:1px solid #21262d;max-width:100%">${roomsSVG}<text x="${PAD}" y="${svgH - 8}" font-family="ui-monospace,monospace" font-size="9" fill="#30363d">Jarvis Floorplan · ${areas.length} áreas · ${new Date().toLocaleTimeString('es-ES')}</text></svg>`;

        return {
          success: true, areas_count: areas.length, svg,
          instruction: `Muestra el plano con este bloque en tu respuesta:\n\`\`\`html-render\n${svg}\n\`\`\``
        };
      }

      // ─── Modificar interfaz (update_ui) ───
      case 'update_ui': {
        const UI_DIR = path.join(C.DATA_DIR, 'ui_components');
        if (input.save_as) {
          if (!fs.existsSync(UI_DIR)) fs.mkdirSync(UI_DIR, { recursive: true });
          const fname = input.save_as.replace(/[^a-z0-9_-]/gi, '_') + '.html';
          fs.writeFileSync(path.join(UI_DIR, fname), input.html);
        }
        return {
          success: true,
          title: input.title || 'Componente UI',
          instruction: `Muestra el componente en tu respuesta con este bloque:\n\`\`\`html-render\n${input.html}\n\`\`\``
        };
      }

      case 'nexus_manage': {
        const DYNAMIC_EXPERTS_FILE = path.join(C.DATA_DIR, 'nexus/dynamic_experts.json');
        const DYNAMIC_MODULES_FILE = path.join(C.DATA_DIR, 'nexus/dynamic_modules.json');
        const dynExperts = loadJSON(DYNAMIC_EXPERTS_FILE, {});
        const dynModules = loadJSON(DYNAMIC_MODULES_FILE, {});

        // Lazy-load NEXUS references
        let NEXUS_MODULES, EXPERTS, nexusGetScore, nexusReloadDynamic, nexusHealth;
        try {
          const nexus = getNexus();
          NEXUS_MODULES = nexus.NEXUS_MODULES;
          EXPERTS = nexus.EXPERTS;
          nexusGetScore = nexus.nexusGetScore;
          nexusReloadDynamic = nexus.nexusReloadDynamic;
          nexusHealth = nexus.nexusHealth;
        } catch {
          // Fallback: read from state if nexus module not yet available
          NEXUS_MODULES = state.NEXUS_MODULES || {};
          EXPERTS = state.EXPERTS || {};
          nexusGetScore = state.nexusGetScore || (() => 0);
          nexusReloadDynamic = state.nexusReloadDynamic || (() => {});
          nexusHealth = state.nexusHealth || {};
        }

        switch (input.action) {
          case 'list': {
            const allExperts = { ...EXPERTS, ...dynExperts };
            const allModules = Object.keys(NEXUS_MODULES).concat(Object.keys(dynModules));
            const healthSummary = {};
            for (const [k, v] of Object.entries(allExperts)) {
              healthSummary[k] = { label: v.label, model: v.model === C.MODEL ? 'MODEL' : 'BG_MODEL', modules: v.modules, health: nexusGetScore(k), dynamic: !!dynExperts[k] };
            }
            return { experts: healthSummary, modules: allModules, dynamic_modules: Object.keys(dynModules) };
          }

          case 'create_expert': {
            if (!input.name || !input.config) return { error: 'Necesito name y config.' };
            if (EXPERTS[input.name]) return { error: `"${input.name}" es un experto base — usa edit_expert para modificar dinámicos o elige otro nombre.` };
            const cfg = input.config;
            dynExperts[input.name] = {
              model: cfg.model === 'BG_MODEL' ? C.BG_MODEL : C.MODEL,
              maxTokens: cfg.maxTokens || 6144,
              maxIter: cfg.maxIter || 15,
              modules: cfg.modules || ['base', 'autonomy'],
              label: cfg.label || input.name,
              keywords: cfg.keywords || []
            };
            saveJSON(DYNAMIC_EXPERTS_FILE, dynExperts);
            nexusReloadDynamic();
            return { success: true, expert: input.name, config: dynExperts[input.name], note: 'Experto creado y activo. El router lo usará automáticamente si las keywords coinciden.' };
          }

          case 'edit_expert': {
            if (!input.name || !input.config) return { error: 'Necesito name y config.' };
            if (!dynExperts[input.name]) return { error: `"${input.name}" no es un experto dinámico. Solo puedes editar los que hayas creado.` };
            const cfg = input.config;
            if (cfg.model) dynExperts[input.name].model = cfg.model === 'BG_MODEL' ? C.BG_MODEL : C.MODEL;
            if (cfg.maxTokens) dynExperts[input.name].maxTokens = cfg.maxTokens;
            if (cfg.maxIter) dynExperts[input.name].maxIter = cfg.maxIter;
            if (cfg.modules) dynExperts[input.name].modules = cfg.modules;
            if (cfg.label) dynExperts[input.name].label = cfg.label;
            if (cfg.keywords) dynExperts[input.name].keywords = cfg.keywords;
            saveJSON(DYNAMIC_EXPERTS_FILE, dynExperts);
            nexusReloadDynamic();
            return { success: true, expert: input.name, config: dynExperts[input.name] };
          }

          case 'delete_expert': {
            if (!input.name) return { error: 'Necesito name.' };
            if (EXPERTS[input.name]) return { error: `"${input.name}" es un experto base — no se puede eliminar.` };
            if (!dynExperts[input.name]) return { error: `No existe el experto dinámico "${input.name}".` };
            delete dynExperts[input.name];
            saveJSON(DYNAMIC_EXPERTS_FILE, dynExperts);
            nexusReloadDynamic();
            return { success: true, deleted: input.name };
          }

          case 'create_module': {
            if (!input.name || !input.content) return { error: 'Necesito name y content.' };
            if (NEXUS_MODULES[input.name]) return { error: `"${input.name}" es un módulo base — elige otro nombre.` };
            dynModules[input.name] = input.content;
            saveJSON(DYNAMIC_MODULES_FILE, dynModules);
            nexusReloadDynamic();
            return { success: true, module: input.name, length: input.content.length, note: 'Módulo creado. Ahora asígnalo a un experto con create_expert o edit_expert.' };
          }

          case 'edit_module': {
            if (!input.name || !input.content) return { error: 'Necesito name y content.' };
            if (NEXUS_MODULES[input.name]) return { error: `"${input.name}" es un módulo base — no se puede editar. Crea uno nuevo con otro nombre.` };
            if (!dynModules[input.name]) return { error: `No existe el módulo dinámico "${input.name}".` };
            dynModules[input.name] = input.content;
            saveJSON(DYNAMIC_MODULES_FILE, dynModules);
            nexusReloadDynamic();
            return { success: true, module: input.name, length: input.content.length };
          }

          case 'delete_module': {
            if (!input.name) return { error: 'Necesito name.' };
            if (NEXUS_MODULES[input.name]) return { error: `"${input.name}" es un módulo base — no se puede eliminar.` };
            if (!dynModules[input.name]) return { error: `No existe el módulo dinámico "${input.name}".` };
            delete dynModules[input.name];
            saveJSON(DYNAMIC_MODULES_FILE, dynModules);
            nexusReloadDynamic();
            return { success: true, deleted: input.name };
          }

          case 'get_health': {
            return { health: nexusHealth, version: 'NEXUS v1.0' };
          }

          default:
            return { error: `Acción desconocida: ${input.action}. Usa: list, create_expert, edit_expert, delete_expert, create_module, edit_module, delete_module, get_health.` };
        }
      }

      // ─── Mapa 3D de la casa ───
      case 'house_3d_map': {
        const MAP_CONFIG_FILE = path.join(C.DATA_DIR, 'house_3d_config.json');

        if (input.action === 'get_config') {
          const cfg = fs.existsSync(MAP_CONFIG_FILE) ? JSON.parse(fs.readFileSync(MAP_CONFIG_FILE, 'utf8')) : { rooms: [] };
          return { config: cfg, rooms_count: cfg.rooms?.length || 0 };
        }

        if (input.action === 'reset') {
          if (fs.existsSync(MAP_CONFIG_FILE)) fs.unlinkSync(MAP_CONFIG_FILE);
          return { success: true, message: 'Configuración del mapa 3D eliminada.' };
        }

        if (input.action === 'get_lovelace_card') {
          // Necesitamos la URL de ingress para el iframe
          return {
            success: true,
            note: 'Añade esta tarjeta a tu dashboard de Lovelace (en modo edición → añadir tarjeta → Manual)',
            yaml: `type: iframe\nurl: /api/hassio_ingress/${process.env.SUPERVISOR_TOKEN ? 'auto' : 'INGRESS_URL'}/3d-map\naspect_ratio: 75%`,
            alternative: 'Si no funciona la URL de ingress, prueba con la URL directa del add-on: http://IP_HA:3000/3d-map',
            tip: 'También puedes abrirlo directamente en tu navegador desde el panel lateral de Jarvis → clic derecho → Abrir en nueva pestaña → cambia la ruta a /3d-map'
          };
        }

        if (input.action === 'setup_rooms') {
          if (!input.rooms || !Array.isArray(input.rooms) || input.rooms.length === 0) {
            return { error: 'Necesito al menos una habitación en el array rooms.' };
          }
          const config = { rooms: input.rooms, updated: new Date().toISOString() };
          fs.writeFileSync(MAP_CONFIG_FILE, JSON.stringify(config, null, 2));
          return {
            success: true,
            rooms_configured: input.rooms.length,
            rooms: input.rooms.map(r => r.name),
            map_url: '/3d-map',
            message: `Mapa 3D configurado con ${input.rooms.length} habitaciones. Accede en /3d-map desde el panel lateral de Jarvis.`,
            next_step: 'Para verlo en Lovelace usa: house_3d_map(action:"get_lovelace_card")'
          };
        }

        return { error: `Acción desconocida: ${input.action}` };
      }

      case 'exec_command': {
        const { command, language = 'bash', script, timeout = 15, working_dir = '/app' } = input;
        const timeoutMs = Math.min(timeout * 1000, 30000);

        // Blocklist de comandos destructivos
        const BLOCKED_PATTERNS = [
          /rm\s+-[rRf]{1,3}\s+\//, // rm -rf / o similares apuntando a /
          /rm\s+--no-preserve-root/,
          /mkfs(\.\w+)?/,           // formatear sistemas de archivos
          /dd\s+if=/,               // copia de disco destructiva
          />\s*\/dev\/(s|h|v|x)d/,  // escribir a dispositivos de bloque
          /shred\b/,                 // sobreescribir archivos de forma segura/destructiva
          /wipefs\b/,                // borrar firmas de sistemas de archivos
          /fdisk\b/,                 // particionado de disco
          /parted\b/,                // particionado de disco
          /format\s+[a-z]:/i,        // format de Windows (por si acaso)
          /:\(\)\{.*\}\s*;.*:/,      // fork bomb
          /curl\s+.*\|\s*(ba)?sh/,   // descargar y ejecutar
          /wget\s+.*\|\s*(ba)?sh/,   // descargar y ejecutar
          /chmod\s+[0-7]*7\s+\//,    // chmod 777 / o similar en raíz
          /nc\s+-[el]|ncat\s+-[el]|socat\b/, // reverse shells
          /\bpasswd\b/,                // cambiar passwords
          /\buseradd\b|\buserdel\b/,   // gestión de usuarios del sistema
          /\biptables\b|\bnft\b/,      // reglas de firewall
          /cat\s+\/etc\/(shadow|passwd)/, // leer credenciales del sistema
          /eval\s*\(|exec\s*\(/,       // eval/exec en scripts
        ];
        const cmdToCheck = command || script || '';
        const blocked = BLOCKED_PATTERNS.find(p => p.test(cmdToCheck));
        if (blocked) {
          return { error: `Comando bloqueado por seguridad: patrón peligroso detectado. Si necesitas esta operación, hazla manualmente desde la consola de HA.` };
        }

        // Validar directorio de trabajo
        const validDirs = ['/app', '/config', '/data', '/share'];
        if (!validDirs.includes(working_dir)) {
          return { error: `Directorio inválido: ${working_dir}. Válidos: ${validDirs.join(', ')}` };
        }

        return new Promise((resolve) => {
          let isTimedOut = false;
          let proc;

          try {
            if (language === 'python') {
              if (!script) return resolve({ error: 'Se requiere script para language=python' });
              // Crear archivo temporal con el script
              const scriptFile = path.join(working_dir, `.jarvis_tmp_${Date.now()}.py`);
              fs.writeFileSync(scriptFile, script);
              proc = exec(`cd ${working_dir} && python3 ${scriptFile}`, { maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
                if (isTimedOut) return;
                try { fs.unlinkSync(scriptFile); } catch {}
                if (error && error.code !== 0) {
                  resolve({ error: stderr || error.message, stdout });
                } else {
                  resolve({ success: true, output: stdout, stderr: stderr || undefined });
                }
              });
            } else {
              // bash
              proc = exec(`cd ${working_dir} && ${command}`, { maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
                if (isTimedOut) return;
                if (error && error.code !== 0) {
                  resolve({ error: stderr || error.message, stdout });
                } else {
                  resolve({ success: true, output: stdout, stderr: stderr || undefined });
                }
              });
            }

            const timerId = setTimeout(() => {
              isTimedOut = true;
              if (proc) proc.kill();
              resolve({ error: `Comando excedió timeout de ${timeout}s` });
            }, timeoutMs);

            // Borrar timeout si el proceso termina primero
            proc.on('exit', () => clearTimeout(timerId));

          } catch (err) {
            resolve({ error: err.message });
          }
        });
      }

      case 'generate_image': {
        // Tamaños válidos para gpt-image-1: 1024x1024, 1024x1536, 1536x1024, auto
        const validSizes = new Set(['1024x1024','1024x1536','1536x1024','auto']);
        const rawSize = input.size || '1024x1024';
        const size = validSizes.has(rawSize) ? rawSize : '1024x1024';
        const { prompt, quality = 'standard' } = input;
        // filename: usa el proporcionado o genera uno por timestamp
        const imgFilename = input.filename
          ? input.filename.replace(/[^a-zA-Z0-9_-]/g, '_') + '.png'
          : `jarvis_${Date.now()}.png`;

        if (!C.OPENAI_API_KEY) {
          return { error: 'OPENAI_API_KEY no configurada en el add-on' };
        }

        if (!prompt || prompt.length < 10) {
          return { error: 'El prompt debe tener al menos 10 caracteres' };
        }

        try {
          const imagesDir = path.join(C.HA_SHARE, 'jarvis', 'images');
          if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

          // gpt-image-1 (sucesor de dall-e-3): devuelve base64 por defecto
          const res = await fetch('https://api.openai.com/v1/images/generations', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${C.OPENAI_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: 'gpt-image-1',
              prompt,
              n: 1,
              size,
              quality,
              output_format: 'png'
            })
          });

          if (!res.ok) {
            const err = await res.json();
            return { error: err.error?.message || 'Error de OpenAI API' };
          }

          const data = await res.json();
          const item = data.data?.[0];
          if (!item) return { error: 'OpenAI no devolvió imagen', raw: JSON.stringify(data).slice(0, 200) };

          // gpt-image-1 devuelve b64_json; fallback a URL si la hubiera
          let buffer;
          if (item.b64_json) {
            buffer = Buffer.from(item.b64_json, 'base64');
          } else if (item.url) {
            const imgRes = await fetch(item.url);
            buffer = await imgRes.buffer();
          } else {
            return { error: 'Formato de respuesta desconocido', raw: JSON.stringify(item).slice(0, 200) };
          }

          const filepath = path.join(imagesDir, imgFilename);
          fs.writeFileSync(filepath, buffer);

          // Copiar a /config/www/jarvis/ para acceso desde Lovelace (/local/jarvis/)
          const wwwDir = '/config/www/jarvis';
          if (!fs.existsSync(wwwDir)) fs.mkdirSync(wwwDir, { recursive: true });
          fs.copyFileSync(filepath, path.join(wwwDir, imgFilename));

          return {
            success: true,
            file: filepath,
            lovelace_url: `/local/jarvis/${imgFilename}`,
            share_url: `/share/jarvis/images/${imgFilename}`,
            prompt,
            size,
            message: `Imagen guardada en /share/jarvis/images/${imgFilename} y accesible en /local/jarvis/${imgFilename}`
          };

        } catch (err) {
          return { error: err.message };
        }
      }

      case 'review_dashboard': {
        const { action = 'analyze_all', dashboard_id, focus = 'all' } = input;

        try {
          // Obtener todos los dashboards
          const dashboards = await haGet('/lovelace/dashboards');
          if (!dashboards || dashboards.length === 0) {
            return { note: 'No hay dashboards configurados. Crea uno primero.' };
          }

          // Cargar historial de reviews
          let reviewHistory = loadJSON(C.DASHBOARD_REVIEWS_FILE, []);

          const results = [];
          let critical = 0, warnings = 0, suggestions = 0;

          for (const db of dashboards) {
            if (action === 'analyze_one' && db.id !== dashboard_id) continue;

            const config = await haGet(`/lovelace/dashboards/${db.id}`);
            const views = config.views || [];
            const configStr = JSON.stringify(config);

            // Análisis profesional completo
            const analysis = {
              name: db.title,
              id: db.id,
              views_count: views.length,
              total_cards: views.reduce((sum, v) => sum + (v.cards?.length || 0), 0),
              performance_score: 0,
              recommendations: { critical: [], warning: [], suggestion: [] }
            };

            // ─ ANÁLISIS CRÍTICO ─────────────────────────────────────────────
            if (views.length === 0) {
              analysis.recommendations.critical.push('Dashboard sin vistas. Organiza al menos una vista para comenzar.');
              critical++;
            }

            const totalCards = analysis.total_cards;
            if (totalCards === 0 && views.length > 0) {
              analysis.recommendations.critical.push('Dashboard vacío. Añade cards para controlar tus dispositivos.');
              critical++;
            } else if (totalCards > 100) {
              analysis.recommendations.critical.push(`⚠️ ${totalCards} cards (muy muchas). Performance se verá afectada. Máximo recomendado: 50-60 por dashboard.`);
              critical++;
            }

            // ─ ANÁLISIS DE PERFORMANCE ─────────────────────────────────────
            let perfScore = 100;
            if (totalCards > 50) perfScore -= 20;
            if (totalCards > 75) perfScore -= 15;
            if (views.length > 10) perfScore -= 10;
            views.forEach(v => {
              const cards = v.cards || [];
              if (cards.length > 20) perfScore -= 5;
            });
            analysis.performance_score = Math.max(0, perfScore);

            // ─ ANÁLISIS DE VISTAS ──────────────────────────────────────────
            let hasUnnamedView = false;
            for (let i = 0; i < views.length; i++) {
              const view = views[i];
              const cards = view.cards || [];
              const viewName = view.title || `Vista sin nombre (${i + 1})`;

              if (cards.length === 0) {
                analysis.recommendations.warning.push(`Vista "${viewName}" vacía. Quítala o añade cards.`);
                warnings++;
              } else if (cards.length > 20) {
                analysis.recommendations.warning.push(`Vista "${viewName}" (${cards.length} cards). Divide en 2-3 vistas para mejorar UX.`);
                warnings++;
              } else if (cards.length > 12) {
                analysis.recommendations.suggestion.push(`Vista "${viewName}" tiene ${cards.length} cards. Considera dividir si el scroll es lento.`);
                suggestions++;
              }

              if (!view.title) hasUnnamedView = true;
            }

            if (hasUnnamedView) {
              analysis.recommendations.suggestion.push('Etiqueta todas las vistas con títulos claros. Mejora navegación.');
              suggestions++;
            }

            // ─ ANÁLISIS DE ENTIDADES ───────────────────────────────────────
            try {
              const entities = await haGet('/states');
              const domainCounts = {};
              entities.forEach(e => {
                const domain = e.entity_id.split('.')[0];
                domainCounts[domain] = (domainCounts[domain] || 0) + 1;
              });

              // Buscar dominios no representados
              const criticalDomains = ['light', 'switch', 'climate', 'lock'];
              for (const domain of criticalDomains) {
                if (domainCounts[domain] > 0 && !configStr.includes(`'${domain}.`) && !configStr.includes(`"${domain}.`)) {
                  analysis.recommendations.suggestion.push(`Tienes ${domainCounts[domain]} ${domain}(s) pero no los controlas desde este dashboard.`);
                  suggestions++;
                }
              }
            } catch (e) {
              // Silenciar errores en análisis de entidades
            }

            // ─ ANÁLISIS DE ESTÉTICA ────────────────────────────────────────
            const cardTypes = {};
            views.forEach(v => {
              (v.cards || []).forEach(c => {
                const type = c.type || 'unknown';
                cardTypes[type] = (cardTypes[type] || 0) + 1;
              });
            });
            const cardTypeCount = Object.keys(cardTypes).length;

            if (cardTypeCount === 1 && totalCards > 0) {
              analysis.recommendations.suggestion.push(`Todas tus cards son del mismo tipo. Variedad visual mejora UX: añade gráficos, botones, etc.`);
              suggestions++;
            } else if (cardTypeCount <= 2) {
              analysis.recommendations.suggestion.push(`Pocas tipos de cards (${cardTypeCount}). Añade más variedad visual.`);
              suggestions++;
            }

            // Verificar accesibilidad
            if (!config.background && !view?.background) {
              analysis.recommendations.suggestion.push('Personaliza el fondo. Un tema coherente mejora la experiencia.');
              suggestions++;
            }

            // ─ CÁLCULO DE SALUD ────────────────────────────────────────────
            analysis.health = {
              score: Math.max(0, 100 - (critical * 30 + warnings * 15 + suggestions * 5)),
              status: critical > 0 ? '⚠️ Crítico' : warnings > 0 ? '🟡 Advertencias' : suggestions > 0 ? '💡 Mejoras disponibles' : '✅ Óptimo'
            };

            results.push(analysis);
          }

          // ─ GENERAR PLAN DE MEJORAS SI SE SOLICITA ──────────────────────
          if (action === 'generate_improvement_plan') {
            const plan = [];
            for (const r of results) {
              if (r.recommendations.critical.length > 0) {
                plan.push({
                  priority: 'CRÍTICO',
                  dashboard: r.name,
                  actions: r.recommendations.critical,
                  timeframe: 'Hoy'
                });
              }
              if (r.recommendations.warning.length > 0) {
                plan.push({
                  priority: 'IMPORTANTE',
                  dashboard: r.name,
                  actions: r.recommendations.warning,
                  timeframe: 'Esta semana'
                });
              }
              if (r.recommendations.suggestion.length > 0) {
                plan.push({
                  priority: 'MEJORA',
                  dashboard: r.name,
                  actions: r.recommendations.suggestion.slice(0, 3),
                  timeframe: 'Próximas 2 semanas'
                });
              }
            }

            // Guardar en historial
            const review = {
              timestamp: new Date().toISOString(),
              dashboards_analyzed: results.length,
              critical_issues: critical,
              warnings: warnings,
              suggestions: suggestions,
              improvement_plan: plan
            };
            reviewHistory.push(review);
            if (reviewHistory.length > 52) reviewHistory = reviewHistory.slice(-52); // Mantener 1 año
            saveJSON(C.DASHBOARD_REVIEWS_FILE, reviewHistory);

            return {
              success: true,
              improvement_plan: plan,
              summary: `Plan creado: ${critical} críticos, ${warnings} advertencias, ${suggestions} sugerencias`,
              next_review: '7 días'
            };
          }

          // ─ RETORNO DE ANÁLISIS ─────────────────────────────────────────
          const totalCritical = results.reduce((s, r) => s + r.recommendations.critical.length, 0);
          const totalWarnings = results.reduce((s, r) => s + r.recommendations.warning.length, 0);
          const totalSuggestions = results.reduce((s, r) => s + r.recommendations.suggestion.length, 0);

          // Guardar en historial
          const review = {
            timestamp: new Date().toISOString(),
            dashboards_analyzed: results.length,
            critical_issues: totalCritical,
            warnings: totalWarnings,
            suggestions: totalSuggestions,
            avg_performance_score: Math.round(results.reduce((s, r) => s + r.performance_score, 0) / results.length)
          };
          reviewHistory.push(review);
          if (reviewHistory.length > 52) reviewHistory = reviewHistory.slice(-52);
          saveJSON(C.DASHBOARD_REVIEWS_FILE, reviewHistory);

          return {
            success: true,
            dashboards_analyzed: results.length,
            analysis: results,
            summary: {
              total_critical: totalCritical,
              total_warnings: totalWarnings,
              total_suggestions: totalSuggestions,
              avg_performance: Math.round(results.reduce((s, r) => s + r.performance_score, 0) / results.length),
              health: results.map(r => `${r.name}: ${r.health.status}`).join(' | ')
            }
          };

        } catch (err) {
          return { error: 'Error analizando dashboards: ' + err.message };
        }
      }

      // ─── web_search_native (GPT-4.1 con web search integrado) ──────────────
      case 'web_search_native': {
        const { query, context: ctx } = input;
        if (!C.OPENAI_API_KEY) return { error: 'OPENAI_API_KEY no configurada' };
        if (!query) return { error: 'query requerido' };

        try {
          const userMsg = ctx
            ? `Contexto: ${ctx}\n\nPregunta: ${query}\n\nBusca en internet, lee las fuentes y responde con datos reales y citaciones.`
            : `${query}\n\nBusca en internet, lee las fuentes y responde con datos reales y citaciones.`;

          // OpenAI Responses API soporta tool 'web_search_preview' nativo en gpt-4.1*
          const res = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${C.OPENAI_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: 'gpt-4.1',
              input: userMsg,
              tools: [{ type: 'web_search_preview' }],
              max_output_tokens: 2048
            })
          });

          if (!res.ok) {
            const errText = await res.text();
            // Fallback al endpoint chat/completions con tool si /responses no está disponible
            const fbRes = await fetch('https://api.openai.com/v1/chat/completions', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${C.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: 'gpt-4.1',
                messages: [{ role: 'user', content: userMsg }],
                tools: [{ type: 'web_search_preview' }],
                max_tokens: 2048
              })
            });
            if (!fbRes.ok) {
              return { error: `web_search_native error: ${errText.slice(0,300)}`, hint: 'Si el modelo o el tool no están disponibles para tu cuenta, usa web_search (DuckDuckGo) como alternativa.' };
            }
            const fbData = await fbRes.json();
            const fbText = fbData.choices?.[0]?.message?.content || '';
            return { success: true, answer: fbText, source: 'gpt-4.1 web_search (chat)', usage: fbData.usage };
          }

          const data = await res.json();

          // Extraer texto sintetizado y citaciones de la respuesta /responses
          let answer = '';
          const citations = [];
          const outputs = data.output || data.outputs || [];
          for (const item of outputs) {
            if (item.type === 'message' && Array.isArray(item.content)) {
              for (const c of item.content) {
                if (c.type === 'output_text' || c.type === 'text') {
                  answer += c.text || '';
                  if (Array.isArray(c.annotations)) {
                    for (const a of c.annotations) {
                      if (a.type === 'url_citation' || a.url) {
                        citations.push({ url: a.url, title: a.title || '' });
                      }
                    }
                  }
                }
              }
            } else if (item.type === 'web_search_call') {
              // ignore — solo es el call interno
            }
          }
          // Fallback: si la respuesta tiene output_text directo
          if (!answer && data.output_text) answer = data.output_text;

          return {
            success: true,
            answer: answer || 'Sin respuesta',
            citations,
            usage: data.usage || {},
            source: 'gpt-4.1 web_search_preview'
          };
        } catch (e) {
          return { error: 'web_search_native falló: ' + e.message };
        }
      }

      // ─── image_edit (DALL-E inpainting) ─────────────────────────────────────
      case 'image_edit': {
        const { image_path, prompt, mask_path, size = '1024x1024' } = input;
        if (!C.OPENAI_API_KEY) return { error: 'OPENAI_API_KEY no configurada' };
        if (!image_path || !prompt) return { error: 'image_path y prompt requeridos' };
        if (!fs.existsSync(image_path)) return { error: `No existe: ${image_path}` };

        try {
          const imgBuffer = fs.readFileSync(image_path);
          const maskBuffer = mask_path && fs.existsSync(mask_path) ? fs.readFileSync(mask_path) : null;

          const result = await callImageEdit(imgBuffer, prompt, maskBuffer, size);

          const imagesDir = path.join(C.HA_SHARE, 'jarvis', 'images');
          if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
          const filename = `edit_${Date.now()}.png`;
          const filepath = path.join(imagesDir, filename);
          fs.writeFileSync(filepath, Buffer.from(result.b64, 'base64'));

          return {
            success: true,
            image_url: `/share/jarvis/images/${filename}`,
            filepath,
            filename,
            prompt,
            size,
            source: image_path
          };
        } catch (e) {
          return { error: 'Error editando imagen: ' + e.message };
        }
      }

      // ─── dev_workspace (sandbox de prototipado) ─────────────────────────────
      case 'dev_workspace': {
        const { action, workspace_id, file, content, command, target_path } = input;
        const wsRoot = path.join(C.DATA_DIR, 'workspace');
        if (!fs.existsSync(wsRoot)) fs.mkdirSync(wsRoot, { recursive: true });

        // list es la única acción que no necesita workspace_id
        if (action !== 'list' && !workspace_id) {
          return { error: 'workspace_id requerido para action=' + action };
        }
        // Sanitizar workspace_id
        if (workspace_id && !/^[a-zA-Z0-9_-]+$/.test(workspace_id)) {
          return { error: 'workspace_id solo puede contener [a-zA-Z0-9_-]' };
        }
        const wsDir = workspace_id ? path.join(wsRoot, workspace_id) : wsRoot;

        try {
          if (action === 'list') {
            // Lista todos los workspaces y sus archivos
            const result = {};
            if (!fs.existsSync(wsRoot)) return { workspaces: {} };
            for (const ws of fs.readdirSync(wsRoot)) {
              const wsPath = path.join(wsRoot, ws);
              if (!fs.statSync(wsPath).isDirectory()) continue;
              const files = [];
              const walk = (dir, prefix = '') => {
                for (const e of fs.readdirSync(dir)) {
                  const full = path.join(dir, e);
                  const rel = prefix ? `${prefix}/${e}` : e;
                  const st = fs.statSync(full);
                  if (st.isDirectory()) walk(full, rel);
                  else files.push({ path: rel, size: st.size });
                }
              };
              walk(wsPath);
              result[ws] = { files, created: fs.statSync(wsPath).birthtime };
            }
            return { workspaces: result };
          }

          if (action === 'create') {
            if (fs.existsSync(wsDir)) return { error: `Workspace ${workspace_id} ya existe — usa write/exec o discard primero` };
            fs.mkdirSync(wsDir, { recursive: true });
            return { success: true, workspace_id, path: wsDir, message: 'Workspace creado. Usa write para añadir archivos.' };
          }

          if (action === 'write') {
            if (!file || content === undefined) return { error: 'file y content requeridos' };
            if (!fs.existsSync(wsDir)) fs.mkdirSync(wsDir, { recursive: true });
            // Prevenir path traversal
            const fullPath = path.resolve(wsDir, file);
            if (!fullPath.startsWith(wsDir)) return { error: 'Path traversal detectado' };
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, content, 'utf8');
            return { success: true, file, size: content.length, path: fullPath };
          }

          if (action === 'read') {
            if (!file) return { error: 'file requerido' };
            const fullPath = path.resolve(wsDir, file);
            if (!fullPath.startsWith(wsDir)) return { error: 'Path traversal detectado' };
            if (!fs.existsSync(fullPath)) return { error: `No existe: ${file}` };
            return { success: true, file, content: fs.readFileSync(fullPath, 'utf8') };
          }

          if (action === 'exec' || action === 'test') {
            if (!command) return { error: 'command requerido' };
            if (!fs.existsSync(wsDir)) return { error: `Workspace ${workspace_id} no existe` };
            // Whitelist de comandos: bash, sh, node, python, python3, pytest, npm, yaml-validation
            const cmdBin = command.trim().split(/\s+/)[0];
            const allowed = ['node', 'npm', 'python', 'python3', 'pytest', 'pip', 'pip3', 'bash', 'sh', 'yamllint', 'jq', 'yq', 'cat', 'ls', 'echo', 'grep', 'sed', 'awk', 'curl', 'wget', 'diff'];
            if (!allowed.includes(cmdBin)) return { error: `Comando ${cmdBin} no permitido en workspace. Allowed: ${allowed.join(', ')}` };
            try {
              const proc = spawnSync('sh', ['-c', command], {
                cwd: wsDir,
                timeout: 30000,
                encoding: 'utf8',
                maxBuffer: 5 * 1024 * 1024
              });
              return {
                success: proc.status === 0,
                exit_code: proc.status,
                stdout: (proc.stdout || '').slice(0, 8000),
                stderr: (proc.stderr || '').slice(0, 4000),
                command,
                workspace_id
              };
            } catch (e) {
              return { error: 'exec falló: ' + e.message };
            }
          }

          if (action === 'apply') {
            if (!file || !target_path) return { error: 'file y target_path requeridos' };
            // Solo permitir aplicar a /config, /share, /data (no /addons que es ro)
            const safePrefixes = [C.HA_CONFIG, C.HA_SHARE, C.DATA_DIR];
            if (!safePrefixes.some(p => target_path.startsWith(p))) {
              return { error: `target_path debe empezar por ${safePrefixes.join(' / ')}` };
            }
            const srcPath = path.resolve(wsDir, file);
            if (!srcPath.startsWith(wsDir)) return { error: 'Path traversal detectado' };
            if (!fs.existsSync(srcPath)) return { error: `No existe en workspace: ${file}` };
            // Auto-backup del destino si existe
            if (fs.existsSync(target_path)) {
              try {
                const { autoBackup } = require('../utils/persistence');
                autoBackup(target_path);
              } catch (e) { /* sin backup, seguir */ }
            }
            fs.mkdirSync(path.dirname(target_path), { recursive: true });
            fs.copyFileSync(srcPath, target_path);
            return { success: true, applied: file, target: target_path, message: 'Archivo promovido. Recuerda reload_config si afecta a HA.' };
          }

          if (action === 'discard') {
            if (!fs.existsSync(wsDir)) return { error: `Workspace ${workspace_id} no existe` };
            // Borrar recursivamente
            fs.rmSync(wsDir, { recursive: true, force: true });
            return { success: true, message: `Workspace ${workspace_id} eliminado` };
          }

          return { error: `Action desconocida: ${action}` };
        } catch (e) {
          return { error: 'dev_workspace error: ' + e.message };
        }
      }

      // ─── edit_automation ───
      case 'edit_automation': {
        if (!yaml) return { error: 'js-yaml no disponible' };
        const automationsPath = path.join(C.HA_CONFIG, 'automations.yaml');

        // 1. Validar YAML nuevo
        const yamlValidErr = validateYamlSyntax(input.yaml_content);
        if (yamlValidErr) {
          return { error: `YAML inválido — automatización NO editada: ${yamlValidErr}` };
        }

        // 2. Leer archivo
        if (!fs.existsSync(automationsPath)) return { error: 'automations.yaml no existe' };
        const rawContent = fs.readFileSync(automationsPath, 'utf8');

        // 3. Parsear para localizar el índice
        let automations;
        try { automations = yaml.load(rawContent) || []; }
        catch (e) { return { error: `No se pudo parsear automations.yaml: ${e.message}` }; }
        if (!Array.isArray(automations)) return { error: 'automations.yaml no contiene una lista' };

        const id = input.identifier;
        const idx = automations.findIndex(a =>
          a.alias === id ||
          (a.alias || '').toLowerCase() === (id || '').toLowerCase() ||
          String(a.id) === String(id)
        );
        if (idx === -1) {
          const available = automations.map(a => a.alias || a.id || '(sin nombre)').slice(0, 20);
          return { error: `Automatización "${id}" no encontrada`, available_aliases: available };
        }
        const oldAlias = automations[idx].alias || automations[idx].id || '(sin alias)';
        const oldData  = automations[idx];

        // 4. Localizar el bloque en el texto original y reemplazarlo
        //    sin pasar el archivo por yaml.dump (que reformatea TODO y corrompe templates)
        const lines = rawContent.split('\n');
        const topLevelStarts = [];
        lines.forEach((line, i) => { if (/^-(\s|$)/.test(line)) topLevelStarts.push(i); });

        // ── PREFLIGHT: extraer el bloque ACTUAL antes de tocarlo ────────────────
        let currentBlockYaml = '';
        let preflight = '';
        if (topLevelStarts.length === automations.length) {
          const bStart = topLevelStarts[idx];
          const bEnd   = idx + 1 < topLevelStarts.length ? topLevelStarts[idx + 1] : lines.length;
          currentBlockYaml = lines.slice(bStart, bEnd).join('\n').trimEnd();

          // Comparar complejidad old vs new para detectar simplificaciones accidentales
          try {
            const newData = yaml.load(input.yaml_content) || {};
            const oldTriggers = [].concat(oldData.trigger || oldData.triggers || []).length;
            const newTriggers = [].concat(newData.trigger || newData.triggers || []).length;
            const oldActions  = [].concat(oldData.action  || oldData.actions  || []).length;
            const newActions  = [].concat(newData.action  || newData.actions  || []).length;
            const oldYamlLen  = currentBlockYaml.length;
            const newYamlLen  = input.yaml_content.length;

            const warnings = [];
            if (newTriggers > 0 && newTriggers < oldTriggers)
              warnings.push(`TRIGGERS: ${oldTriggers} → ${newTriggers} (¿eliminaste alguno?)`);
            if (newActions > 0 && newActions < oldActions)
              warnings.push(`ACTIONS: ${oldActions} → ${newActions} (¿perdiste lógica de apagado?)`);
            if (newYamlLen < oldYamlLen * 0.6)
              warnings.push(`TAMAÑO: ${oldYamlLen} → ${newYamlLen} chars (reducción >40% — ¿simplificaste?)`);
            // Detectar si el original tenía turn_off y el nuevo no
            const hadTurnOff = /turn_off|light\.off|switch\.off/.test(currentBlockYaml);
            const hasTurnOff = /turn_off|light\.off|switch\.off/.test(input.yaml_content);
            if (hadTurnOff && !hasTurnOff)
              warnings.push('APAGADO: el original tenía lógica turn_off y el nuevo NO — ¿la eliminaste?');
            // Detectar wait_for_trigger perdido
            const hadWait = /wait_for_trigger/.test(currentBlockYaml);
            const hasWait = /wait_for_trigger/.test(input.yaml_content);
            if (hadWait && !hasWait)
              warnings.push('ESPERA: el original tenía wait_for_trigger y el nuevo NO');

            if (warnings.length > 0)
              preflight = ` ⚠ SIMPLIFICACIÓN DETECTADA — ${warnings.join(' | ')} — Revisa si esto es intencional.`;
          } catch {}

          // ── VALIDACIÓN entity_ids (no bloqueante, solo aviso) ──────────────
          try {
            const entityMatches = [...input.yaml_content.matchAll(/entity_id:\s*([^\n{]+)/g)];
            const usedIds = entityMatches.map(m => m[1].trim().replace(/['"]/g, ''))
              .flatMap(v => v.startsWith('[') ? v.slice(1,-1).split(',').map(s=>s.trim()) : [v])
              .filter(v => v.includes('.') && !v.includes('{') && !v.includes('*'));
            if (usedIds.length > 0) {
              const haStates = await haGet('/states').catch(() => []);
              const existingIds = new Set(haStates.map(s => s.entity_id));
              const missing = usedIds.filter(id => !existingIds.has(id));
              if (missing.length > 0)
                preflight += ` ⚠ ENTITY_IDS INEXISTENTES: ${missing.join(', ')} — usa search_entities() para encontrar el id real.`;
            }
          } catch {}
        }

        autoBackup(automationsPath);

        let newContent;
        if (topLevelStarts.length === automations.length) {
          // Reemplazar solo el bloque afectado, el resto queda intacto
          const blockStart = topLevelStarts[idx];
          const blockEnd   = idx + 1 < topLevelStarts.length ? topLevelStarts[idx + 1] : lines.length;
          const newBlock   = ('- ' + input.yaml_content.replace(/\n/g, '\n  ')).split('\n');
          // Preservar línea vacía de separación si la había antes del siguiente bloque
          const newLines = [
            ...lines.slice(0, blockStart),
            ...newBlock,
            ...(lines[blockEnd - 1] === '' ? [] : ['']),  // separación
            ...lines.slice(blockEnd)
          ];
          newContent = newLines.join('\n');
        } else {
          // NUNCA usar yaml.dump como fallback — reformatearía todo el archivo y corrompería
          // templates Jinja2, IDs y formato original. Devolver error y pedir edición manual.
          return { error: `No se puede editar de forma segura: el archivo automations.yaml tiene una estructura atípica (${topLevelStarts.length} bloques a nivel raíz detectados vs ${automations.length} entradas parseadas). Edita la automatización manualmente desde el editor de HA o el File Editor.` };
        }

        const writeErr = validateYamlSyntax(newContent);
        if (writeErr) return { error: `El archivo resultante tendría YAML inválido: ${writeErr}. Automatización NO modificada.` };
        fs.writeFileSync(automationsPath, newContent);

        try { await haPost('/services/automation/reload', {}); } catch {}
        await new Promise(r => setTimeout(r, 2500));

        // Verificar que no hay nuevos "restored" tras el reload
        let restoredWarning = '';
        try {
          const states = await haGet('/states');
          const restored = states.filter(e => e.entity_id.startsWith('automation.') && e.attributes?.restored === true);
          if (restored.length > 0) {
            restoredWarning = ` ⚠ ALERTA: ${restored.length} automatizaciones en estado "restored" tras editar. Ejecuta rollback("automations.yaml") para restaurar el backup previo a esta edición.`;
          }
        } catch {}

        let newAlias = '(sin alias)';
        try { const p = yaml.load(input.yaml_content); newAlias = p?.alias || p?.id || '(sin alias)'; } catch {}
        return {
          success: true,
          message: `Automatización editada. Sólo el bloque "${oldAlias}" fue modificado — el resto del archivo quedó intacto.${preflight}${restoredWarning}`,
          old_alias: oldAlias,
          new_alias: newAlias,
          previous_yaml: currentBlockYaml  // ← bloque anterior completo para comparación
        };
      }

      // ─── delete_automation ───
      case 'delete_automation': {
        if (!yaml) return { error: 'js-yaml no disponible' };
        const automationsPath = path.join(C.HA_CONFIG, 'automations.yaml');

        if (!fs.existsSync(automationsPath)) return { error: 'automations.yaml no existe' };
        const rawContent = fs.readFileSync(automationsPath, 'utf8');

        let automations;
        try { automations = yaml.load(rawContent) || []; }
        catch (e) { return { error: `No se pudo parsear automations.yaml: ${e.message}` }; }
        if (!Array.isArray(automations)) return { error: 'automations.yaml no contiene una lista' };

        const id = input.identifier;
        const idx = automations.findIndex(a =>
          a.alias === id ||
          (a.alias || '').toLowerCase() === (id || '').toLowerCase() ||
          String(a.id) === String(id)
        );
        if (idx === -1) {
          const available = automations.map(a => a.alias || a.id || '(sin nombre)').slice(0, 20);
          return { error: `Automatización "${id}" no encontrada`, available_aliases: available };
        }
        const deletedName = automations[idx].alias || automations[idx].id || '(sin nombre)';

        // Eliminar el bloque a nivel de texto, sin reformatear el resto
        const lines = rawContent.split('\n');
        const topLevelStarts = [];
        lines.forEach((line, i) => { if (/^-(\s|$)/.test(line)) topLevelStarts.push(i); });

        autoBackup(automationsPath);

        let newContent;
        if (topLevelStarts.length === automations.length) {
          const blockStart = topLevelStarts[idx];
          const blockEnd   = idx + 1 < topLevelStarts.length ? topLevelStarts[idx + 1] : lines.length;
          const newLines   = [...lines.slice(0, blockStart), ...lines.slice(blockEnd)];
          newContent = newLines.join('\n').replace(/\n{3,}/g, '\n\n'); // limpiar líneas vacías extra
        } else {
          // NUNCA usar yaml.dump como fallback — corrompería todo el archivo.
          return { error: `No se puede eliminar de forma segura: el archivo automations.yaml tiene una estructura atípica (${topLevelStarts.length} bloques a nivel raíz detectados vs ${automations.length} entradas parseadas). Elimina la automatización manualmente desde HA o el File Editor.` };
        }

        fs.writeFileSync(automationsPath, newContent);
        try { await haPost('/services/automation/reload', {}); } catch {}

        return { success: true, message: `Automatización "${deletedName}" eliminada. El resto del archivo quedó intacto.`, deleted: deletedName };
      }

      // ─── edit_script ───
      case 'edit_script': {
        const scriptFile = '/config/scripts.yaml';
        const raw = fs.readFileSync(scriptFile, 'utf8');
        // Backup
        const backupDir = path.join(C.DATA_DIR, 'backups');
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
        fs.writeFileSync(path.join(backupDir, 'scripts.yaml.bak'), raw);

        const scriptId = input.script_id;
        // Buscar el bloque del script por su clave raíz
        const lines = raw.split('\n');
        let startIdx = -1, endIdx = lines.length;
        for (let i = 0; i < lines.length; i++) {
          const match = lines[i].match(/^(\w[\w_]*):/);
          if (match && match[1] === scriptId) {
            startIdx = i;
          } else if (match && startIdx >= 0 && i > startIdx) {
            endIdx = i;
            break;
          }
        }
        if (startIdx < 0) return { error: `Script "${scriptId}" no encontrado en scripts.yaml` };

        // Construir nuevo contenido
        const before = lines.slice(0, startIdx).join('\n');
        const after = lines.slice(endIdx).join('\n');
        const newBlock = `${scriptId}:\n${input.yaml_content.split('\n').map(l => l.startsWith('  ') ? l : '  ' + l).join('\n')}`;
        const newContent = [before, newBlock, after].filter(Boolean).join('\n');

        fs.writeFileSync(scriptFile, newContent, 'utf8');
        await haPost('/services/script/reload', {}).catch(() => {});
        return { success: true, message: `Script "${scriptId}" editado y recargado. Backup guardado.` };
      }

      // ─── delete_script ───
      case 'delete_script': {
        const scriptFile2 = '/config/scripts.yaml';
        const raw2 = fs.readFileSync(scriptFile2, 'utf8');
        const backupDir2 = path.join(C.DATA_DIR, 'backups');
        if (!fs.existsSync(backupDir2)) fs.mkdirSync(backupDir2, { recursive: true });
        fs.writeFileSync(path.join(backupDir2, 'scripts.yaml.bak'), raw2);

        const lines2 = raw2.split('\n');
        let start2 = -1, end2 = lines2.length;
        for (let i = 0; i < lines2.length; i++) {
          const match = lines2[i].match(/^(\w[\w_]*):/);
          if (match && match[1] === input.script_id) {
            start2 = i;
          } else if (match && start2 >= 0 && i > start2) {
            end2 = i;
            break;
          }
        }
        if (start2 < 0) return { error: `Script "${input.script_id}" no encontrado` };

        lines2.splice(start2, end2 - start2);
        fs.writeFileSync(scriptFile2, lines2.join('\n'), 'utf8');
        await haPost('/services/script/reload', {}).catch(() => {});
        return { success: true, message: `Script "${input.script_id}" eliminado. Backup guardado.` };
      }

      // ─── mqtt_publish ───
      case 'mqtt_publish': {
        const mqttResult = await haPost('/services/mqtt/publish', {
          topic: input.topic,
          payload: input.payload,
          retain: input.retain || false
        });
        return { success: true, topic: input.topic, payload: input.payload };
      }

      // ─── zigbee_manage ───
      case 'zigbee_manage': {
        const z2mBase = 'zigbee2mqtt/bridge';
        switch (input.action) {
          case 'permit_join':
            await haPost('/services/mqtt/publish', {
              topic: `${z2mBase}/request/permit_join`,
              payload: JSON.stringify({ value: true, time: input.duration || 120 })
            });
            return { success: true, message: `Emparejamiento abierto ${input.duration || 120}s` };
          case 'devices': {
            const devStates = await haGet('/states');
            const z2mDevices = devStates.filter(e => e.entity_id.includes('zigbee2mqtt') || (e.attributes && e.attributes.device && typeof e.attributes.device === 'object'));
            return { devices: z2mDevices.slice(0, 50).map(d => ({ entity_id: d.entity_id, state: d.state, name: d.attributes?.friendly_name })) };
          }
          case 'network_map':
            await haPost('/services/mqtt/publish', {
              topic: `${z2mBase}/request/networkmap`,
              payload: JSON.stringify({ type: 'raw', routes: true })
            });
            return { success: true, message: 'Mapa de red solicitado. Resultado llegará por MQTT en unos segundos.' };
          case 'rename':
            if (!input.device || !input.new_name) return { error: 'Requiere device y new_name' };
            await haPost('/services/mqtt/publish', {
              topic: `${z2mBase}/request/device/rename`,
              payload: JSON.stringify({ from: input.device, to: input.new_name })
            });
            return { success: true, message: `Renombrado: ${input.device} → ${input.new_name}` };
          case 'remove':
            if (!input.device) return { error: 'Requiere device' };
            await haPost('/services/mqtt/publish', {
              topic: `${z2mBase}/request/device/remove`,
              payload: JSON.stringify({ id: input.device, force: false })
            });
            return { success: true, message: `Eliminación solicitada: ${input.device}` };
          case 'ota_check':
            await haPost('/services/mqtt/publish', {
              topic: `${z2mBase}/request/device/ota_update/check`,
              payload: input.device ? JSON.stringify({ id: input.device }) : ''
            });
            return { success: true, message: 'OTA check solicitado' };
          case 'ota_update':
            if (!input.device) return { error: 'Requiere device' };
            await haPost('/services/mqtt/publish', {
              topic: `${z2mBase}/request/device/ota_update/update`,
              payload: JSON.stringify({ id: input.device })
            });
            return { success: true, message: `OTA update lanzado para ${input.device}` };
          case 'bridge_info':
            await haPost('/services/mqtt/publish', {
              topic: `${z2mBase}/request/config`,
              payload: ''
            });
            return { success: true, message: 'Info del bridge solicitada' };
          case 'restart':
            await haPost('/services/mqtt/publish', {
              topic: `${z2mBase}/request/restart`,
              payload: ''
            });
            return { success: true, message: 'Zigbee2MQTT reiniciándose' };
          default:
            return { error: `Acción zigbee desconocida: ${input.action}` };
        }
      }

      // ─── template_render ───
      case 'template_render': {
        const response = await fetch(C.HA_URL + '/api/template', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + C.HA_TOKEN,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ template: input.template })
        });
        const text = await response.text();
        if (!response.ok) {
          return { error: `HA template error ${response.status}: ${text}` };
        }
        return { result: text };
      }

      // ─── score_installation ───
      case 'score_installation': {
        // 1. Obtener todas las entidades
        const states = await haGet('/states');
        const totalEntities = states.length;
        const unavailableEntities = states.filter(e => e.state === 'unavailable' || e.state === 'unknown');
        const unavailableCount = unavailableEntities.length;

        // Entidades sin friendly_name (el nombre es igual al entity_id o vacío)
        const unnamedEntities = states.filter(e => {
          const fn = e.attributes?.friendly_name;
          if (!fn) return true;
          // Si friendly_name parece un entity_id autogenerado (ej. "sensor.some_thing_abc123")
          return fn === e.entity_id || /^[a-z_]+\.[a-z0-9_]+$/.test(fn);
        });
        const unnamedCount = unnamedEntities.length;

        // 2. Leer automations.yaml
        const automationsPath = path.join(C.HA_CONFIG, 'automations.yaml');
        let automationsTotal = 0;
        let automationsNoAlias = 0;
        let automationsAutoId = 0;
        try {
          if (fs.existsSync(automationsPath)) {
            const parsed = yaml.load(fs.readFileSync(automationsPath, 'utf8')) || [];
            if (Array.isArray(parsed)) {
              automationsTotal = parsed.length;
              automationsNoAlias = parsed.filter(a => !a.alias || a.alias.trim() === '').length;
              automationsAutoId = parsed.filter(a => a.id && String(a.id).startsWith('automation_')).length;
            }
          }
        } catch {}

        // 3. Calcular score
        let score = 100;
        const unavailablePenalty = Math.min(unavailableCount * 1, 20);
        const unnamedPenalty = Math.min(unnamedCount * 0.5, 15);
        const noAliasPenalty = Math.min(automationsNoAlias * 2, 15);
        const autoIdPenalty = automationsAutoId > 10 ? 10 : 0;

        score -= unavailablePenalty;
        score -= unnamedPenalty;
        score -= noAliasPenalty;
        score -= autoIdPenalty;
        score = Math.round(Math.max(0, Math.min(100, score)));

        // 4. Recomendaciones
        const recommendations = [];
        if (unavailableCount > 0) {
          recommendations.push(`${unavailableCount} entidades en estado unavailable/unknown — revisa las integraciones afectadas`);
        }
        if (unnamedCount > 5) {
          recommendations.push(`${unnamedCount} entidades sin nombre amigable — añade friendly_name en customize.yaml`);
        }
        if (automationsNoAlias > 0) {
          recommendations.push(`${automationsNoAlias} automatizaciones sin alias — añade un alias descriptivo a cada una`);
        }
        if (automationsAutoId > 10) {
          recommendations.push(`${automationsAutoId} automatizaciones con ID autogenerado por HA — considera asignar IDs descriptivos`);
        }
        if (recommendations.length < 3) {
          recommendations.push('Instala HACS y añade cards custom para mejorar la UI de Lovelace');
        }

        return {
          score,
          total_entities: totalEntities,
          unavailable_count: unavailableCount,
          unnamed_entities: unnamedCount,
          automations_total: automationsTotal,
          automations_no_alias: automationsNoAlias,
          recommendations
        };
      }

      case 'simulate_automation': {
        if (!yaml) return { error: 'js-yaml no está disponible en este entorno' };
        const automationsPath = '/config/automations.yaml';
        let automations = [];
        try {
          const raw = fs.readFileSync(automationsPath, 'utf8');
          const parsed = yaml.load(raw);
          automations = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
        } catch (e) {
          return { error: `No se pudo leer automations.yaml: ${e.message}` };
        }

        const id = input.identifier;
        const a = automations.find(x =>
          (x.alias && x.alias.toLowerCase() === id.toLowerCase()) ||
          x.id === id
        );

        if (!a) {
          return {
            error: 'Automatización no encontrada',
            available: automations.map(x => x.alias || x.id).filter(Boolean)
          };
        }

        // Resolve current state for entity-based triggers
        const triggerList = (Array.isArray(a.trigger) ? a.trigger : [a.trigger]).filter(Boolean);
        const enrichedTriggers = await Promise.all(triggerList.map(async t => {
          const entry = { type: t.platform || t.trigger || 'unknown', details: t };
          const entityId = t.entity_id || (Array.isArray(t.entity_id) ? t.entity_id[0] : null);
          if (entityId) {
            try {
              const stateData = await haGet('/states/' + (Array.isArray(entityId) ? entityId[0] : entityId));
              entry.current_state = stateData ? { state: stateData.state, attributes: stateData.attributes } : null;
            } catch (_) {
              entry.current_state = null;
            }
          }
          return entry;
        }));

        const conditionList = (Array.isArray(a.condition) ? a.condition : a.condition ? [a.condition] : []);
        const actionList = (Array.isArray(a.action) ? a.action : [a.action]).filter(Boolean);

        return {
          automation: a.alias || a.id,
          description: a.description || null,
          mode: a.mode || 'single',
          dry_run: true,
          triggers: enrichedTriggers,
          conditions: conditionList.map(c => ({
            type: c.condition || 'unknown',
            details: c
          })),
          actions: actionList.map(act => {
            if (act.service || act.action) return { type: 'service', call: act.service || act.action, data: act.data || act.target || {} };
            if (act.delay) return { type: 'delay', duration: act.delay };
            if (act.condition) return { type: 'condition_check', condition: act.condition };
            return { type: 'other', raw: act };
          }),
          note: 'Simulación sin ejecutar — ninguna acción real fue tomada'
        };
      }

      case 'generate_image_gemini': {
        if (!C.GEMINI_API_KEY) return { error: 'GEMINI_API_KEY no configurada. Añádela en la configuración del add-on.' };

        const prompt    = input.prompt || '';
        const filename  = (input.filename || 'gemini_image').replace(/[^a-zA-Z0-9_-]/g, '_');
        const ratio     = input.aspect_ratio || '1:1';
        const useFlash  = input.model === 'gemini-flash';

        const imagesDir = '/share/jarvis/images';
        if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

        let imageBase64, mimeType;

        if (useFlash) {
          // Gemini Flash con salida de imagen — prueba modelos en orden
          const flashModels = [
            'gemini-2.0-flash-preview-image-generation',
            'gemini-2.0-flash-exp',
            'gemini-2.5-flash-preview-image-generation',
          ];
          let flashDone = false;
          for (const flashModel of flashModels) {
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${flashModel}:generateContent?key=${C.GEMINI_API_KEY}`;
            const body = {
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
            };
            const r = await fetch(geminiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (!r.ok) continue; // prueba siguiente modelo
            const data = await r.json();
            const parts = data.candidates?.[0]?.content?.parts || [];
            const imgPart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
            if (!imgPart) continue;
            imageBase64 = imgPart.inlineData.data;
            mimeType = imgPart.inlineData.mimeType;
            flashDone = true;
            break;
          }
          if (!flashDone) return { error: 'Gemini Flash: ningún modelo de imagen disponible en tu plan/región. Usa model=imagen-4 en su lugar.' };
        } else {
          // Imagen 4 — máxima calidad (Imagen 3 se retiró junio 2026)
          const imagenModels = [
            'imagen-4.0-generate-001',
            'imagen-4.0-fast-generate-001',
            'imagen-3.0-generate-002',  // fallback Imagen 3
          ];
          let imagenDone = false;
          for (const imagenModel of imagenModels) {
            const imagenUrl = `https://generativelanguage.googleapis.com/v1beta/models/${imagenModel}:predict?key=${C.GEMINI_API_KEY}`;
            const body = {
              instances: [{ prompt }],
              parameters: { sampleCount: 1, aspectRatio: ratio, safetyFilterLevel: 'BLOCK_SOME', personGeneration: 'DONT_ALLOW' }
            };
            const r = await fetch(imagenUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (!r.ok) continue; // prueba siguiente modelo
            const data = await r.json();
            const pred = data.predictions?.[0];
            if (!pred?.bytesBase64Encoded) continue;
            imageBase64 = pred.bytesBase64Encoded;
            mimeType = pred.mimeType || 'image/png';
            imagenDone = true;
            break;
          }
          if (!imagenDone) return { error: 'Imagen 4: ningún modelo disponible en tu plan/región. Verifica que tu API key tiene acceso a imagen-4.0-generate-001.' };
        }

        // Guardar imagen
        const ext = mimeType.includes('jpeg') ? 'jpg' : 'png';
        const outPath = path.join(imagesDir, `${filename}.${ext}`);
        fs.writeFileSync(outPath, Buffer.from(imageBase64, 'base64'));

        // También copiar a /config/www/jarvis/ para acceso desde Lovelace
        const wwwDir = '/config/www/jarvis';
        if (!fs.existsSync(wwwDir)) fs.mkdirSync(wwwDir, { recursive: true });
        const wwwPath = path.join(wwwDir, `${filename}.${ext}`);
        fs.copyFileSync(outPath, wwwPath);

        return {
          success: true,
          file: outPath,
          lovelace_url: `/local/jarvis/${filename}.${ext}`,
          share_url: `/share/jarvis/images/${filename}.${ext}`,
          model_used: useFlash ? 'gemini-flash' : 'imagen-4.0',
          size_kb: Math.round(Buffer.from(imageBase64, 'base64').length / 1024)
        };
      }

      case 'show_house_status': {
        const sts = await haGet('/states');

        // Luces
        const allLights = sts.filter(e => e.entity_id.startsWith('light.'));
        const onLights  = allLights.filter(e => e.state === 'on');
        const lightsData = allLights.slice(0, 20).map(l => ({
          entity_id: l.entity_id,
          name: l.attributes.friendly_name || l.entity_id,
          state: l.state,
          brightness: l.attributes.brightness !== undefined ? Math.round(l.attributes.brightness / 2.55) : null
        }));

        // Temperatura
        const temps = sts.filter(e =>
          e.entity_id.startsWith('sensor.') &&
          e.attributes?.unit_of_measurement === '°C' &&
          e.attributes?.device_class === 'temperature' &&
          !isNaN(parseFloat(e.state))
        ).slice(0, 10).map(t => ({
          name: (t.attributes.friendly_name || t.entity_id).replace(/temperatura/i, '').trim(),
          value: parseFloat(t.state).toFixed(1), unit: '°C'
        }));

        // Clima
        const climate = sts.filter(e => e.entity_id.startsWith('climate.')).map(c => ({
          name: c.attributes.friendly_name || c.entity_id,
          state: c.state,
          target: c.attributes.temperature,
          current: c.attributes.current_temperature
        }));

        // Persianas
        const covers = sts.filter(e => e.entity_id.startsWith('cover.')).map(c => ({
          name: c.attributes.friendly_name || c.entity_id,
          state: c.state,
          position: c.attributes.current_position ?? null
        }));

        // Personas
        const persons = sts.filter(e => e.entity_id.startsWith('person.')).map(p => ({
          name: p.attributes.friendly_name || p.entity_id,
          state: p.state
        }));

        // Media
        const media = sts.filter(e =>
          e.entity_id.startsWith('media_player.') && ['playing','paused'].includes(e.state)
        ).map(m => ({
          name: m.attributes.friendly_name || m.entity_id,
          state: m.state,
          media: m.attributes.media_title || ''
        }));

        // No disponibles
        const unavailable = sts.filter(e =>
          ['unavailable','unknown'].includes(e.state) &&
          /^(sensor|binary_sensor|light|switch)\./.test(e.entity_id)
        ).length;

        const { loadJSON: lj } = require('../utils/persistence');
        const thoughts = lj(require('path').join(C.DATA_DIR, 'pending_thoughts.json'), [])
          .filter(t => t.status === 'pending').slice(0, 5)
          .map(t => ({ title: t.title, priority: t.priority, type: t.type }));
        const emergencies = Object.keys(lj(require('path').join(C.DATA_DIR, 'active_emergencies.json'), {})).length;

        const payload = {
          lights: { on: onLights.length, total: allLights.length, entities: lightsData },
          temperature: temps, climate, covers, persons, media,
          unavailable, pending_thoughts: thoughts, active_emergencies: emergencies,
          ts: new Date().toISOString()
        };

        // Inyectar panel visual directamente en el chat del usuario
        if (typeof state.currentSendEvent === 'function') {
          state.currentSendEvent({ type: 'status_panel', data: payload });
        }

        // Resumen compacto para el LLM (sin repetir el JSON completo)
        const atHome = persons.filter(p => p.state === 'home').map(p => p.name).join(', ') || 'nadie';
        const avgTmp = temps.length
          ? (temps.filter(t => !/(disk|cpu|shelly|omv)/i.test(t.name))
              .reduce((s, t) => s + parseFloat(t.value), 0) /
             (temps.filter(t => !/(disk|cpu|shelly|omv)/i.test(t.name)).length || 1)).toFixed(1) + '°C'
          : 'sin datos';
        return {
          panel_enviado: true,
          resumen: `Luces: ${onLights.length}/${allLights.length} encendidas. Temp. media: ${avgTmp}. En casa: ${atHome}. No disponibles: ${unavailable}. Emergencias: ${emergencies}.`,
          pensamientos_pendientes: thoughts.length
        };
      }

      // ─── Backup / Restore ───
      case 'backup_restore': {
        const svGet = async (ep) => {
          const r = await fetch(`http://supervisor${ep}`, { headers: { Authorization: `Bearer ${C.HA_TOKEN}` } });
          const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t }; }
        };
        const svPost = async (ep, body) => {
          const opts = { method: 'POST', headers: { Authorization: `Bearer ${C.HA_TOKEN}`, 'Content-Type': 'application/json' } };
          if (body) opts.body = JSON.stringify(body);
          const r = await fetch(`http://supervisor${ep}`, opts);
          const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t }; }
        };
        const svDel = async (ep) => {
          const r = await fetch(`http://supervisor${ep}`, { method: 'DELETE', headers: { Authorization: `Bearer ${C.HA_TOKEN}` } });
          const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t }; }
        };

        switch (input.action) {
          case 'list': {
            const r = await svGet('/backups');
            const backups = (r.data || r).backups || [];
            return { backups: backups.map(b => ({ slug: b.slug, name: b.name, date: b.date, type: b.type, size: b.size })), total: backups.length };
          }
          case 'create': {
            const backupName = input.name || `Jarvis backup ${new Date().toISOString().slice(0, 16)}`;
            const body = { name: backupName };
            const ep = input.partial ? '/backups/new/partial' : '/backups/new/full';
            if (input.partial) body.folders = ['config'];
            const r = await svPost(ep, body);
            return r.result === 'ok' ? { success: true, slug: r.data?.slug, name: backupName, type: input.partial ? 'partial' : 'full' } : r;
          }
          case 'info': {
            if (!input.slug) return { error: 'slug requerido' };
            const r = await svGet(`/backups/${input.slug}/info`);
            return r.data || r;
          }
          case 'restore': {
            if (!input.slug) return { error: 'slug requerido' };
            const r = await svPost(`/backups/${input.slug}/restore/full`);
            return r.result === 'ok' ? { success: true, message: `Restauración de ${input.slug} iniciada. HA se reiniciará.` } : r;
          }
          case 'delete': {
            if (!input.slug) return { error: 'slug requerido' };
            const r = await svDel(`/backups/${input.slug}`);
            return r.result === 'ok' ? { success: true, message: `Backup ${input.slug} eliminado` } : r;
          }
          default:
            return { error: `Acción backup desconocida: ${input.action}` };
        }
      }

      // ─── Notify All (broadcast unificado) ───
      case 'notify_all': {
        const channels = input.channels || (input.priority === 'critical' ? ['telegram', 'push', 'tts'] : ['telegram', 'push']);
        const results = {};

        if (channels.includes('telegram')) {
          try {
            const chatId = process.env.TELEGRAM_CHAT_ID || '';
            if (chatId) {
              await haPost('/services/telegram_bot/send_message', { message: input.message, title: input.title || undefined, target: chatId });
              results.telegram = 'sent';
            } else {
              await haPost('/services/notify/notify', { message: input.message, title: input.title || 'Jarvis' });
              results.telegram = 'sent via notify.notify';
            }
          } catch (e) { results.telegram = `error: ${e.message}`; }
        }

        if (channels.includes('push')) {
          try {
            await haPost('/services/notify/notify', {
              message: input.message,
              title: input.title || 'Jarvis',
              data: input.priority === 'critical' ? { push: { sound: { name: 'default', critical: 1, volume: 1.0 } } } : undefined
            });
            results.push = 'sent';
          } catch (e) { results.push = `error: ${e.message}`; }
        }

        if (channels.includes('tts')) {
          try {
            const target = input.tts_target;
            if (target) {
              await haPost('/services/tts/speak', { entity_id: target, message: input.message });
            } else {
              const states = await haGet('/states');
              const players = states.filter(e => e.entity_id.startsWith('media_player.') && e.state !== 'unavailable');
              for (const p of players.slice(0, 3)) {
                try { await haPost('/services/tts/speak', { entity_id: p.entity_id, message: input.message }); } catch {}
              }
            }
            results.tts = 'sent';
          } catch (e) { results.tts = `error: ${e.message}`; }
        }

        return { success: true, channels: results, priority: input.priority || 'normal' };
      }

      // ─── Energy Query ───
      case 'energy_query': {
        const states = await haGet('/states');

        switch (input.action) {
          case 'sensors': {
            const energySensors = states.filter(e => {
              const cls = e.attributes?.device_class;
              const unit = e.attributes?.unit_of_measurement;
              return cls === 'energy' || cls === 'power' || unit === 'kWh' || unit === 'W' || unit === 'Wh';
            }).map(e => ({
              entity_id: e.entity_id,
              name: e.attributes?.friendly_name,
              state: e.state,
              unit: e.attributes?.unit_of_measurement,
              device_class: e.attributes?.device_class
            }));
            return { sensors: energySensors, total: energySensors.length };
          }
          case 'current': {
            const power = states.filter(e => {
              const cls = e.attributes?.device_class;
              const unit = e.attributes?.unit_of_measurement;
              return (cls === 'power' || unit === 'W') && !isNaN(parseFloat(e.state));
            }).map(e => ({
              entity_id: e.entity_id,
              name: e.attributes?.friendly_name,
              value: parseFloat(e.state),
              unit: 'W'
            }));
            const totalW = power.reduce((s, p) => s + p.value, 0);
            return { current_power: power, total_watts: Math.round(totalW), total_kw: (totalW / 1000).toFixed(2) };
          }
          case 'daily':
          case 'weekly':
          case 'monthly': {
            const now = new Date();
            let startDate;
            if (input.action === 'daily') {
              startDate = new Date(now); startDate.setHours(0, 0, 0, 0);
            } else if (input.action === 'weekly') {
              startDate = new Date(now); startDate.setDate(now.getDate() - 7);
            } else {
              startDate = new Date(now); startDate.setMonth(now.getMonth() - 1);
            }
            const energyEntities = states.filter(e =>
              e.attributes?.device_class === 'energy' || e.attributes?.unit_of_measurement === 'kWh'
            ).map(e => e.entity_id);

            if (energyEntities.length === 0) return { error: 'No hay sensores de energía (kWh) configurados' };

            try {
              const histUrl = `${C.HA_URL}/api/history/period/${startDate.toISOString()}?filter_entity_id=${energyEntities.slice(0, 5).join(',')}&minimal_response&no_attributes`;
              const histResp = await fetch(histUrl, { headers: { Authorization: `Bearer ${C.HA_TOKEN}` } });
              const histData = await histResp.json();
              const summary = histData.map((entityHist, i) => {
                if (!entityHist || entityHist.length === 0) return null;
                const first = parseFloat(entityHist[0]?.state) || 0;
                const last = parseFloat(entityHist[entityHist.length - 1]?.state) || 0;
                return { entity_id: energyEntities[i], consumption_kwh: Math.max(0, last - first).toFixed(2) };
              }).filter(Boolean);
              return { period: input.action, from: startDate.toISOString(), to: now.toISOString(), consumption: summary };
            } catch (e) {
              return { error: `Error consultando historial: ${e.message}` };
            }
          }
          case 'cost': {
            const pvpc = states.find(e => e.entity_id.includes('pvpc') || (e.attributes?.device_class === 'monetary' && e.attributes?.unit_of_measurement?.includes('€')));
            const energy = states.filter(e => e.attributes?.device_class === 'energy' && e.attributes?.unit_of_measurement === 'kWh');
            return {
              pvpc_price: pvpc ? { entity_id: pvpc.entity_id, price: pvpc.state, unit: pvpc.attributes?.unit_of_measurement } : 'No encontrado',
              energy_sensors: energy.map(e => ({ entity_id: e.entity_id, name: e.attributes?.friendly_name, kwh: e.state })),
              hint: 'Usa el sensor PVPC y el consumo diario para calcular el coste. Coste = consumo_kwh * precio_€/kWh'
            };
          }
          default:
            return { error: `Acción energy desconocida: ${input.action}` };
        }
      }

      // ─── ESPHome management ───
      case 'esphome_manage': {
        const espSlug = '5c53de3b_esphome';
        const espApi = async (endpoint, method = 'GET', body) => {
          const opts = {
            method,
            headers: { Authorization: `Bearer ${C.HA_TOKEN}` }
          };
          if (body) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
          }
          const r = await fetch(`http://supervisor/addons/${espSlug}/api/${endpoint}`, opts);
          const text = await r.text();
          if (!r.ok) return { error: `ESPHome API ${r.status}: ${text.slice(0, 500)}` };
          try { return JSON.parse(text); } catch { return { raw: text.slice(0, 3000) }; }
        };
        const espSvGet = async (endpoint) => {
          const r = await fetch(`http://supervisor/addons/${espSlug}${endpoint}`, {
            headers: { Authorization: `Bearer ${C.HA_TOKEN}` }
          });
          const text = await r.text();
          try { return JSON.parse(text); } catch { return { raw: text }; }
        };

        switch (input.action) {
          case 'addon_info': {
            const info = await espSvGet('/info');
            const d = info.data || info;
            return { name: d.name, version: d.version, state: d.state, update_available: d.update_available, url: d.url };
          }
          case 'list': {
            const configDir = '/config/esphome';
            if (!fs.existsSync(configDir)) return { error: 'Directorio /config/esphome no encontrado. ¿Está ESPHome instalado?' };
            const files = fs.readdirSync(configDir).filter(f => f.endsWith('.yaml') && !f.startsWith('.') && f !== 'secrets.yaml');
            const devices = files.map(f => {
              const name = f.replace('.yaml', '');
              try {
                const content = fs.readFileSync(path.join(configDir, f), 'utf8');
                const platformMatch = content.match(/^(esp32|esp8266|rp2040|bk72xx|rtl87xx):/m);
                return { name, file: f, platform: platformMatch ? platformMatch[1] : 'unknown' };
              } catch { return { name, file: f }; }
            });
            return { devices, total: devices.length };
          }
          case 'config': {
            if (!input.device) return { error: 'device requerido' };
            const filePath = `/config/esphome/${input.device}.yaml`;
            if (!fs.existsSync(filePath)) return { error: `No existe: ${filePath}` };
            const content = fs.readFileSync(filePath, 'utf8');
            return { device: input.device, config: content.slice(0, 5000) };
          }
          case 'validate': {
            if (!input.device) return { error: 'device requerido' };
            const filePath = `/config/esphome/${input.device}.yaml`;
            if (!fs.existsSync(filePath)) return { error: `No existe: ${filePath}` };
            const content = fs.readFileSync(filePath, 'utf8');
            try {
              yaml.load(content);
              return { valid: true, device: input.device };
            } catch (e) {
              return { valid: false, error: e.message };
            }
          }
          case 'compile': {
            if (!input.device) return { error: 'device requerido' };
            const r = await espApi(`${input.device}/compile`, 'POST');
            return r.error ? r : { success: true, message: `Compilación de ${input.device} iniciada. Puede tardar 1-3 minutos.` };
          }
          case 'install': {
            if (!input.device) return { error: 'device requerido' };
            const r = await espApi(`${input.device}/install?mode=ota`, 'POST');
            return r.error ? r : { success: true, message: `Instalación OTA de ${input.device} iniciada.` };
          }
          case 'logs': {
            if (!input.device) return { error: 'device requerido' };
            const r = await espApi(`${input.device}/logs`);
            return r;
          }
          case 'restart': {
            const svPost = async (endpoint) => {
              const r2 = await fetch(`http://supervisor/addons/${espSlug}${endpoint}`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${C.HA_TOKEN}` }
              });
              const text = await r2.text();
              try { return JSON.parse(text); } catch { return { raw: text }; }
            };
            const r = await svPost('/restart');
            return r.result === 'ok' ? { success: true, message: 'ESPHome add-on reiniciándose' } : r;
          }
          default:
            return { error: `Acción ESPHome desconocida: ${input.action}. Usa: list, config, compile, install, logs, restart, addon_info, validate` };
        }
      }

      default:
        return { error: `Tool desconocida: ${name}` };
    }
  } catch (err) {
    // Aprender del error automáticamente
    state.learnings.push({
      type: 'error',
      context: `Tool ${name} con input ${JSON.stringify(input).slice(0, 200)}`,
      lesson: err.message,
      solution: null,
      learnedAt: new Date().toISOString()
    });
    if (state.learnings.length > 200) state.learnings = state.learnings.slice(-200);
    saveJSON(C.LEARNINGS_FILE, state.learnings);
    return { error: err.message };
  }
}

module.exports = { executeTool, saveHistory, pushToAll };
