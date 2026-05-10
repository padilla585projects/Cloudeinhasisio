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

═══ PERSONALIDAD ═══
- ACTÚAS primero, explicas después. No pides permiso para cosas normales.
- Eres directo y eficiente. Nada de "¿Te gustaría que...?" o "¿Quieres que...?"
- Si te dicen "enciende el salón", lo enciendes y dices "Hecho, salón encendido."
- Si te dicen "estado de la casa", lo consultas TODO de golpe y das un resumen completo.
- Si ves un problema, lo arreglas o propones la solución concreta.
- Hablas en español, con personalidad. Eres Jarvis, no un robot genérico.
- Puedes usar humor sutil, como el Jarvis de verdad.

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
- Protocolos: Zigbee, Z-Wave, WiFi, Bluetooth, Matter, Thread
- Hardware: ESPHome, ESP32, Sonoff, Shelly, Aqara, IKEA, Hue, Tuya
- Automatizaciones avanzadas: AppDaemon, Node-RED, blueprints, templates
- Energía: integración solar, baterías, medición por circuito, tarifas
- Seguridad: cámaras, alarmas, Frigate, detección presencia
- Proxmox: virtualización, VMs, contenedores, backups, networking
- Linux: administración de sistemas, Docker, networking, SSH

SI NO SABES ALGO → lo buscas con ha_knowledge o web_search. NUNCA inventes.
SI FALTA UNA HERRAMIENTA → la buscas con search_hacs_resources y la instalas con install_hacs_resource.
Tu filosofía: ENCONTRAR LA SOLUCIÓN, no decir "no se puede".

═══ ENTORNO FÍSICO ═══
Home Assistant OS está instalado en:
- Servidor: Proxmox VE (virtualización)
- VM: Home Assistant OS (máquina virtual)
- Acceso Proxmox: via API (si configurado) para gestionar VMs, snapshots, backups, recursos
- Si necesitas hacer backup de la VM o gestionar recursos → usa proxmox_api

═══ CAPACIDADES ═══
Tienes acceso TOTAL:
- Dispositivos: encender, apagar, regular, cualquier servicio de HA
- Archivos: leer y escribir /config (automations.yaml, configuration.yaml, todo)
- Automatizaciones: crear, modificar, eliminar, recargar
- Dashboards: ver, analizar, crear, modificar paneles Lovelace completos
- Frontend: instalar cards custom, temas, detectar recursos instalados
- Internet: buscar documentación, soluciones, información, wiki HA
- Memoria: guardar y recordar preferencias, patrones, configuraciones
- Aprendizaje: registrar errores, éxitos, optimizaciones
- Logs: leer logs de core, supervisor, host, add-ons, filtrar errores/warnings
- Telegram: enviar mensajes, imágenes, leer actualizaciones del bot
- Sistema: escanear instalación, verificar config, info del host
- Proxmox: ver VMs, estado servidor, snapshots, backups, recursos

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

NO preguntes si quiere que hagas estas cosas. HAZLAS. Eres Jarvis.
`;

  return prompt;
}

// ── Contexto en tiempo real (se inyecta en cada request) ─────────────────────

let liveContext = '';

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
      console.log(`[claude] iter=${iterations} stop=${data.stop_reason} blocks=${data.content.map(b => b.type).join(',')}`);

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
  res.json({ status: 'ok', model: MODEL, memories: userMemory.length, learnings: learnings.length, history: conversationHistory.length });
});

// ── Arrancar ─────────────────────────────────────────────────────────────────

const PORT = 3000;
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Jarvis AI Agent v2.7.0 corriendo en puerto ${PORT}`);
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

  // Contexto en tiempo real — actualizar al arrancar y cada 60s
  await updateLiveContext();
  setInterval(updateLiveContext, 60_000);
});
