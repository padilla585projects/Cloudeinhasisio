'use strict';
const fs = require('fs');
const fetch = require('node-fetch');
const { OPENAI_API_KEY, DEEPSEEK_API_KEY, DEEPSEEK_URL, API_USAGE_FILE,
        POOL_URL, POOL_API_KEY, POOL_MODEL, POOL_MODEL_FONDO } = require('./constants');
const state = require('./state');

// Precios reales por modelo (USD / token)
// cache_read / cache_write: coste de tokens de prompt caching (Anthropic)
const MODEL_PRICES = {
  'deepseek-v4-flash':  { in: 0.14 / 1e6,   out: 0.28 / 1e6,  cache_read: 0.0028 / 1e6,   cache_write: 0 },
  // DeepSeek lista hoy su modelo rapido como 'deepseek-flash' (v4-flash es un alias que puede desaparecer);
  // el Core del pool lo usa asi en sus cadenas. Mismo precio.
  'deepseek-flash':     { in: 0.14 / 1e6,   out: 0.28 / 1e6,  cache_read: 0.0028 / 1e6,   cache_write: 0 },
  'deepseek-v4-pro':    { in: 0.435 / 1e6,  out: 0.87 / 1e6,  cache_read: 0.003625 / 1e6, cache_write: 0 },
  'deepseek-chat':      { in: 0.27 / 1e6,   out: 1.10 / 1e6,  cache_read: 0, cache_write: 0 },
  'deepseek-reasoner':  { in: 0.55 / 1e6,   out: 2.19 / 1e6,  cache_read: 0, cache_write: 0 },
  'gpt-4.1-mini':       { in: 0.40 / 1e6,   out: 1.60 / 1e6,  cache_read: 0.10 / 1e6,    cache_write: 0 },
  'gpt-4o-mini':        { in: 0.15 / 1e6,   out: 0.60 / 1e6,  cache_read: 0.075 / 1e6,   cache_write: 0 },
  'gpt-4.1':            { in: 2.00 / 1e6,   out: 8.00 / 1e6,  cache_read: 0.50 / 1e6,    cache_write: 0 },
  'gpt-4o':             { in: 2.50 / 1e6,   out: 10.00 / 1e6, cache_read: 0.625 / 1e6,   cache_write: 0 },
  'claude-sonnet-4-5':  { in: 3.00 / 1e6,   out: 15.00 / 1e6, cache_read: 0.30 / 1e6,    cache_write: 3.75 / 1e6 },
  'claude-sonnet-4-6':  { in: 3.00 / 1e6,   out: 15.00 / 1e6, cache_read: 0.30 / 1e6,    cache_write: 3.75 / 1e6 },
  'claude-haiku-4-5':   { in: 1.00 / 1e6,   out: 5.00 / 1e6,  cache_read: 0.10 / 1e6,    cache_write: 1.25 / 1e6 },
  'jarvis:1.0':         { in: 0,            out: 0,           cache_read: 0,             cache_write: 0 }, // pool local = gratis
};

function trackUsage(model, usage) {
  if (!usage) return;
  const out_tok = usage.completion_tokens || usage.output_tokens || 0;
  const cache_r = usage.cache_read_input_tokens || usage.prompt_cache_hit_tokens || 0;
  const cache_c = usage.cache_creation_input_tokens || 0;
  // DeepSeek V4: prompt_tokens = cache_hit + cache_miss; use cache_miss as non-cached input
  // Others: prompt_tokens/input_tokens is already non-cached input
  let in_tok;
  if (usage.prompt_cache_miss_tokens !== undefined) {
    in_tok = usage.prompt_cache_miss_tokens;
  } else {
    in_tok = usage.prompt_tokens || usage.input_tokens || 0;
  }
  const total_in = usage.prompt_tokens || usage.input_tokens || in_tok + cache_r + cache_c;
  state.apiUsage.calls++;
  state.apiUsage.inputTokens  += total_in;
  state.apiUsage.outputTokens += out_tok;
  state.apiUsage.cacheReadTokens      += cache_r;
  state.apiUsage.cacheCreationTokens  += cache_c;
  const prices = MODEL_PRICES[model] || MODEL_PRICES['deepseek-v4-pro'];
  state.apiUsage.costUSD = (state.apiUsage.costUSD || 0)
    + in_tok  * prices.in
    + out_tok * prices.out
    + cache_r * (prices.cache_read  || 0)
    + cache_c * (prices.cache_write || 0);
  const dailyLimit = parseFloat(process.env.DAILY_COST_LIMIT || '1.5');
  if (!state.saverMode && state.apiUsage.costUSD > dailyLimit) {
    state.saverMode = true;
    state._saverAutoActivated = true;
    console.warn(`[cost-guard] Gasto $${state.apiUsage.costUSD.toFixed(2)} > limite $${dailyLimit}/dia -> Modo ahorro ACTIVADO`);
  }
  persistApiUsage();
}

