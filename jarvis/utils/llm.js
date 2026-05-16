'use strict';
const fetch = require('node-fetch');
const { OPENAI_API_KEY, ANTHROPIC_API_KEY } = require('./constants');
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

// ── Wrapper unificado: detecta modelo y enruta ────────────────────────────────

async function callLLM(model, system, messages, tools, maxTokens) {
  if (model && model.startsWith('claude-')) {
    return callAnthropic(model, system, messages, tools, maxTokens);
  }
  return callOpenAI(model, system, messages, tools, maxTokens);
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
  callLLM,
  callWhisper,
  callImageEdit,
  sanitizeMessagesForOpenAI,
  stripImagesFromHistory,
  convertMessagesToAnthropic,
  convertToolsToAnthropic
};
