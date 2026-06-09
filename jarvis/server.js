'use strict';
const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const { EdgeTTS } = require('node-edge-tts');

// ── Módulos propios ──────────────────────────────────────────────────────────
const state   = require('./utils/state');
const C       = require('./utils/constants');
const { loadJSON, saveJSON, autoBackup } = require('./utils/persistence');
const { haGet, haPost }      = require('./utils/ha-api');
const { scanInstallation }   = require('./utils/scan');
const { callLLM, callOpenAI, callWhisper, callImageEdit, sanitizeMessagesForOpenAI, stripImagesFromHistory } = require('./utils/llm');
const { updateLiveContext, buildDynamicContext } = require('./utils/context');
const { tools, openAITools } = require('./tools/definitions');
const { executeTool }        = require('./tools/executor');
const { nexusRoute, nexusAssemblePrompt, nexusGetAllExperts, nexusPickExpert, nexusGetToolsForExpert, nexusLogLayerStats } = require('./nexus/router');
const { nexusEvolutionTick, nexusWatchers, nexusGetScore } = require('./nexus/health');
const { EXPERTS } = require('./nexus/experts');
const { proactiveThinkingLoop } = require('./background/proactive');
const { captureStateSnapshot, analyzePatterns } = require('./background/patterns');
const { knowledgeExpansionLoop, distillLearnings } = require('./background/knowledge');
const { checkSelfUpdate, checkSystemUpdates } = require('./background/updates');
const { checkEmergencies, bootRecoverScripts, bootSelfCheck, bootLearnHA, bootLearnOwnProject } = require('./background/selfcheck');
const { netGuardLoop } = require('./background/netguard');
const { infraGuardLoop } = require('./background/infraguard');
const { startTelegramBot } = require('./background/telegram_bot');

// agent_network es OPCIONAL — si el archivo falta (deployment incompleto, build cache, etc.)
// NO debe tirar abajo todo el add-on. Stub silencioso como fallback.
let agentNetwork;
try {
  agentNetwork = require('./background/agent_network');
} catch (e) {
  console.log(`[boot] agent_network no disponible (${e.code || 'error'}: ${e.message.slice(0,80)}). Jarvis arranca SIN red de agentes.`);
  agentNetwork = {
    start:    async () => {},
    stop:     () => {},
    statusInfo: () => ({ enabled: false, reachable: false, error: 'module not loaded' }),
    handleRemoteTask: async () => ({ summary: 'agent_network no cargado en este build' })
  };
}

// ── Inyectar en state lo que los módulos necesitan acceder ───────────────────
state.openAITools = openAITools;
state.executeTool = executeTool;

// ── Asegurar que /data existe ─────────────────────────────────────────────────
if (!fs.existsSync(C.DATA_DIR)) fs.mkdirSync(C.DATA_DIR, { recursive: true });

// ── Inicializar estado desde disco ────────────────────────────────────────────
state.userMemory          = loadJSON(C.MEMORY_FILE, []);
state.conversationHistory = loadJSON(C.HISTORY_FILE, []);
state.learnings           = loadJSON(C.LEARNINGS_FILE, []);
state.installationMap     = loadJSON(C.INSTALLATION_MAP_FILE, {});
state.scheduledTasks      = loadJSON(C.SCHEDULED_TASKS_FILE, {});

try {
  if (fs.existsSync(C.HOUSE_CONTEXT_FILE)) {
    state.houseContext = JSON.parse(fs.readFileSync(C.HOUSE_CONTEXT_FILE, 'utf8')).summary || '';
  }
} catch {}

// ── Express ────────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// ── Log ring buffer ───────────────────────────────────────────────────────────
const MAX_LOGS = 200;
const originalLog = console.log;
console.log = function(...args) {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  state.internalLogs.push({ ts: new Date().toISOString(), msg });
  if (state.internalLogs.length > MAX_LOGS) state.internalLogs.shift();
  originalLog.apply(console, args);
};

console.log(`[init] Memoria: ${state.userMemory.length} notas | Historial: ${state.conversationHistory.length} msgs | Learnings: ${state.learnings.length}`);

// ── Helpers ───────────────────────────────────────────────────────────────────
function saveHistory() {
  const histLimit = state.saverMode ? 10 : 20;
  if (state.conversationHistory.length > histLimit)
    state.conversationHistory = state.conversationHistory.slice(-histLimit);
  saveJSON(C.HISTORY_FILE, state.conversationHistory);
}

function pushToAll(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of state.pushClients) {
    try { res.write(line); } catch { state.pushClients.delete(res); }
  }
}

function calcCost(usage) {
  // costUSD se acumula en llm.js con precios reales por modelo
  return Math.round((usage.costUSD || 0) * 10000) / 10000;
}

// ── Sistema de tareas programadas ─────────────────────────────────────────────
function scheduleTask(taskName, cronExpression, taskFn) {
  const nextRun = calculateNextRun(cronExpression);
  console.log(`[SCHEDULER] Tarea "${taskName}" programada. Próxima ejecución: ${nextRun}`);

  // El require va dentro del try — si node-cron no está instalado, caemos al fallback con setInterval.
  try {
    const cron = require('node-cron');
    cron.schedule(cronExpression, async () => {
      console.log(`[TASK] Ejecutando: ${taskName}`);
      try {
        await taskFn();
        state.scheduledTasks[taskName] = { lastRun: new Date().toISOString(), success: true };
      } catch (e) {
        console.log(`[TASK ERROR] ${taskName}: ${e.message}`);
        state.scheduledTasks[taskName] = { lastRun: new Date().toISOString(), success: false, error: e.message };
      }
      saveJSON(C.SCHEDULED_TASKS_FILE, state.scheduledTasks);
    });
  } catch (e) {
    console.log(`[SCHEDULER] node-cron no disponible (${e.code || 'error'}). Usando setInterval como fallback para "${taskName}".`);
    const interval = parseSimpleCron(cronExpression);
    setInterval(async () => {
      console.log(`[TASK] Ejecutando: ${taskName}`);
      try {
        await taskFn();
        state.scheduledTasks[taskName] = { lastRun: new Date().toISOString(), success: true };
      } catch (err) {
        console.log(`[TASK ERROR] ${taskName}: ${err.message}`);
        state.scheduledTasks[taskName] = { lastRun: new Date().toISOString(), success: false, error: err.message };
      }
      saveJSON(C.SCHEDULED_TASKS_FILE, state.scheduledTasks);
    }, interval);
  }
}

function calculateNextRun(cronExpr) {
  const parts = cronExpr.split(' ');
  if (parts.length === 5) {
    const [minute, hour, day, month, dow] = parts;
    const now = new Date();
    if (dow === '*' || !dow || dow === '?') {
      return `Hoy a las ${hour}:${minute} (aprox)`;
    } else if (dow === '1-5') {
      return `Próximo día laboral a las ${hour}:${minute}`;
    }
  }
  return 'próxima ejecución calculada';
}