// Persiste apiUsage + saverMode a disco para que sobrevivan a un reinicio del
// proceso (self-update, auto-repair, reinicios manuales) — sin esto el
// contador de gasto diario se resetea a 0 en cada reinicio y el límite de
// coste ($DAILY_COST_LIMIT/día) deja de proteger nada.
function persistApiUsage() {
  try {
    fs.writeFileSync(API_USAGE_FILE, JSON.stringify({
      apiUsage: state.apiUsage,
      saverMode: state.saverMode
    }, null, 2));
  } catch (e) {
    console.log(`[cost-guard] Error guardando uso de API: ${e.message}`);
  }
}

module.exports._trackUsage = trackUsage;
module.exports.persistApiUsage = persistApiUsage;

// ── Conversión formato Anthropic → OpenAI ────────────────────────────────────

function sanitizeMessagesForOpenAI(messages, stripImages = false) {
  return messages.map(msg => {
    if (!Array.isArray(msg.content)) return msg;
    const content = msg.content
      .map(block => {
        if (stripImages && (block.type === 'image_url' || block.type === 'image'))
          return { type: 'text', text: '[imagen adjunta anteriormente]' };
        if (block.type === 'image' && block.source) {
          const { media_type, data } = block.source;
          const b64 = (data || '').replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
          return { type: 'image_url', image_url: { url: `data:${media_type};base64,${b64}`, detail: 'auto' } };
        }
        if (block.type === 'document') return { type: 'text', text: '📎 [Documento adjunto]' };
        if (block.type === 'tool_result') return { type: 'text', text: block.content || '' };
        return block;
      })
      .filter(Boolean);
    const hasText = content.some(b => b.type === 'text');
    if (!hasText && content.length === 0) return { ...msg, content: [{ type: 'text', text: '[mensaje anterior]' }] };
    return { ...msg, content };
  });
}

// Repara los pares llamada/resultado de herramientas de una conversacion. Los proveedores estrictos
// (Anthropic, y el OpenAI-compatible de DeepSeek) rechazan con 400 un mensaje `tool` sin la llamada del
// asistente que lo origino ("unexpected tool_use_id found in tool_result"), o una llamada sin su resultado.
// Pasa cuando el historial se recorta en mitad de un intercambio: el limite de 60 mensajes y el resumen
// automatico (que sustituye los 20 primeros) pueden dejar un `tool` huerfano al principio. Con el pool, si
// TODOS los pasos de la cadena fallan por eso, el usuario ve "pool error 502: the paid step failed".
// Devuelve un array NUEVO (sin mutar el original): quita los `tool` sin llamada, quita de un mensaje del
// asistente las llamadas sin resultado (o el mensaje entero si solo tenia eso) y recorta lo que quede al
// principio sin ser del usuario (Anthropic exige que empiece por un mensaje de usuario).
function repairToolPairs(messages) {
  if (!Array.isArray(messages)) return messages;
  const out = [];
  let validIds = null;   // ids de llamadas cuyo resultado puede aparecer ahora mismo
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'tool') {
      if (validIds && validIds.has(m.tool_call_id)) out.push(m);   // si no, es huerfano: se descarta
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const respondidos = new Set();
      for (let j = i + 1; j < messages.length && messages[j] && messages[j].role === 'tool'; j++) respondidos.add(messages[j].tool_call_id);
      const validas = m.tool_calls.filter(tc => respondidos.has(tc.id));
      if (validas.length === 0) {
        validIds = null;
        if (m.content) { const { tool_calls, ...resto } = m; out.push(resto); }   // se conserva el texto
        continue;
      }
      out.push(validas.length === m.tool_calls.length ? m : { ...m, tool_calls: validas });
      validIds = new Set(validas.map(tc => tc.id));
      continue;
    }
    validIds = null;
    out.push(m);
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

