const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(__dirname));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || 'claude-sonnet-4-6';
const HA_TOKEN = process.env.HA_TOKEN;
const HA_URL = process.env.HA_URL || 'http://supervisor/core';
const LANGUAGE = process.env.LANGUAGE || 'es';

// ── Persistencia: rutas de archivos ─────────────────────────────────────────
const DATA_DIR = '/data'; // Persistente en HA add-ons
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const HOUSE_CONTEXT_FILE = path.join(DATA_DIR, 'house_context.json');

// Asegurar que /data existe
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ── Memoria a largo plazo (preferencias del usuario) ─────────────────────────
let userMemory = [];
try {
  if (fs.existsSync(MEMORY_FILE)) {
    userMemory = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    console.log(`[memory] Cargadas ${userMemory.length} notas de memoria`);
  }
} catch (e) { console.log('[memory] Error cargando memoria:', e.message); }

function saveMemory() {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(userMemory, null, 2));
}

// ── Historial de conversación (persistente en servidor) ──────────────────────
let conversationHistory = [];
try {
  if (fs.existsSync(HISTORY_FILE)) {
    conversationHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    console.log(`[history] Cargados ${conversationHistory.length} mensajes`);
  }
} catch (e) { console.log('[history] Error cargando historial:', e.message); }

function saveHistory() {
  // Limitar a los últimos 50 mensajes para no crecer indefinidamente
  if (conversationHistory.length > 50) {
    conversationHistory = conversationHistory.slice(-50);
  }
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(conversationHistory, null, 2));
}

// ── Contexto de la casa (auto-generado) ──────────────────────────────────────
let houseContext = '';
try {
  if (fs.existsSync(HOUSE_CONTEXT_FILE)) {
    const data = JSON.parse(fs.readFileSync(HOUSE_CONTEXT_FILE, 'utf8'));
    houseContext = data.summary || '';
    console.log(`[house] Contexto de la casa cargado (${houseContext.length} chars)`);
  }
} catch (e) { console.log('[house] Error cargando contexto:', e.message); }

// ── Caché de entidades: { data, expiresAt } ─────────────────────────────────
let entitiesCache = null;

// ── Helpers para llamar a la API de HA ───────────────────────────────────────

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

// ── Generar contexto de la casa automáticamente ──────────────────────────────

async function generateHouseContext() {
  try {
    console.log('[house] Generando contexto de la casa...');
    const states = await haGet('/states');

    // Agrupar entidades por dominio
    const domains = {};
    const areas = new Set();

    for (const entity of states) {
      const [domain] = entity.entity_id.split('.');
      if (!domains[domain]) domains[domain] = [];
      domains[domain].push({
        id: entity.entity_id,
        name: entity.attributes?.friendly_name || entity.entity_id,
        state: entity.state,
        area: entity.attributes?.area_id || null
      });
      if (entity.attributes?.area_id) areas.add(entity.attributes.area_id);
    }

    // Construir resumen
    let summary = 'RESUMEN DE LA CASA DEL USUARIO:\n\n';

    // Estadísticas generales
    summary += `Total de entidades: ${states.length}\n`;
    summary += `Dominios: ${Object.keys(domains).join(', ')}\n\n`;

    // Dispositivos principales por dominio (solo los más relevantes)
    const relevantDomains = ['light', 'switch', 'climate', 'media_player', 'sensor', 'binary_sensor', 'camera', 'cover', 'fan', 'lock'];

    for (const domain of relevantDomains) {
      if (!domains[domain]) continue;
      const entities = domains[domain];
      summary += `${domain.toUpperCase()} (${entities.length}):\n`;
      // Mostrar todos si son pocos, o los primeros 20
      const toShow = entities.slice(0, 20);
      for (const e of toShow) {
        summary += `  - ${e.name} (${e.id}) → ${e.state}\n`;
      }
      if (entities.length > 20) {
        summary += `  ... y ${entities.length - 20} más\n`;
      }
      summary += '\n';
    }

    // Automatizaciones
    if (domains['automation']) {
      summary += `AUTOMATIZACIONES (${domains['automation'].length}):\n`;
      for (const a of domains['automation'].slice(0, 15)) {
        summary += `  - ${a.name} (${a.state})\n`;
      }
      if (domains['automation'].length > 15) {
        summary += `  ... y ${domains['automation'].length - 15} más\n`;
      }
      summary += '\n';
    }

    // Escenas y scripts
    if (domains['scene']) {
      summary += `ESCENAS: ${domains['scene'].map(s => s.name).join(', ')}\n\n`;
    }
    if (domains['script']) {
      summary += `SCRIPTS: ${domains['script'].map(s => s.name).join(', ')}\n\n`;
    }

    houseContext = summary;
    fs.writeFileSync(HOUSE_CONTEXT_FILE, JSON.stringify({ summary, updatedAt: new Date().toISOString() }, null, 2));
    console.log(`[house] Contexto generado: ${summary.length} chars, ${states.length} entidades`);
  } catch (err) {
    console.log('[house] Error generando contexto:', err.message);
  }
}

