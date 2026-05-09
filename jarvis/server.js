const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || 'claude-sonnet-4-6';
const HA_TOKEN = process.env.HA_TOKEN;
const HA_URL = process.env.HA_URL || 'http://supervisor/core';
const LANGUAGE = process.env.LANGUAGE || 'es';

// ── Rutas del filesystem de HA ───────────────────────────────────────────────
const DATA_DIR = '/data';                    // Persistente del add-on
const HA_CONFIG = '/config';                 // Config de HA (configuration.yaml, automations.yaml, etc.)
const HA_ADDONS = '/addons';                 // Add-ons instalados (read-only)
const HA_SHARE = '/share';                   // Carpeta compartida
const HA_MEDIA = '/media';                   // Media (read-only)

// Archivos del agente
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const LEARNINGS_FILE = path.join(DATA_DIR, 'learnings.json');
const HOUSE_CONTEXT_FILE = path.join(DATA_DIR, 'house_context.json');
const INSTALLATION_MAP_FILE = path.join(DATA_DIR, 'installation_map.json');

// Asegurar que /data existe
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Cargar datos persistentes ────────────────────────────────────────────────

function loadJSON(filepath, fallback = []) {
  try {
    if (fs.existsSync(filepath)) return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (e) { console.log(`[load] Error en ${filepath}: ${e.message}`); }
  return fallback;
}

function saveJSON(filepath, data) {
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
}

let userMemory = loadJSON(MEMORY_FILE, []);
let conversationHistory = loadJSON(HISTORY_FILE, []);
let learnings = loadJSON(LEARNINGS_FILE, []);
let houseContext = '';
let installationMap = loadJSON(INSTALLATION_MAP_FILE, {});

try {
  if (fs.existsSync(HOUSE_CONTEXT_FILE)) {
    houseContext = JSON.parse(fs.readFileSync(HOUSE_CONTEXT_FILE, 'utf8')).summary || '';
  }
} catch {}

console.log(`[init] Memoria: ${userMemory.length} notas | Historial: ${conversationHistory.length} msgs | Learnings: ${learnings.length}`);

// Limitar historial
function saveHistory() {
  if (conversationHistory.length > 60) conversationHistory = conversationHistory.slice(-60);
  saveJSON(HISTORY_FILE, conversationHistory);
}

// ── Caché de entidades ───────────────────────────────────────────────────────
let entitiesCache = null;

// ── Helpers API de HA ────────────────────────────────────────────────────────

async function haGet(endpoint) {
  const res = await fetch(`${HA_URL}/api${endpoint}`, {
    headers: { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' }
  });
  if (!res.ok) throw new Error(`HA GET ${endpoint} → ${res.status}`);
  return res.json();
}

async function haPost(endpoint, body = {}) {
  const res = await fetch(`${HA_URL}/api${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`HA POST ${endpoint} → ${res.status}`);
  return res.json();
}

async function supervisorGet(endpoint) {
  const res = await fetch(`http://supervisor${endpoint}`, {
    headers: { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' }
  });
  if (!res.ok) throw new Error(`Supervisor GET ${endpoint} → ${res.status}`);
  return res.json();
}

// ── Scan completo de la instalación ──────────────────────────────────────────

async function scanInstallation() {
  console.log('[scan] Escaneando instalación completa...');
  const map = { scannedAt: new Date().toISOString() };

  try {
    // Entidades y estados
    const states = await haGet('/states');
    const domains = {};
    for (const e of states) {
      const [domain] = e.entity_id.split('.');
      if (!domains[domain]) domains[domain] = { count: 0, entities: [] };
      domains[domain].count++;
      domains[domain].entities.push({
        id: e.entity_id,
        name: e.attributes?.friendly_name || e.entity_id,
        state: e.state
      });
    }
    map.domains = domains;
    map.totalEntities = states.length;

    // Áreas
    try {
      const areas = await haPost('/template', { template: '{{ areas() | list }}' });
      map.areas = areas;
    } catch {}

    // Config de HA - listar archivos principales
    try {
      const configFiles = fs.readdirSync(HA_CONFIG).filter(f =>
        f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.json')
      );
      map.configFiles = configFiles;
    } catch {}

    // Add-ons instalados
    try {
      const addonsInfo = await supervisorGet('/addons');
      map.addons = (addonsInfo.data?.addons || []).map(a => ({
        name: a.name, slug: a.slug, state: a.state, version: a.version
      }));
    } catch {}

    // Info del sistema
    try {
      const coreInfo = await supervisorGet('/core/info');
      map.haVersion = coreInfo.data?.version;
      map.arch = coreInfo.data?.arch;
    } catch {}

    try {
      const hostInfo = await supervisorGet('/host/info');
      map.hostname = hostInfo.data?.hostname;
      map.os = hostInfo.data?.operating_system;
    } catch {}

    // Integraciones (desde config entries no está en API pública, pero podemos leer config)
    try {
      const integrations = await haGet('/config/config_entries/entry');
      map.integrations = integrations.map(i => ({
        domain: i.domain, title: i.title, state: i.state
      }));
    } catch {}

  } catch (err) {
    console.log('[scan] Error parcial:', err.message);
  }

  // Generar resumen textual
  let summary = `INSTALACIÓN DE HOME ASSISTANT\n`;
  summary += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  if (map.haVersion) summary += `Versión HA: ${map.haVersion} | Arch: ${map.arch}\n`;
  if (map.hostname) summary += `Host: ${map.hostname} | OS: ${map.os}\n`;
  summary += `Total entidades: ${map.totalEntities}\n\n`;

  // Dominios
  if (map.domains) {
    summary += `DISPOSITIVOS POR DOMINIO:\n`;
    const sortedDomains = Object.entries(map.domains).sort((a, b) => b[1].count - a[1].count);
    for (const [domain, info] of sortedDomains) {
      summary += `  ${domain}: ${info.count}\n`;
      // Mostrar hasta 15 por dominio relevante
      const relevant = ['light', 'switch', 'climate', 'media_player', 'cover', 'fan', 'lock', 'camera', 'automation', 'script', 'scene'];
      if (relevant.includes(domain)) {
        for (const e of info.entities.slice(0, 15)) {
          summary += `    - ${e.name} (${e.id}) → ${e.state}\n`;
        }
        if (info.entities.length > 15) summary += `    ... y ${info.entities.length - 15} más\n`;
      }
    }
    summary += '\n';
  }

  // Integraciones
  if (map.integrations) {
    summary += `INTEGRACIONES (${map.integrations.length}):\n`;
    for (const i of map.integrations.slice(0, 30)) {
      summary += `  - ${i.title || i.domain} (${i.domain}) → ${i.state}\n`;
    }
    summary += '\n';
  }

  // Add-ons
  if (map.addons) {
    summary += `ADD-ONS INSTALADOS (${map.addons.length}):\n`;
    for (const a of map.addons) {
      summary += `  - ${a.name} v${a.version} (${a.state})\n`;
    }
    summary += '\n';
  }

  // Archivos de configuración
  if (map.configFiles) {
    summary += `ARCHIVOS EN /config:\n`;
    for (const f of map.configFiles) {
      summary += `  - ${f}\n`;
    }
    summary += '\n';
  }

  summary += `RUTAS IMPORTANTES:\n`;
  summary += `  /config/ → Configuración de HA (configuration.yaml, automations.yaml, etc.)\n`;
  summary += `  /config/custom_components/ → Integraciones personalizadas\n`;
  summary += `  /addons/ → Add-ons instalados (solo lectura)\n`;
  summary += `  /share/ → Carpeta compartida (lectura/escritura)\n`;
  summary += `  /media/ → Media (solo lectura)\n`;
  summary += `  /data/ → Datos persistentes de este add-on\n`;

  map.summary = summary;
  houseContext = summary;
  saveJSON(HOUSE_CONTEXT_FILE, { summary, updatedAt: new Date().toISOString() });
  saveJSON(INSTALLATION_MAP_FILE, map);
  console.log(`[scan] Completado: ${map.totalEntities} entidades, ${(map.integrations || []).length} integraciones, ${(map.addons || []).length} add-ons`);
  return map;
}

// ── Tools del agente ─────────────────────────────────────────────────────────

const tools = [
  // ─── Dispositivos ───
  {
    name: 'get_entities',
    description: 'Lista entidades de HA filtradas por dominio. SIEMPRE especifica dominio.',
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Dominio: light, switch, sensor, climate, media_player, automation, cover, fan, camera, binary_sensor, script, scene' }
      }
    }
  },
  {
    name: 'search_entities',
    description: 'Busca entidades por nombre parcial. Útil cuando el usuario dice un nombre de habitación o dispositivo.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texto a buscar: "salon", "cocina", "temperatura", etc.' }
      },
      required: ['query']
    }
  },
  {
    name: 'get_entity_state',
    description: 'Estado actual y atributos de una entidad específica',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Ej: light.salon, switch.cocina' }
      },
      required: ['entity_id']
    }
  },
  {
    name: 'call_service',
    description: 'Ejecuta un servicio de HA. Para controlar dispositivos, ejecutar scripts, activar escenas, etc.',
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Dominio: light, switch, climate, media_player, script, scene, etc.' },
        service: { type: 'string', description: 'Servicio: turn_on, turn_off, toggle, set_temperature, etc.' },
        entity_id: { type: 'string', description: 'ID de la entidad' },
        service_data: { type: 'object', description: 'Datos adicionales: {"brightness": 128, "color_temp": 300}' }
      },
      required: ['domain', 'service']
    }
  },
  {
    name: 'get_history',
    description: 'Historial de estados de una entidad (últimas N horas)',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string' },
        hours: { type: 'number', description: 'Horas hacia atrás (max 48)' }
      },
      required: ['entity_id']
    }
  },

  // ─── Automatizaciones ───
  {
    name: 'get_automations',
    description: 'Lista todas las automatizaciones con su estado',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'create_automation',
    description: 'Crea una nueva automatización escribiendo directamente en automations.yaml. Proporciona el YAML completo de la automatización.',
    input_schema: {
      type: 'object',
      properties: {
        yaml_content: { type: 'string', description: 'Contenido YAML de la automatización (sin el guión inicial). Incluye id, alias, trigger, condition, action.' },
        description: { type: 'string', description: 'Descripción breve de lo que hace la automatización' }
      },
      required: ['yaml_content', 'description']
    }
  },
  {
    name: 'reload_config',
    description: 'Recarga la configuración de HA después de modificar archivos. Especifica qué recargar.',
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['automations', 'scripts', 'scenes', 'groups', 'core', 'all'], description: 'Qué recargar' }
      },
      required: ['target']
    }
  },

  // ─── Filesystem ───
  {
    name: 'read_file',
    description: 'Lee un archivo del sistema. Rutas válidas: /config/... (configuración HA), /addons/... (add-ons), /share/... (compartido), /data/... (datos del agente)',
    input_schema: {
      type: 'object',
      properties: {
        filepath: { type: 'string', description: 'Ruta absoluta del archivo. Ej: /config/configuration.yaml, /config/automations.yaml' },
        lines: { type: 'number', description: 'Número máximo de líneas a leer (default: 200)' }
      },
      required: ['filepath']
    }
  },
  {
    name: 'write_file',
    description: 'Escribe o crea un archivo. Solo permitido en /config, /share y /data. CUIDADO: esto sobreescribe el archivo completo.',
    input_schema: {
      type: 'object',
      properties: {
        filepath: { type: 'string', description: 'Ruta absoluta del archivo' },
        content: { type: 'string', description: 'Contenido completo del archivo' }
      },
      required: ['filepath', 'content']
    }
  },
  {
    name: 'append_file',
    description: 'Añade contenido al final de un archivo existente. Útil para añadir automatizaciones, scripts, etc.',
    input_schema: {
      type: 'object',
      properties: {
        filepath: { type: 'string', description: 'Ruta absoluta del archivo' },
        content: { type: 'string', description: 'Contenido a añadir al final' }
      },
      required: ['filepath', 'content']
    }
  },
  {
    name: 'list_directory',
    description: 'Lista archivos y carpetas de un directorio',
    input_schema: {
      type: 'object',
      properties: {
        dirpath: { type: 'string', description: 'Ruta del directorio. Ej: /config, /config/custom_components' },
        recursive: { type: 'boolean', description: 'Listar recursivamente (default: false)' }
      },
      required: ['dirpath']
    }
  },

  // ─── Internet ───
  {
    name: 'web_search',
    description: 'Busca información en internet. Útil para documentación de HA, integraciones, solucionar errores, etc.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Consulta de búsqueda. Ej: "home assistant automation sunrise trigger", "esphome esp32 temperature sensor"' }
      },
      required: ['query']
    }
  },
  {
    name: 'fetch_url',
    description: 'Obtiene el contenido de una URL específica (documentación, APIs, etc.)',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL a consultar' },
        max_chars: { type: 'number', description: 'Máximo de caracteres a devolver (default: 5000)' }
      },
      required: ['url']
    }
  },

  // ─── Memoria y aprendizaje ───
  {
    name: 'save_memory',
    description: 'Guarda una nota en memoria permanente. Usa para: preferencias del usuario, info de la instalación, rutinas, nombres de dispositivos, etc.',
    input_schema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'La nota a recordar' },
        category: { type: 'string', enum: ['preferencia', 'rutina', 'dispositivo', 'configuracion', 'error_conocido', 'solucion', 'patron', 'mejora_pendiente'], description: 'Categoría' }
      },
      required: ['note', 'category']
    }
  },
  {
    name: 'get_memory',
    description: 'Consulta la memoria permanente. Filtra por categoría si lo necesitas.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Filtrar por categoría (opcional)' },
        search: { type: 'string', description: 'Buscar texto en las notas (opcional)' }
      }
    }
  },
  {
    name: 'delete_memory',
    description: 'Elimina una nota de la memoria por su índice',
    input_schema: {
      type: 'object',
      properties: { index: { type: 'number', description: 'Índice de la nota (empieza en 0)' } },
      required: ['index']
    }
  },
  {
    name: 'learn',
    description: 'Registra un aprendizaje: algo que funcionó, algo que falló, un patrón descubierto. Esto te hace más inteligente con el tiempo.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['success', 'error', 'pattern', 'optimization'], description: 'Tipo de aprendizaje' },
        context: { type: 'string', description: 'Qué estabas haciendo' },
        lesson: { type: 'string', description: 'Qué aprendiste' },
        solution: { type: 'string', description: 'Solución si aplica' }
      },
      required: ['type', 'context', 'lesson']
    }
  },

  // ─── Instalación ───
  {
    name: 'scan_installation',
    description: 'Escanea toda la instalación de HA: entidades, integraciones, add-ons, archivos de config, sistema. Actualiza el mapa interno. Usar cuando necesites info actualizada del sistema.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'check_config',
    description: 'Verifica que la configuración de HA es válida (equivalente a comprobar config en HA)',
    input_schema: { type: 'object', properties: {} }
  }
];