function parseSimpleCron(cronExpr) {
  const parts = cronExpr.split(' ');
  if (parts.length === 5) {
    const [minute, hour, day, month, dow] = parts;
    if (hour !== '*' && minute !== '*') {
      const [h, m] = [parseInt(hour), parseInt(minute)];
      const now = new Date();
      let next = new Date(now);
      next.setHours(h, m, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      return Math.max(60000, next - now);
    }
  }
  return 7 * 24 * 60 * 60 * 1000;
}

// ── TTS voces disponibles ─────────────────────────────────────────────────────
const EDGE_VOICES = [
  { id: 'es-ES-AlvaroNeural', name: 'Alvaro', gender: 'M', desc: 'Española natural', engine: 'edge' },
  { id: 'es-ES-ElviraNeural', name: 'Elvira', gender: 'F', desc: 'Española natural', engine: 'edge' },
  { id: 'es-ES-DarioNeural', name: 'Dario', gender: 'M', desc: 'Española joven', engine: 'edge' },
  { id: 'es-ES-IreneNeural', name: 'Irene', gender: 'F', desc: 'Española suave', engine: 'edge' },
  { id: 'es-ES-SaulNeural', name: 'Saul', gender: 'M', desc: 'Española grave', engine: 'edge' },
  { id: 'es-ES-TrianaNeural', name: 'Triana', gender: 'F', desc: 'Española clara', engine: 'edge' },
  { id: 'es-ES-TeoNeural', name: 'Teo', gender: 'M', desc: 'Española calmada', engine: 'edge' },
  { id: 'es-ES-AbrilNeural', name: 'Abril', gender: 'F', desc: 'Española brillante', engine: 'edge' },
];

const OPENAI_VOICES = [
  { id: 'openai:alloy', name: 'Alloy', gender: 'N', desc: 'OpenAI neutra', engine: 'openai' },
  { id: 'openai:ash', name: 'Ash', gender: 'M', desc: 'OpenAI masculina', engine: 'openai' },
  { id: 'openai:coral', name: 'Coral', gender: 'F', desc: 'OpenAI femenina', engine: 'openai' },
  { id: 'openai:echo', name: 'Echo', gender: 'M', desc: 'OpenAI profunda', engine: 'openai' },
  { id: 'openai:fable', name: 'Fable', gender: 'M', desc: 'OpenAI narrativa', engine: 'openai' },
  { id: 'openai:nova', name: 'Nova', gender: 'F', desc: 'OpenAI cálida', engine: 'openai' },
  { id: 'openai:onyx', name: 'Onyx', gender: 'M', desc: 'OpenAI grave', engine: 'openai' },
  { id: 'openai:sage', name: 'Sage', gender: 'F', desc: 'OpenAI clara', engine: 'openai' },
  { id: 'openai:shimmer', name: 'Shimmer', gender: 'F', desc: 'OpenAI brillante', engine: 'openai' },
];

function cleanTTSText(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/#{1,6}\s/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[-•]\s/gm, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .trim()
    .slice(0, 4096);
}

// ── Endpoints ────────────────────────────────────────────────────────────────

// Historial
app.get('/api/history', (req, res) => {
  res.json({ messages: state.conversationHistory });
});

app.delete('/api/history', (req, res) => {
  state.conversationHistory = [];
  saveHistory();
  res.json({ success: true });
});

app.get('/api/pending_task', (req, res) => {
  res.json(loadJSON(C.PENDING_TASK_FILE, { status: 'idle' }));
});

// Respuesta de local_file desde el browser
app.post('/api/local_response', (req, res) => {
  const { requestId, error, ...data } = req.body;
  const pending = state.pendingLocalRequests.get(requestId);
  if (pending) {
    state.pendingLocalRequests.delete(requestId);
    if (error) pending.reject(new Error(error));
    else pending.resolve(data);
  }
  res.json({ ok: true });
});

// Chat principal
app.post('/api/chat', async (req, res) => {
  const { messages, files } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages es requerido' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  state.currentSendEvent = sendEvent;

  try {
    await updateLiveContext();

    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'user') {
      if (files && files.length > 0) {
        const userContent = [];
        if (lastMsg.content) userContent.push({ type: 'text', text: lastMsg.content });

        const uploadsDir = path.join(C.DATA_DIR, 'uploads');
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

        for (const file of files) {
          const mime = file.type || 'application/octet-stream';
          const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');

          if (file.encoding === 'base64' && mime.startsWith('image/')) {
            let b64 = file.content.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
            const safeMime = mime.split(';')[0] || 'image/jpeg';
            const supportedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
            const b64Bytes = b64.length * 0.75;
            console.log(`[image] mime=${safeMime} size=${Math.round(b64Bytes/1024)}KB b64len=${b64.length}`);

            if (!supportedMimes.includes(safeMime)) {
              const filePath = path.join(uploadsDir, safeName);
              fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));
              userContent.push({ type: 'text', text: `📎 Imagen **${file.name}** (${safeMime}) guardada en ${filePath} — formato no soportado por visión, usa read_file o create_custom_tool para procesarla.` });
            } else if (b64Bytes > 4 * 1024 * 1024) {
              const filePath = path.join(uploadsDir, safeName);
              fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));
              userContent.push({ type: 'text', text: `📎 Imagen **${file.name}** demasiado grande (${Math.round(b64Bytes/1024/1024)}MB) guardada en ${filePath}. Usa read_file para describirla o create_custom_tool para procesarla.` });
            } else {
              userContent.push({ type: 'image_url', image_url: { url: `data:${safeMime};base64,${b64}`, detail: 'auto' } });
            }

          } else if (file.encoding === 'base64') {
            const filePath = path.join(uploadsDir, safeName);
            try {
              fs.writeFileSync(filePath, Buffer.from(file.content, 'base64'));
              const raw = fs.readFileSync(filePath);
              const text = raw.toString('utf8').replace(/\0/g, '');
              const isPrintable = text.length > 0 && (text.match(/[\x20-\x7E\n\r\t]/g) || []).length / text.length > 0.7;
              if (isPrintable) {
                const truncated = text.length > 60000 ? text.slice(0, 60000) + '\n...[truncado]' : text;
                userContent.push({ type: 'text', text: `📎 **${file.name}** (guardado en ${filePath}):\n\`\`\`\n${truncated}\n\`\`\`` });
              } else {
                userContent.push({ type: 'text', text: `📎 **${file.name}** guardado en ${filePath} (${mime}). Usa read_file("${filePath}") para acceder a su contenido o create_custom_tool para procesarlo.` });
              }
            } catch (e) {
              userContent.push({ type: 'text', text: `📎 **${file.name}** (${mime}) — error guardando: ${e.message}` });
            }

          } else {
            const truncated = file.content.length > 60000 ? file.content.slice(0, 60000) + '\n...[truncado]' : file.content;
            userContent.push({ type: 'text', text: `📎 **${file.name}**\n\`\`\`\n${truncated}\n\`\`\`` });
          }
        }
        state.conversationHistory.push({ role: 'user', content: userContent });
      } else {
        state.conversationHistory.push(lastMsg);
      }
      saveHistory();
    }

    const userMsg = lastMsg?.content || '';
    state.lastUserActivity = Date.now(); // para que proactive sepa si el usuario está activo
    saveJSON(C.PENDING_TASK_FILE, { status: 'running', message: userMsg, startedAt: new Date().toISOString() });

    // NEXUS: Router dinámico
    let nexusExpertName = 'ha_control';
    if (!state.saverMode) {
      try {
        const route = await nexusRoute(lastMsg?.content || '');
        nexusExpertName = nexusPickExpert(route.expert);
        console.log(`[nexus] Expert: ${nexusExpertName} (${route.source}, conf=${route.confidence})`);
      } catch (e) {
        console.log(`[nexus] Router error → ha_control: ${e.message}`);
      }
    } else {
      nexusExpertName = 'rapido';
    }
    const nexusExpert = nexusGetAllExperts()[nexusExpertName] || EXPERTS.ha_control;
    const activeModel = nexusExpert.model;
    const activeMaxTokens = nexusExpert.maxTokens;
    const activeMaxIter = nexusExpert.maxIter;
    const layerInfo = nexusLogLayerStats(nexusExpertName);
    console.log(`[nexus] ${nexusExpert.label} | model=${activeModel} | health=${nexusGetScore(nexusExpertName)} | tools=${layerInfo.tools}/${layerInfo.toolsTotal}`);

    // Bloque B: tool scoping — solo las tools del experto activo
    const scopedTools = nexusGetToolsForExpert(nexusExpertName);

    let currentMessages = [...state.conversationHistory];
    let finalText = '';
    let iterations = 0;
    const MAX_ITERATIONS = state.saverMode ? 8 : activeMaxIter;
    let consecutiveTextOnly = 0;
    let lastToolSignature = '';
    // Bloque B: assembleSystemPrompt ya integra L0-L4 (incluye buildDynamicContext via L2)
    const systemPrompt = nexusAssemblePrompt(nexusExpertName);

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      let result;
      try {
        // Bloque B: callLLM enruta a OpenAI o Anthropic según el modelo del experto
        result = await callLLM(activeModel, systemPrompt, currentMessages, scopedTools, activeMaxTokens);
      } catch (err) {
        console.log(`[jarvis] Error API iter=${iterations}: ${err.message}`);
        if (err.message.includes('429') || err.message.includes('503')) {
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
        if (err.message.includes('base64') || err.message.includes('image') || err.message.includes('invalid_value')) {
          console.log('[jarvis] Error de imagen — limpiando historial y reintentando sin imágenes...');
          stripImagesFromHistory();
          currentMessages = sanitizeMessagesForOpenAI([...state.conversationHistory], true);
          try {
            result = await callLLM(activeModel, systemPrompt, currentMessages, scopedTools, activeMaxTokens);
          } catch (err2) {
            sendEvent({ type: 'error', error: `Error API: ${err2.message}` });
            break;
          }
        } else {
          sendEvent({ type: 'error', error: `Error API: ${err.message}` });
          break;
        }
      }

      console.log(`[jarvis] iter=${iterations} finish=${result.finishReason} tools=${result.toolCalls.length} tokens=${result.usage.prompt_tokens}+${result.usage.completion_tokens} cost=$${state.apiUsage.costUSD?.toFixed(4)||0}`);

      if (result.text) {
        finalText += result.text;
        sendEvent({ type: 'text', text: result.text });
      }

      if (result.toolCalls.length === 0) {
        if (result.finishReason === 'stop') break;

        if (result.finishReason === 'length') {
          currentMessages.push(result.message);
          currentMessages.push({ role: 'user', content: 'Continúa con la tarea. No te has detenido por instrucción mía.' });
          console.log(`[jarvis] length en iter=${iterations}, inyectando continuación`);
          continue;
        }

        consecutiveTextOnly++;
        if (consecutiveTextOnly >= 2) break;

        currentMessages.push(result.message);
        currentMessages.push({ role: 'user', content: 'Continúa ejecutando los pasos necesarios para completar la tarea.' });
        continue;
      }

      consecutiveTextOnly = 0;

      for (const tc of result.toolCalls) {
        sendEvent({ type: 'tool_start', tool: tc.name, input: tc.input });
      }

      // Detectar chattering real: misma tool + mismos inputs (no solo nombre de tool)
      // Un read_file('/a.yaml') seguido de read_file('/b.yaml') NO es chattering
      const currentToolSig = result.toolCalls
        .map(tc => tc.name + ':' + JSON.stringify(tc.input)).sort().join('|');
      if (currentToolSig === lastToolSignature && iterations > 2) {
        console.log(`[jarvis] Chattering detectado (misma tool+input x2) en iter=${iterations}. Deteniendo.`);
        sendEvent({ type: 'text', text: '\n\n⚠️ Detecté que estaba repitiendo exactamente la misma acción. Parando para evitar un bucle.' });
        break;
      }
      lastToolSignature = currentToolSig;

      // Ejecutar tools con timeout individual de 45s
      const results = await Promise.all(
        result.toolCalls.map(async tc => {
          try {
            const toolPromise = executeTool(tc.name, tc.input);
            const timeoutPromise = new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`Tool "${tc.name}" timeout (45s)`)), 45000)
            );
            return await Promise.race([toolPromise, timeoutPromise]);
          } catch (err) {
            console.log(`[jarvis] Tool ${tc.name} falló: ${err.message}`);
            return { error: err.message, hint: 'Prueba una aproximación alternativa.' };
          }
        })
      );

      currentMessages.push(result.message);

      const maxLen = state.saverMode ? 1500 : (activeModel === C.BG_MODEL ? 2000 : 3000);
      for (let i = 0; i < result.toolCalls.length; i++) {
        const tc = result.toolCalls[i];
        sendEvent({ type: 'tool_end', tool: tc.name, result: results[i] });
        const raw = JSON.stringify(results[i]);
        const content = raw.length > maxLen ? raw.slice(0, maxLen) + '\n...[truncado para ahorrar tokens]' : raw;
        currentMessages.push({ role: 'tool', tool_call_id: tc.id, content });
      }
    }

    if (iterations >= MAX_ITERATIONS) {
      console.log(`[claude] Límite de ${MAX_ITERATIONS} iteraciones alcanzado`);
      sendEvent({ type: 'text', text: '\n\n⚠️ Tarea muy larga — he llegado al límite de pasos. Dime si quiero continuar.' });
    }

    if (finalText) {
      state.conversationHistory.push({ role: 'assistant', content: finalText });
      saveHistory();
      const hadCorrection = finalText.toLowerCase().includes('perdona') || finalText.toLowerCase().includes('tienes raz');
      nexusEvolutionTick(nexusExpertName, true, hadCorrection);
    }

    saveJSON(C.PENDING_TASK_FILE, { status: 'idle' });

    sendEvent({ type: 'done' });
    res.end();
  } catch (err) {
    console.log(`[chat] Error: ${err.message}`);
    sendEvent({ type: 'error', error: err.message });
    res.end();
  } finally {
    state.currentSendEvent = null;
  }
});