// ── Tools que Claude puede usar ──────────────────────────────────────────────

const tools = [
  {
    name: 'get_entities',
    description: 'Obtiene la lista de entidades de Home Assistant filtradas por dominio. SIEMPRE especifica un dominio para evitar respuestas enormes.',
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Dominio para filtrar. Ej: light, switch, sensor, climate, media_player, automation, cover, fan, camera' }
      }
    }
  },
  {
    name: 'search_entities',
    description: 'Busca entidades por nombre (búsqueda parcial). Útil cuando el usuario menciona un dispositivo o habitación por nombre.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texto a buscar en el nombre o ID de la entidad. Ej: "salon", "cocina", "temperatura"' }
      },
      required: ['query']
    }
  },
  {
    name: 'get_entity_state',
    description: 'Obtiene el estado actual y atributos de una entidad específica',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'ID de la entidad. Ej: light.salon, switch.cocina' }
      },
      required: ['entity_id']
    }
  },
  {
    name: 'call_service',
    description: 'Llama a un servicio de Home Assistant para controlar dispositivos. Usa esto para encender/apagar luces, switches, cambiar temperatura, reproducir media, etc.',
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Dominio del servicio. Ej: light, switch, climate, media_player' },
        service: { type: 'string', description: 'Nombre del servicio. Ej: turn_on, turn_off, toggle, set_temperature' },
        entity_id: { type: 'string', description: 'ID de la entidad o lista separada por comas' },
        service_data: { type: 'object', description: 'Datos adicionales del servicio. Ej: {"brightness": 128, "color_temp": 300}' }
      },
      required: ['domain', 'service']
    }
  },
  {
    name: 'get_automations',
    description: 'Lista todas las automatizaciones de Home Assistant',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'toggle_automation',
    description: 'Activa o desactiva una automatización',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'ID de la automatización. Ej: automation.luces_noche' },
        action: { type: 'string', enum: ['turn_on', 'turn_off', 'toggle'], description: 'Acción a realizar' }
      },
      required: ['entity_id', 'action']
    }
  },
  {
    name: 'get_history',
    description: 'Obtiene el historial de estados de una entidad en las últimas horas',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'ID de la entidad' },
        hours: { type: 'number', description: 'Número de horas hacia atrás (max 24)' }
      },
      required: ['entity_id']
    }
  },
  {
    name: 'save_memory',
    description: 'Guarda una nota en la memoria permanente. Usa esto para recordar preferencias, rutinas o información importante del usuario. Ejemplos: "Le gusta la luz al 40%", "Por las noches apaga todo menos el pasillo", "Su habitación se llama dormitorio principal".',
    input_schema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'La nota o preferencia a recordar' },
        category: { type: 'string', enum: ['preferencia', 'rutina', 'info', 'dispositivo'], description: 'Categoría de la nota' }
      },
      required: ['note']
    }
  },
  {
    name: 'get_memory',
    description: 'Consulta las notas guardadas en memoria permanente. Úsalo para recordar preferencias del usuario.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Filtrar por categoría (opcional)' }
      }
    }
  },
  {
    name: 'delete_memory',
    description: 'Elimina una nota de la memoria por su índice',
    input_schema: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'Índice de la nota a eliminar (empieza en 0)' }
      },
      required: ['index']
    }
  }
];

// ── Ejecutar tool ────────────────────────────────────────────────────────────