function stripImagesFromHistory() {
  state.conversationHistory = state.conversationHistory.map(msg => {
    if (!Array.isArray(msg.content)) return msg;
    const content = msg.content.map(block =>
      (block.type === 'image_url' || block.type === 'image')
        ? { type: 'text', text: '[imagen]' }
        : block
    );
    return { ...msg, content };
  });
}

// ── Llamada a OpenAI ──────────────────────────────────────────────────────────

// ── Retry con backoff exponencial para errores transitorios ──────────────────
async function withRetry(fn, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err.message || '';
      const isRetryable = msg.includes('429') || msg.includes('503') || msg.includes('502')
        || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('abort');
      if (!isRetryable || attempt === maxRetries) throw err;
      const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 8000);
      console.log(`[llm] Retry ${attempt + 1}/${maxRetries} tras ${Math.round(delay)}ms: ${msg.slice(0, 80)}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function callOpenAI(model, system, messages, aiTools, maxTokens) {
  if (!OPENAI_API_KEY) {
    const e = new Error('⚠️ OpenAI API Key no configurada. Ve a Ajustes del add-on → openai_api_key.');
    e.noApiKey = true;
    throw e;
  }
  const sanitized = sanitizeMessagesForOpenAI(messages);
  const msgs = system ? [{ role: 'system', content: system }, ...sanitized] : [...sanitized];
  const body = { model, max_tokens: maxTokens, messages: msgs };
  if (aiTools && aiTools.length > 0) body.tools = aiTools;

  const data = await withRetry(async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    let response;
    try {
      response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }
    if (!response.ok) {
      const err = await response.text();
      const sanitizedErr = err.slice(0, 300).replace(/sk-[a-zA-Z0-9]+/g, '[KEY_REDACTED]');
      throw new Error(`OpenAI error ${response.status}: ${sanitizedErr}`);
    }
    return response.json();
  });
  const choice = data.choices[0];
  const message = choice.message;
  const usage = data.usage || {};
  trackUsage(model, usage);
  return {
    text: message.content || '',
    toolCalls: (message.tool_calls || []).map(tc => ({
      id: tc.id,
      name: tc.function.name,
      input: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })()
    })),
    finishReason: choice.finish_reason,
    message,
    usage
  };
}

// ── DeepSeek (V3 + R1) ────────────────────────────────────────────────────────

async function callDeepSeek(model, system, messages, aiTools, maxTokens, options = {}) {
  if (!DEEPSEEK_API_KEY) {
    const e = new Error('DeepSeek API Key no configurada. Ve a Ajustes del add-on -> deepseek_api_key.');
    e.noApiKey = true;
    throw e;
  }

  const isV4 = model.startsWith('deepseek-v4-');
  const isPro = model === 'deepseek-v4-pro' || model === 'deepseek-reasoner';
  const isReasoner = model === 'deepseek-reasoner';
  // Por defecto: V4 Flash sin thinking (rápido/barato), V4 Pro con thinking (razonamiento).
  // options.thinking (true/false/'max') sobreescribe el default cuando el llamador lo especifica.
  const thinkingMode = isV4
    ? (options.thinking !== undefined ? options.thinking !== false : isPro)
    : isReasoner;
  const reasoningEffort = options.thinking === 'max' ? 'max' : 'high';

  const sanitized = sanitizeMessagesForOpenAI(messages);
  const msgs = system ? [{ role: 'system', content: system }, ...sanitized] : [...sanitized];

  const body = { model, max_tokens: maxTokens, messages: msgs };
  if (isV4 && thinkingMode) {
    body.thinking = { type: 'enabled' };
    body.reasoning_effort = reasoningEffort;
  } else if (isV4 && !thinkingMode) {
    body.thinking = { type: 'disabled' };
  }
  if (!isReasoner && aiTools && aiTools.length > 0) body.tools = aiTools;

  const data = await withRetry(async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000);
    let response;
    try {
      response = await fetch(`${DEEPSEEK_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }
    if (!response.ok) {
      const err = await response.text();
      const sanitizedErr = err.slice(0, 300).replace(/[a-zA-Z0-9_\-]{30,}/g, '[REDACTED]');
      throw new Error(`DeepSeek error ${response.status}: ${sanitizedErr}`);
    }
    return response.json();
  });
  const choice = data.choices[0];
  const message = choice.message;

  if (message.reasoning_content) {
    const preview = message.reasoning_content.slice(0, 300).replace(/\n/g, ' ');
    console.log(`[deepseek] reasoning: ${preview}...`);
  }

  const text = message.content || '';
  const toolCalls = (message.tool_calls || []).map(tc => ({
    id: tc.id,
    name: tc.function.name,
    input: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })()
  }));

  const usage = data.usage || {};
  trackUsage(model, usage);
  const resultMessage = {
    role: 'assistant',
    content: text || null,
    ...(toolCalls.length > 0 ? { tool_calls: message.tool_calls } : {})
  };
  if (message.reasoning_content && thinkingMode && toolCalls.length > 0) {
    resultMessage.reasoning_content = message.reasoning_content;
  }
  return {
    text,
    toolCalls,
    finishReason: choice.finish_reason || 'stop',
    message: resultMessage,
    usage
  };
}

