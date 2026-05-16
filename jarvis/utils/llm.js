'use strict';
const fetch = require('node-fetch');
const { OPENAI_API_KEY } = require('./constants');
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

// ── Llamada unificada a OpenAI ────────────────────────────────────────────────

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

module.exports = { callOpenAI, sanitizeMessagesForOpenAI, stripImagesFromHistory };