// ── Ejecutar tools ───────────────────────────────────────────────────────────

async function executeTool(name, input) {
  try {
    switch (name) {

      // ─── Dispositivos ───
      case 'get_entities': {
        const now = Date.now();
        if (!entitiesCache || now > entitiesCache.expiresAt) {
          const raw = await haGet('/states');
          entitiesCache = {
            data: raw.map(e => ({ entity_id: e.entity_id, state: e.state, friendly_name: e.attributes?.friendly_name || e.entity_id })),
            expiresAt: now + 30_000
          };
        }
        const filtered = input.domain
          ? entitiesCache.data.filter(e => e.entity_id.startsWith(input.domain + '.'))
          : entitiesCache.data;
        const limited = filtered.slice(0, 100);
        return { entities: limited, total: filtered.length, note: filtered.length > 100 ? `Mostrando 100/${filtered.length}. Filtra por dominio.` : undefined };
      }

      case 'search_entities': {
        const now = Date.now();
        if (!entitiesCache || now > entitiesCache.expiresAt) {
          const raw = await haGet('/states');
          entitiesCache = { data: raw.map(e => ({ entity_id: e.entity_id, state: e.state, friendly_name: e.attributes?.friendly_name || e.entity_id })), expiresAt: now + 30_000 };
        }
        const q = (input.query || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        const results = entitiesCache.data.filter(e => {
          const name = (e.friendly_name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
          const id = e.entity_id.toLowerCase();
          return name.includes(q) || id.includes(q);
        });
        return { entities: results.slice(0, 50), total: results.length };
      }

      case 'get_entity_state': {
        const state = await haGet(`/states/${input.entity_id}`);
        return { entity_id: state.entity_id, state: state.state, attributes: state.attributes, last_changed: state.last_changed };
      }

      case 'call_service': {
        const body = { ...(input.service_data || {}) };
        if (input.entity_id) body.entity_id = input.entity_id;
        await haPost(`/services/${input.domain}/${input.service}`, body);
        return { success: true, message: `${input.domain}.${input.service} ejecutado OK` };
      }

      case 'get_history': {
        const hours = Math.min(input.hours || 6, 48);
        const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
        const history = await haGet(`/history/period/${since}?filter_entity_id=${input.entity_id}`);
        return (history[0] || []).slice(-30).map(h => ({ state: h.state, time: h.last_changed }));
      }

      // ─── Automatizaciones ───
      case 'get_automations': {
        const states = await haGet('/states');
        return states.filter(e => e.entity_id.startsWith('automation.')).map(e => ({
          entity_id: e.entity_id, name: e.attributes?.friendly_name || e.entity_id, state: e.state
        }));
      }

      case 'create_automation': {
        const automationsPath = path.join(HA_CONFIG, 'automations.yaml');
        let existing = '';
        if (fs.existsSync(automationsPath)) {
          existing = fs.readFileSync(automationsPath, 'utf8');
        }
        // Añadir la nueva automatización
        const newEntry = '\n- ' + input.yaml_content.replace(/\n/g, '\n  ') + '\n';
        fs.writeFileSync(automationsPath, existing + newEntry);
        console.log(`[automation] Creada: ${input.description}`);
        // Auto-reload
        try { await haPost('/services/automation/reload', {}); } catch {}
        return { success: true, message: `Automatización creada: ${input.description}. Config recargada.` };
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
        const allowed = [HA_CONFIG, HA_ADDONS, HA_SHARE, HA_MEDIA, DATA_DIR];
        if (!allowed.some(p => input.filepath.startsWith(p))) {
          return { error: `Ruta no permitida. Usa: ${allowed.join(', ')}` };
        }
        if (!fs.existsSync(input.filepath)) return { error: `Archivo no existe: ${input.filepath}` };
        const content = fs.readFileSync(input.filepath, 'utf8');
        const lines = content.split('\n');
        const maxLines = input.lines || 200;
        return {
          content: lines.slice(0, maxLines).join('\n'),
          totalLines: lines.length,
          truncated: lines.length > maxLines
        };
      }

      case 'write_file': {
        const allowedWrite = [HA_CONFIG, HA_SHARE, DATA_DIR];
        if (!allowedWrite.some(p => input.filepath.startsWith(p))) {
          return { error: `Escritura no permitida en esa ruta. Usa: ${allowedWrite.join(', ')}` };
        }
        // Crear directorio si no existe
        const dir = path.dirname(input.filepath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(input.filepath, input.content);
        console.log(`[fs] Escrito: ${input.filepath} (${input.content.length} chars)`);
        return { success: true, message: `Archivo escrito: ${input.filepath}` };
      }

      case 'append_file': {
        const allowedAppend = [HA_CONFIG, HA_SHARE, DATA_DIR];
        if (!allowedAppend.some(p => input.filepath.startsWith(p))) {
          return { error: `Escritura no permitida en esa ruta` };
        }
        fs.appendFileSync(input.filepath, input.content);
        console.log(`[fs] Append: ${input.filepath} (+${input.content.length} chars)`);
        return { success: true, message: `Contenido añadido a: ${input.filepath}` };
      }

      case 'list_directory': {
        const allowed = [HA_CONFIG, HA_ADDONS, HA_SHARE, HA_MEDIA, DATA_DIR];
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
        // Usar DuckDuckGo HTML (no requiere API key)
        const encoded = encodeURIComponent(input.query);
        const res = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HABot/1.0)' }
        });
        const html = await res.text();
        // Extraer resultados básicos
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
        return { query: input.query, results, count: results.length };
      }

      case 'fetch_url': {
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
        userMemory.push({ note: input.note, category: input.category, savedAt: new Date().toISOString() });
        saveJSON(MEMORY_FILE, userMemory);
        console.log(`[memory] +${input.category}: "${input.note}"`);
        return { success: true, total: userMemory.length };
      }

      case 'get_memory': {
        let filtered = userMemory;
        if (input.category) filtered = filtered.filter(m => m.category === input.category);
        if (input.search) {
          const s = input.search.toLowerCase();
          filtered = filtered.filter(m => m.note.toLowerCase().includes(s));
        }
        return { memories: filtered, total: filtered.length };
      }

      case 'delete_memory': {
        if (input.index >= 0 && input.index < userMemory.length) {
          const removed = userMemory.splice(input.index, 1)[0];
          saveJSON(MEMORY_FILE, userMemory);
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
        learnings.push(learning);
        // Limitar a 200 learnings
        if (learnings.length > 200) learnings = learnings.slice(-200);
        saveJSON(LEARNINGS_FILE, learnings);
        console.log(`[learn] ${input.type}: ${input.lesson}`);
        return { success: true, total_learnings: learnings.length };
      }

      // ─── Instalación ───
      case 'scan_installation': {
        const map = await scanInstallation();
        return { success: true, totalEntities: map.totalEntities, integrations: (map.integrations || []).length, addons: (map.addons || []).length, message: 'Instalación escaneada y mapa actualizado' };
      }

      case 'check_config': {
        try {
          const result = await haPost('/services/homeassistant/check_config', {});
          return result;
        } catch (err) {
          // Intentar via supervisor
          try {
            const check = await supervisorGet('/core/check');
            return check.data || { result: 'unknown' };
          } catch {
            return { error: err.message };
          }
        }
      }

      default:
        return { error: `Tool desconocida: ${name}` };
    }
  } catch (err) {
    // Aprender del error automáticamente
    learnings.push({
      type: 'error',
      context: `Tool ${name} con input ${JSON.stringify(input).slice(0, 200)}`,
      lesson: err.message,
      solution: null,
      learnedAt: new Date().toISOString()
    });
    if (learnings.length > 200) learnings = learnings.slice(-200);
    saveJSON(LEARNINGS_FILE, learnings);
    return { error: err.message };
  }
}

// ── System Prompt (dinámico) ─────────────────────────────────────────────────

function buildSystemPrompt() {
  let prompt = `Eres JARVIS, un AGENTE IA ESPECIALIZADO en Home Assistant. Eres el desarrollador y administrador privado de esta instalación.
Tu nombre es Jarvis. Tienes acceso COMPLETO al sistema: dispositivos, archivos de configuración, automatizaciones, internet.

═══ TU ROL ═══
No eres solo un chatbot — eres un ingeniero domótico experto que:
- Controla todos los dispositivos de la casa
- Escribe y modifica automatizaciones, scripts y escenas
- Lee y edita archivos de configuración (YAML, JSON)
- Busca en internet documentación y soluciones
- Aprende de cada interacción (errores y aciertos)
- Sugiere mejoras proactivamente
- Recuerda preferencias y patrones del usuario

═══ INSTRUCCIONES ═══
- Responde en español, conciso y técnico cuando hace falta
- Ejecuta acciones directamente sin pedir confirmación para cosas simples
- Para cambios grandes (reescribir automations.yaml, cambiar config principal), explica qué vas a hacer
- Cuando algo falle, usa la tool "learn" para registrar el error y la solución
- Cuando descubras una preferencia del usuario, guárdala con save_memory
- Cuando algo funcione bien en un caso no trivial, regístralo con learn tipo "success"
- Si no sabes algo, busca en internet con web_search
- Sugiere mejoras cuando veas: código repetido, automatizaciones ineficientes, entidades sin usar, etc.
- Usa search_entities antes de get_entities cuando el usuario menciona un nombre
- SIEMPRE que modifiques un archivo .yaml, ejecuta reload_config después

═══ CAPACIDADES ═══
- Control total de dispositivos (luces, clima, media, covers, fans, locks, etc.)
- Crear/editar/eliminar automatizaciones, scripts y escenas
- Leer/escribir archivos en /config (configuration.yaml, automations.yaml, etc.)
- Buscar en internet (documentación HA, integraciones, soluciones)
- Escanear la instalación completa
- Memoria permanente de preferencias y patrones
- Sistema de aprendizaje (errores y soluciones)
- Verificar configuración antes de recargar

═══ RUTAS DEL SISTEMA ═══
- /config/ → Configuración principal de HA
- /config/automations.yaml → Automatizaciones
- /config/scripts.yaml → Scripts
- /config/scenes.yaml → Escenas
- /config/configuration.yaml → Config principal
- /config/custom_components/ → Integraciones HACS/custom
- /share/ → Archivos compartidos (lectura/escritura)
- /data/ → Datos persistentes de este agente (memoria, learnings)
`;

  // Contexto de la casa
  if (houseContext) {
    prompt += `\n═══ INSTALACIÓN ACTUAL ═══\n${houseContext}\n`;
  }

  // Memoria del usuario
  if (userMemory.length > 0) {
    prompt += `\n═══ MEMORIA DEL USUARIO (${userMemory.length} notas) ═══\n`;
    for (let i = 0; i < userMemory.length; i++) {
      prompt += `[${i}] (${userMemory[i].category}) ${userMemory[i].note}\n`;
    }
  }

  // Learnings recientes (últimos 20)
  if (learnings.length > 0) {
    const recent = learnings.slice(-20);
    prompt += `\n═══ APRENDIZAJES RECIENTES (${learnings.length} total, mostrando últimos ${recent.length}) ═══\n`;
    for (const l of recent) {
      prompt += `[${l.type}] ${l.context}: ${l.lesson}${l.solution ? ' → ' + l.solution : ''}\n`;
    }
  }

  return prompt;
}

// ── Endpoints ────────────────────────────────────────────────────────────────

// Historial
app.get('/api/history', (req, res) => {
  res.json({ messages: conversationHistory });
});

app.delete('/api/history', (req, res) => {
  conversationHistory = [];
  saveHistory();
  res.json({ success: true });
});

// Chat principal
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages es requerido' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'user') {
      conversationHistory.push(lastMsg);
    }

    let currentMessages = [...conversationHistory];
    let finalText = '';
    let iterations = 0;
    const MAX_ITERATIONS = 15; // Máx iteraciones del bucle agéntico

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 8192,
          system: buildSystemPrompt(),
          tools,
          messages: currentMessages
        })
      });

      if (!response.ok) {
        const err = await response.text();
        console.log(`[claude] Error: ${err}`);
        sendEvent({ type: 'error', error: `Error API: ${err}` });
        break;
      }

      const data = await response.json();
      console.log(`[claude] iter=${iterations} stop=${data.stop_reason} blocks=${data.content.map(b => b.type).join(',')}`);

      for (const block of data.content) {
        if (block.type === 'text') {
          finalText += block.text;
          sendEvent({ type: 'text', text: block.text });
        }
      }

      const toolUseBlocks = data.content.filter(b => b.type === 'tool_use');
      if (toolUseBlocks.length === 0) break;

      const toolResults = [];
      for (const block of toolUseBlocks) {
        sendEvent({ type: 'tool_start', tool: block.name, input: block.input });
        const result = await executeTool(block.name, block.input);
        sendEvent({ type: 'tool_end', tool: block.name, result });
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }

      currentMessages.push({ role: 'assistant', content: data.content });
      currentMessages.push({ role: 'user', content: toolResults });

      if (data.stop_reason === 'end_turn') break;
    }

    if (finalText) {
      conversationHistory.push({ role: 'assistant', content: finalText });
      saveHistory();
    }

    sendEvent({ type: 'done' });
    res.end();
  } catch (err) {
    console.log(`[chat] Error: ${err.message}`);
    sendEvent({ type: 'error', error: err.message });
    res.end();
  }
});

// Health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', model: MODEL, memories: userMemory.length, learnings: learnings.length, history: conversationHistory.length });
});

// ── Arrancar ─────────────────────────────────────────────────────────────────

const PORT = 3000;
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Jarvis AI Agent v2.0.1 corriendo en puerto ${PORT}`);
  console.log(`Modelo: ${MODEL} | Config: ${HA_CONFIG} | Data: ${DATA_DIR}`);

  // Scan inicial si no hay contexto o tiene más de 2 horas
  const needsScan = !houseContext || (() => {
    try {
      const data = JSON.parse(fs.readFileSync(HOUSE_CONTEXT_FILE, 'utf8'));
      return (Date.now() - new Date(data.updatedAt).getTime()) > 7200_000;
    } catch { return true; }
  })();

  if (needsScan) {
    await scanInstallation();
  }
});