// ── Estado rápido de la casa ──────────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  try {
    const states = await haGet('/states');
    const lights = states.filter(e => e.entity_id.startsWith('light.'));
    const lightsOn = lights.filter(e => e.state === 'on');
    const temps = states.filter(e =>
      e.entity_id.startsWith('sensor.') &&
      e.attributes?.unit_of_measurement === '°C' &&
      e.attributes?.device_class === 'temperature' &&
      !isNaN(parseFloat(e.state))
    ).slice(0, 6).map(t => ({
      name: (t.attributes.friendly_name || t.entity_id).replace(/temperatura/i, '').trim(),
      value: parseFloat(t.state).toFixed(1),
      unit: '°C'
    }));
    const persons = states.filter(e => e.entity_id.startsWith('person.')).map(p => ({
      name: p.attributes.friendly_name || p.entity_id,
      state: p.state
    }));
    const unavailable = states.filter(e =>
      ['unavailable', 'unknown'].includes(e.state) &&
      (e.entity_id.startsWith('sensor.') || e.entity_id.startsWith('binary_sensor.') ||
       e.entity_id.startsWith('light.') || e.entity_id.startsWith('switch.'))
    ).length;
    const mediaPlaying = states.filter(e =>
      e.entity_id.startsWith('media_player.') && e.state === 'playing'
    ).map(m => ({ name: m.attributes.friendly_name || m.entity_id, media: m.attributes.media_title || '' }));
    const thoughts = loadJSON(path.join(C.DATA_DIR, 'pending_thoughts.json'), []).filter(t => t.status === 'pending');
    const activeEmergencies = loadJSON(path.join(C.DATA_DIR, 'active_emergencies.json'), {});

    res.json({
      lights: { on: lightsOn.length, total: lights.length, names: lightsOn.slice(0, 5).map(l => l.attributes.friendly_name || l.entity_id) },
      temperature: temps,
      persons,
      unavailable,
      media: mediaPlaying,
      pending_thoughts: thoughts.slice(0, 3).map(t => ({ title: t.title, priority: t.priority, type: t.type })),
      active_emergencies: Object.keys(activeEmergencies).length,
      ts: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Sugerencias contextuales ──────────────────────────────────────────────────
app.get('/api/suggestions', async (req, res) => {
  const hour = new Date().getHours();
  const suggestions = [];

  try {
    const states = await haGet('/states');
    const lightsOn = states.filter(e => e.entity_id.startsWith('light.') && e.state === 'on').length;
    const unavailable = states.filter(e => ['unavailable','unknown'].includes(e.state)).length;
    const thoughts = loadJSON(path.join(C.DATA_DIR, 'pending_thoughts.json'), []).filter(t => t.status === 'pending');

    if (hour >= 6 && hour < 10) {
      suggestions.push('☀️ Buenos días, ¿cómo está la casa?');
      suggestions.push('🌡️ ¿Qué temperatura hace esta mañana?');
      suggestions.push('📊 Resumen de la noche');
    } else if (hour >= 10 && hour < 14) {
      suggestions.push('💡 ¿Qué luces están encendidas?');
      suggestions.push('⚡ ¿Cuánto estoy consumiendo?');
      suggestions.push('🔌 Estado de los enchufes');
    } else if (hour >= 14 && hour < 18) {
      suggestions.push('🌡️ ¿Temperatura en todas las habitaciones?');
      suggestions.push('🤖 Revisa mis automatizaciones');
      suggestions.push('📈 Análisis de consumo del día');
    } else if (hour >= 18 && hour < 22) {
      suggestions.push('🎬 Modo cine en el salón');
      suggestions.push('💡 Luces de ambiente para la noche');
      suggestions.push('🔒 ¿Está todo cerrado?');
    } else {
      suggestions.push('🌙 Modo noche — apaga todo');
      suggestions.push('🔒 Comprueba puertas y ventanas');
      suggestions.push('⏰ ¿Alguna automatización activa ahora?');
    }

    if (lightsOn > 5) suggestions.push(`💡 Hay ${lightsOn} luces encendidas, ¿apago las innecesarias?`);
    if (unavailable > 10) suggestions.push(`⚠️ ${unavailable} dispositivos no responden, ¿lo reviso?`);
    if (thoughts.length > 0) suggestions.push(`💭 Tengo ${thoughts.length} sugerencia${thoughts.length > 1 ? 's' : ''} pendiente${thoughts.length > 1 ? 's' : ''} para ti`);

    res.json({ suggestions: suggestions.slice(0, 6), hour });
  } catch (e) {
    res.json({ suggestions: [
      '💡 Enciende las luces del salón',
      '🌡️ ¿Qué temperatura hace en casa?',
      '🤖 Muéstrame mis automatizaciones',
      '📊 Estado general de la casa'
    ], hour });
  }
});

// ── Voz bidireccional Alexa ───────────────────────────────────────────────────
app.post('/api/alexa-voice', async (req, res) => {
  const { command, source_echo } = req.body || {};
  if (!command) return res.status(400).json({ error: 'command requerido' });

  const pending = loadJSON(C.ALEXA_VOICE_FILE, []);
  const entry = { command, source_echo: source_echo || 'unknown', received_at: new Date().toISOString(), processed: false };
  pending.push(entry);
  if (pending.length > 20) pending.splice(0, pending.length - 20);
  saveJSON(C.ALEXA_VOICE_FILE, pending);
  console.log(`[alexa-voice] Comando recibido: "${command}" desde ${source_echo}`);

  (async () => {
    try {
      entry.processed = true;
      saveJSON(C.ALEXA_VOICE_FILE, pending);
    } catch (e) {
      console.log(`[alexa-voice] Error procesando: ${e.message}`);
    }
  })();

  res.json({ received: true, command });
});

// ── Mapa 3D de la casa ────────────────────────────────────────────────────────
const HOUSE_3D_CONFIG_FILE = path.join(C.DATA_DIR, 'house_3d_config.json');

app.get('/api/3d-map-config', (req, res) => {
  const cfg = fs.existsSync(HOUSE_3D_CONFIG_FILE)
    ? JSON.parse(fs.readFileSync(HOUSE_3D_CONFIG_FILE, 'utf8'))
    : { rooms: [] };
  res.json(cfg);
});

app.get('/api/ha-states-simple', async (req, res) => {
  try {
    const states = await haGet('/states');
    const map = {};
    for (const s of states) map[s.entity_id] = s.state;
    res.json(map);
  } catch (e) {
    res.json({});
  }
});

// ── Historial y estadísticas de reviews de dashboards ────────────────────────
app.get('/api/dashboard-reviews', (req, res) => {
  try {
    const reviews = loadJSON(C.DASHBOARD_REVIEWS_FILE, []);

    let totalReviews = reviews.length;
    let avgCritical = 0, avgWarnings = 0, avgSuggestions = 0;
    let criticalTrend = 0, warningsTrend = 0;

    if (totalReviews > 0) {
      avgCritical = Math.round(reviews.reduce((s, r) => s + (r.critical_issues || 0), 0) / totalReviews);
      avgWarnings = Math.round(reviews.reduce((s, r) => s + (r.warnings || 0), 0) / totalReviews);
      avgSuggestions = Math.round(reviews.reduce((s, r) => s + (r.suggestions || 0), 0) / totalReviews);

      if (totalReviews >= 4) {
        const firstTwo = reviews.slice(0, 2);
        const lastTwo = reviews.slice(-2);
        const avgFirstCritical = Math.round(firstTwo.reduce((s, r) => s + (r.critical_issues || 0), 0) / 2);
        const avgLastCritical = Math.round(lastTwo.reduce((s, r) => s + (r.critical_issues || 0), 0) / 2);
        criticalTrend = avgFirstCritical - avgLastCritical;

        const avgFirstWarnings = Math.round(firstTwo.reduce((s, r) => s + (r.warnings || 0), 0) / 2);
        const avgLastWarnings = Math.round(lastTwo.reduce((s, r) => s + (r.warnings || 0), 0) / 2);
        warningsTrend = avgFirstWarnings - avgLastWarnings;
      }
    }

    const recent = reviews.slice(-5).map(r => ({
      timestamp: r.timestamp,
      critical: r.critical_issues || 0,
      warnings: r.warnings || 0,
      suggestions: r.suggestions || 0,
      dashboards: r.dashboards_analyzed || r.dashboards_count || 0
    }));

    res.json({
      total_reviews: totalReviews,
      last_review: reviews.length > 0 ? reviews[reviews.length - 1].timestamp : null,
      statistics: {
        avg_critical: avgCritical,
        avg_warnings: avgWarnings,
        avg_suggestions: avgSuggestions
      },
      trends: {
        critical_improvement: criticalTrend > 0 ? `↓ ${criticalTrend} críticos` : criticalTrend < 0 ? `↑ ${Math.abs(criticalTrend)} críticos` : 'Sin cambio',
        warnings_improvement: warningsTrend > 0 ? `↓ ${warningsTrend} advertencias` : warningsTrend < 0 ? `↑ ${Math.abs(warningsTrend)} advertencias` : 'Sin cambio'
      },
      recent_reviews: recent
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Visor 3D Three.js
app.get('/3d-map', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Jarvis — Mapa 3D</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#0d1117;font-family:'DM Sans',system-ui,sans-serif;overflow:hidden}
    canvas{display:block;width:100vw;height:100vh}
    #hud{position:fixed;top:12px;left:12px;color:#8b949e;font-size:11px;font-family:monospace;pointer-events:none}
    #legend{position:fixed;bottom:16px;right:16px;background:rgba(22,27,34,0.92);border:1px solid #30363d;border-radius:10px;padding:10px 14px;font-size:10px;color:#8b949e;pointer-events:none}
    .li{display:flex;align-items:center;gap:7px;margin:3px 0}
    .ld{width:10px;height:10px;border-radius:2px;flex-shrink:0}
    #tooltip{position:fixed;background:rgba(22,27,34,0.96);border:1px solid #30363d;border-radius:8px;padding:8px 12px;font-size:11px;color:#e6edf3;pointer-events:none;display:none;z-index:100;line-height:1.5}
    #hint{position:fixed;bottom:16px;left:16px;color:#30363d;font-size:10px;pointer-events:none}
    #refresh{position:fixed;top:12px;right:12px;background:rgba(22,27,34,0.8);border:1px solid #30363d;color:#8b949e;font-size:10px;padding:5px 10px;border-radius:7px;cursor:pointer}
    #refresh:hover{border-color:#58a6ff;color:#58a6ff}
  </style>
</head>
<body>
<canvas id="c"></canvas>
<div id="hud">🏠 Jarvis — Mapa 3D · <span id="room-count">cargando...</span></div>
<div id="tooltip"></div>
<div id="legend">
  <div class="li"><div class="ld" style="background:#6b5410"></div>Luces encendidas</div>
  <div class="li"><div class="ld" style="background:#0d2240"></div>Presencia detectada</div>
  <div class="li"><div class="ld" style="background:#1a2744"></div>Sin actividad</div>
</div>
<div id="hint">Rotar: arrastrar · Zoom: rueda · Pan: Shift+arrastrar</div>
<button id="refresh" onclick="loadStates()">↻ Actualizar</button>
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r134/three.min.js"></script>
<script>
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({canvas, antialias:true});
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x0d1117);
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth/window.innerHeight, 0.1, 1000);
const ambient = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambient);
const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
dirLight.position.set(15, 25, 15);
dirLight.castShadow = true;
scene.add(dirLight);
const grid = new THREE.GridHelper(60, 30, 0x21262d, 0x161b22);
scene.add(grid);

let azimuth = Math.PI/5, elevation = Math.PI/4.5, radius = 24, tx = 0, tz = 0;
function updateCam() {
  camera.position.set(tx + radius*Math.sin(azimuth)*Math.cos(elevation), radius*Math.sin(elevation)+2, tz + radius*Math.cos(azimuth)*Math.cos(elevation));
  camera.lookAt(tx, 1.5, tz);
}
updateCam();

let drag = false, lastX = 0, lastY = 0, shiftDown = false;
canvas.addEventListener('mousedown', e=>{drag=true;lastX=e.clientX;lastY=e.clientY;shiftDown=e.shiftKey});
canvas.addEventListener('mouseup', ()=>drag=false);
canvas.addEventListener('mouseleave', ()=>drag=false);
canvas.addEventListener('mousemove', e=>{
  if(!drag) return;
  const dx=(e.clientX-lastX)*0.006, dy=(e.clientY-lastY)*0.006;
  if(shiftDown||e.buttons===4){tx-=Math.cos(azimuth)*dx*radius*0.3;tz+=Math.sin(azimuth)*dx*radius*0.3;}
  else{azimuth+=dx;elevation=Math.max(0.05,Math.min(Math.PI/2.1,elevation-dy));}
  lastX=e.clientX;lastY=e.clientY;updateCam();
});
canvas.addEventListener('wheel', e=>{radius=Math.max(2,Math.min(100,radius+e.deltaY*0.05));updateCam();e.preventDefault();},{passive:false});

const rooms = new Map();
const labelEls = [];

function hex3(hex){return new THREE.Color(parseInt(hex.replace('#',''),16));}

function addRoom(r) {
  const w=r.width||3, d=r.depth||3, h=r.height||2.5;
  const flY=(r.floor||0)*(h+0.4);
  const cx=(r.x||0)+w/2, cz=(r.y||0)+d/2;
  const baseColor = r.color ? hex3(r.color) : new THREE.Color(0x1a2744);

  const floorGeo = new THREE.BoxGeometry(w-0.06, 0.06, d-0.06);
  const floorMat = new THREE.MeshLambertMaterial({color: baseColor.clone()});
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.position.set(cx, flY, cz);
  floor.receiveShadow = true;
  scene.add(floor);

  const wh = h*0.88;
  const wallMat = new THREE.MeshLambertMaterial({color: baseColor.clone(), transparent:true, opacity:0.28, side:THREE.DoubleSide});
  [[cx,flY+wh/2+0.03,cz+d/2,w,wh,0.05],[cx,flY+wh/2+0.03,cz-d/2,w,wh,0.05],[cx+w/2,flY+wh/2+0.03,cz,0.05,wh,d],[cx-w/2,flY+wh/2+0.03,cz,0.05,wh,d]].forEach(([x,y,z,gw,gh,gd])=>{
    const m = new THREE.Mesh(new THREE.BoxGeometry(gw,gh,gd), wallMat.clone());
    m.position.set(x,y,z);
    scene.add(m);
  });

  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w,0.06,d)), new THREE.LineBasicMaterial({color:0x30363d}));
  edges.position.set(cx,flY,cz);
  scene.add(edges);

  const lbl = document.createElement('div');
  lbl.style.cssText='position:fixed;background:rgba(13,17,23,0.85);color:#c9d1d9;font-size:9px;padding:2px 6px;border-radius:4px;pointer-events:none;white-space:nowrap;font-family:DM Sans,system-ui';
  lbl.textContent = r.name;
  document.body.appendChild(lbl);
  labelEls.push({el:lbl, x:cx, y:flY+h+0.5, z:cz});

  rooms.set(r.id, {floor, wallMat, room:r, baseColor:baseColor.clone(), cx, cz, flY});
}

function project(x,y,z){
  const v=new THREE.Vector3(x,y,z).project(camera);
  return{sx:(v.x*.5+.5)*window.innerWidth,sy:(-v.y*.5+.5)*window.innerHeight,behind:v.z>1};
}

let haStates = {};

async function loadConfig() {
  try {
    const res = await fetch('api/3d-map-config');
    const cfg = await res.json();
    for(const r of (cfg.rooms||[])) addRoom(r);
    document.getElementById('room-count').textContent = (cfg.rooms||[]).length + ' habitaciones';
    if(!(cfg.rooms||[]).length) showNoConfig();
  } catch(e) { showNoConfig(); }
}

function showNoConfig() {
  document.getElementById('room-count').textContent = 'sin configurar';
  const d = document.createElement('div');
  d.style.cssText='position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(22,27,34,0.95);border:1px solid #30363d;border-radius:12px;padding:24px 32px;color:#8b949e;font-size:13px;text-align:center;pointer-events:none;line-height:1.7';
  d.innerHTML='🏠 <b style="color:#e6edf3;font-size:15px">Mapa sin configurar</b><br>Dile a Jarvis:<br><i style="color:#58a6ff">«Crea el mapa 3D de mi casa»</i><br>y descríbele las habitaciones.';
  document.body.appendChild(d);
}

async function loadStates() {
  try {
    const res = await fetch('api/ha-states-simple');
    haStates = await res.json();
    updateColors();
  } catch {}
}

function updateColors() {
  for(const [id,{floor,wallMat,room,baseColor}] of rooms) {
    const ents = room.entities||[];
    const hasLight = ents.some(e=>e.startsWith('light.')&&haStates[e]==='on');
    const hasPresence = ents.some(e=>(e.startsWith('binary_sensor.')||e.startsWith('person.'))&&(haStates[e]==='on'||haStates[e]==='home'));
    if(hasLight){
      floor.material.color.set(0x6b5410);
    } else if(hasPresence){
      floor.material.color.set(0x0d2240);
    } else {
      floor.material.color.copy(baseColor);
    }
  }
}

const ray = new THREE.Raycaster();
const mouse = new THREE.Vector2();
canvas.addEventListener('mousemove', e=>{
  mouse.x=(e.clientX/window.innerWidth)*2-1;
  mouse.y=-(e.clientY/window.innerHeight)*2+1;
  ray.setFromCamera(mouse, camera);
  const meshes=[...rooms.values()].map(r=>r.floor);
  const hits=ray.intersectObjects(meshes);
  const tt=document.getElementById('tooltip');
  if(hits.length){
    const entry=[...rooms.values()].find(r=>r.floor===hits[0].object);
    if(entry){
      const {room}=entry;
      const active=(room.entities||[]).filter(e=>['on','home','playing','open'].includes(haStates[e])).length;
      tt.style.display='block';
      tt.style.left=(e.clientX+14)+'px';
      tt.style.top=(e.clientY-8)+'px';
      tt.innerHTML='<b>'+room.name+'</b><br>'+(room.entities?.length||0)+' entidades · '+active+' activas';
    }
  } else tt.style.display='none';
});

function animate(){
  requestAnimationFrame(animate);
  for(const {el,x,y,z} of labelEls){
    const p=project(x,y,z);
    if(p.behind){el.style.display='none';}
    else{el.style.display='block';el.style.left=(p.sx-el.offsetWidth/2)+'px';el.style.top=(p.sy-8)+'px';}
  }
  renderer.render(scene,camera);
}

window.addEventListener('resize',()=>{
  camera.aspect=window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth,window.innerHeight);
});

loadConfig();
loadStates();
setInterval(loadStates, 15000);
animate();
</script>
</body>
</html>`);
});

// ── Chat flotante — widget JS para HA ──────────────────────────────────────
// Sirve el widget JS. También puede escribirse en /config/www/ con /api/widget-install.
const WIDGET_JS = `
/* Jarvis Floating Chat Widget — auto-generado por Jarvis v${state.JARVIS_VERSION} */
(function() {
  if (document.getElementById('jarvis-float-root')) return; // ya instalado

  const PORT = 3000;
  const BASE = window.location.protocol + '//' + window.location.hostname + ':' + PORT;

  // ── Estilos ──
  const style = document.createElement('style');
  style.textContent = \`
    #jarvis-float-btn {
      position: fixed; bottom: 22px; right: 22px; z-index: 9000;
      width: 52px; height: 52px; border-radius: 50%;
      background: linear-gradient(135deg,#6c8ef7,#a78bfa);
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; box-shadow: 0 4px 20px rgba(108,142,247,0.5);
      font-size: 22px; transition: transform .2s,box-shadow .2s;
      border: none; outline: none; user-select: none;
    }
    #jarvis-float-btn:hover { transform: scale(1.08); box-shadow: 0 6px 28px rgba(108,142,247,0.7); }
    #jarvis-float-btn.open { transform: scale(0.92); }
    #jarvis-float-drawer {
      position: fixed; top: 0; right: 0; bottom: 0; z-index: 8999;
      width: 420px; max-width: 95vw;
      background: #0f1117;
      box-shadow: -4px 0 40px rgba(0,0,0,0.6);
      transform: translateX(102%);
      transition: transform .3s cubic-bezier(.4,0,.2,1);
      display: flex; flex-direction: column;
      border-left: 1px solid rgba(108,142,247,0.2);
    }
    #jarvis-float-drawer.open { transform: translateX(0); }
    #jarvis-float-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px; background: #161b27;
      border-bottom: 1px solid rgba(108,142,247,0.15);
      flex-shrink: 0;
    }
    #jarvis-float-header span { color:#6c8ef7; font-size:13px; font-weight:600; font-family:system-ui; }
    #jarvis-float-close {
      background: none; border: none; color: #8892aa;
      cursor: pointer; font-size: 18px; line-height: 1; padding: 2px 6px;
      border-radius: 6px; transition: color .15s, background .15s;
    }
    #jarvis-float-close:hover { color: #fff; background: rgba(255,255,255,0.08); }
    #jarvis-float-frame {
      flex: 1; border: none; width: 100%; height: 100%; display: block;
    }
    #jarvis-float-overlay {
      display: none; position: fixed; inset: 0; z-index: 8998;
      background: rgba(0,0,0,0.35); transition: opacity .3s;
    }
    #jarvis-float-overlay.open { display: block; }
  \`;
  document.head.appendChild(style);

  // ── DOM ──
  const root = document.createElement('div');
  root.id = 'jarvis-float-root';

  const overlay = document.createElement('div');
  overlay.id = 'jarvis-float-overlay';

  const btn = document.createElement('button');
  btn.id = 'jarvis-float-btn';
  btn.title = 'Abrir Jarvis';
  btn.innerHTML = '🤖';

  const drawer = document.createElement('div');
  drawer.id = 'jarvis-float-drawer';
  drawer.innerHTML = \`
    <div id="jarvis-float-header">
      <span>⚡ Jarvis</span>
      <button id="jarvis-float-close" title="Cerrar">✕</button>
    </div>
    <iframe id="jarvis-float-frame" src="about:blank" allow="microphone"></iframe>
  \`;

  root.appendChild(overlay);
  root.appendChild(btn);
  root.appendChild(drawer);
  document.body.appendChild(root);

  // ── Lógica ──
  let open = false;
  let loaded = false;

  function toggle() {
    open = !open;
    drawer.classList.toggle('open', open);
    overlay.classList.toggle('open', open);
    btn.classList.toggle('open', open);
    btn.innerHTML = open ? '✕' : '🤖';
    if (open && !loaded) {
      document.getElementById('jarvis-float-frame').src = BASE + '/?embed=1';
      loaded = true;
    }
  }

  btn.addEventListener('click', toggle);
  overlay.addEventListener('click', toggle);
  document.getElementById('jarvis-float-close').addEventListener('click', toggle);

  // Cerrar con Escape
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) toggle(); });
})();
`;

app.get('/widget.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(WIDGET_JS);
});

app.post('/api/widget-install', async (req, res) => {
  try {
    const wwwDir = path.join(C.HA_CONFIG, 'www');
    if (!fs.existsSync(wwwDir)) fs.mkdirSync(wwwDir, { recursive: true });

    // Escribir el widget JS
    const widgetPath = path.join(wwwDir, 'jarvis-widget.js');
    fs.writeFileSync(widgetPath, WIDGET_JS, 'utf8');

    // Parchear configuration.yaml para añadir extra_module_url
    const configPath = path.join(C.HA_CONFIG, 'configuration.yaml');
    let cfg = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
    const widgetUrl = '/local/jarvis-widget.js';

    if (!cfg.includes('jarvis-widget')) {
      if (cfg.includes('extra_module_url:')) {
        // Ya existe extra_module_url — añadir el widget a la lista
        cfg = cfg.replace(/extra_module_url:\s*\n((\s+-[^\n]+\n)*)/,
          (m) => m + `  - ${widgetUrl}\n`);
      } else if (cfg.includes('frontend:')) {
        // Ya existe bloque frontend — añadir extra_module_url
        cfg = cfg.replace(/frontend:\s*\n/, `frontend:\n  extra_module_url:\n    - ${widgetUrl}\n`);
      } else {
        // No existe frontend — añadir al final
        cfg += `\nfrontend:\n  extra_module_url:\n    - ${widgetUrl}\n`;
      }
      fs.writeFileSync(configPath, cfg, 'utf8');
    }

    res.json({ ok: true, widgetPath, widgetUrl });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Health
app.get('/api/health', (req, res) => {
  const cost = calcCost(state.apiUsage);
  res.json({
    status: 'ok',
    version: state.JARVIS_VERSION,
    agent_type: 'jarvis',
    model: state.saverMode ? C.BG_MODEL : C.MODEL,
    saver_mode: state.saverMode,
    memories: state.userMemory.length,
    learnings: state.learnings.length,
    history: state.conversationHistory.length,
    ha_connected: !!state.liveContext,
    api_key_set: !!C.ANTHROPIC_API_KEY,
    uptime: Math.floor(process.uptime()) + 's',
    api_usage: { ...state.apiUsage, cost_usd: cost }
  });
});

// Coste de sesión para HA REST sensor
app.get('/api/cost', (req, res) => {
  const cost = calcCost(state.apiUsage);
  res.json({
    state: cost.toFixed(4),
    unit_of_measurement: 'USD',
    attributes: {
      calls: state.apiUsage.calls,
      input_tokens: state.apiUsage.inputTokens,
      output_tokens: state.apiUsage.outputTokens,
      cache_read_tokens: state.apiUsage.cacheReadTokens,
      cache_creation_tokens: state.apiUsage.cacheCreationTokens,
      saver_mode: state.saverMode,
      model: state.saverMode ? C.BG_MODEL : C.MODEL,
      since: state.apiUsage.lastReset
    }
  });
});

// TTS status
app.get('/api/tts/status', (req, res) => {
  const engines = ['edge-tts'];
  if (C.OPENAI_API_KEY) engines.push('openai');
  res.json({ available: true, engines });
});

app.get('/api/tts/voices', (req, res) => {
  const voices = [...EDGE_VOICES];
  if (C.OPENAI_API_KEY) voices.push(...OPENAI_VOICES);
  res.json({ voices });
});

app.post('/api/tts', async (req, res) => {
  const { text, voice = 'es-ES-AlvaroNeural' } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text requerido' });

  const clean = cleanTTSText(text);
  if (!clean) return res.status(400).json({ error: 'text vacío tras limpiar' });

  try {
    if (voice.startsWith('openai:')) {
      if (!C.OPENAI_API_KEY) return res.status(400).json({ error: 'OpenAI API key no configurada' });
      const openaiVoice = voice.replace('openai:', '');
      const oaiRes = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { Authorization: `Bearer ${C.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'tts-1', input: clean, voice: openaiVoice, response_format: 'mp3' })
      });
      if (!oaiRes.ok) {
        const errText = await oaiRes.text();
        console.error('[tts] OpenAI error:', oaiRes.status, errText);
        return res.status(500).json({ error: `OpenAI TTS error: ${oaiRes.status}` });
      }
      res.setHeader('Content-Type', 'audio/mpeg');
      oaiRes.body.pipe(res);
      return;
    }

    const tts = new EdgeTTS({ voice, lang: 'es-ES', outputFormat: 'audio-24khz-48kbitrate-mono-mp3' });
    const tmpFile = `/tmp/tts-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`;
    await tts.ttsPromise(clean, tmpFile);

    res.setHeader('Content-Type', 'audio/mpeg');
    const stream = fs.createReadStream(tmpFile);
    stream.pipe(res);
    stream.on('end', () => fs.unlink(tmpFile, () => {}));
    stream.on('error', () => { fs.unlink(tmpFile, () => {}); res.status(500).end(); });
  } catch (err) {
    console.error('[tts] TTS error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Whisper STT — transcripción de audio del usuario ────────────────────────
// El frontend envía audio base64 (desde MediaRecorder) en JSON: { audio: 'data:audio/webm;base64,...', language?: 'es' }
// O bytes raw multipart/form-data si en el futuro se prefiere subida directa.
app.post('/api/transcribe', async (req, res) => {
  try {
    if (!C.OPENAI_API_KEY) return res.status(400).json({ error: 'OPENAI_API_KEY no configurada' });

    const { audio, language = 'es', filename } = req.body || {};
    if (!audio) return res.status(400).json({ error: 'audio (base64) requerido' });

    // Aceptar tanto data URL como base64 puro
    const m = audio.match(/^data:([^;]+);base64,(.+)$/s);
    const mime = m ? m[1] : 'audio/webm';
    const b64  = m ? m[2] : audio;
    const buffer = Buffer.from(b64, 'base64');

    // Adivinar extensión por mime
    const ext = mime.includes('webm') ? 'webm'
              : mime.includes('mp3')  ? 'mp3'
              : mime.includes('wav')  ? 'wav'
              : mime.includes('mp4')  ? 'mp4'
              : mime.includes('m4a')  ? 'm4a'
              : mime.includes('ogg')  ? 'ogg' : 'webm';

    const fname = filename || `voz-${Date.now()}.${ext}`;
    console.log(`[whisper] Transcribiendo ${Math.round(buffer.length/1024)}KB (${mime}) lang=${language}`);

    const result = await callWhisper(buffer, fname, language);
    console.log(`[whisper] → "${result.text.slice(0, 80)}..."`);
    res.json({ text: result.text, language: result.language });
  } catch (e) {
    console.error('[whisper] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GetawayAgentes — estado de la red de agentes ────────────────────────────
app.get('/api/agent_network/status', (req, res) => {
  try { res.json(agentNetwork.statusInfo()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});


// Modo ahorro
app.post('/api/saver', (req, res) => {
  state.saverMode = req.body.enabled !== undefined ? !!req.body.enabled : !state.saverMode;
  console.log(`[saver] Modo ahorro ${state.saverMode ? 'ACTIVADO' : 'desactivado'}`);
  res.json({ saver_mode: state.saverMode, model: state.saverMode ? C.BG_MODEL : C.MODEL });
});

app.get('/api/logs', (req, res) => {
  const lines = parseInt(req.query.lines) || 50;
  res.json({ logs: state.internalLogs.slice(-lines) });
});

// Saludo de bienvenida
app.get('/api/greeting', async (req, res) => {
  try {
    const now = new Date();
    const hora = now.getHours();
    const saludo = hora < 12 ? 'Buenos días' : hora < 20 ? 'Buenas tardes' : 'Buenas noches';

    const thoughts = loadJSON(path.join(C.DATA_DIR, 'pending_thoughts.json'), []);
    const pendingThoughts = thoughts.filter(t => t.status === 'pending');
    const routines = loadJSON(path.join(C.DATA_DIR, 'detected_routines.json'), []);

    let unavailable = [], lightsOn = 0, switchesOn = 0, totalEntities = 0, automationsOff = [];
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
      memory: state.userMemory.length,
      learnings: state.learnings.length,
      totalEntities,
      pendingThoughts: pendingThoughts.slice(0, 5),
      unavailable,
      lightsOn,
      switchesOn,
      automationsOff,
      routines: routines.slice(0, 3),
      houseContextReady: !!state.houseContext
    });
  } catch (err) {
    res.json({ error: err.message, saludo: 'Hola', memory: 0, learnings: 0 });
  }
});

// SSE persistente
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  res.lastHeartbeat = Date.now();
  state.pushClients.add(res);
  req.on('close', () => state.pushClients.delete(res));
});

// Pending thoughts
app.get('/api/pending_thoughts', (req, res) => {
  const thoughtsFile = path.join(C.DATA_DIR, 'pending_thoughts.json');
  const thoughts = loadJSON(thoughtsFile, []);
  const pending = thoughts.filter(t => t.status === 'pending');
  res.json({ thoughts: pending, total: pending.length });
});

app.post('/api/pending_thoughts/:id', (req, res) => {
  const { action } = req.body;
  const thoughtId = parseInt(req.params.id);
  const thoughtsFile = path.join(C.DATA_DIR, 'pending_thoughts.json');
  let thoughts = loadJSON(thoughtsFile, []);
  const idx = thoughts.findIndex(t => t.id === thoughtId);
  if (idx === -1) return res.status(404).json({ error: 'Pensamiento no encontrado' });
  thoughts[idx].status = action === 'approve' ? 'approved' : 'rejected';
  thoughts[idx].resolvedAt = new Date().toISOString();
  saveJSON(thoughtsFile, thoughts);
  res.json({ success: true, thought: thoughts[idx] });
});

// ── Deploy-update: fuerza refresco del repo del Supervisor + update del addon ──
// Llamable desde la LAN sin UI: curl -X POST http://192.168.10.36:3000/api/deploy-update
// Úsalo tras cada git push para instalar la nueva versión sin tocar el navegador.
app.post('/api/deploy-update', async (req, res) => {
  const REPO_URL      = 'https://github.com/padilla585projects/Cloudeinhasisio';
  const ADDON_SLUG    = 'jarvis_ai_agent';
  const UPDATE_ENTITY = 'update.jarvis_ai_agent_actualizar';
  const TOKEN = C.HA_TOKEN;
  const log = [];
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const svGet = async (ep) => {
    const r = await fetch(`http://supervisor${ep}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const t = await r.text();
    try { return JSON.parse(t); } catch { return { raw: t }; }
  };
  const svPost = async (ep, body = {}) => {
    const r = await fetch(`http://supervisor${ep}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const t = await r.text();
    try { return JSON.parse(t); } catch { return { raw: t, ok: r.ok }; }
  };
  // svDel devuelve objeto {ok, status, body} para diagnóstico
  const svDel = async (ep) => {
    const r = await fetch(`http://supervisor${ep}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` }
    });
    const t = await r.text().catch(() => '');
    return { ok: r.ok, status: r.status, body: t.slice(0, 120) };
  };

  try {
    // ── Paso 1: Intentar repo cache-bust (best-effort, no bloquea si falla) ──
    const reposData = await svGet('/store/repositories');
    const allRepos = Array.isArray(reposData.data) ? reposData.data : ((reposData.data || reposData).repositories || []);
    const found = allRepos.find(rp => (rp.source || rp.url || '').includes('padilla585projects'));
    log.push(`repos: ${allRepos.length} encontrados`);

    if (found) {
      const delR = await svDel(`/store/repositories/${found.slug}`);
      log.push(`repo_deleted: slug=${found.slug} status=${delR.status} ok=${delR.ok}`);
      if (delR.ok) {
        await sleep(2000);
        const addR = await svPost('/store/repositories', { repository: REPO_URL });
        log.push(`repo_added: result=${addR.result || addR.raw?.slice(0, 50) || 'ok'}`);
        await sleep(5000);   // esperar a que el Supervisor clone el repo fresco
      } else {
        // DELETE fallido (403/405/etc.) — saltamos re-add y vamos directo a update.install
        log.push(`repo_delete_failed (${delR.status}): usando update.install directo`);
      }
    } else {
      // Repo no estaba — añadirlo (primer uso)
      const addR = await svPost('/store/repositories', { repository: REPO_URL });
      log.push(`repo_added_fresh: result=${addR.result || 'ok'}`);
      await sleep(7000);
    }

    // ── Paso 2: Forzar re-check del store (GET /store/addons actualiza la caché del Supervisor) ──
    // El Supervisor usa la GitHub Contents API (tiene caché propia 5-30 min). Hacer GET del
    // store de addons fuerza al Supervisor a re-chequear versiones disponibles en ese momento.
    await svGet('/store/addons');
    log.push('store_refreshed');
    await sleep(2000);  // dar tiempo al Supervisor a actualizar la entidad de update

    // ── Paso 3: Llamar update.install via HA REST (funciona con SUPERVISOR_TOKEN) ──
    // C.HA_URL = "http://supervisor/core"
    const installResp = await fetch(`${C.HA_URL}/api/services/update/install`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_id: UPDATE_ENTITY })
    });
    const installText = await installResp.text().catch(() => '');
    log.push(`update_install: status=${installResp.status}`);

    // ── Paso 4: Fallback — intentar también via Supervisor addon update ──
    if (!installResp.ok) {
      const updateR = await svPost(`/addons/${ADDON_SLUG}/update`);
      log.push(`addon_update_fallback: result=${updateR.result || JSON.stringify(updateR).slice(0, 60)}`);
    }

    const success = installResp.ok;
    console.log(`[deploy-update] ${log.join(' | ')}`);
    res.json({
      success,
      addon: ADDON_SLUG,
      steps: log,
      note: success
        ? 'Actualización en curso. Jarvis se reiniciará en ~30s.'
        : `Store refrescado pero update.install devolvió HTTP ${installResp.status}. Si GitHub Contents API aún tiene caché, espera 5 min y reintenta. Respuesta: ${installText.slice(0, 100)}`
    });
  } catch (err) {
    console.error('[deploy-update] Error:', err.message);
    res.status(500).json({ success: false, error: err.message, steps: log });
  }
});

// ── Arrancar ─────────────────────────────────────────────────────────────────
const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Jarvis AI Agent v${state.JARVIS_VERSION} corriendo en puerto ${PORT}`);
  console.log(`Modelo: ${C.MODEL} | Config: ${C.HA_CONFIG} | Data: ${C.DATA_DIR}`);
  console.log(`API Key: ${C.ANTHROPIC_API_KEY ? 'configurada (' + C.ANTHROPIC_API_KEY.slice(0, 10) + '...)' : '⚠️ NO CONFIGURADA'}`);
  console.log(`HA Token: ${C.HA_TOKEN ? 'presente' : '⚠️ NO DISPONIBLE'}`);
  console.log(`[boot] Servidor listo. Iniciando tareas de background...`);

  setTimeout(async () => {
    try {
      console.log('[boot] Intentando conectar con Home Assistant...');

      const needsScan = !state.houseContext || (() => {
        try {
          const data = JSON.parse(fs.readFileSync(C.HOUSE_CONTEXT_FILE, 'utf8'));
          return (Date.now() - new Date(data.updatedAt).getTime()) > 7200_000;
        } catch { return true; }
      })();

      if (needsScan) {
        console.log('[boot] Escaneando instalación...');
        await scanInstallation().catch(e => console.log(`[boot] Scan falló (no crítico): ${e.message}`));
      }

      console.log('[boot] Cargando contexto en tiempo real...');
      await updateLiveContext().catch(e => console.log(`[boot] LiveContext falló (no crítico): ${e.message}`));

      console.log('[boot] Inicialización completa. Jarvis operativo.');

      await bootSelfCheck().catch(e => console.log(`[boot] Self-check falló: ${e.message}`));

      try {
        const cfgPath = path.join(C.HA_CONFIG, 'configuration.yaml');
        const automationsPath = path.join(C.HA_CONFIG, 'automations.yaml');
        if (fs.existsSync(cfgPath) && fs.existsSync(automationsPath)) {
          const cfgContent = fs.readFileSync(cfgPath, 'utf8');
          const hasAutomationLine = cfgContent.split('\n').some(line =>
            /^automation\s*:/.test(line.trim()) && !line.trim().startsWith('#')
          );
          if (!hasAutomationLine) {
            console.log('[boot] ⚠️ FALTA "automation: !include automations.yaml" en configuration.yaml — REPARANDO');
            autoBackup(cfgPath);
            fs.appendFileSync(cfgPath, '\nautomation: !include automations.yaml\n');
            console.log('[boot] ✓ Añadido "automation: !include automations.yaml" a configuration.yaml');
            await haPost('/services/automation/reload', {}).catch(() => {});
          }
        }
      } catch (e) { console.log(`[boot] Error verificando configuration.yaml: ${e.message}`); }

      try {
        await bootRecoverScripts();
      } catch (e) { console.log(`[boot] Script recovery falló (no crítico): ${e.message}`); }

      const pendingTask = loadJSON(C.PENDING_TASK_FILE, { status: 'idle' });
      if (pendingTask.status === 'running' && pendingTask.message) {
        console.log(`[boot] Tarea pendiente detectada: "${pendingTask.message.slice(0, 60)}..."`);
        const resumeMsg = `[SISTEMA: Jarvis se reinició mientras ejecutaba esta tarea. Retoma desde donde lo dejaste y complétala. Tarea: "${pendingTask.message}"]`;
        state.conversationHistory.push({ role: 'user', content: resumeMsg });
        saveHistory();
        saveJSON(C.PENDING_TASK_FILE, { status: 'resumed', message: pendingTask.message, resumedAt: new Date().toISOString() });
        console.log('[boot] Tarea inyectada en historial para reanudación automática.');
      }
    } catch (err) {
      console.log(`[boot] Error en inicialización (no crítico, el chat funciona): ${err.message}`);
    }
  }, 5000);

  // Heartbeat SSE — limpia conexiones muertas y envía keepalive
  setInterval(() => {
    const now = Date.now();
    const line = `data: ${JSON.stringify({ type: 'heartbeat', ts: now })}\n\n`;
    for (const res of state.pushClients) {
      try {
        res.write(line);
        res.lastHeartbeat = now;
      } catch {
        state.pushClients.delete(res);
      }
    }
    // Eliminar clientes sin heartbeat en más de 90s (probablemente muertos)
    for (const res of state.pushClients) {
      if (res.lastHeartbeat && now - res.lastHeartbeat > 90000) {
        state.pushClients.delete(res);
      }
    }
  }, 30000);

  // Timers
  setInterval(updateLiveContext, 60_000);

  setInterval(captureStateSnapshot, 10 * 60_000);
  setTimeout(captureStateSnapshot, 60_000);

  setInterval(analyzePatterns, 6 * 3600_000);
  setTimeout(analyzePatterns, 30 * 60_000);

  setInterval(proactiveThinkingLoop, 2 * 3600_000);
  setTimeout(proactiveThinkingLoop, 30 * 60_000);

  setInterval(knowledgeExpansionLoop, 4 * 3600_000);
  setTimeout(knowledgeExpansionLoop, 20 * 60_000);

  setInterval(distillLearnings, 6 * 3600_000);
  setTimeout(distillLearnings, 15 * 60_000);

  setInterval(checkSystemUpdates, 12 * 3600_000);
  setTimeout(checkSystemUpdates, 8 * 60_000);

  setInterval(checkSelfUpdate, 2 * 60_000);
  setTimeout(checkSelfUpdate, 2 * 60_000);

  setTimeout(bootLearnHA, 45_000);
  setInterval(bootLearnHA, 6 * 3600_000);

  setTimeout(bootLearnOwnProject, 20_000);

  setInterval(() => { checkEmergencies(); nexusWatchers(); }, 30_000);

  // ── NETGUARD — watchdog de red/DNS (código puro, sin IA): detecta DNS caído y
  //    reinicia el Pi-hole en Proxmox por IP. Cada 2 min; primer chequeo a los 3 min.
  setInterval(netGuardLoop, 2 * 60_000);
  setTimeout(netGuardLoop, 3 * 60_000);

  // ── INFRAGUARD — watchdog de servicios HA: add-ons crasheados, Zigbee2MQTT, etc.
  //    Cada 5 min; primer chequeo a los 5 min (cuando HA esté estable).
  setInterval(infraGuardLoop, 5 * 60_000);
  setTimeout(infraGuardLoop, 5 * 60_000);

  // ── Bot de Telegram standalone (opt-in via telegram_bot_token en config) ──
  startTelegramBot().catch(e => console.log('[tg-bot] start error:', e.message));

  // ── Limpieza de pensamientos proactivos duplicados al arrancar (una vez) ──
  setTimeout(() => {
    try {
      const thoughtsFile = require('path').join(C.DATA_DIR, 'pending_thoughts.json');
      const thoughts = loadJSON(thoughtsFile, []);
      const pending = thoughts.filter(t => t.status === 'pending');
      if (pending.length <= 5) return; // nada que limpiar

      // Mismo dedup que en proactive_thought: Jaccard 0.4 + área + substring
      const STOPWORDS = new Set(['para','como','segun','sobre','desde','hasta','este','esta',
        'esto','control','mediante','usando','cuando','donde','todos','todas','cada',
        'tener','hacer','crear','nuevo','nueva','entre','dentro','fuera']);
      const AREA_WORDS = ['garaje','salon','dormitorio','cocina','bano','terraza','entrada',
        'pasillo','jardin','habitacion','comedor','biblioteca','oficina','trastero'];
      const norm = (s) => (s||'').toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g,'')
        .replace(/[^a-z0-9\s]/g,' ').split(/\s+/)
        .filter(w => w.length > 3 && !STOPWORDS.has(w));
      const getArea = (s) => AREA_WORDS.find(a =>
        (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').includes(a)) || null;

      const kept = [];
      for (const t of pending) {
        const tToks = new Set(norm(t.title));
        const tArea = getArea(t.title);
        const isDup = kept.some(k => {
          const kToks = new Set(norm(k.title));
          if (tToks.size > 0 && kToks.size > 0) {
            let inter = 0; for (const w of tToks) if (kToks.has(w)) inter++;
            const union = tToks.size + kToks.size - inter;
            if (union > 0 && inter / union >= 0.4) return true;
          }
          if (tArea && getArea(k.title) === tArea && (t.type||'') === (k.type||'')) return true;
          const nT = norm(t.title).join(' '), nK = norm(k.title).join(' ');
          if (nT && nK && (nK.includes(nT) || nT.includes(nK))) return true;
          return false;
        });
        if (!isDup) kept.push(t);
      }

      const removed = pending.length - kept.length;
      if (removed > 0) {
        // Sustituir los pendientes deduplicados + conservar los no-pending
        const nonPending = thoughts.filter(t => t.status !== 'pending');
        saveJSON(thoughtsFile, [...nonPending, ...kept]);
        console.log(`[boot-dedup] ${removed} pensamientos duplicados eliminados (${kept.length} conservados)`);
      }
    } catch(e) { console.log('[boot-dedup] error:', e.message); }
  }, 3000);

  // ── GetawayAgentes — red de agentes (opt-in via AGENT_NET_ENABLED=true) ──
  setTimeout(() => agentNetwork.start().catch(e => console.log('[agent-net] start error:', e.message)), 8_000);

  // Revisión semanal de dashboard (lunes 9:00 AM)
  scheduleTask('weekly-dashboard-review', '0 9 * * 1', async () => {
    try {
      console.log('[TASK] Iniciando revisión semanal de dashboard...');

      const dashboards = await haGet('/lovelace/dashboards');
      if (!dashboards || dashboards.length === 0) {
        console.log('[TASK] No hay dashboards para revisar');
        return;
      }

      const reviewResults = [];
      let totalCritical = 0, totalWarnings = 0, totalSuggestions = 0;

      for (const db of dashboards) {
        const config = await haGet(`/lovelace/dashboards/${db.id}`);
        const views = config.views || [];

        const analysis = {
          name: db.title,
          id: db.id,
          total_cards: views.reduce((sum, v) => sum + (v.cards?.length || 0), 0),
          recommendations: { critical: [], warning: [], suggestion: [] }
        };

        if (views.length === 0) {
          analysis.recommendations.critical.push('Sin vistas organizadas');
          totalCritical++;
        }

        const totalCards = analysis.total_cards;
        if (totalCards === 0 && views.length > 0) {
          analysis.recommendations.critical.push('Dashboard vacío');
          totalCritical++;
        } else if (totalCards > 100) {
          analysis.recommendations.critical.push(`${totalCards} cards (demasiadas, máx: 50-60)`);
          totalCritical++;
        }

        views.forEach((v, i) => {
          const cards = v.cards || [];
          if (cards.length === 0) {
            analysis.recommendations.warning.push(`Vista "${v.title || `#${i+1}`}" vacía`);
            totalWarnings++;
          } else if (cards.length > 20) {
            analysis.recommendations.warning.push(`Vista "${v.title || `#${i+1}`}" (${cards.length} cards)`);
            totalWarnings++;
          }
        });

        reviewResults.push(analysis);
      }

      const reviewHistoryFile = path.join(C.DATA_DIR, 'dashboard_reviews.json');
      let reviewHistory = loadJSON(reviewHistoryFile, []);
      reviewHistory.push({
        timestamp: new Date().toISOString(),
        dashboards_count: reviewResults.length,
        critical: totalCritical,
        warnings: totalWarnings,
        suggestions: totalSuggestions,
        results: reviewResults
      });
      if (reviewHistory.length > 52) reviewHistory = reviewHistory.slice(-52);
      saveJSON(reviewHistoryFile, reviewHistory);

      const summary = `📊 REVISIÓN SEMANAL DE DASHBOARD\n` +
        `Dashboards: ${reviewResults.length}\n` +
        `🔴 Críticos: ${totalCritical} | 🟡 Advertencias: ${totalWarnings} | 💡 Sugerencias: ${totalSuggestions}`;

      console.log(`[TASK] Revisión completada: ${summary.replace(/\n/g, ' ')}`);

      try {
        await haPost('/services/telegram_bot/send_message', {
          target: 'admin',
          message: summary
        }).catch(() => null);
      } catch (e) {
        console.log(`[TASK] Telegram no disponible (no crítico): ${e.message}`);
      }

      pushToAll({
        type: 'dashboard_review',
        critical: totalCritical,
        warnings: totalWarnings,
        summary: summary
      });

    } catch (err) {
      console.log(`[TASK ERROR] weekly-dashboard-review: ${err.message}`);
    }
  });

  console.log('[boot] Revisión semanal de dashboard programada (lunes 9:00 AM)');
});