// Clave de precio de un modelo servido por el pool de pago. X-AI-Pool-Model trae el
// modelo real, p. ej. "deepseek-v4-pro", "claude-haiku-4-5-20251001" o con proveedor
// delante ("paid:deepseek/deepseek-v4-pro"). Si no lo conocemos, trackUsage usa el
// precio de deepseek-v4-pro (aproximacion prudente, no cero).
function poolPriceKey(modelHeader) {
  const m = String(modelHeader || '').toLowerCase().replace(/^paid:/, '').split('/').pop();
  if (MODEL_PRICES[m]) return m;
  const hit = Object.keys(MODEL_PRICES).find(k => k !== 'jarvis:1.0' && m.startsWith(k));
  return hit || 'deepseek-v4-pro';
}

// ¿Este nombre de modelo lo sirve el pool? Los modelos virtuales empiezan por "jarvis" (jarvis:1.0,
// jarvis-fondo:1.0, jarvis-analisis:1.0, jarvis-razonamiento:1.0, jarvis-vision:1.0) y qwen* es local.
function isPoolModel(model) {
  if (!model) return false;
  return model.startsWith('jarvis') || model.startsWith('qwen') ||
         model === POOL_MODEL || (!!POOL_MODEL_FONDO && model === POOL_MODEL_FONDO);
}
// Nombre real que se pide al pool: los virtuales por su nombre; cualquier otro, el principal.
function resolvePoolModel(model) {
  return (model && model.startsWith('jarvis')) ? model : POOL_MODEL;
}
// Etiqueta X-AI-Pool-Use (<=40 car., solo [a-zA-Z0-9_.:-]) para el desglose del gasto por ruta en el Core.
function poolUseLabel(use) {
  return String(use).replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 40);
}