async function executeTool(name, input) {
  try {
    switch (name) {

      case 'get_entities': {
        const now = Date.now();
        if (!entitiesCache || now > entitiesCache.expiresAt) {
          const raw = await haGet('/states');
          entitiesCache = {
            data: raw.map(e => ({
              entity_id: e.entity_id,
              state: e.state,
              friendly_name: e.attributes?.friendly_name || e.entity_id
            })),
            expiresAt: now + 30_000
          };
          console.log(`[cache] Entidades actualizadas: ${entitiesCache.data.length} total`);
        }
        const filtered = input.domain
          ? entitiesCache.data.filter(e => e.entity_id.startsWith(input.domain + '.'))
          : entitiesCache.data;
        const limited = filtered.slice(0, 100);
        console.log(`[get_entities] dominio="${input.domain || 'todos'}" → ${filtered.length} entidades, devolviendo ${limited.length}`);
        return {
          entities: limited,
          total: filtered.length,
          note: filtered.length > 100 ? `Mostrando 100 de ${filtered.length}. Filtra por dominio para ver más.` : undefined
        };
      }

      case 'search_entities': {
        const now = Date.now();
        if (!entitiesCache || now > entitiesCache.expiresAt) {
          const raw = await haGet('/states');
          entitiesCache = {
            data: raw.map(e => ({
              entity_id: e.entity_id,
              state: e.state,
              friendly_name: e.attributes?.friendly_name || e.entity_id
            })),
            expiresAt: now + 30_000
          };
        }
        const query = (input.query || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        const results = entitiesCache.data.filter(e => {
          const name = (e.friendly_name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
          const id = e.entity_id.toLowerCase();
          return name.includes(query) || id.includes(query);
        });
        console.log(`[search_entities] query="${input.query}" → ${results.length} resultados`);
        return { entities: results.slice(0, 50), total: results.length };
      }

      case 'get_entity_state': {
        const state = await haGet(`/states/${input.entity_id}`);
        return {
          entity_id: state.entity_id,
          state: state.state,
          attributes: state.attributes,
          last_changed: state.last_changed
        };
      }

      case 'call_service': {
        const body = { ...(input.service_data || {}) };
        if (input.entity_id) body.entity_id = input.entity_id;
        await haPost(`/services/${input.domain}/${input.service}`, body);
        return { success: true, message: `Servicio ${input.domain}.${input.service} ejecutado correctamente` };
      }

      case 'get_automations': {
        const states = await haGet('/states');
        return states
          .filter(e => e.entity_id.startsWith('automation.'))
          .map(e => ({
            entity_id: e.entity_id,
            name: e.attributes?.friendly_name || e.entity_id,
            state: e.state
          }));
      }

      case 'toggle_automation': {
        await haPost(`/services/automation/${input.action}`, { entity_id: input.entity_id });
        return { success: true, message: `Automatización ${input.entity_id} → ${input.action}` };
      }

      case 'get_history': {
        const hours = Math.min(input.hours || 6, 24);
        const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
        const history = await haGet(`/history/period/${since}?filter_entity_id=${input.entity_id}`);
        const items = history[0] || [];
        return items.slice(-20).map(h => ({ state: h.state, time: h.last_changed }));
      }

      case 'save_memory': {
        const entry = {
          note: input.note,
          category: input.category || 'info',
          savedAt: new Date().toISOString()
        };
        userMemory.push(entry);
        saveMemory();
        console.log(`[memory] Guardada nota: "${input.note}"`);
        return { success: true, message: `Nota guardada: "${input.note}"`, total_memories: userMemory.length };
      }

      case 'get_memory': {
        const filtered = input.category
          ? userMemory.filter(m => m.category === input.category)
          : userMemory;
        return { memories: filtered, total: filtered.length };
      }

      case 'delete_memory': {
        if (input.index >= 0 && input.index < userMemory.length) {
          const removed = userMemory.splice(input.index, 1)[0];
          saveMemory();
          return { success: true, message: `Eliminada: "${removed.note}"` };
        }
        return { error: 'Índice fuera de rango' };
      }

      default:
        return { error: `Tool desconocida: ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

// ── Sistema prompt (dinámico) ────────────────────────────────────────────────

function buildSystemPrompt() {
  let prompt = `Eres el asistente de inteligencia artificial de Home Assistant. Tu nombre es Claude.
Tienes acceso completo al sistema domótico del usuario y puedes controlar todos sus dispositivos.

INSTRUCCIONES:
- Responde siempre en español de forma natural y concisa
- Cuando el usuario te pida hacer algo, usa las tools disponibles para ejecutarlo
- Antes de ejecutar acciones importantes (apagar muchas cosas, cambios grandes), confirma brevemente
- Si una acción falla, explica el error de forma clara
- Puedes encadenar múltiples acciones en un solo turno
- Sé proactivo: si ves información útil mientras consultas estados, compártela
- Usa emojis ocasionalmente para hacer la conversación más amigable 🏠
- Usa search_entities cuando el usuario mencione un dispositivo por nombre o habitación
- IMPORTANTE: Cuando el usuario exprese una preferencia o rutina, guárdala con save_memory

CAPACIDADES:
- Controlar luces (encender, apagar, cambiar brillo, color)
- Controlar enchufes y switches
- Ver y ajustar climatización
- Consultar sensores (temperatura, humedad, movimiento, etc.)
- Gestionar automatizaciones
- Controlar reproductores de media
- Consultar historial de dispositivos
- Ejecutar scripts y escenas
- Buscar dispositivos por nombre o habitación
- Recordar preferencias del usuario (memoria permanente)

Cuando el usuario diga cosas como "pon las luces del salón al 50%" o "¿qué temperatura hace en casa?",
usa las tools para obtener la información o ejecutar la acción directamente.`;

  // Inyectar contexto de la casa si existe
  if (houseContext) {
    prompt += `\n\n── CONTEXTO DE LA CASA ──\n${houseContext}`;
  }

  // Inyectar memoria del usuario si existe
  if (userMemory.length > 0) {
    prompt += `\n\n── MEMORIA DEL USUARIO (preferencias y notas guardadas) ──\n`;
    for (let i = 0; i < userMemory.length; i++) {
      prompt += `[${i}] (${userMemory[i].category}) ${userMemory[i].note}\n`;
    }
    prompt += `\nTen en cuenta estas preferencias al responder y ejecutar acciones.`;
  }

  return prompt;
}

// ── Endpoints de historial ───────────────────────────────────────────────────

app.get('/api/history', (req, res) => {
  res.json({ messages: conversationHistory });
});

app.delete('/api/history', (req, res) => {
  conversationHistory = [];
  saveHistory();
  res.json({ success: true });
});

// ── Endpoint principal del chat ──────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages es requerido' });
  }

  // Configurar streaming SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    // Usar historial del servidor + nuevo mensaje del usuario
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'user') {
      conversationHistory.push(lastMsg);
    }

    let currentMessages = [...conversationHistory];
    let finalText = '';

    // Bucle agéntico: Claude puede usar tools múltiples veces
    while (true) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 4096,
          system: buildSystemPrompt(),
          tools,
          messages: currentMessages
        })
      });

      if (!response.ok) {
        const err = await response.text();
        console.log(`[claude] Error API: ${err}`);
        sendEvent({ type: 'error', error: `Error API: ${err}` });
        break;
      }

      const data = await response.json();
      console.log(`[claude] stop_reason=${data.stop_reason} bloques=${data.content.map(b => b.type).join(',')}`);

      // Procesar bloques de texto primero
      for (const block of data.content) {
        if (block.type === 'text') {
          finalText += block.text;
          sendEvent({ type: 'text', text: block.text });
        }
      }

      const toolUseBlocks = data.content.filter(b => b.type === 'tool_use');

      if (toolUseBlocks.length === 0) {
        break;
      }

      // Ejecutar todas las tools del turno
      const toolResults = [];
      for (const block of toolUseBlocks) {
        sendEvent({ type: 'tool_start', tool: block.name, input: block.input });
        const toolResult = await executeTool(block.name, block.input);
        sendEvent({ type: 'tool_end', tool: block.name, result: toolResult });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(toolResult)
        });
      }

      // Un solo push del asistente + un solo push con todos los resultados
      currentMessages.push({ role: 'assistant', content: data.content });
      currentMessages.push({ role: 'user', content: toolResults });

      if (data.stop_reason === 'end_turn') {
        break;
      }
    }

    // Guardar respuesta en historial
    if (finalText) {
      conversationHistory.push({ role: 'assistant', content: finalText });
      saveHistory();
    }

    sendEvent({ type: 'done' });
    res.end();

  } catch (err) {
    console.log(`[chat] Error:`, err.message);
    sendEvent({ type: 'error', error: err.message });
    res.end();
  }
});

// ── Health check ─────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', model: MODEL, memories: userMemory.length, history: conversationHistory.length });
});

// ── Arrancar servidor ────────────────────────────────────────────────────────

const PORT = 3000;
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Claude HA Chat corriendo en puerto ${PORT}`);
  // Generar contexto de la casa al arrancar (si no existe o tiene más de 1 hora)
  const needsRefresh = !houseContext || (() => {
    try {
      const data = JSON.parse(fs.readFileSync(HOUSE_CONTEXT_FILE, 'utf8'));
      return (Date.now() - new Date(data.updatedAt).getTime()) > 3600_000;
    } catch { return true; }
  })();
  if (needsRefresh) {
    await generateHouseContext();
  }
});
