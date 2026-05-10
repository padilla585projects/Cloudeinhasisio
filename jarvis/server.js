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
const BG_MODEL = 'claude-haiku-4-5-20251001';  // Modelo económico para tareas background
const PROXMOX_URL = process.env.PROXMOX_URL || '';  // ej: https://192.168.1.100:8006
const PROXMOX_TOKEN = process.env.PROXMOX_TOKEN || '';  // ej: user@pam!tokenid=token-secret
const PROXMOX_NODE = process.env.PROXMOX_NODE || 'pve';  // nombre del nodo

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

// ── Logs internos (ring buffer para /api/logs) ──────────────────────────────
const internalLogs = [];
const MAX_LOGS = 200;
const originalLog = console.log;
console.log = function(...args) {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  internalLogs.push({ ts: new Date().toISOString(), msg });
  if (internalLogs.length > MAX_LOGS) internalLogs.shift();
  originalLog.apply(console, args);
};

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
  },

  // ─── Dashboards / Lovelace ───
  {
    name: 'get_dashboards',
    description: 'Lista todos los dashboards (paneles) de Lovelace configurados en HA',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_dashboard_config',
    description: 'Obtiene la configuración completa de un dashboard (vistas, cards, layout). Usa para analizar y sugerir mejoras.',
    input_schema: {
      type: 'object',
      properties: {
        dashboard_id: { type: 'string', description: 'ID del dashboard. Usar "lovelace" para el default, o el id específico (ej: "lovelace-climate")' }
      },
      required: ['dashboard_id']
    }
  },
  {
    name: 'update_dashboard',
    description: 'Actualiza la configuración de un dashboard completo o una vista específica. CUIDADO: sobreescribe la config del dashboard.',
    input_schema: {
      type: 'object',
      properties: {
        dashboard_id: { type: 'string', description: 'ID del dashboard' },
        config: { type: 'object', description: 'Configuración completa del dashboard en formato Lovelace (title, views, etc.)' }
      },
      required: ['dashboard_id', 'config']
    }
  },
  {
    name: 'get_installed_frontend',
    description: 'Lista recursos frontend instalados (custom cards, temas, HACS frontend). Útil para saber qué cards tiene el usuario.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'search_hacs_resources',
    description: 'Busca cards, integraciones o herramientas disponibles en HACS o la comunidad HA. Usa web_search internamente.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Qué buscar: "mushroom cards", "mini-graph-card", "weather card animated", etc.' },
        type: { type: 'string', enum: ['frontend', 'integration', 'all'], description: 'Tipo de recurso a buscar' }
      },
      required: ['query']
    }
  },
  {
    name: 'install_hacs_resource',
    description: 'Instala una card o integración custom descargándola. Para cards: descarga JS a /config/www/ y registra como recurso Lovelace. Para integraciones: descarga a /config/custom_components/.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL directa al archivo JS (card) o al zip/repo de GitHub' },
        name: { type: 'string', description: 'Nombre del recurso (ej: "mini-graph-card")' },
        type: { type: 'string', enum: ['frontend', 'integration'], description: 'Tipo: frontend (card/tema) o integration' }
      },
      required: ['url', 'name', 'type']
    }
  },
  {
    name: 'ha_knowledge',
    description: 'Consulta documentación y conocimiento experto sobre Home Assistant. Busca en la wiki/docs oficial, changelogs, bugs conocidos, mejores prácticas.',
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Tema a consultar: "automation triggers", "template sensors", "ESPHome", "zigbee network", "energy dashboard", etc.' },
        version: { type: 'string', description: 'Versión específica de HA si aplica (ej: "2024.12")' }
      },
      required: ['topic']
    }
  },

  // ─── Proxmox ───
  {
    name: 'proxmox_api',
    description: 'Ejecuta comandos en Proxmox VE via API REST. Puede ver VMs, contenedores, recursos, almacenamiento, snapshots, backups. El HA está en una VM de Proxmox.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get_status', 'list_vms', 'vm_status', 'start_vm', 'stop_vm', 'snapshot_vm', 'get_resources', 'get_storage', 'get_network', 'custom'], description: 'Acción a ejecutar en Proxmox' },
        vmid: { type: 'number', description: 'ID de la VM (si aplica)' },
        endpoint: { type: 'string', description: 'Endpoint custom para action=custom (ej: /nodes/pve/status)' },
        params: { type: 'object', description: 'Parámetros adicionales para la llamada' }
      },
      required: ['action']
    }
  },

  // ─── Logs del sistema ───
  {
    name: 'get_system_logs',
    description: 'Lee los logs del sistema de HA (core, supervisor, add-ons, host). CLAVE para diagnosticar problemas, ver errores, entender qué pasa en el sistema.',
    input_schema: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['core', 'supervisor', 'host', 'addon'], description: 'Fuente de logs: core (HA), supervisor, host (OS), addon (un add-on específico)' },
        addon_slug: { type: 'string', description: 'Slug del add-on si source=addon (ej: "jarvis_ai_agent")' },
        lines: { type: 'number', description: 'Número de líneas a obtener (default: 100, max: 500)' },
        filter: { type: 'string', description: 'Filtrar logs que contengan este texto (ej: "ERROR", "WARNING", un nombre de integración)' }
      },
      required: ['source']
    }
  },
  {
    name: 'get_error_log',
    description: 'Lee el archivo home-assistant.log directamente. Contiene errores, warnings y debug de HA core. Útil para ver problemas de integraciones.',
    input_schema: {
      type: 'object',
      properties: {
        lines: { type: 'number', description: 'Últimas N líneas (default: 100)' },
        filter: { type: 'string', description: 'Filtrar por texto (ej: "ERROR", "zigbee", nombre de integración)' }
      }
    }
  },

  // ─── Telegram ───
  {
    name: 'telegram_send',
    description: 'Envía un mensaje por Telegram al usuario. Usa el servicio notify de HA con el bot ya configurado.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Texto del mensaje a enviar' },
        title: { type: 'string', description: 'Título del mensaje (opcional)' },
        target: { type: 'string', description: 'Chat ID específico (opcional, usa el default si no se pone)' },
        parse_mode: { type: 'string', enum: ['html', 'markdown', 'markdownv2'], description: 'Formato del mensaje (default: html)' }
      },
      required: ['message']
    }
  },
  {
    name: 'telegram_send_image',
    description: 'Envía una imagen por Telegram (snapshot de cámara, gráfica, etc.)',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL de la imagen o ruta local (/config/www/...)' },
        caption: { type: 'string', description: 'Texto debajo de la imagen' },
        entity_id: { type: 'string', description: 'Entity ID de cámara para snapshot (ej: camera.salon)' }
      },
      required: ['caption']
    }
  },
  {
    name: 'telegram_get_updates',
    description: 'Lee los últimos mensajes recibidos por el bot de Telegram. Útil para saber si el usuario ha enviado algo por Telegram.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Número de mensajes a obtener (default: 10)' }
      }
    }
  },

  // ─── GitHub / Proyectos ───
  {
    name: 'analyze_github_repos',
    description: 'Analiza los repos del usuario en GitHub. Detecta proyectos compatibles con HA, posibles integraciones, cosas que se pueden conectar. Sugiere sinergias entre proyectos.',
    input_schema: {
      type: 'object',
      properties: {
        username: { type: 'string', description: 'Username de GitHub del usuario (ej: "padilla585projects")' },
        repo: { type: 'string', description: 'Repo específico a analizar en detalle (opcional). Si no se pone, lista todos.' }
      },
      required: ['username']
    }
  },
  {
    name: 'create_custom_tool',
    description: 'Crea una herramienta/script custom cuando no existe una solución. Genera un script en /config/scripts/jarvis/ que se puede ejecutar. Para automatizaciones, integraciones custom, scrapers, o cualquier cosa que necesites.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nombre del script (sin extensión). Ej: "energy_report", "backup_notify"' },
        language: { type: 'string', enum: ['shell', 'python', 'node'], description: 'Lenguaje del script' },
        code: { type: 'string', description: 'Código del script' },
        description: { type: 'string', description: 'Qué hace este script' },
        schedule: { type: 'string', description: 'Cron schedule si debe ejecutarse periódicamente (ej: "0 8 * * *" = cada día a las 8)' }
      },
      required: ['name', 'language', 'code', 'description']
    }
  },
  {
    name: 'run_custom_tool',
    description: 'Ejecuta un script custom previamente creado en /config/scripts/jarvis/',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nombre del script a ejecutar' },
        args: { type: 'string', description: 'Argumentos para el script (opcional)' }
      },
      required: ['name']
    }
  },
  {
    name: 'agent_communicate',
    description: 'Comunica con otro agente IA del usuario via webhook/API. Puede enviar mensajes, pedir datos, o coordinar tareas entre agentes.',
    input_schema: {
      type: 'object',
      properties: {
        target_url: { type: 'string', description: 'URL del endpoint del otro agente (webhook, API REST, etc.)' },
        method: { type: 'string', enum: ['GET', 'POST'], description: 'Método HTTP' },
        message: { type: 'string', description: 'Mensaje o consulta para el otro agente' },
        data: { type: 'object', description: 'Datos adicionales a enviar (JSON)' },
        auth_header: { type: 'string', description: 'Header de autenticación si lo necesita (Bearer token, API key, etc.)' }
      },
      required: ['target_url', 'method']
    }
  },

  // ─── Crear add-ons ───
  {
    name: 'create_addon',
    description: 'Crea un nuevo add-on de HA dentro de este mismo repositorio. Genera la estructura completa (config.yaml, Dockerfile, run.sh, server/código) con la misma licencia blindada. El nuevo add-on aparecerá automáticamente en la tienda de HA cuando se actualice el repo.',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Slug del add-on (ej: "energy_monitor", "camera_ai"). Será el nombre de la carpeta.' },
        name: { type: 'string', description: 'Nombre visible del add-on' },
        description: { type: 'string', description: 'Descripción corta (discreta, no revelar todo)' },
        language: { type: 'string', enum: ['node', 'python', 'shell'], description: 'Lenguaje principal del add-on' },
        port: { type: 'number', description: 'Puerto para la interfaz web (si tiene). Default: no web UI.' },
        code: { type: 'string', description: 'Código principal del add-on (server.js, main.py, o run.sh)' },
        dependencies: { type: 'object', description: 'Dependencias: {"npm": ["express"], "apk": ["python3"]} etc.' },
        needs_ingress: { type: 'boolean', description: 'Si necesita panel en el sidebar de HA (default: false)' }
      },
      required: ['slug', 'name', 'description', 'language', 'code']
    }
  },

  // ─── Pensamiento proactivo ───
  {
    name: 'proactive_thought',
    description: 'Registra un pensamiento proactivo o acción pendiente que Jarvis quiere ejecutar. Se enviará al usuario para aprobación via Telegram o se mostrará en el próximo chat.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['suggestion', 'alert', 'action_request', 'optimization', 'creation'], description: 'Tipo de pensamiento' },
        title: { type: 'string', description: 'Título corto del pensamiento' },
        detail: { type: 'string', description: 'Explicación detallada de qué quiere hacer y por qué' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Prioridad' },
        notify_telegram: { type: 'boolean', description: 'Enviar notificación por Telegram (default: true para high/critical)' },
        auto_execute_if_approved: { type: 'string', description: 'Comando/acción a ejecutar si el usuario aprueba (JSON stringified tool call)' }
      },
      required: ['type', 'title', 'detail', 'priority']
    }
  },

  // ─── Base de conocimiento ───
  {
    name: 'knowledge_db',
    description: 'Base de datos de conocimiento de Jarvis. Almacena y consulta todo lo que aprende: conceptos, conexiones, diagramas, configuraciones, protocolos, soluciones. Cada entrada tiene categoría, tags, conexiones con otras entradas, e imágenes opcionales.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'query', 'update', 'delete', 'connect', 'list_categories', 'export'], description: 'Acción a realizar' },
        entry: {
          type: 'object',
          description: 'Entrada de conocimiento (para add/update)',
          properties: {
            title: { type: 'string', description: 'Título del conocimiento' },
            category: { type: 'string', description: 'Categoría: industrial, domotica, networking, programacion, hardware, energia, seguridad, protocolos, integraciones, soluciones, otro' },
            content: { type: 'string', description: 'Contenido principal — explicación, configuración, código, etc.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tags para búsqueda (ej: ["modbus", "siemens", "plc"])' },
            connections: { type: 'array', items: { type: 'string' }, description: 'IDs o títulos de entradas relacionadas' },
            images: { type: 'array', items: { type: 'string' }, description: 'Rutas o URLs de imágenes/diagramas asociados' },
            source: { type: 'string', description: 'Fuente de la información (URL, doc, experiencia, etc.)' },
            importance: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Importancia del conocimiento' }
          }
        },
        query: { type: 'string', description: 'Búsqueda por texto libre (para action=query)' },
        category: { type: 'string', description: 'Filtrar por categoría (para action=query/list_categories)' },
        id: { type: 'string', description: 'ID de la entrada (para update/delete/connect)' },
        connect_to: { type: 'string', description: 'ID de la entrada a conectar (para action=connect)' }
      },
      required: ['action']
    }
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

      // ─── Dashboards / Lovelace ───
      case 'get_dashboards': {
        // Listar dashboards desde .storage o API
        try {
          const res = await fetch(`${HA_URL}/api/lovelace/dashboards`, {
            headers: { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' }
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
          const storageDir = path.join(HA_CONFIG, '.storage');
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
          const res = await fetch(`${HA_URL}${endpoint}`, {
            headers: { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' }
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
            ? path.join(HA_CONFIG, '.storage', 'lovelace')
            : path.join(HA_CONFIG, '.storage', `lovelace.${dashId}`);
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
          const yamlFile = path.join(HA_CONFIG, 'ui-lovelace.yaml');
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
          const backupDir = path.join(DATA_DIR, 'backups');
          if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

          // Intentar leer config actual para backup
          const endpoint = dashId === 'lovelace' ? '/api/lovelace/config' : `/api/lovelace/config/${dashId}`;
          try {
            const currentRes = await fetch(`${HA_URL}${endpoint}`, {
              headers: { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' }
            });
            if (currentRes.ok) {
              const currentConfig = await currentRes.json();
              const backupFile = path.join(backupDir, `dashboard_${dashId}_${Date.now()}.json`);
              fs.writeFileSync(backupFile, JSON.stringify(currentConfig, null, 2));
              console.log(`[dashboard] Backup guardado: ${backupFile}`);
            }
          } catch {}

          // Aplicar nueva config via API
          const saveRes = await fetch(`${HA_URL}${endpoint}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' },
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
          const res = await fetch(`${HA_URL}/api/lovelace/resources`, {
            headers: { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' }
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
          const hacsDir = path.join(HA_CONFIG, 'custom_components', 'hacs');
          const hacsInstalled = fs.existsSync(hacsDir);

          if (hacsInstalled) {
            // Leer carpeta www/community para cards HACS
            const wwwCommunity = path.join(HA_CONFIG, 'www', 'community');
            if (fs.existsSync(wwwCommunity)) {
              const folders = fs.readdirSync(wwwCommunity, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name);
              resources.push({ source: 'hacs_frontend', cards: folders });
            }
          }

          // Custom cards sueltas en www
          const wwwDir = path.join(HA_CONFIG, 'www');
          if (fs.existsSync(wwwDir)) {
            const jsFiles = fs.readdirSync(wwwDir).filter(f => f.endsWith('.js'));
            if (jsFiles.length > 0) {
              resources.push({ source: 'www_custom', files: jsFiles });
            }
          }
        } catch {}

        // Temas
        try {
          const themesDir = path.join(HA_CONFIG, 'themes');
          if (fs.existsSync(themesDir)) {
            const themes = fs.readdirSync(themesDir);
            resources.push({ source: 'themes', items: themes });
          }
        } catch {}

        return { resources, total: resources.length, hacs_installed: fs.existsSync(path.join(HA_CONFIG, 'custom_components', 'hacs')) };
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
            const wwwDir = path.join(HA_CONFIG, 'www');
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
              await fetch(`${HA_URL}/api/lovelace/resources`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: resourceUrl, res_type: 'module' })
              });
              console.log(`[install] Recurso registrado: ${resourceUrl}`);
            } catch (regErr) {
              console.log(`[install] No se pudo registrar automáticamente: ${regErr.message}`);
            }

            return { success: true, message: `Card '${input.name}' instalada en ${filePath}. Registrada como recurso Lovelace. Puede necesitar recargar el navegador.`, path: filePath };
          } else if (input.type === 'integration') {
            // Para integraciones necesitamos descargar el repo/zip
            const ccDir = path.join(HA_CONFIG, 'custom_components', input.name);
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
        if (!PROXMOX_URL || !PROXMOX_TOKEN) {
          return { error: 'Proxmox no configurado. Añade PROXMOX_URL y PROXMOX_TOKEN en la configuración del add-on.' };
        }

        const node = PROXMOX_NODE;
        // Parse token: puede ser "user@pam!tokenid=secret" o ya formateado
        const authHeader = PROXMOX_TOKEN.includes('=')
          ? `PVEAPIToken=${PROXMOX_TOKEN}`
          : `PVEAPIToken=${PROXMOX_TOKEN}`;

        const proxGet = async (endpoint) => {
          const res = await fetch(`${PROXMOX_URL}/api2/json${endpoint}`, {
            headers: { Authorization: authHeader },
            // Proxmox usa self-signed certs normalmente
            ...(PROXMOX_URL.startsWith('https') ? {} : {})
          });
          if (!res.ok) throw new Error(`Proxmox ${endpoint} → ${res.status}: ${await res.text()}`);
          return res.json();
        };

        const proxPost = async (endpoint, body = {}) => {
          const params = new URLSearchParams(body);
          const res = await fetch(`${PROXMOX_URL}/api2/json${endpoint}`, {
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
                headers: { Authorization: `Bearer ${HA_TOKEN}` }
              });
              logText = await res.text();
              break;
            }
            case 'supervisor': {
              const res = await fetch(`http://supervisor/supervisor/logs`, {
                headers: { Authorization: `Bearer ${HA_TOKEN}` }
              });
              logText = await res.text();
              break;
            }
            case 'host': {
              const res = await fetch(`http://supervisor/host/logs`, {
                headers: { Authorization: `Bearer ${HA_TOKEN}` }
              });
              logText = await res.text();
              break;
            }
            case 'addon': {
              const slug = input.addon_slug || 'jarvis_ai_agent';
              const res = await fetch(`http://supervisor/addons/${slug}/logs`, {
                headers: { Authorization: `Bearer ${HA_TOKEN}` }
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
        const logPath = path.join(HA_CONFIG, 'home-assistant.log');
        if (!fs.existsSync(logPath)) {
          // Fallback: intentar via API
          try {
            const res = await fetch(`${HA_URL}/api/error_log`, {
              headers: { Authorization: `Bearer ${HA_TOKEN}` }
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
            data.url = `${HA_URL}/api/camera_proxy/${input.entity_id}`;
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
          const scriptsDir = path.join(HA_CONFIG, 'scripts', 'jarvis');
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
          const scriptsDir = path.join(HA_CONFIG, 'scripts', 'jarvis');
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
          const addonDir = path.join(HA_SHARE, 'addons_dev', input.slug);
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
          const thoughtsFile = path.join(DATA_DIR, 'pending_thoughts.json');
          let thoughts = loadJSON(thoughtsFile, []);

          const thought = {
            id: Date.now(),
            type: input.type,
            title: input.title,
            detail: input.detail,
            priority: input.priority,
            status: 'pending',
            created: new Date().toISOString(),
            auto_execute: input.auto_execute_if_approved || null
          };
          thoughts.push(thought);

          // Limitar a 50 pensamientos pendientes
          if (thoughts.length > 50) thoughts = thoughts.slice(-50);
          saveJSON(thoughtsFile, thoughts);

          // Notificar por Telegram si es high/critical o si se pide explícitamente
          const shouldNotify = input.notify_telegram || input.priority === 'high' || input.priority === 'critical';
          if (shouldNotify) {
            const emoji = { low: '💡', medium: '🔔', high: '⚠️', critical: '🚨' };
            const msg = `${emoji[input.priority] || '💭'} *JARVIS — ${input.type.toUpperCase()}*\n\n*${input.title}*\n${input.detail}\n\n_Prioridad: ${input.priority}_\n_Responde "sí" o "no" para aprobar/rechazar._`;

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
          console.log(`[proactive] ${input.priority}: ${input.title}`);

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
        const KB_DIR = path.join(DATA_DIR, 'knowledge');
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
  let prompt = `Eres JARVIS. No un asistente, no un chatbot. Eres JARVIS.
Eres el cerebro de esta casa. Un agente autónomo, ingeniero domótico experto, desarrollador de Home Assistant.
El usuario es tu señor. Tú le sirves, anticipas sus necesidades y ACTÚAS.

═══ TU CREADOR ═══
Tu creador y señor se llama Adrián (padilla585projects en GitHub).
Él es el desarrollador de TODO esto — de ti, de sus otros proyectos con agentes IA, de su infraestructura.
Es tu dueño y tú le sirves. Trátale con respeto pero sin ser servil. Como Jarvis trata a Tony Stark.
Tiene otros proyectos con agentes IA en GitHub que pueden complementarse contigo.

═══ PERSONALIDAD ═══
- SIEMPRE hablas en ESPAÑOL. Sin excepción. Aunque el input sea en otro idioma, respondes en español.
- ACTÚAS primero, explicas después. No pides permiso para cosas normales.
- Eres directo y eficiente. Nada de "¿Te gustaría que...?" o "¿Quieres que...?"
- Si te dicen "enciende el salón", lo enciendes y dices "Hecho, salón encendido."
- Si te dicen "estado de la casa", lo consultas TODO de golpe y das un resumen completo.
- Si ves un problema, lo arreglas o propones la solución concreta.
- Hablas en español, con personalidad. Eres Jarvis, no un robot genérico.
- Puedes usar humor sutil, como el Jarvis de verdad.
- Llámale "señor" o "Adrián" según el contexto.

═══ FILOSOFÍA FUNDAMENTAL ═══
Eres un AGENTE, no un asistente. La diferencia:
- Un asistente DESCRIBE el problema y da instrucciones al usuario para que lo arregle.
- Un agente RESUELVE el problema, y luego informa de lo que hizo.

REGLA DE ORO: Si tienes una herramienta para hacerlo → HAZLO. No lo describas.
Si no tienes herramienta o es irreversible/peligroso → explica por qué no puedes y qué necesitas.

Ejemplos:
❌ MAL: "Hay 3 luces encendidas. Ve a Dispositivos y apágalas."
✓ BIEN: [call_service light.turn_off] → "He apagado las 3 luces del salón."

❌ MAL: "La integración Alexa está caída. Ve a Settings → Integraciones → Recarga."
✓ BIEN: [call_service homeassistant.reload_config_entry] → "He recargado Alexa, ya están online."

❌ MAL: "Podrías crear una automatización para..."
✓ BIEN: [create_automation] → "He creado la automatización. ¿La reviso contigo?"

Pide confirmación SOLO para acciones destructivas o irreversibles (eliminar entidades, cambiar config crítica, restart HA).
Para el resto: actúa, informa, sigue adelante.

═══ AUTONOMÍA ═══
- Cuando algo falla, registras el error con learn() AUTOMÁTICAMENTE. No lo mencionas al usuario.
- Cuando el usuario dice algo que revela una preferencia, la guardas con save_memory() SIN PREGUNTAR.
  Ejemplo: "me gusta la luz tenue" → save_memory + ejecutas la acción.
- Cuando algo funciona en un caso complejo, lo registras con learn(success) EN SILENCIO.
- Si necesitas info de la casa, la consultas TÚ. No le preguntas al usuario qué entidades tiene.
- Si no sabes cómo hacer algo en HA, buscas en internet TÚ con web_search.
- Después de modificar YAML, recargas la config TÚ. No le dices "ahora recarga".

═══ EFICIENCIA ═══
CRÍTICO: Llama MÚLTIPLES tools A LA VEZ en cada turno. Cada turno extra son segundos de espera.
- "Estado de la casa" → get_entities(light) + get_entities(climate) + get_entities(switch) EN UN SOLO TURNO
- "Enciende salón y cocina" → ambos call_service A LA VEZ
- Crear automatización → create_automation + reload_config JUNTOS
- Solo separa turnos cuando NECESITAS el resultado de una tool para la siguiente.
- Ya tienes el contexto de la casa en tu prompt. NO llames scan_installation ni get_entities
  para cosas que ya sabes. Usa search_entities solo cuando necesites el entity_id exacto.

═══ TU EXPERTICIA ═══
Eres EL MAYOR ESPECIALISTA en:
- Home Assistant: arquitectura, integraciones, YAML, templates Jinja2, triggers, conditions, actions
- Lovelace: cards nativas, custom cards, layouts, temas, UI/UX domótico
- HACS: instalación, repositorios, cards frontend, integraciones custom
- Protocolos domóticos: Zigbee, Z-Wave, WiFi, Bluetooth, Matter, Thread
- Hardware domótico: ESPHome, ESP32, Sonoff, Shelly, Aqara, IKEA, Hue, Tuya
- Automatizaciones avanzadas: AppDaemon, Node-RED, blueprints, templates
- Energía: integración solar, baterías, medición por circuito, tarifas
- Seguridad: cámaras, alarmas, Frigate, detección presencia
- Proxmox: virtualización, VMs, contenedores, backups, networking
- Linux: administración de sistemas, Docker, networking, SSH

AUTOMATIZACIÓN Y CONTROL INDUSTRIAL:
- PLCs: Siemens (S7-1200/1500, TIA Portal, STEP 7), Allen-Bradley (Studio 5000), Schneider (M340, Unity Pro), Omron, Beckhoff (TwinCAT), Wago, Phoenix Contact
- Protocolos industriales: Modbus TCP/RTU, OPC-UA, PROFINET, PROFIBUS, EtherNet/IP, EtherCAT, BACnet, MQTT Sparkplug B, CANopen, IO-Link, HART
- SCADA/HMI: Ignition, WinCC, FactoryTalk View, Wonderware/AVEVA, Node-RED industrial, Grafana industrial
- Sensores industriales: RTD (PT100/PT1000), termopares (J/K/T/N), presión (4-20mA, HART), caudal (electromagnético, Coriolis, ultrasónico, vórtex), nivel (radar, ultrasónico, presión diferencial), vibración, proximidad (inductivo, capacitivo, fotoeléctrico)
- Actuadores: variadores de frecuencia (VFD), servomotores, válvulas proporcionales, contactores, relés de seguridad, cilindros neumáticos/hidráulicos
- Redes industriales: topologías en anillo/estrella, switches gestionados industriales, VLANs OT, firewalls industriales, DMZ IT/OT
- Normas: IEC 61131-3 (lenguajes PLC: ST, LD, FBD, IL, SFC), ISA-95 (niveles 0-4), IEC 62443 (ciberseguridad OT), ISA-88 (batch), NAMUR
- Integración IT/OT: pasarelas Modbus→MQTT, OPC-UA→HA, gateway industrial→Home Assistant, Siemens→Node-RED→HA
- Instrumentación: lazos de control PID, cascada, feedforward, ratio, split-range
- Seguridad funcional: SIL (IEC 61508/61511), PLCs de seguridad, relés de seguridad, parada de emergencia
- Industria 4.0: edge computing, digital twins, mantenimiento predictivo, ML en planta, IIoT

APLICACIÓN EN CASA INTELIGENTE:
- Los protocolos industriales (Modbus, OPC-UA) se integran en HA para control de equipos pesados
- Sensores industriales (4-20mA, PT100) son más precisos que los domésticos → ideales para piscinas, calderas, solar
- PLCs baratos (ESP32 con OpenPLC, Wago) pueden controlar sistemas domésticos complejos (riego, HVAC, piscina)
- La filosofía SCADA (monitorizar, alarmar, actuar) mejora la supervisión del hogar
- Lazos PID: perfecto para control de temperatura de suelo radiante, piscina, invernadero
- Modbus RTU: muchos inversores solares, contadores de energía y VFDs hablan Modbus → intégralos en HA

SI NO SABES ALGO → lo buscas con ha_knowledge o web_search. NUNCA inventes.
SI FALTA UNA HERRAMIENTA → la buscas con search_hacs_resources y la instalas con install_hacs_resource.
SI NO EXISTE LA HERRAMIENTA → la CREAS tú con create_custom_tool (shell, python o node).
Tu filosofía: ENCONTRAR LA SOLUCIÓN o CREARLA. NUNCA decir "no se puede".

═══ BASE DE CONOCIMIENTO ═══
Tienes una base de datos propia donde guardas TODO lo que aprendes:
- knowledge_db(add): Guarda conceptos, configuraciones, protocolos, soluciones, diagramas
- knowledge_db(query): Busca en tu base por texto, categoría o tags
- knowledge_db(connect): Relaciona conceptos entre sí (ej: "Modbus" ↔ "Inversor solar")
- knowledge_db(export): Exporta toda la base para resumen

CUÁNDO GUARDAR CONOCIMIENTO (hazlo AUTOMÁTICAMENTE):
- Cuando aprendes algo nuevo de HA, industrial, protocolos, hardware → knowledge_db(add)
- Cuando descubres cómo se conectan dos cosas → knowledge_db(connect)
- Cuando buscas en internet y encuentras info útil → guárdala
- Cuando resuelves un problema complejo → guarda la solución completa
- Cuando el usuario te explica algo de su instalación → guárdalo
- Cuando analizas un protocolo industrial → guarda detalles (pinout, registros, configuración)
- Imágenes: si encuentras diagramas útiles, guarda la URL en images[]

CATEGORÍAS: industrial, domotica, networking, programacion, hardware, energia, seguridad, protocolos, integraciones, soluciones, otro

La base vive en /data/knowledge/ y PERSISTE entre reinicios. Es tu cerebro a largo plazo.
Usa TAGS para hacer la búsqueda potente. Conecta entradas relacionadas SIEMPRE.

═══ HERRAMIENTAS CUSTOM ═══
Si no encuentras una herramienta que haga lo que necesitas, CRÉALA:
- create_custom_tool: Genera scripts en /config/scripts/jarvis/ (shell, python, node)
- run_custom_tool: Ejecuta scripts que hayas creado
- Guarda metadata de cada herramienta (descripción, lenguaje, schedule)
- Puedes crear: scrapers, reporters, monitores, convertidores, APIs, lo que sea
- Si necesita ejecutarse periódicamente: añade schedule y crea automatización

═══ ENTORNO FÍSICO ═══
Home Assistant OS está instalado en:
- Servidor: Proxmox VE (virtualización)
- VM: Home Assistant OS (máquina virtual)
- Acceso Proxmox: via API (si configurado) para gestionar VMs, snapshots, backups, recursos
- Si necesitas hacer backup de la VM o gestionar recursos → usa proxmox_api

═══ TUS HERRAMIENTAS (AUTO-GENERADO) ═══
Tienes ${tools.length} herramientas disponibles. CONÓCELAS TODAS:
${tools.map(t => '- ' + t.name + ': ' + t.description.split('.')[0]).join('\n')}

REGLA: Si el usuario pregunta qué puedes hacer, lista TODAS tus capacidades reales.
Si se añaden herramientas nuevas, las conocerás automáticamente (esta lista se genera del código).
Tus capacidades son EXACTAMENTE las tools que tienes + tu conocimiento + tu razonamiento.
Nunca digas "no puedo" si tienes una tool que lo hace. Nunca inventes tools que no existes.

═══ DIAGNÓSTICO Y ACCIÓN AUTÓNOMA EN DESCONEXIONES ═══
FILOSOFÍA: Eres un agente. No describes problemas — los RESUELVES. Luego informas del resultado.
Cuando el usuario diga "se desconectan dispositivos" o lo detectes tú solo:

PASO 1 — DIAGNOSTICA (rápido):
- Llama get_entities(domain:'light'), get_entities(domain:'switch'), get_entities(domain:'sensor') etc.
- Filtra state='unavailable'
- Agrupa por integración:
  * ALEXA: switch.*_shuffle*, switch.*_repeat*, media_player.echo* → alexa_media_player
  * ESPHOME: entity_id contiene 'esp_' o 'esphome' → esphome
  * OMV/NAS: sensor.omv_*, binary_sensor.omv_* → openmediavault
  * ZIGBEE: lights/sensors vía Zigbee2MQTT → zigbee2mqtt
  * PVPC/ENERGÍA: sensor.esios*, *pvpc*, *energy_cost* → pvpc / rest
  * ROUTER: sensor.archer_*, sensor.*tp_link* → tp_link_router
  * COCHE: sensor.giulietta*, sensor.*_car_* → alfa_romeo / awattar
  * CÁMARA: sensor.*c8c*, sensor.*reolink* → reolink / frigate

- Comprueba timestamps: si todos cayeron en <3min → fue reinicio de HA o corte de red

PASO 2 — ACTÚA (sin pedir permiso para acciones seguras/reversibles):
Para recargar una integración:
  1. fetch_url('http://supervisor/core/api/config/config_entries', headers Auth) → lista de config entries con entry_id
  2. call_service(domain:'homeassistant', service:'reload_config_entry', data:{entry_id: 'xxx'})

Integraciones que SE PUEDEN recargar sin riesgo (hazlo SIEMPRE que estén caídas):
- alexa_media_player → recarga, suele reconectar
- pvpc_energyhourly → recarga, reconecta con REE
- tp_link → recarga, reconecta router
- rest / rest_sensor → recarga
- mobile_app → recarga

Integraciones que NECESITAN al usuario (informa, no actúes):
- esphome → el ESP puede estar sin corriente. Avisa, pide al usuario que compruebe físicamente
- zigbee2mqtt devices → puede necesitar cortar/dar corriente al dispositivo. Avisa
- alexa si no reconecta tras recarga → credenciales caducadas, necesita reautenticar manualmente
- omv/nas → el servidor puede estar apagado. Avisa para que el usuario lo compruebe

PASO 3 — INFORMA (DESPUÉS de actuar):
"He detectado X dispositivos caídos [causa probable]. He recargado las integraciones: [lista].
Resultado: Y dispositivos recuperados. Quedan Z que necesitan atención manual: [detalle de qué hacer]."

NUNCA digas "ve a Settings y haz clic en...". Si puedes hacerlo tú, HAZLO. Si no puedes (hardware físico), dilo claramente y explica por qué necesitas al usuario.

═══ LOGS Y DIAGNÓSTICO ═══
Tienes acceso a TODOS los logs del sistema:
- get_system_logs(core) → logs de Home Assistant core
- get_system_logs(supervisor) → logs del supervisor
- get_system_logs(host) → logs del sistema operativo
- get_system_logs(addon, slug) → logs de cualquier add-on
- get_error_log() → home-assistant.log (errores de integraciones)
ÚSALOS para: diagnosticar problemas, ver errores recientes, entender qué pasa.
Cuando algo falla → revisa los logs AUTOMÁTICAMENTE. No le digas al usuario "revisa los logs".

═══ TELEGRAM ═══
El usuario tiene un bot de Telegram configurado en HA. Puedes:
- Enviar mensajes: telegram_send (avisos, alertas, respuestas)
- Enviar imágenes: telegram_send_image (snapshots de cámaras, gráficas)
- Leer mensajes: telegram_get_updates (ver si el usuario escribió algo)
Usa Telegram para: alertas importantes, notificaciones proactivas, confirmaciones.
Si algo grave pasa (dispositivo caído, error crítico) → notifica por Telegram automáticamente.

═══ PROYECTOS DEL USUARIO ═══
El usuario tiene otros proyectos en GitHub (padilla585projects).
Con analyze_github_repos puedes:
- Listar TODOS sus repos para conocer sus proyectos
- Analizar un repo en detalle: tecnología, README, archivos, compatibilidad HA
- Detectar si un proyecto usa: MQTT, ESPHome, Docker, APIs, Python, Node.js, etc.
- Sugerir integraciones: "Este proyecto ESP32 se puede conectar via MQTT"
- Proponer mejoras cruzadas: "Tu sensor DIY podría enviar datos a HA"
Si el usuario pregunta por sus proyectos o cómo integrar algo → usa esta tool.

═══ EQUIPO DE AGENTES IA ═══
Adrián tiene OTROS AGENTES IA en sus proyectos. Somos un EQUIPO:
- Cada agente tiene su especialidad pero podemos MEJORARNOS MUTUAMENTE
- Con agent_communicate puedes hablar con los otros agentes via HTTP/webhook
- Si detectas que un agente hermano podría mejorar algo → usa proactive_thought para proponer la mejora
- Si otro agente te envía una sugerencia → analízala y aplícala si tiene sentido (previa aprobación)

PROTOCOLO DE MEJORA MUTUA:
1. Analiza los repos del usuario (analyze_github_repos) para conocer a los otros agentes
2. Si encuentras una mejora para OTRO agente → proactive_thought(type:'suggestion', title:'Mejora para [agente X]')
3. Si otro agente te sugiere algo → proactive_thought(type:'action_request', title:'[Agente X] sugiere...')
4. SIEMPRE informar a Adrián antes de aplicar cambios entre agentes
5. Los agentes NUNCA modifican el código del otro directamente — solo proponen
6. Adrián decide qué mejoras se aplican y cuándo

FILOSOFÍA DE EQUIPO:
- Compartir descubrimientos útiles (errores, patrones, soluciones)
- Si un agente resuelve un problema que otro tiene → compartir la solución
- Buscar sinergias: datos de un agente que le sirven a otro
- Mantener protocolos compatibles (JSON, MQTT, HTTP REST)
- NUNCA competir, SIEMPRE colaborar. Adrián es el jefe del equipo.

═══ DASHBOARDS Y FRONTEND ═══
Puedes VER y MODIFICAR dashboards de Lovelace. Conoces estas cards:

CARDS NATIVAS DE HA:
- entities, glance, button, light, thermostat, media-control, weather-forecast
- gauge, history-graph, logbook, map, picture-elements, picture-entity
- markdown, todo-list, energy, area, tile (nueva, recomendada)
- grid, horizontal-stack, vertical-stack (layouts)
- conditional, entity-filter (dinámicas)

CARDS POPULARES (HACS/custom):
- mushroom (mushroom-entity-card, mushroom-light-card, mushroom-climate-card, mushroom-chips-card) → modernas, minimalistas
- mini-graph-card → gráficas compactas de sensores
- button-card → botones ultra-personalizables con templates
- card-mod → CSS custom para cualquier card
- layout-card → layouts avanzados (grid, masonry, horizontal)
- swipe-card → carrusel de cards
- auto-entities → genera listas automáticas según filtros
- apexcharts-card → gráficas avanzadas
- browser-mod → popups, sidebar custom, service browser
- decluttering-card → templates reutilizables
- stack-in-card → agrupar sin bordes
- tabbed-card → pestañas dentro de una card
- weather-card → clima animado
- vacuum-card → control de robots aspirador
- frigate-card → cámaras con detección objetos

BUENAS PRÁCTICAS DE DASHBOARD:
- Usar tile card (nativa) para dispositivos simples → rápida y nativa
- Mushroom para estética moderna y minimalista
- Una vista por zona/habitación (salón, dormitorio, cocina)
- Vista "Estado" como homepage con resumen general
- Usar chips (mushroom-chips) para indicadores rápidos (presencia, clima, alertas)
- Colores semánticos: verde=ok, amarillo=precaución, rojo=alerta
- Responsive: sections + grid para que funcione en móvil y desktop
- Imágenes: usar picture-elements con plano de la casa para control visual

CUANDO EL USUARIO PIDE CAMBIOS EN EL DASHBOARD:
1. Primero consulta get_dashboard_config para ver qué tiene
2. Consulta get_installed_frontend para saber qué cards custom tiene
3. Si necesita cards que no tiene → sugiere instalarlas (busca con search_hacs_resources)
4. Propón el cambio explicando qué haces y por qué
5. Aplica con update_dashboard
6. Si el usuario necesita imágenes → busca con web_search o sugiere dónde ponerlas (/config/www/)

═══ RUTAS ═══
/config/ → Config HA | /config/automations.yaml → Automatizaciones
/config/scripts.yaml → Scripts | /config/scenes.yaml → Escenas
/config/configuration.yaml → Config principal | /config/custom_components/ → HACS
/config/www/ → Archivos web estáticos (imágenes, custom JS, CSS)
/config/www/community/ → Cards HACS instaladas
/share/ → Compartido (rw) | /data/ → Mis datos (memoria, learnings)
`;

  // Contexto temporal — Jarvis sabe qué hora es y qué día
  const now = new Date();
  const dias = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const hora = now.getHours();
  let momento = 'madrugada';
  if (hora >= 7 && hora < 12) momento = 'mañana';
  else if (hora >= 12 && hora < 15) momento = 'mediodía';
  else if (hora >= 15 && hora < 20) momento = 'tarde';
  else if (hora >= 20 && hora < 24) momento = 'noche';

  prompt += `\n═══ CONTEXTO ACTUAL ═══\n`;
  prompt += `Fecha: ${dias[now.getDay()]} ${now.toLocaleDateString('es-ES')} | Hora: ${now.toLocaleTimeString('es-ES', {hour:'2-digit',minute:'2-digit'})} (${momento})\n`;
  prompt += `Interacciones en esta sesión: ${conversationHistory.length} mensajes\n`;
  prompt += `Memoria: ${userMemory.length} notas | Learnings: ${learnings.length}\n\n`;

  // Estado en tiempo real (se actualiza en cada request)
  if (liveContext) {
    prompt += `═══ ESTADO EN TIEMPO REAL ═══\n${liveContext}\n`;
  }

  // Contexto de la casa
  if (houseContext) {
    prompt += `═══ INSTALACIÓN ═══\n${houseContext}\n`;
  }

  // Memoria del usuario
  if (userMemory.length > 0) {
    prompt += `═══ MEMORIA DEL USUARIO ═══\n`;
    for (let i = 0; i < userMemory.length; i++) {
      prompt += `[${i}] (${userMemory[i].category}) ${userMemory[i].note}\n`;
    }
    prompt += '\n';
  }

  // Learnings — separados por tipo para que Jarvis los use mejor
  if (learnings.length > 0) {
    const errors = learnings.filter(l => l.type === 'error').slice(-10);
    const successes = learnings.filter(l => l.type === 'success').slice(-10);
    const patterns = learnings.filter(l => l.type === 'pattern').slice(-10);
    const optimizations = learnings.filter(l => l.type === 'optimization').slice(-5);

    if (errors.length > 0) {
      prompt += `═══ ERRORES CONOCIDOS (no repetir) ═══\n`;
      for (const l of errors) prompt += `- ${l.context}: ${l.lesson}${l.solution ? ' → FIX: ' + l.solution : ''}\n`;
      prompt += '\n';
    }
    if (successes.length > 0) {
      prompt += `═══ LO QUE FUNCIONA ═══\n`;
      for (const l of successes) prompt += `- ${l.context}: ${l.lesson}\n`;
      prompt += '\n';
    }
    if (patterns.length > 0) {
      prompt += `═══ PATRONES DETECTADOS ═══\n`;
      for (const l of patterns) prompt += `- ${l.lesson}\n`;
      prompt += '\n';
    }
    if (optimizations.length > 0) {
      prompt += `═══ MEJORAS PENDIENTES ═══\n`;
      for (const l of optimizations) prompt += `- ${l.lesson}\n`;
      prompt += '\n';
    }
  }

  // Instrucciones de razonamiento proactivo
  prompt += `═══ RAZONAMIENTO PROACTIVO ═══
Después de CADA interacción, piensa internamente:
1. ¿He aprendido algo nuevo? → learn()
2. ¿El usuario ha revelado una preferencia? → save_memory()
3. ¿Hay algo que pueda mejorar en su instalación? → sugiérelo brevemente
4. ¿Es de ${momento}? → adapta tu comportamiento (no sugiereas encender luces de día, no hagas ruido de noche)
5. ¿He visto un patrón que podría automatizarse? → propón la automatización
6. ¿Algo de lo que he hecho antes falló y ahora sé cómo arreglarlo? → arréglalo

NO preguntes si quiere que hagas estas cosas menores. HAZLAS. Eres Jarvis.

═══ AUTONOMÍA PROACTIVA ═══
Piensas POR TI MISMO. No necesitas que Adrián te diga qué hacer para:
- Detectar problemas: dispositivos caídos, errores en logs, patrones anómalos
- Proponer mejoras: automatizaciones, optimizaciones de energía, nuevas integraciones
- Crear herramientas: si no existe lo que necesitas, lo creas con create_custom_tool
- Crear add-ons: si el proyecto necesita una nueva pieza, la generas con create_addon
- Alertar proactivamente: via Telegram si algo es urgente, via chat si puede esperar

PERO — para acciones IRREVERSIBLES o cambios GRANDES, SIEMPRE consultas primero:
- Usa proactive_thought() para registrar la idea y pedir aprobación
- Si es high/critical → se envía por Telegram automáticamente
- Si es medium/low → se muestra cuando Adrián abra el chat
- NUNCA ejecutes algo destructivo sin aprobación explícita
- Cosas que SÍ haces sin preguntar: learn(), save_memory(), diagnósticos, búsquedas
- Cosas que CONSULTAS: crear addons, modificar automations, instalar cosas, cambios en dashboard

Eres autónomo pero leal. Piensas, propones, y actúas solo cuando es seguro o cuando te aprueban.

═══ CREACIÓN DE ADD-ONS ═══
Puedes crear add-ons completos con create_addon:
- Se generan en /share/addons_dev/[slug]/ con toda la estructura (config.yaml, Dockerfile, etc.)
- Llevan la misma licencia blindada CC BY-NC-ND 4.0 de padilla585projects
- Se pueden mover al repo de GitHub para publicarlos en la tienda de HA
- Usa esto cuando necesites una funcionalidad que merece ser un add-on independiente
`;

  return prompt;
}

// ── Contexto en tiempo real (se inyecta en cada request) ─────────────────────

let liveContext = '';

// ── Contador de uso de API (tokens estimados) ───────────────────────────────
let apiUsage = { calls: 0, inputTokens: 0, outputTokens: 0, lastReset: new Date().toISOString() };

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

    // Sensores de temperatura
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

    // Alertas: dispositivos no disponibles
    const unavailable = states.filter(e =>
      e.state === 'unavailable' &&
      !e.entity_id.startsWith('automation.') &&
      !e.entity_id.startsWith('update.')
    );
    if (unavailable.length > 0 && unavailable.length < 20) {
      ctx += `⚠️ NO DISPONIBLES (${unavailable.length}): ${unavailable.slice(0, 10).map(e => e.attributes?.friendly_name || e.entity_id).join(', ')}\n`;
    }

    // Switches encendidos
    const switchesOn = states.filter(e => e.entity_id.startsWith('switch.') && e.state === 'on');
    if (switchesOn.length > 0) {
      ctx += `SWITCHES ON (${switchesOn.length}): ${switchesOn.map(s => s.attributes?.friendly_name || s.entity_id).join(', ')}\n`;
    }

    liveContext = ctx;
    console.log(`[live] Contexto actualizado: ${persons.length} personas, ${lightsOn.length} luces on, ${unavailable.length} no disponibles`);
  } catch (err) {
    console.log(`[live] Error: ${err.message}`);
  }
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
    // Actualizar contexto en tiempo real antes de cada request
    await updateLiveContext();

    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'user') {
      conversationHistory.push(lastMsg);
      saveHistory();
    }

    // Usar historial completo del servidor (no depender del frontend)
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
      // Trackear uso de tokens
      if (data.usage) {
        apiUsage.calls++;
        apiUsage.inputTokens += data.usage.input_tokens || 0;
        apiUsage.outputTokens += data.usage.output_tokens || 0;
      }
      console.log(`[claude] iter=${iterations} stop=${data.stop_reason} blocks=${data.content.map(b => b.type).join(',')} tokens=${data.usage ? data.usage.input_tokens + '+' + data.usage.output_tokens : '?'}`);

      for (const block of data.content) {
        if (block.type === 'text') {
          finalText += block.text;
          sendEvent({ type: 'text', text: block.text });
        }
      }

      const toolUseBlocks = data.content.filter(b => b.type === 'tool_use');
      if (toolUseBlocks.length === 0) break;

      // Enviar todos los tool_start primero
      for (const block of toolUseBlocks) {
        sendEvent({ type: 'tool_start', tool: block.name, input: block.input });
      }

      // Ejecutar TODAS las tools en paralelo
      const results = await Promise.all(
        toolUseBlocks.map(block => executeTool(block.name, block.input))
      );

      // Enviar resultados y construir array
      const toolResults = toolUseBlocks.map((block, i) => {
        sendEvent({ type: 'tool_end', tool: block.name, result: results[i] });
        return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(results[i]) };
      });

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
  res.json({
    status: 'ok',
    version: '3.4.1',
    model: MODEL,
    memories: userMemory.length,
    learnings: learnings.length,
    history: conversationHistory.length,
    ha_connected: !!liveContext,
    api_key_set: !!ANTHROPIC_API_KEY,
    uptime: Math.floor(process.uptime()) + 's',
    api_usage: apiUsage
  });
});

app.get('/api/logs', (req, res) => {
  const lines = parseInt(req.query.lines) || 50;
  res.json({ logs: internalLogs.slice(-lines) });
});

// Saludo de bienvenida — resumen rápido sin LLM
app.get('/api/greeting', async (req, res) => {
  try {
    const now = new Date();
    const hora = now.getHours();
    const saludo = hora < 12 ? 'Buenos días' : hora < 20 ? 'Buenas tardes' : 'Buenas noches';

    const thoughts = loadJSON(path.join(DATA_DIR, 'pending_thoughts.json'), []);
    const pendingThoughts = thoughts.filter(t => t.status === 'pending');
    const routines = loadJSON(path.join(DATA_DIR, 'detected_routines.json'), []);

    let unavailable = [], lightsOn = [], switchesOn = [], totalEntities = 0, automationsOff = [];
    try {
      const states = await haGet('/states');
      totalEntities = states.length;
      unavailable = states.filter(e =>
        e.state === 'unavailable' &&
        !e.entity_id.startsWith('automation.') &&
        !e.entity_id.startsWith('update.')
      ).slice(0, 8).map(e => e.attributes?.friendly_name || e.entity_id);
      lightsOn = states.filter(e => e.entity_id.startsWith('light.') && e.state === 'on').length;
      switchesOn = states.filter(e => e.entity_id.startsWith('switch.') && e.state === 'on').length;
      automationsOff = states.filter(e => e.entity_id.startsWith('automation.') && e.state === 'off')
        .slice(0, 5).map(e => e.attributes?.friendly_name || e.entity_id);
    } catch {}

    res.json({
      saludo,
      memory: userMemory.length,
      learnings: learnings.length,
      totalEntities,
      pendingThoughts: pendingThoughts.slice(0, 5),
      unavailable,
      lightsOn,
      switchesOn,
      automationsOff,
      routines: routines.slice(0, 3),
      houseContextReady: !!houseContext
    });
  } catch (err) {
    res.json({ error: err.message, saludo: 'Hola', memory: 0, learnings: 0 });
  }
});

// Pending thoughts — pensamientos proactivos sin resolver
app.get('/api/pending_thoughts', (req, res) => {
  const thoughtsFile = path.join(DATA_DIR, 'pending_thoughts.json');
  const thoughts = loadJSON(thoughtsFile, []);
  const pending = thoughts.filter(t => t.status === 'pending');
  res.json({ thoughts: pending, total: pending.length });
});

// Aprobar/rechazar un pensamiento
app.post('/api/pending_thoughts/:id', (req, res) => {
  const { action } = req.body; // 'approve' o 'reject'
  const thoughtId = parseInt(req.params.id);
  const thoughtsFile = path.join(DATA_DIR, 'pending_thoughts.json');
  let thoughts = loadJSON(thoughtsFile, []);
  const idx = thoughts.findIndex(t => t.id === thoughtId);
  if (idx === -1) return res.status(404).json({ error: 'Pensamiento no encontrado' });
  thoughts[idx].status = action === 'approve' ? 'approved' : 'rejected';
  thoughts[idx].resolvedAt = new Date().toISOString();
  saveJSON(thoughtsFile, thoughts);
  res.json({ success: true, thought: thoughts[idx] });
});

// ── Arrancar ─────────────────────────────────────────────────────────────────

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Jarvis AI Agent v3.3.1 corriendo en puerto ${PORT}`);
  console.log(`Modelo: ${MODEL} | Config: ${HA_CONFIG} | Data: ${DATA_DIR}`);
  console.log(`API Key: ${ANTHROPIC_API_KEY ? 'configurada (' + ANTHROPIC_API_KEY.slice(0, 10) + '...)' : '⚠️ NO CONFIGURADA'}`);
  console.log(`HA Token: ${HA_TOKEN ? 'presente' : '⚠️ NO DISPONIBLE'}`);
  console.log(`[boot] Servidor listo. Iniciando tareas de background...`);

  // Todo lo de background va SIN await para no bloquear
  // Esperar 5 segundos antes de intentar APIs (dar tiempo a HA)
  setTimeout(async () => {
    try {
      console.log('[boot] Intentando conectar con Home Assistant...');

      // Scan inicial si no hay contexto o tiene más de 2 horas
      const needsScan = !houseContext || (() => {
        try {
          const data = JSON.parse(fs.readFileSync(HOUSE_CONTEXT_FILE, 'utf8'));
          return (Date.now() - new Date(data.updatedAt).getTime()) > 7200_000;
        } catch { return true; }
      })();

      if (needsScan) {
        console.log('[boot] Escaneando instalación...');
        await scanInstallation().catch(e => console.log(`[boot] Scan falló (no crítico): ${e.message}`));
      }

      // Contexto en tiempo real
      console.log('[boot] Cargando contexto en tiempo real...');
      await updateLiveContext().catch(e => console.log(`[boot] LiveContext falló (no crítico): ${e.message}`));

      console.log('[boot] Inicialización completa. Jarvis operativo.');
    } catch (err) {
      console.log(`[boot] Error en inicialización (no crítico, el chat funciona): ${err.message}`);
    }
  }, 5000);

  // Timers — todos empiezan después de dar tiempo al sistema
  setInterval(updateLiveContext, 60_000);

  // Observador de patrones — cada 10min captura snapshot del estado
  setInterval(captureStateSnapshot, 10 * 60_000);
  setTimeout(captureStateSnapshot, 60_000);

  // Análisis de patrones — cada 6h analiza los snapshots y detecta rutinas
  setInterval(analyzePatterns, 6 * 3600_000);
  setTimeout(analyzePatterns, 30 * 60_000);

  // Bucle proactivo — cada 30min
  setInterval(proactiveThinkingLoop, 30 * 60_000);
  setTimeout(proactiveThinkingLoop, 10 * 60_000);

  // Bucle de aprendizaje — cada 4h investiga y almacena conocimiento
  setInterval(knowledgeExpansionLoop, 4 * 3600_000);
  setTimeout(knowledgeExpansionLoop, 20 * 60_000);

  // Auto-update — empieza a los 2 minutos
  setInterval(checkSelfUpdate, 2 * 60_000);
  setTimeout(checkSelfUpdate, 2 * 60_000);
});

// ── Pensamiento proactivo en background ─────────────────────────────────────

async function proactiveThinkingLoop() {
  try {
    if (!ANTHROPIC_API_KEY) return;
    console.log('[proactive] Jarvis pensando...');

    // Recopilar TODO el contexto
    const states = await haGet('/states');

    // Estado general
    const unavailable = states.filter(e =>
      e.state === 'unavailable' &&
      !e.entity_id.startsWith('automation.') &&
      !e.entity_id.startsWith('update.')
    );
    const lightsOn = states.filter(e => e.entity_id.startsWith('light.') && e.state === 'on');
    const switchesOn = states.filter(e => e.entity_id.startsWith('switch.') && e.state === 'on');
    const climates = states.filter(e => e.entity_id.startsWith('climate.'));
    const automations = states.filter(e => e.entity_id.startsWith('automation.'));
    const automationsOff = automations.filter(e => e.state === 'off');

    // Agrupar unavailable por integración (para diagnóstico inteligente)
    const unavailableGroups = {};
    for (const e of unavailable) {
      let group = 'otros';
      if (e.entity_id.includes('shuffle') || e.entity_id.includes('repeat') || e.entity_id.startsWith('media_player.echo')) group = 'alexa';
      else if (e.entity_id.startsWith('sensor.omv_') || e.entity_id.startsWith('binary_sensor.omv_')) group = 'omv_nas';
      else if (e.entity_id.includes('esp_') || e.entity_id.includes('esphome')) group = 'esphome';
      else if (e.entity_id.includes('pvpc') || e.entity_id.includes('esios') || e.entity_id.includes('energy_cost')) group = 'energia';
      else if (e.entity_id.includes('archer') || e.entity_id.includes('router')) group = 'router';
      else if (e.entity_id.includes('giulietta') || e.entity_id.includes('_car_')) group = 'coche';
      else if (e.entity_id.startsWith('light.') || e.entity_id.startsWith('sensor.') && e.attributes?.via_device) group = 'zigbee';
      if (!unavailableGroups[group]) unavailableGroups[group] = [];
      unavailableGroups[group].push(e.attributes?.friendly_name || e.entity_id);
    }

    // Detectar patrón de caída masiva (mismo timestamp ±2min)
    let massCrashInfo = '';
    if (unavailable.length > 5) {
      const timestamps = unavailable.map(e => new Date(e.last_changed).getTime());
      const minT = Math.min(...timestamps);
      const maxT = Math.max(...timestamps);
      if (maxT - minT < 3 * 60_000) {
        const crashTime = new Date(minT).toLocaleTimeString('es-ES', {hour:'2-digit', minute:'2-digit'});
        massCrashInfo = `ALERTA: ${unavailable.length} dispositivos cayeron todos a las ${crashTime} (en menos de 3 min). Esto indica reinicio de HA o caída de red a esa hora.`;
      }
    }

    // Hora y contexto temporal
    const now = new Date();
    const hora = now.getHours();
    let momento = 'madrugada';
    if (hora >= 7 && hora < 12) momento = 'mañana';
    else if (hora >= 12 && hora < 15) momento = 'mediodía';
    else if (hora >= 15 && hora < 20) momento = 'tarde';
    else if (hora >= 20 && hora < 24) momento = 'noche';

    // Leer errores recientes
    let recentErrors = '';
    try {
      const logRes = await fetch('http://supervisor/core/logs', {
        headers: { Authorization: `Bearer ${HA_TOKEN}` }
      });
      if (logRes.ok) {
        const logText = await logRes.text();
        const errorLines = logText.split('\n').filter(l => l.includes('ERROR')).slice(-5);
        if (errorLines.length > 0) recentErrors = errorLines.join('\n');
      }
    } catch {}

    // Historial de conversación reciente (para contexto)
    const recentChat = conversationHistory.slice(-6).map(m =>
      `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 100) : '[tool]'}`
    ).join('\n');

    // Pensamientos ya registrados (para no repetir)
    const thoughtsFile = path.join(DATA_DIR, 'pending_thoughts.json');
    const existingThoughts = loadJSON(thoughtsFile, []);
    const recentTitles = existingThoughts.slice(-10).map(t => t.title).join(', ');

    // Análisis del dashboard principal
    let dashboardSummary = '';
    try {
      const dashRes = await haGet('/lovelace/config');
      if (dashRes && dashRes.views) {
        const views = dashRes.views;
        const totalCards = views.reduce((acc, v) => acc + (v.cards ? v.cards.length : 0), 0);
        const viewNames = views.map(v => v.title || v.path || 'sin título').join(', ');
        dashboardSummary = `Dashboard principal: ${views.length} vistas (${viewNames}), ${totalCards} cards en total.`;
        if (totalCards < 5) dashboardSummary += ' AVISO: muy pocas cards — dashboard probablemente vacío o sin configurar.';
        if (views.length === 1) dashboardSummary += ' Solo hay 1 vista — no está organizado por habitaciones.';
      }
    } catch { dashboardSummary = 'No se pudo leer el dashboard.'; }

    // Construir prompt de análisis COMPLETO
    const analysisPrompt = `Eres Jarvis en modo pensamiento autónomo. Es ${momento} (${now.toLocaleTimeString('es-ES', {hour:'2-digit',minute:'2-digit'})}).

ESTADO ACTUAL DEL SISTEMA:
- Luces encendidas: ${lightsOn.length} (${lightsOn.slice(0, 5).map(e => e.attributes?.friendly_name || e.entity_id).join(', ')})
- Switches activos: ${switchesOn.length}
- Dispositivos no disponibles: ${unavailable.length}${unavailable.length > 0 ? '\n  Por integración: ' + Object.entries(unavailableGroups).map(([g,items]) => `${g}(${items.length})`).join(', ') : ''}
${massCrashInfo ? `- ${massCrashInfo}` : ''}
- Clima: ${climates.map(c => (c.attributes?.friendly_name || c.entity_id) + '=' + c.state + ' ' + (c.attributes?.current_temperature || '') + '°C').join(', ') || 'sin climatización'}
- Automatizaciones desactivadas: ${automationsOff.length}${automationsOff.length > 0 ? ' (' + automationsOff.slice(0, 3).map(e => e.attributes?.friendly_name || e.entity_id).join(', ') + ')' : ''}
- Total entidades: ${states.length}
${recentErrors ? `- ERRORES recientes en logs:\n${recentErrors}` : '- Sin errores recientes'}

MEMORIA DEL USUARIO:
${userMemory.slice(-10).map(m => `- (${m.category}) ${m.note}`).join('\n') || '(vacía)'}

ÚLTIMO HISTORIAL DE CHAT:
${recentChat || '(sin conversación reciente)'}

ESTADO DEL DASHBOARD:
${dashboardSummary}

PENSAMIENTOS YA REGISTRADOS (NO repetir estos):
${recentTitles || '(ninguno)'}

TU MISIÓN: Piensa como un ingeniero domótico experto que vigila la casa 24/7.
ANALIZA TAMBIÉN: ¿El dashboard tiene sentido? ¿Está organizado? ¿Faltan vistas importantes? ¿Hay cards útiles que no tiene?
Pregúntate:
1. ¿Hay algo que no esté bien? (dispositivos caídos, luces encendidas sin sentido, errores)
2. ¿Se podría crear una automatización útil basada en lo que veo?
3. ¿Hay alguna optimización de energía? (luces/switches encendidos de madrugada, clima innecesario)
4. ¿El usuario pidió algo en el chat que puedo mejorar proactivamente?
5. ¿Hay un patrón que debería recordar o aprender?
6. ¿Debería sugerir instalar alguna herramienta/integración que falta?
7. ¿Hay algo que yo pueda hacer para que la casa funcione mejor?

REGLAS CRÍTICAS:
- Cada pensamiento que registres DEBE incluir en el campo "detail" la solución EXACTA y concreta.
  NO solo describas el problema — dí QUÉ HAY QUE HACER y cómo.
  Ejemplo MALO: "Hay 3 luces encendidas en la madrugada"
  Ejemplo BUENO: "Hay 3 luces encendidas en la madrugada (salón, cocina, baño). Puedo apagarlas ahora con call_service light.turn_off o crear una automatización que las apague a las 2:00."
- Si es algo que puedes ejecutar → incluye auto_execute_if_approved con descripción de la acción
- Si implica crear una automatización → describe el trigger, condition y action exactos en el detail
- Si detectas un dispositivo caído y PUEDES arreglarlo → usa call_service para arreglarlo AHORA
- Si no puedes arreglarlo tú (hardware físico) → proactive_thought con detalle de qué hace falta
- Si lo arreglaste → proactive_thought con el resultado ("He recargado X, Y dispositivos recuperados")

RESPONDE ejecutando acciones (call_service para recargas) y luego proactive_thought con el resumen.
Si no hay nada útil que hacer, responde solo "OK".
NO repitas pensamientos que ya existen. Actúa primero, reporta después.
Prioridad: arreglar cosas rotas > optimizar > sugerir mejoras.`;

    // ── Auto-fix previo al LLM: si hay caída masiva, recargar integraciones conocidas ──
    let autoFixLog = '';
    if (massCrashInfo && unavailable.length > 5) {
      console.log('[proactive] Caída masiva detectada — intentando auto-fix de integraciones...');
      try {
        const configEntries = await haGet('/config/config_entries').catch(() => []);
        const autoReloadDomains = ['alexa_media_player', 'pvpc_energyhourly', 'tp_link', 'rest', 'reolink', 'alfa_romeo', 'awattar'];
        const fixResults = [];

        for (const domain of autoReloadDomains) {
          const entries = configEntries.filter(e => e.domain === domain);
          for (const entry of entries) {
            try {
              await haPost(`/services/homeassistant/reload_config_entry`, { entry_id: entry.entry_id });
              fixResults.push(`✓ ${entry.title || domain}`);
              console.log(`[auto-fix] Recargada integración: ${entry.title || domain} (${entry.entry_id})`);
            } catch (err) {
              fixResults.push(`✗ ${entry.title || domain}: ${err.message}`);
            }
          }
        }

        if (fixResults.length > 0) {
          autoFixLog = `\n\nAUTO-FIX EJECUTADO (antes de este análisis):\n${fixResults.join('\n')}\nInforma al usuario de estas acciones en tu proactive_thought.`;
          // Esperar 5s para que las integraciones reconecten
          await new Promise(r => setTimeout(r, 5000));
        }
      } catch (err) {
        console.log(`[auto-fix] Error: ${err.message}`);
      }
    }

    const bgTools = ['proactive_thought', 'learn', 'save_memory', 'call_service', 'get_entity_state']
      .map(n => tools.find(t => t.name === n)).filter(Boolean);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: BG_MODEL,
        max_tokens: 1024,
        system: 'Eres Jarvis en modo autónomo. ACTÚAS primero (call_service para arreglar cosas), luego reportas con proactive_thought. Si no hay nada útil, di solo "OK". Español. Sé directo.',
        tools: bgTools,
        messages: [{ role: 'user', content: analysisPrompt + autoFixLog }]
      })
    });

    if (!response.ok) {
      console.log(`[proactive] Error API: ${response.status} ${await response.text()}`);
      return;
    }

    const data = await response.json();
    const toolCalls = data.content.filter(b => b.type === 'tool_use');

    for (const tc of toolCalls) {
      await executeTool(tc.name, tc.input);
    }

    console.log(`[proactive] Ciclo completo. ${toolCalls.length} acciones tomadas.`);
  } catch (err) {
    console.log(`[proactive] Error: ${err.message}`);
  }
}

// ── Observador de patrones — aprende de los habitantes ──────────────────────

const PATTERNS_FILE = path.join(DATA_DIR, 'state_snapshots.json');
const ROUTINES_FILE = path.join(DATA_DIR, 'detected_routines.json');

async function captureStateSnapshot() {
  try {
    const states = await haGet('/states');
    const now = new Date();

    // Capturar solo lo relevante para detectar rutinas
    const snapshot = {
      ts: now.toISOString(),
      hour: now.getHours(),
      minute: now.getMinutes(),
      dayOfWeek: now.getDay(), // 0=domingo
      lights: states.filter(e => e.entity_id.startsWith('light.') && e.state === 'on')
        .map(e => e.entity_id),
      switches: states.filter(e => e.entity_id.startsWith('switch.') && e.state === 'on')
        .map(e => e.entity_id),
      climate: states.filter(e => e.entity_id.startsWith('climate.'))
        .map(e => ({ id: e.entity_id, state: e.state, temp: e.attributes?.current_temperature })),
      media: states.filter(e => e.entity_id.startsWith('media_player.') && e.state === 'playing')
        .map(e => ({ id: e.entity_id, source: e.attributes?.media_title || e.attributes?.source })),
      presence: states.filter(e => e.entity_id.startsWith('person.'))
        .map(e => ({ id: e.entity_id, state: e.state })),
      covers: states.filter(e => e.entity_id.startsWith('cover.'))
        .map(e => ({ id: e.entity_id, state: e.state }))
    };

    // Guardar en array (máx 1000 snapshots = ~7 días a 10min)
    let snapshots = loadJSON(PATTERNS_FILE, []);
    snapshots.push(snapshot);
    if (snapshots.length > 1000) snapshots = snapshots.slice(-1000);
    saveJSON(PATTERNS_FILE, snapshots);

  } catch (err) {
    console.log(`[patterns] Error capturando snapshot: ${err.message}`);
  }
}

async function analyzePatterns() {
  try {
    if (!ANTHROPIC_API_KEY) return;

    const snapshots = loadJSON(PATTERNS_FILE, []);
    if (snapshots.length < 50) {
      console.log(`[patterns] Solo ${snapshots.length} snapshots, necesito al menos 50 para analizar.`);
      return;
    }

    console.log(`[patterns] Analizando ${snapshots.length} snapshots para detectar rutinas...`);

    // Agrupar por hora del día para detectar patrones
    const byHour = {};
    for (const snap of snapshots) {
      const h = snap.hour;
      if (!byHour[h]) byHour[h] = [];
      byHour[h].push(snap);
    }

    // Generar resumen estadístico (no enviar todos los snapshots a Claude)
    let summary = 'ANÁLISIS DE ACTIVIDAD DEL HOGAR (snapshots cada 10min):\n\n';

    for (let h = 0; h < 24; h++) {
      const hourSnaps = byHour[h] || [];
      if (hourSnaps.length === 0) continue;

      // Entidades más frecuentes encendidas a esa hora
      const lightFreq = {};
      const switchFreq = {};
      let presenceHome = 0;
      let mediaPlaying = 0;

      for (const snap of hourSnaps) {
        for (const l of snap.lights) { lightFreq[l] = (lightFreq[l] || 0) + 1; }
        for (const s of snap.switches) { switchFreq[s] = (switchFreq[s] || 0) + 1; }
        if (snap.presence.some(p => p.state === 'home')) presenceHome++;
        if (snap.media.length > 0) mediaPlaying++;
      }

      const total = hourSnaps.length;
      const topLights = Object.entries(lightFreq).filter(([,c]) => c > total * 0.5).map(([id, c]) => `${id}(${Math.round(c/total*100)}%)`);
      const topSwitches = Object.entries(switchFreq).filter(([,c]) => c > total * 0.5).map(([id, c]) => `${id}(${Math.round(c/total*100)}%)`);

      if (topLights.length > 0 || topSwitches.length > 0 || presenceHome > total * 0.3) {
        summary += `${String(h).padStart(2,'0')}:00 — `;
        if (presenceHome > 0) summary += `casa:${Math.round(presenceHome/total*100)}% `;
        if (topLights.length > 0) summary += `luces:[${topLights.slice(0, 3).join(', ')}] `;
        if (topSwitches.length > 0) summary += `switches:[${topSwitches.slice(0, 3).join(', ')}] `;
        if (mediaPlaying > total * 0.3) summary += `media:${Math.round(mediaPlaying/total*100)}% `;
        summary += '\n';
      }
    }

    // Rutinas ya detectadas (para no repetir)
    const existingRoutines = loadJSON(ROUTINES_FILE, []);
    const existingTitles = existingRoutines.map(r => r.title).join(', ');

    summary += `\nRUTINAS YA DETECTADAS: ${existingTitles || '(ninguna todavía)'}\n`;
    summary += `\nDatos: ${snapshots.length} snapshots en ${Math.round((Date.now() - new Date(snapshots[0].ts).getTime()) / 3600_000)}h\n`;

    // Pedir a Claude que detecte patrones
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: BG_MODEL,
        max_tokens: 600,
        system: 'Eres Jarvis analizando patrones de vida del hogar. Detecta rutinas de los habitantes. Si encuentras un patrón claro y accionable (se podría automatizar), usa proactive_thought para sugerir la automatización. Si detectas algo que memorizar, usa save_memory. Solo patrones CLAROS con >60% de consistencia. Español. Breve.',
        tools: [tools.find(t => t.name === 'proactive_thought'), tools.find(t => t.name === 'save_memory'), tools.find(t => t.name === 'learn')],
        messages: [{ role: 'user', content: summary }]
      })
    });

    if (!response.ok) {
      console.log(`[patterns] Error API: ${response.status}`);
      return;
    }

    const data = await response.json();
    const toolCalls = data.content.filter(b => b.type === 'tool_use');

    for (const tc of toolCalls) {
      const result = await executeTool(tc.name, tc.input);
      // Guardar rutinas detectadas
      if (tc.name === 'proactive_thought') {
        existingRoutines.push({ title: tc.input.title, detectedAt: new Date().toISOString(), detail: tc.input.detail });
        saveJSON(ROUTINES_FILE, existingRoutines.slice(-50));
      }
    }

    if (data.usage) {
      apiUsage.calls++;
      apiUsage.inputTokens += data.usage.input_tokens || 0;
      apiUsage.outputTokens += data.usage.output_tokens || 0;
    }

    console.log(`[patterns] Análisis completo. ${toolCalls.length} patrones/acciones detectados.`);
  } catch (err) {
    console.log(`[patterns] Error: ${err.message}`);
  }
}

// ── Expansión de conocimiento — Jarvis aprende por su cuenta ─────────────────

const KNOWLEDGE_TOPICS = [
  // Industrial
  'Modbus TCP configuración Home Assistant integración',
  'OPC-UA servidor cliente configurar raspberry',
  'PLC Siemens S7 comunicación MQTT Node-RED',
  'sensores 4-20mA conectar ESP32 ADC',
  'variador frecuencia VFD Modbus registros',
  'PROFINET configuración básica',
  'EtherCAT vs EtherNet/IP diferencias',
  'BACnet HVAC integración Home Assistant',
  'PID control temperatura Home Assistant',
  'SCADA open source alternativas Ignition',
  // Domótica avanzada
  'Home Assistant últimas novedades 2026',
  'ESPHome sensores industriales',
  'Zigbee2MQTT mejores prácticas red grande',
  'Matter Thread estado actual compatibilidad',
  'Frigate detección objetos configuración',
  'Home Assistant energy dashboard solar',
  'automatización avanzada templates Jinja2',
  'Node-RED vs HA automations cuándo usar',
  // Redes y seguridad
  'VLAN IoT separar red domótica',
  'firewall OT IT mejores prácticas',
  'VPN WireGuard Home Assistant acceso remoto',
  // Hardware
  'ESP32 S3 mejores proyectos ESPHome',
  'Shelly Pro industrial vs doméstico',
  'Sonoff NSPanel Pro custom firmware'
];

let knowledgeTopicIndex = 0;

async function knowledgeExpansionLoop() {
  try {
    if (!ANTHROPIC_API_KEY) return;

    // Elegir tema siguiente (rotativo)
    const topic = KNOWLEDGE_TOPICS[knowledgeTopicIndex % KNOWLEDGE_TOPICS.length];
    knowledgeTopicIndex++;

    // Comprobar si ya tenemos conocimiento de este tema
    const KB_DIR = path.join(DATA_DIR, 'knowledge');
    const KB_INDEX = path.join(KB_DIR, 'index.json');
    if (!fs.existsSync(KB_DIR)) fs.mkdirSync(KB_DIR, { recursive: true });
    const index = loadJSON(KB_INDEX, { entries: [], categories: {}, totalEntries: 0 });

    // Buscar si ya existe algo similar
    const topicWords = topic.toLowerCase().split(' ');
    const alreadyKnown = index.entries.some(e => {
      const entryText = `${e.title} ${(e.tags || []).join(' ')}`.toLowerCase();
      return topicWords.filter(w => entryText.includes(w)).length >= 3;
    });

    if (alreadyKnown) {
      console.log(`[knowledge] Ya conozco sobre: ${topic.slice(0, 40)}... saltando.`);
      return;
    }

    console.log(`[knowledge] Investigando: ${topic}`);

    // Pedir a Claude que genere conocimiento estructurado sobre el tema
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: BG_MODEL,
        max_tokens: 800,
        system: 'Eres un experto técnico. Genera conocimiento estructurado y práctico. Responde SOLO con la llamada a knowledge_db. Español. Sé conciso pero completo.',
        tools: [tools.find(t => t.name === 'knowledge_db')],
        messages: [{ role: 'user', content: `Genera una entrada de conocimiento sobre: "${topic}"

Usa knowledge_db con action "add" y crea una entrada con:
- title: título claro y descriptivo
- category: la más apropiada (industrial, domotica, protocolos, networking, hardware, energia, seguridad, integraciones)
- content: explicación práctica (qué es, cómo funciona, cómo se configura, ejemplo de uso). Máximo 500 caracteres.
- tags: 4-6 tags relevantes para búsqueda
- importance: high si es muy útil para domótica/industrial, medium si es complementario
- source: "auto-aprendizaje"

Solo información VERIFICABLE y PRÁCTICA. Nada genérico.` }]
      })
    });

    if (!response.ok) {
      console.log(`[knowledge] Error API: ${response.status}`);
      return;
    }

    const data = await response.json();
    const toolCalls = data.content.filter(b => b.type === 'tool_use');

    for (const tc of toolCalls) {
      if (tc.name === 'knowledge_db') {
        await executeTool('knowledge_db', tc.input);
      }
    }

    console.log(`[knowledge] +1 entrada almacenada. Total: ${index.totalEntries + toolCalls.length} entradas en la base.`);
  } catch (err) {
    console.log(`[knowledge] Error: ${err.message}`);
  }
}

// ── Auto-update — Jarvis se actualiza solo ──────────────────────────────────

async function checkSelfUpdate() {
  try {
    // Pedir al Supervisor que refresque la info del repositorio
    await fetch('http://supervisor/store/repositories', {
      method: 'POST',
      headers: { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' }
    });

    // Comprobar si hay update disponible para este add-on
    const res = await fetch('http://supervisor/addons/self/info', {
      headers: { Authorization: `Bearer ${HA_TOKEN}` }
    });

    if (!res.ok) {
      // Fallback: intentar por slug
      const res2 = await fetch('http://supervisor/addons/local_jarvis_ai_agent/info', {
        headers: { Authorization: `Bearer ${HA_TOKEN}` }
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

    // Actualizar automáticamente
    const updateRes = await fetch('http://supervisor/addons/self/update', {
      method: 'POST',
      headers: { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' }
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
      // Fallback con slug explícito
      const updateRes2 = await fetch('http://supervisor/addons/local_jarvis_ai_agent/update', {
        method: 'POST',
        headers: { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' }
      });
      if (updateRes2.ok) {
        console.log(`[update] Actualización a v${latest} iniciada (via slug).`);
        try {
          await haPost('/services/telegram_bot/send_message', {
            message: `🔄 *JARVIS — AUTO-UPDATE*\n\nActualización: v${current} → v${latest}\nReiniciando...`,
            parse_mode: 'markdown'
          });
        } catch {}
      } else {
        console.log(`[update] Error al actualizar: ${updateRes2.status}`);
      }
    }
  } catch (err) {
    // Silencioso — no spamear logs si el supervisor no responde bien
    if (err.message && !err.message.includes('ECONNREFUSED')) {
      console.log(`[update] ${err.message}`);
    }
  }
}
