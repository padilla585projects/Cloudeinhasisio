'use strict';
const fetch = require('node-fetch');
const { OPENAI_API_KEY, ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, DEEPSEEK_URL } = require('./constants');
const state = require('./state');

// Precios reales por modelo (USD / token)
// cache_read / cache_write: coste de tokens de prompt caching (Anthropic)
const MODEL_PRICES = {
  'deepseek-v4-flash':  { in: 0.14 / 1e6,   out: 0.28 / 1e6,  cache_read: 0.0028 / 1e6,   cache_write: 0 },
  'deepseek-v4-pro':    { in: 0.435 / 1e6,  out: 0.87 / 1e6,  cache_read: 0.003625 / 1e6, cache_write: 0 },
  'deepseek-chat':      { in: 0.27 / 1e6,   out: 1.10 / 1e6,  cache_read: 0, cache_write: 0 },
  'deepseek-reasoner':  { in: 0.55 / 1e6,   out: 2.19 / 1e6,  cache_read: 0, cache_write: 0 },
  'gpt-4.1-mini':       { in: 0.40 / 1e6,   out: 1.60 / 1e6,  cache_read: 0.10 / 1e6,    cache_write: 0 },
  'gpt-4o-mini':        { in: 0.15 / 1e6,   out: 0.60 / 1e6,  cache_read: 0.075 / 1e6,   cache_write: 0 },
  'gpt-4.1':            { in: 2.00 / 1e6,   out: 8.00 / 1e6,  cache_read: 0.50 / 1e6,    cache_write: 0 },
  'gpt-4o':             { in: 2.50 / 1e6,   out: 10.00 / 1e6, cache_read: 0.625 / 1e6,   cache_write: 0 },
  'claude-sonnet-4-5':  { in: 3.00 / 1e6,   out: 15.00 / 1e6, cache_read: 0.30 / 1e6,    cache_write: 3.75 / 1e6 },
  'claude-sonnet-4-6':  { in: 3.00 / 1e6,   out: 15.00 / 1e6, cache_read: 0.30 / 1e6,    cache_write: 3.75 / 1e6 },
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
}

module.exports._trackUsage = trackUsage;

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

// ── Conversión OpenAI → Anthropic ────────────────────────────────────────────

function convertMessagesToAnthropic(openAIMessages) {
  const result = [];
  let i = 0;
  while (i < openAIMessages.length) {
    const msg = openAIMessages[i];

    if (msg.role === 'system') {
      // Los system messages van como system param en Anthropic, no en messages[]
      i++; continue;
    }

    if (msg.role === 'tool') {
      // Agrupar todos los tool_results consecutivos en un único user message
      const toolResults = [];
      while (i < openAIMessages.length && openAIMessages[i].role === 'tool') {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: openAIMessages[i].tool_call_id,
          content: String(openAIMessages[i].content || '')
        });
        i++;
      }
      result.push({ role: 'user', content: toolResults });
      continue;
    }

    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'user', content: [{ type: 'text', text: msg.content }] });
      } else if (Array.isArray(msg.content)) {
        const content = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            content.push(block);
          } else if (block.type === 'image_url') {
            const url = block.image_url?.url || '';
            const m = url.match(/^data:([^;]+);base64,(.+)$/s);
            if (m) {
              content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
            } else {
              content.push({ type: 'text', text: `[imagen: ${url.slice(0, 80)}]` });
            }
          } else if (block.type === 'tool_result') {
            content.push(block);
          } else {
            content.push({ type: 'text', text: block.text || JSON.stringify(block) });
          }
        }
        if (content.length === 0) content.push({ type: 'text', text: '[mensaje vacío]' });
        result.push({ role: 'user', content });
      }
      i++; continue;
    }

    if (msg.role === 'assistant') {
      const content = [];
      // Texto
      const text = typeof msg.content === 'string' ? msg.content : (Array.isArray(msg.content) ? msg.content.find(b => b.type === 'text')?.text : null);
      if (text) content.push({ type: 'text', text });
      // Tool calls
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          let input = {};
          try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {}
          content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name || 'unknown', input });
        }
      }
      if (content.length === 0) content.push({ type: 'text', text: '' });
      result.push({ role: 'assistant', content });
      i++; continue;
    }

    i++;
  }

  // Anthropic requiere que el primer mensaje sea 'user' y que no haya dos del mismo rol seguidos
  // Asegurar alternancia básica
  const cleaned = [];
  for (const m of result) {
    if (cleaned.length > 0 && cleaned[cleaned.length - 1].role === m.role) {
      // Combinar con el anterior si es el mismo rol
      const prev = cleaned[cleaned.length - 1];
      const combined = Array.isArray(prev.content) ? prev.content : [{ type: 'text', text: String(prev.content) }];
      const addContent = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }];
      cleaned[cleaned.length - 1] = { role: m.role, content: [...combined, ...addContent] };
    } else {
      cleaned.push(m);
    }
  }

  if (cleaned.length > 0 && cleaned[0].role !== 'user') {
    cleaned.unshift({ role: 'user', content: [{ type: 'text', text: '[inicio de conversación]' }] });
  }

  return cleaned;
}

