'use strict';
const fetch = require('node-fetch');
const { OPENAI_API_KEY, ANTHROPIC_API_KEY, OLLAMA_URL, OLLAMA_MODEL, OLLAMA_BG_MODEL, LOCAL_FIRST, PRIVACY_MODE } = require('./constants');
const state = require('./state');

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

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const choice = data.choices[0];
  const message = choice.message;
  return {
    text: message.content || '',
    toolCalls: (message.tool_calls || []).map(tc => ({
      id: tc.id,
      name: tc.function.name,
      input: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })()
    })),
    finishReason: choice.finish_reason,
    message,
    usage: data.usage || {}
  };
}

// ── Llamada a Anthropic Claude ────────────────────────────────────────────────

async function callAnthropic(model, system, messages, aiTools, maxTokens) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY no configurada');

  const anthropicMsgs = convertMessagesToAnthropic(messages);
  const anthropicTools = convertToolsToAnthropic(aiTools);

  // Sistema como array de bloques para prompt caching (L0 marcado como cacheable)
  const systemBlocks = [];
  if (system) {
    // Dividir: la primera mitad (identidad + dominio) es cacheable; la segunda (contexto dinámico) no
    const midpoint = Math.floor(system.length * 0.6);
    const staticPart = system.slice(0, midpoint);
    const dynamicPart = system.slice(midpoint);
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

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic error ${response.status}: ${err}`);
  }

  const data = await response.json();

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

  return {
    text,
    toolCalls,
    finishReason,
    message: openAIMessage,
    usage: {
      prompt_tokens: data.usage?.input_tokens || 0,
      completion_tokens: data.usage?.output_tokens || 0,
      cache_read_input_tokens: data.usage?.cache_read_input_tokens || 0,
      cache_creation_input_tokens: data.usage?.cache_creation_input_tokens || 0
    }
  };
}

// ── Ollama (compatible OpenAI: /v1/chat/completions) ─────────────────────────

/**
 * Llama a Ollama usando su endpoint OpenAI-compatible.
 * Formato de modelo: 'ollama/qwen2.5:7b-instruct' o solo 'ollama' (usa OLLAMA_MODEL default).
 * Si OLLAMA_URL apunta a localhost, el contenedor del add-on probablemente NO podrá alcanzarlo
 * — configurar OLLAMA_URL a la IP de la LAN donde corre Ollama (ej: http://192.168.1.50:11434).
 */
async function callOllama(model, system, messages, aiTools, maxTokens) {
  // Extraer modelo real: 'ollama/qwen2.5:7b' → 'qwen2.5:7b'
  const realModel = model.startsWith('ollama/')
    ? model.slice('ollama/'.length)
    : model.startsWith('ollama:')
      ? model.slice('ollama:'.length)
      : (model === 'ollama' ? OLLAMA_MODEL : model);

  const sanitized = sanitizeMessagesForOpenAI(messages);
  const msgs = system ? [{ role: 'system', content: system }, ...sanitized] : [...sanitized];

  const body = { model: realModel, max_tokens: maxTokens, messages: msgs, stream: false };
  if (aiTools && aiTools.length > 0) body.tools = aiTools;

  const url = `${OLLAMA_URL.replace(/\/$/, '')}/v1/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeout: 90000
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Ollama error ${response.status}: ${err.slice(0, 300)}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0];
  if (!choice) throw new Error('Ollama respuesta vacía: ' + JSON.stringify(data).slice(0, 200));
  const message = choice.message || {};
  return {
    text: message.content || '',
    toolCalls: (message.tool_calls || []).map(tc => ({
      id: tc.id || `call_${Math.random().toString(36).slice(2)}`,
      name: tc.function?.name || tc.name,
      input: (() => {
        const raw = tc.function?.arguments ?? tc.arguments ?? {};
        if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return {}; } }
        return raw;
      })()
    })),
    finishReason: choice.finish_reason || 'stop',
    message,
    usage: data.usage || {}
  };
}

/**
 * Comprueba si Ollama está alcanzable (GET /api/tags).
 * @returns {Promise<{ok: boolean, models?: string[], error?: string}>}
 */
async function checkOllamaHealth() {
  try {
    const r = await fetch(`${OLLAMA_URL.replace(/\/$/, '')}/api/tags`, { timeout: 4000 });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const d = await r.json();
    return { ok: true, models: (d.models || []).map(m => m.name) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Wrapper unificado: detecta modelo + fallback automático a Ollama ─────────

/**
 * Decide la cadena de modelos a probar para un request.
 * - Si PRIVACY_MODE: solo Ollama
 * - Si LOCAL_FIRST: Ollama luego cloud
 * - Si modelo empieza por 'ollama': Ollama luego cloud (por si Ollama no responde)
 * - Si modelo es cloud (gpt o claude): cloud luego Ollama (fallback offline)
 */
function buildModelChain(primaryModel) {
  if (PRIVACY_MODE) {
    return [primaryModel.startsWith('ollama') ? primaryModel : `ollama/${OLLAMA_MODEL}`];
  }
  const localModel = `ollama/${OLLAMA_MODEL}`;
  const isLocal = primaryModel && (primaryModel.startsWith('ollama/') || primaryModel.startsWith('ollama:') || primaryModel === 'ollama');
  if (isLocal) return [primaryModel, 'gpt-4.1-mini'];  // si Ollama cae, usar OpenAI
  if (LOCAL_FIRST) return [localModel, primaryModel];  // local primero, cloud si falla
  return [primaryModel, localModel];                   // cloud primero, local si falla
}

async function callLLM(model, system, messages, tools, maxTokens) {
  const chain = buildModelChain(model);
  let lastErr;
  for (let i = 0; i < chain.length; i++) {
    const m = chain[i];
    try {
      if (m && (m.startsWith('ollama/') || m.startsWith('ollama:') || m === 'ollama')) {
        const r = await callOllama(m, system, messages, tools, maxTokens);
        if (i > 0) console.log(`[llm-fallback] ✓ Ollama (${m}) tras fallar ${chain[0]}`);
        return r;
      }
      if (m && m.startsWith('claude-')) {
        const r = await callAnthropic(m, system, messages, tools, maxTokens);
        if (i > 0) console.log(`[llm-fallback] ✓ Anthropic (${m}) tras fallar ${chain[0]}`);
        return r;
      }
      const r = await callOpenAI(m, system, messages, tools, maxTokens);
      if (i > 0) console.log(`[llm-fallback] ✓ OpenAI (${m}) tras fallar ${chain[0]}`);
      return r;
    } catch (e) {
      lastErr = e;
      console.log(`[llm-fallback] ${m} falló: ${e.message.slice(0, 120)}`);
      // Solo hacer fallback en errores de red, 5xx, timeout, 429
      const msg = (e.message || '').toLowerCase();
      if (e.noApiKey) throw e; // API key no configurada — no tiene sentido hacer fallback
      const isRetryable = msg.includes('econnref') || msg.includes('timeout') || msg.includes('etimedout')
                       || msg.includes('enotfound') || msg.includes('socket') || msg.includes('network')
                       || /\b(5\d\d|429)\b/.test(msg);
      if (!isRetryable && i < chain.length - 1) {
        // Error no recuperable → no intentar siguientes
        throw e;
      }
    }
  }
  throw lastErr || new Error('Todos los modelos fallaron');
}

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
  callOllama,
  callLLM,
  callWhisper,
  callImageEdit,
  checkOllamaHealth,
  buildModelChain,
  sanitizeMessagesForOpenAI,
  stripImagesFromHistory,
  convertMessagesToAnthropic,
  convertToolsToAnthropic
};
