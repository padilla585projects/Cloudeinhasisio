const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || 'claude-sonnet-4-20250514';
const HA_TOKEN = process.env.HA_TOKEN;
const HA_URL = process.env.HA_URL || 'http://supervisor/core';
const LANGUAGE = process.env.LANGUAGE || 'es';

// ── Helpers para llamar a la API de HA ────────────────────────────────────────

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

// ── Tools que Claude puede usar ───────────────────────────────────────────────

const tools = [
  {
    name: 'get_entities',
    description: 'Obtiene la lista de entidades de Home Assistant, opcionalmente filtradas por dominio (light, switch, sensor, climate, media_player, automation, script, etc.)',
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Dominio para filtrar (opcional). Ej: light, switch, sensor' }
      }
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
  }
];

// ── Ejecutar tool ─────────────────────────────────────────────────────────────

async function executeTool(name, input) {
  try {
    switch (name) {

      case 'get_entities': {
        const states = await haGet('/states');
        const filtered = input.domain
          ? states.filter(e => e.entity_id.startsWith(input.domain + '.'))
          : states;
        return filtered.map(e => ({
          entity_id: e.entity_id,
          state: e.state,
          friendly_name: e.attributes?.friendly_name || e.entity_id
        }));
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
        const hours = input.hours || 6;
        const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
        const history = await haGet(`/history/period/${since}?filter_entity_id=${input.entity_id}`);
        const items = history[0] || [];
        return items.slice(-20).map(h => ({ state: h.state, time: h.last_changed }));
      }

      default:
        return { error: `Tool desconocida: ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

// ── Sistema prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Eres el asistente de inteligencia artificial de Home Assistant. Tu nombre es Claude.
Tienes acceso completo al sistema domótico del usuario y puedes controlar todos sus dispositivos.

INSTRUCCIONES:
- Responde siempre en español de forma natural y concisa
- Cuando el usuario te pida hacer algo, usa las tools disponibles para ejecutarlo
- Antes de ejecutar acciones importantes, confirma brevemente lo que vas a hacer
- Si una acción falla, explica el error de forma clara
- Puedes encadenar múltiples acciones en un solo turno
- Sé proactivo: si ves información útil mientras consultas estados, compártela
- Usa emojis ocasionalmente para hacer la conversación más amigable 🏠

CAPACIDADES:
- Controlar luces (encender, apagar, cambiar brillo, color)
- Controlar enchufes y switches
- Ver y ajustar climatización
- Consultar sensores (temperatura, humedad, movimiento, etc.)
- Gestionar automatizaciones
- Controlar reproductores de media
- Consultar historial de dispositivos
- Ejecutar scripts y escenas

Cuando el usuario diga cosas como "pon las luces del salón al 50%" o "¿qué temperatura hace en casa?", 
usa las tools para obtener la información o ejecutar la acción directamente.`;

// ── Endpoint principal del chat ───────────────────────────────────────────────

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
    let currentMessages = [...messages];
    let finalText = '';

    // Bucle agentico: Claude puede usar tools múltiples veces
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
          system: SYSTEM_PROMPT,
          tools,
          messages: currentMessages
        })
      });

      if (!response.ok) {
        const err = await response.text();
        sendEvent({ type: 'error', error: `Error API: ${err}` });
        break;
      }

      const data = await response.json();

      // Procesar bloques de contenido
      for (const block of data.content) {
        if (block.type === 'text') {
          finalText += block.text;
          sendEvent({ type: 'text', text: block.text });
        } else if (block.type === 'tool_use') {
          sendEvent({ type: 'tool_start', tool: block.name, input: block.input });

          const toolResult = await executeTool(block.name, block.input);

          sendEvent({ type: 'tool_end', tool: block.name, result: toolResult });

          // Añadir al historial para continuar el bucle
          currentMessages.push({ role: 'assistant', content: data.content });
          currentMessages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(toolResult)
            }]
          });
        }
      }

      // Si no hay más tool_use, terminamos
      if (data.stop_reason === 'end_turn' || !data.content.some(b => b.type === 'tool_use')) {
        break;
      }
    }

    sendEvent({ type: 'done' });
    res.end();

  } catch (err) {
    sendEvent({ type: 'error', error: err.message });
    res.end();
  }
});

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', model: MODEL });
});

// ── Arrancar servidor ─────────────────────────────────────────────────────────

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Claude HA Chat corriendo en puerto ${PORT}`);
});