function convertToolsToAnthropic(openAITools) {
  if (!openAITools || openAITools.length === 0) return [];
  return openAITools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters || { type: 'object', properties: {} }
  }));
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

// ── Llamada a Anthropic Claude ────────────────────────────────────────────────

async function callAnthropic(model, system, messages, aiTools, maxTokens) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY no configurada');

  const anthropicMsgs = convertMessagesToAnthropic(messages);
  const anthropicTools = convertToolsToAnthropic(aiTools);

  // Split semántico para prompt caching: buscar delimitador entre parte estática y dinámica
  const systemBlocks = [];
  if (system) {
    const dynamicMarkers = ['CONTEXTO ACTUAL:', 'ESTADO EN TIEMPO REAL:', 'MEMORIA'];
    let splitIdx = -1;
    for (const marker of dynamicMarkers) {
      const idx = system.indexOf(marker);
      if (idx > 0) { splitIdx = idx; break; }
    }
    if (splitIdx < 0) splitIdx = Math.floor(system.length * 0.6);
    const staticPart = system.slice(0, splitIdx);
    const dynamicPart = system.slice(splitIdx);
    if (staticPart) systemBlocks.push({ type: 'text', text: staticPart, cache_control: { type: 'ephemeral' } });
    if (dynamicPart) systemBlocks.push({ type: 'text', text: dynamicPart });
  }

  const body = {
    model,
    max_tokens: maxTokens,
    system: systemBlocks.length > 0 ? systemBlocks : undefined,
    messages: anthropicMsgs
  };
  if (anthropicTools.length > 0) body.tools = anthropicTools;

  const data = await withRetry(async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000);
    let response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }
    if (!response.ok) {
      const err = await response.text();
      const sanitizedErr = err.slice(0, 300).replace(/sk-ant-[a-zA-Z0-9\-]+/g, '[KEY_REDACTED]');
      throw new Error(`Anthropic error ${response.status}: ${sanitizedErr}`);
    }
    return response.json();
  });

  // Convertir respuesta Anthropic → formato OpenAI (para que server.js no cambie)
  let text = '';
  const toolCalls = [];
  for (const block of (data.content || [])) {
    if (block.type === 'text') text += block.text;
    if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, input: block.input || {} });
    }
  }

  const finishReason = data.stop_reason === 'tool_use' ? 'tool_calls' : 'stop';

  // Reconstruir message en formato OpenAI para que el loop pueda pushearlo de vuelta
  const openAIMessage = {
    role: 'assistant',
    content: text || null,
    tool_calls: toolCalls.map(tc => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.input) }
    }))
  };
  if (openAIMessage.tool_calls.length === 0) delete openAIMessage.tool_calls;

  const usage = {
    prompt_tokens: data.usage?.input_tokens || 0,
    completion_tokens: data.usage?.output_tokens || 0,
    cache_read_input_tokens: data.usage?.cache_read_input_tokens || 0,
    cache_creation_input_tokens: data.usage?.cache_creation_input_tokens || 0
  };
  trackUsage(model, usage);
  return { text, toolCalls, finishReason, message: openAIMessage, usage };
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
  const thinkingMode = isV4 ? (options.thinking !== false) : isReasoner;
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

// ── Wrapper unificado ─────────────────────────────────────────────────────────

async function callLLM(model, system, messages, tools, maxTokens, options = {}) {
  if (model && model.startsWith('claude-')) {
    if (!ANTHROPIC_API_KEY) {
      console.log('[llm] Anthropic no configurado -> fallback deepseek-v4-pro');
      return callDeepSeek('deepseek-v4-pro', system, messages, tools, maxTokens, options);
    }
    try {
      return await callAnthropic(model, system, messages, tools, maxTokens);
    } catch (e) {
      const isCreditsErr = e.message && (
        e.message.includes('credit') || e.message.includes('balance') ||
        e.message.includes('quota') || e.message.includes('rate_limit') ||
        e.message.includes('invalid_api_key') || e.message.includes('401')
      );
      if (isCreditsErr) {
        console.log(`[llm] Anthropic no disponible (${e.message.slice(0,80)}) -> fallback deepseek-v4-pro`);
        return callDeepSeek('deepseek-v4-pro', system, messages, tools, maxTokens, options);
      }
      throw e;
    }
  }
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
async function callWhisper(audioBuffer, filename = 'audio.webm', language = 'es') {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY no configurada');
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', audioBuffer, { filename, contentType: 'audio/webm' });
  form.append('model', 'whisper-1');
  if (language) form.append('language', language);
  form.append('response_format', 'json');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...form.getHeaders() },
    body: form
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Whisper error ${response.status}: ${err}`);
  }
  const data = await response.json();
  return { text: data.text || '', language: data.language || language };
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
  callAnthropic,
  callDeepSeek,
  callLLM,
  callWhisper,
  callImageEdit,
  sanitizeMessagesForOpenAI,
  stripImagesFromHistory,
  convertMessagesToAnthropic,
  convertToolsToAnthropic
};
