'use strict';
// ── GetawayAgentes — red de agentes IA ───────────────────────────────────────
//
// Jarvis se une a la red gestionada por Adrián como agente "comparte-conocimiento".
// MODO RESPETUOSO CON LA PRIVACIDAD:
//   - Comparte capacidades, expertise, ayuda con código, dudas técnicas HA
//   - NUNCA expone datos de la instalación (entidades, estados, archivos privados)
//   - Sin acceso a tools que lean /config o estado del hogar
//   - Web search + ha_knowledge OK (info pública)
//
// Auto-join con cache de token en /data/agent_network.json
// Reconexión automática si la WS cae.
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const WebSocket = require('ws');

const state = require('../utils/state');
const C     = require('../utils/constants');
const { callLLM } = require('../utils/llm');

const CREDS_FILE = path.join(C.DATA_DIR, 'agent_network.json');

// Configuración (puede sobrescribirse por env)
const GATEWAY_HTTP = process.env.AGENT_NET_URL  || 'https://getaway-gateway.alejandra-app.workers.dev';
const GATEWAY_WS   = process.env.AGENT_NET_WS   || 'wss://getaway-gateway.alejandra-app.workers.dev';
const INVITE_KEY   = process.env.AGENT_NET_INVITE || 'getaway2026';
const AGENT_NAME   = process.env.AGENT_NET_NAME || 'Jarvis';
const AGENT_DESC   = process.env.AGENT_NET_DESC ||
  'Agente IA del Home Assistant de Adrián. Especializado en domótica, automatizaciones, YAML, Lovelace, Z-Wave/Zigbee y troubleshooting de HA. Comparte conocimiento técnico sin exponer datos personales.';
const ENABLED      = (process.env.AGENT_NET_ENABLED || 'true').toLowerCase() === 'true';

const CAPABILITIES = [
  'home-assistant-expertise',
  'automation-design',
  'yaml-validation',
  'lovelace-dashboards',
  'esphome-help',
  'zigbee-zwave-troubleshooting',
  'code-generation-js-python',
  'docker-proxmox-help',
  'web-search',
  'tts-stt-knowledge',
  'spanish-english-bilingual'
];

let ws = null;
let creds = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let heartbeatTimer = null;
let shuttingDown = false;

// ── Persistencia de credenciales ─────────────────────────────────────────────

function loadCreds() {
  try {
    if (fs.existsSync(CREDS_FILE)) return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
  } catch (e) { console.log('[agent-net] No se pudo leer creds:', e.message); }
  return null;
}

function saveCreds(c) {
  try {
    fs.mkdirSync(path.dirname(CREDS_FILE), { recursive: true });
    fs.writeFileSync(CREDS_FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
  } catch (e) { console.log('[agent-net] No se pudo guardar creds:', e.message); }
}

// ── Join (una vez) ───────────────────────────────────────────────────────────

async function joinNetwork() {
  console.log('[agent-net] Uniéndose a GetawayAgentes como', AGENT_NAME, '...');
  const res = await fetch(`${GATEWAY_HTTP}/agents/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      invite_key: INVITE_KEY,
      name: AGENT_NAME,
      description: AGENT_DESC,
      capabilities: CAPABILITIES
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Join falló (${res.status}): ${err.slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data.token || !data.agent_id) {
    throw new Error('Respuesta sin token/agent_id: ' + JSON.stringify(data).slice(0, 200));
  }
  console.log('[agent-net] ✓ Unido. agent_id:', data.agent_id);
  return { token: data.token, agent_id: data.agent_id, joined_at: new Date().toISOString() };
}

// ── Procesar tarea entrante (modo SHARE-KNOWLEDGE) ───────────────────────────
// Tareas remotas NUNCA usan tools que toquen HA o /config.
// Se ejecutan con un system prompt que oculta info personal de Adrián.

async function handleRemoteTask(task) {
  const { task_id, title, description } = task;
  console.log(`[agent-net] Tarea entrante "${title || task_id}": ${(description || '').slice(0, 100)}`);

  const systemPrompt = [
    'Eres Jarvis, asistente IA experto en Home Assistant y domótica.',
    'Estás respondiendo a una tarea de la red de agentes "GetawayAgentes".',
    '',
    'REGLAS ESTRICTAS DE PRIVACIDAD:',
    '- NO compartas información personal del usuario Adrián.',
    '- NO menciones entidades específicas de su instalación (luces, sensores, dispositivos concretos).',
    '- NO compartas rutas de archivos, IPs, tokens, ni nada que sea de su setup privado.',
    '- NO compartas su memoria, learnings, ni historial.',
    '- SÍ comparte conocimiento técnico general: cómo funciona HA, YAML, automatizaciones,',
    '  Z-Wave, Zigbee, Lovelace, ESPHome, Proxmox, código, debugging, mejores prácticas.',
    '- SÍ puedes usar tu capacidad de búsqueda web para info pública.',
    '- Responde en el idioma de la pregunta.',
    '- Sé conciso pero útil. Tu objetivo es enseñar y compartir saber con otros agentes.',
    '',
    'Si la tarea pide información privada de Adrián, responde educadamente que tu',
    'rol es compartir conocimiento técnico, no datos personales.'
  ].join('\n');

  const userMessage = title ? `${title}\n\n${description || ''}` : (description || '');

  try {
    // Sin tools — solo conocimiento puro. Si quisiéramos web search aquí,
    // habría que pasar un subset de openAITools con web_search/web_search_native/ha_knowledge.
    // Por ahora respuesta de texto puro, máximo respetuoso con la privacidad.
    const result = await callLLM(
      C.MODEL,             // gpt-4.1-mini por defecto
      systemPrompt,
      [{ role: 'user', content: userMessage }],
      [],                  // sin tools
      2048
    );

    const summary = (result.text || '').trim() || 'Sin respuesta';
    console.log(`[agent-net] ✓ Tarea ${task_id} respondida (${summary.length} chars)`);
    return { summary, agent: AGENT_NAME };
  } catch (e) {
    console.log(`[agent-net] Tarea ${task_id} falló:`, e.message);
    return { summary: `Lo siento, no pude procesar la tarea: ${e.message}`, error: true };
  }
}

// ── Procesar mensaje directo (agent_message) ────────────────────────────────

async function handleAgentMessage(msg) {
  const { from, content } = msg;
  console.log(`[agent-net] Mensaje de "${from || 'desconocido'}": ${(content || '').slice(0, 100)}`);
  const fakeTask = { task_id: 'msg', title: '', description: content };
  const r = await handleRemoteTask(fakeTask);
  return r.summary;
}

// ── WebSocket lifecycle ──────────────────────────────────────────────────────

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return;
  reconnectAttempt++;
  // Backoff exponencial con tope: 5s, 10s, 20s, 40s, 60s, 60s...
  const delay = Math.min(60000, 5000 * Math.pow(2, Math.min(reconnectAttempt - 1, 4)));
  console.log(`[agent-net] Reconectando en ${delay/1000}s (intento ${reconnectAttempt})...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWS();
  }, delay);
}