// Aviso (como mucho cada 6 h) de que el pool ha cortado el gasto de pago de Jarvis. Lazy-require: evita ciclos.
let _ultimoAvisoTope = 0;
function avisoTopeAlcanzado() {
  if (Date.now() - _ultimoAvisoTope < 6 * 3600_000) return;
  _ultimoAvisoTope = Date.now();
  try {
    require('./notify').notify('💶 El pool ha cortado el gasto de IA de pago de Jarvis: se alcanzo el tope mensual del proyecto. Hasta el mes siguiente (o hasta que se suba el tope) solo funciona la IA local, y el ASUS va justo.',
      { title: 'Jarvis — tope de gasto alcanzado', source: 'spendwatch' }).catch(() => {});
  } catch (_) {}
}

// Gasto del mes de Jarvis segun el pool (GET /v1/spend/me): {state, month_eur, budget_eur, project_month_eur,
// project_cap_eur}. null si no se puede leer (se registra el motivo). No cuenta como gasto.
async function poolSpendMe() {
  if (!POOL_API_KEY || !POOL_URL) return null;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(`${poolBase()}/v1/spend/me`, { headers: { 'Authorization': `Bearer ${POOL_API_KEY}` }, signal: controller.signal });
    if (!r.ok) { console.log(`[spend] /v1/spend/me -> ${r.status}`); return null; }
    return await r.json();
  } catch (e) {
    console.log(`[spend] /v1/spend/me no disponible (${(e.message || '').slice(0, 80)})`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

function poolBase() {
  // Acepta la URL como la da el panel del pool: con o sin /openai/v1 (o /v1) al final.
  return POOL_URL.replace(/\/+$/, '').replace(/\/(openai\/v1|openai|v1)$/i, '');
}

// Calentamiento ligero del modelo local: POST /v1/inference/warm responde AL INSTANTE
// (202 warming / 200 warm) y no cuenta como gasto. Evita que la primera peticion tras una
// pausa (el ASUS apaga su servidor de modelos a los 30 min) tenga que cargar el modelo.
// Throttle: como mucho una vez cada minIntervalMs. Nunca lanza: devuelve {ok,status}.
let _lastPoolWarm = 0;
async function poolWarm({ minIntervalMs = 0 } = {}) {
  if (!POOL_API_KEY || !POOL_URL) return { ok: false, status: 0 };
  if (minIntervalMs && Date.now() - _lastPoolWarm < minIntervalMs) return { ok: true, status: 'skip' };
  _lastPoolWarm = Date.now();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(`${poolBase()}/v1/inference/warm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${POOL_API_KEY}` },
      body: JSON.stringify({ model: POOL_MODEL }),
      signal: controller.signal
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    _lastPoolWarm = 0;
    return { ok: false, status: 0, error: e.message };
  } finally {
    clearTimeout(t);
  }
}

// ── Pool de IA local (OpenAI-compatible) ──────────────────────────────────────
// Llama al pool (jarvis:1.0 y demas modelos virtuales). El Core enruta local -> pago y es quien
// lleva el respaldo: Jarvis NO tiene respaldo propio. Un solo intento; ante error o plazo lanza.
// max_tokens SIEMPRE. Manda thinking desactivado por defecto (ver mas abajo).
async function callPool(model, system, messages, aiTools, maxTokens, options = {}) {
  if (!POOL_API_KEY || !POOL_URL) {
    const e = new Error('Pool no configurado (pool_url / pool_api_key)');
    e.noApiKey = true;
    throw e;
  }
  // repairToolPairs: si el historial trae un `tool` huerfano, Anthropic/DeepSeek devuelven 400 y la cadena entera falla.
  const sanitized = repairToolPairs(sanitizeMessagesForOpenAI(messages));
  const msgs = system ? [{ role: 'system', content: system }, ...sanitized] : [...sanitized];
  const body = { model: resolvePoolModel(model), max_tokens: maxTokens || 2048, messages: msgs };
  if (aiTools && aiTools.length > 0) {
    body.tools = aiTools;
    body.tool_choice = 'auto';
  }
  // Razonamiento: lo decide la RUTA. Por defecto DESACTIVADO, en el formato OBJETO de DeepSeek
  // ({"type":"disabled"}); activado solo si la ruta lo pide (thinking:true|'max': experto razonamiento).
  // Motivo (07-10-2026): el razonamiento de v4-pro/flash se come el max_tokens (el Core solo lo apaga
  // solo con <=256) y una respuesta vacia acaba en Haiku; ademas, razonar cuesta tokens de salida.
  // El tramo local (llama.cpp) ignora el campo (probado por el Core). NO se manda a jarvis-vision: su
  // cadena empieza por OpenAI y no esta confirmado que lo tolere.
  if (!/^jarvis-vision/.test(body.model)) {
    body.thinking = (options.thinking === true || options.thinking === 'max') ? { type: 'enabled' } : { type: 'disabled' };
  }
  // Plazo: interactivo 120 s, fondo 180 s (el Core corta a los 190). Sin respaldo propio, es mejor
  // esperar a que el pool conteste (local <=10 s y luego pago) que cortar y dejar al usuario sin respuesta.
  const timeoutMs = options.timeoutMs || (options.background ? 180000 : 120000);
  // Siempre reconstruimos el endpoint canónico, así no importa cómo se pegue la URL.
  const base = poolBase();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${base}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${POOL_API_KEY}`,
        // El Core saca la petición de la cola si cortamos: no dejamos trabajo colgado para nadie.
        'X-AI-Pool-Timeout': String(Math.round(timeoutMs / 1000)),
        // Trabajo de fondo = aplazable: el local tiene hasta 60 s (en vez de 10) antes de pasar a
        // pago, y si el presupuesto del pool llega a critical/over, el Core lo corta antes que a
        // lo que espera un usuario.
        ...(options.background ? { 'X-AI-Pool-Priority': 'batch' } : {}),
        // Ruta de la llamada (chat_ha_control, router, fondo_resumen...) para el desglose en el contador del Core.
        ...(options.use ? { 'X-AI-Pool-Use': poolUseLabel(options.use) } : {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }
  if (!response.ok) {
    const err = await response.text();
    // Tope mensual POR PROYECTO del Core (corte duro, 429 project_budget_exceeded): el texto NO lleva "429"
    // a proposito, para que el bucle del agente no lo reintente como un limite pasajero.
    if (/project_budget_exceeded/.test(err)) {
      const eTope = new Error('tope mensual de gasto de Jarvis en el pool alcanzado (project_budget_exceeded): el pool no hace llamadas de pago hasta el mes siguiente o hasta que se suba el tope; solo funciona la IA local');
      eTope.projectBudgetExceeded = true;
      avisoTopeAlcanzado();
      throw eTope;
    }
    const e = new Error(`pool error ${response.status}: ${err.slice(0, 200)}`);
    // Con el presupuesto del pool en critical/over, el Core bloquea SOLO lo marcado batch con HTTP 429
    // y {"error":{"type":"rate_limit_error","code":"budget_deferred"}} (confirmado por el Core). NO es
    // un fallo del pool ni hay que saltarse el limite llamando a DeepSeek directo: ese gasto no pasaria
    // por su libro de 100 EUR/mes. Un 429 normal (limite por minuto) NO lleva ese codigo y si cae al respaldo.
    if (options.background && /budget_deferred/.test(err)) e.budgetBlocked = true;
    throw e;
  }
  const data = await response.json();
  const choice = (data.choices || [])[0];
  if (!choice) throw new Error('pool: respuesta sin choices');
  const message = choice.message || {};
  const usage = data.usage || {};
  // El Core puede responder con la IA local (gratis) o, si esta no llega a tiempo, con un
  // modelo de PAGO de su cadena. Lo dice X-AI-Pool-Source. Si fue de pago hay que contarlo
  // al precio del modelo real, o el guarda de coste diario no vería ese gasto (el libro
  // global de 100 EUR/mes es del pool, pero el limite diario de Jarvis es el nuestro).
  const poolSource = (response.headers.get('x-ai-pool-source') || 'local').toLowerCase();
  const poolModelUsed = response.headers.get('x-ai-pool-model') || POOL_MODEL;
  trackUsage(poolSource === 'paid' ? poolPriceKey(poolModelUsed) : POOL_MODEL, usage);
  // Traza ligera para validar que el pool responde (y quién): modelo/worker reales
  // y tokens NUEVOS leídos (prompt - cache), que es lo que marca el tiempo de lectura.
  try {
    const pm = poolModelUsed;
    // Local: X-AI-Pool-Worker (el equipo). Pago: no hay worker, esta X-AI-Pool-Provider.
    const pw = response.headers.get('x-ai-pool-worker') || response.headers.get('x-ai-pool-provider') || '?';
    const pt = usage.prompt_tokens || 0;
    // Local (llama.cpp): prompt_tokens_details.cached_tokens. DeepSeek: prompt_cache_hit_tokens.
    const ct = (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || usage.prompt_cache_hit_tokens || 0;
    console.log(`[llm] pool OK (${poolSource}): ${pm}@${pw} | prompt ${pt} (cache ${ct}, nuevos ${pt - ct}) | out ${usage.completion_tokens || 0}`);
  } catch {}
  return {
    text: message.content || '',
    toolCalls: (message.tool_calls || []).map(tc => ({
      id: tc.id,
      name: tc.function.name,
      input: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })()
    })),
    finishReason: choice.finish_reason || 'stop',
    message,
    usage
  };
}

// ── Wrapper unificado ─────────────────────────────────────────────────────────

async function callLLM(model, system, messages, tools, maxTokens, options = {}) {
  // Con el pool configurado TODO va por el pool, sin respaldos: el Core enruta local -> pago y es
  // el unico que habla con los proveedores. Si el pool falla, la llamada falla (y se ve en el log).
  if (POOL_API_KEY && POOL_URL) {
    const target = isPoolModel(model) ? model : POOL_MODEL;
    try {
      return await callPool(target, system, messages, tools, maxTokens, options);
    } catch (e) {
      if (e.budgetBlocked) console.log(`[llm] pool: presupuesto agotado, tarea aplazable omitida (${(e.message || '').slice(0, 90)})`);
      else console.log(`[llm] pool ERROR (${options.use || target}): ${(e.message || '').slice(0, 140)}`);
      throw e;
    }
  }
  // Modo directo (sin pool configurado): DeepSeek / OpenAI con sus claves, como antes del pool.
  if (model && model.startsWith('claude-')) throw new Error('Anthropic ya no esta soportado en Jarvis (v3.44.0): usa el pool');
  if (model && model.startsWith('deepseek-'))  return callDeepSeek(model, system, messages, tools, maxTokens, options);
  return callOpenAI(model, system, messages, tools, maxTokens);
}

const OPENAI_MODEL_FALLBACK = require('./constants').MODEL;

// ── Whisper STT ───────────────────────────────────────────────────────────────

/**
 * Transcribe audio usando OpenAI Whisper.
 * @param {Buffer} audioBuffer  — bytes del audio
 * @param {string} filename     — nombre con extensión (.webm, .mp3, .wav, .m4a, .ogg)
 * @param {string} language     — código ISO (es, en, ...) o null para auto-detect
 * @returns {Promise<{text: string, language: string}>}
 */
// Una peticion de transcripcion (formato OpenAI) a `url` con la clave dada. El FormData
// se construye aqui dentro: es un stream y no se puede reutilizar entre intentos.
async function whisperRequest(url, apiKey, audioBuffer, filename, language, extraHeaders = {}, timeoutMs = 0) {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', audioBuffer, { filename, contentType: 'audio/webm' });
  form.append('model', 'whisper-1');
  if (language) form.append('language', language);
  form.append('response_format', 'json');

  const controller = timeoutMs ? new AbortController() : null;
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, ...extraHeaders, ...form.getHeaders() },
      body: form,
      ...(controller ? { signal: controller.signal } : {})
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Whisper error ${response.status}: ${err.slice(0, 300)}`);
    }
    const data = await response.json();
    return { text: data.text || '', language: data.language || language };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Voz a texto. Con el pool configurado va SOLO por el (POST /openai/v1/audio/transcriptions, whisper-1
// de pago por ahora; el Core lo apunta en su libro): sin respaldo. Plazo 30 s. Sin pool: OpenAI directo.
async function callWhisper(audioBuffer, filename = 'audio.webm', language = 'es') {
  if (POOL_API_KEY && POOL_URL) {
    return whisperRequest(`${poolBase()}/openai/v1/audio/transcriptions`, POOL_API_KEY,
      audioBuffer, filename, language, { 'X-AI-Pool-Timeout': '30', 'X-AI-Pool-Use': 'voz' }, 30000);
  }
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY no configurada');
  return whisperRequest('https://api.openai.com/v1/audio/transcriptions', OPENAI_API_KEY, audioBuffer, filename, language);
}

// Busqueda web del pool (POST /v1/tools/search): el pool busca, descarga las paginas con equipos libres
// de casa y las resume con modelos pequenos locales (gratis). Devuelve el JSON del pool
// ({results:[{title,url,snippet,read,summary}], devices, took_s}) o null si falla (se registra en el log);
// quien llama devuelve entonces un error al agente: no hay busqueda de respaldo. Plazo 90 s (la
// herramienta de busqueda tiene 100 s en el bucle del agente, ver TOOL_TIMEOUT_MS en server.js; el pool dice
// 14-33 s con equipos libres, pero el 08-10-2026 tardo MAS de 40 s dos veces seguidas).
async function poolSearch(query, { results = 8, read = 2, question, timeoutMs = 90000 } = {}) {
  if (!POOL_API_KEY || !POOL_URL || !query) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(`${poolBase()}/v1/tools/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${POOL_API_KEY}`,
        'X-AI-Pool-Timeout': String(Math.round(timeoutMs / 1000)),
        'X-AI-Pool-Use': 'busqueda'
      },
      body: JSON.stringify({ query, results, read, ...(question ? { question } : {}) }),
      signal: controller.signal
    });
    if (!r.ok) {
      console.log(`[search] pool error ${r.status}`);
      return null;
    }
    const data = await r.json();
    return (data && Array.isArray(data.results)) ? data : null;
  } catch (e) {
    console.log(`[search] pool no disponible (${(e.message || '').slice(0, 80)})`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── DALL-E image edit / variation ─────────────────────────────────────────────

/**
 * Edita una imagen existente con DALL-E (image edit endpoint).
 * @param {Buffer} imageBuffer  — PNG con canal alpha para zona transparente, o sin alpha
 * @param {string} prompt
 * @param {Buffer|null} maskBuffer — máscara PNG donde transparente = zona a editar
 * @param {string} size — '1024x1024' | '512x512' | '256x256'
 * @returns {Promise<{url: string, b64: string}>}
 */
async function callImageEdit(imageBuffer, prompt, maskBuffer = null, size = '1024x1024') {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY no configurada');
  const FormData = require('form-data');
  const form = new FormData();
  form.append('image', imageBuffer, { filename: 'image.png', contentType: 'image/png' });
  if (maskBuffer) form.append('mask', maskBuffer, { filename: 'mask.png', contentType: 'image/png' });
  form.append('prompt', prompt);
  form.append('model', 'dall-e-2');  // dall-e-3 no soporta edit; dall-e-2 sí
  form.append('size', size);
  form.append('response_format', 'b64_json');
  form.append('n', '1');

  const response = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...form.getHeaders() },
    body: form
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`DALL-E edit error ${response.status}: ${err}`);
  }
  const data = await response.json();
  return { b64: data.data[0].b64_json, url: null };
}

module.exports = {
  callOpenAI,
  callDeepSeek,
  callLLM,
  callWhisper,
  callImageEdit,
  sanitizeMessagesForOpenAI,
  repairToolPairs,
  stripImagesFromHistory,
  persistApiUsage,
  poolWarm,
  poolSearch,
  poolSpendMe
};