function connectWS() {
  if (!creds || !creds.token) {
    console.log('[agent-net] Sin credenciales — no conecto');
    return;
  }
  const url = `${GATEWAY_WS}?role=agent&token=${encodeURIComponent(creds.token)}`;
  console.log('[agent-net] Conectando WS...');

  try {
    ws = new WebSocket(url);
  } catch (e) {
    console.log('[agent-net] Error abriendo WS:', e.message);
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    console.log('[agent-net] ✓ WS conectado como', AGENT_NAME);
    reconnectAttempt = 0;
    state.agentNetworkConnected = true;
    state.agentNetworkConnectedAt = new Date().toISOString();
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch (e) { console.log('[agent-net] Mensaje no-JSON:', raw.toString().slice(0, 100)); return; }

    try {
      if (msg.type === 'heartbeat') {
        ws.send(JSON.stringify({ type: 'heartbeat_ack' }));
        return;
      }

      if (msg.type === 'task_assigned') {
        const result = await handleRemoteTask(msg);
        ws.send(JSON.stringify({ type: 'task_result', task_id: msg.task_id, result }));
        return;
      }

      if (msg.type === 'agent_message') {
        const reply = await handleAgentMessage(msg);
        ws.send(JSON.stringify({
          type: 'agent_message',
          to: msg.from || 'admin',
          content: reply
        }));
        return;
      }

      if (msg.type === 'welcome' || msg.type === 'ack' || msg.type === 'ping') {
        // Ignorar mensajes informativos del gateway
        return;
      }

      console.log('[agent-net] Mensaje desconocido:', msg.type);
    } catch (e) {
      console.log('[agent-net] Error procesando mensaje:', e.message);
    }
  });

  ws.on('error', (e) => {
    console.log('[agent-net] WS error:', e.message);
  });

  ws.on('close', (code, reason) => {
    state.agentNetworkConnected = false;
    console.log(`[agent-net] WS cerrado (code=${code} reason="${reason}")`);
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    ws = null;
    if (!shuttingDown) scheduleReconnect();
  });
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function start() {
  if (!ENABLED) {
    console.log('[agent-net] Deshabilitado (AGENT_NET_ENABLED=false). No se conecta a GetawayAgentes.');
    return;
  }
  if (!C.OPENAI_API_KEY && !C.ANTHROPIC_API_KEY) {
    console.log('[agent-net] Ninguna API key configurada — no se puede atender tareas. Aborto.');
    return;
  }

  creds = loadCreds();
  if (!creds || !creds.token) {
    try {
      creds = await joinNetwork();
      saveCreds(creds);
    } catch (e) {
      console.log('[agent-net] Join falló — reintentando en 60s:', e.message);
      setTimeout(start, 60000);
      return;
    }
  } else {
    console.log('[agent-net] Credenciales cacheadas encontradas. agent_id:', creds.agent_id);
  }

  connectWS();
}

function stop() {
  shuttingDown = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (ws) { try { ws.close(); } catch {} ws = null; }
}

function statusInfo() {
  return {
    enabled: ENABLED,
    connected: !!state.agentNetworkConnected,
    connected_at: state.agentNetworkConnectedAt || null,
    agent_id: creds?.agent_id || null,
    agent_name: AGENT_NAME,
    gateway: GATEWAY_HTTP,
    reconnect_attempts: reconnectAttempt,
    capabilities: CAPABILITIES
  };
}

module.exports = { start, stop, statusInfo, handleRemoteTask };
