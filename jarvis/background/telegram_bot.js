'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// TELEGRAM BOT STANDALONE — Jarvis accesible desde cualquier lugar
//
// Permite hablar con Jarvis a través de Telegram igual que desde el panel de HA.
// No usa la integración de HA (no depende de notify.telegram) — llama directamente
// a la Bot API de Telegram y redirige los mensajes al bucle agéntico de Jarvis
// vía HTTP interno (localhost:3000/api/chat).
//
// Activación: configurar telegram_bot_token en las opciones del add-on.
// Seguridad:  si telegram_allowed_ids está vacío, se aprende el primer chat_id
//             que escriba y se guarda en /data/telegram_bot_state.json.
//
// Comandos especiales (sin pasar por el LLM):
//   /start  → mensaje de bienvenida
//   /ayuda  → lista de comandos disponibles
//   Resto   → forwarded al loop agéntico completo de Jarvis
// ─────────────────────────────────────────────────────────────────────────────
const fetch = require('node-fetch');
const path  = require('path');
const { loadJSON, saveJSON } = require('../utils/persistence');
const C = require('../utils/constants');

const STATE_FILE = path.join(C.DATA_DIR, 'telegram_bot_state.json');
const TG_BASE    = `https://api.telegram.org/bot${C.TELEGRAM_BOT_TOKEN}`;
const JARVIS_URL = 'http://localhost:3000/api/chat';

// ── Helpers Telegram API ─────────────────────────────────────────────────────
async function tgCall(method, body = {}) {
  try {
    const res = await fetch(`${TG_BASE}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: 10_000,
    });
    return res.json();
  } catch (e) {
    console.log(`[tg-bot] tgCall ${method} error: ${e.message}`);
    return { ok: false };
  }
}

async function sendMessage(chatId, text, opts = {}) {
  // Telegram limita los mensajes a 4096 caracteres; partir si hace falta
  const chunks = splitText(text, 4000);
  for (const chunk of chunks) {
    await tgCall('sendMessage', {
      chat_id: chatId,
      text: chunk,
      parse_mode: 'Markdown',
      ...opts,
    });
  }
}

async function sendTyping(chatId) {
  await tgCall('sendChatAction', { chat_id: chatId, action: 'typing' });
}

function splitText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const parts = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxLen;
    if (end < text.length) {
      // Cortar en salto de línea si es posible
      const nl = text.lastIndexOf('\n', end);
      if (nl > start) end = nl + 1;
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

// ── Autorización ─────────────────────────────────────────────────────────────
function getAllowedIds(st) {
  // IDs configuradas explícitamente
  const configured = C.TELEGRAM_ALLOWED_IDS
    ? C.TELEGRAM_ALLOWED_IDS.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  // + ID aprendida automáticamente del primer usuario
  const learned = st.learnedChatId ? [String(st.learnedChatId)] : [];
  return [...new Set([...configured, ...learned])];
}

function isAllowed(chatId, st) {
  const allowed = getAllowedIds(st);
  if (allowed.length === 0) return true;   // sin restricción configurada
  return allowed.includes(String(chatId));
}

// ── Llamada al bucle agéntico de Jarvis ─────────────────────────────────────
// Consume el SSE stream de /api/chat y devuelve el texto final concatenado.
async function askJarvis(userText, history = []) {
  const messages = [
    ...history,
    { role: 'user', content: userText },
  ];

  let response;
  try {
    response = await fetch(JARVIS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
      timeout: 120_000,
    });
  } catch (e) {
    return `⚠️ No pude conectar con Jarvis: ${e.message}`;
  }

  if (!response.ok) {
    return `⚠️ Error del servidor: ${response.status}`;
  }

  // Consumir el stream SSE y recoger todos los fragmentos de texto
  let fullText = '';
  let buffer   = '';
  let lastAssistantText = '';

  try {
    for await (const chunk of response.body) {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop(); // línea incompleta → guardar para el siguiente chunk

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt.type === 'text') {
            fullText += evt.text;
          } else if (evt.type === 'done') {
            lastAssistantText = fullText;
          } else if (evt.type === 'error') {
            fullText += `\n⚠️ Error: ${evt.error}`;
          }
          // tool_start / tool_end → ignorar en Telegram (no hace falta mostrar)
        } catch {}
      }
    }
  } catch (e) {
    console.log(`[tg-bot] stream error: ${e.message}`);
  }

  return (fullText || lastAssistantText || '').trim() || '_(sin respuesta)_';
}

// ── Comandos especiales ──────────────────────────────────────────────────────
const HELP_TEXT = `
🤖 *Jarvis — Bot de Telegram*

Escríbeme cualquier cosa y te respondo igual que desde el panel de HA.

Comandos rápidos:
• \`/estado\` — Estado de la casa
• \`/luces\` — Ver/controlar luces
• \`/temperatura\` — Temperaturas y clima
• \`/scan\` — Escaneo de la instalación
• \`/ayuda\` — Este mensaje

También puedo ejecutar cualquier acción: "enciende la luz del salón", "¿qué consume ahora?", "revisa los logs", etc.
`.trim();

async function handleCommand(cmd, chatId) {
  switch (cmd.split(' ')[0].toLowerCase()) {
    case '/start':
      return `¡Hola! Soy Jarvis, tu agente de hogar inteligente. ` +
             `Escríbeme lo que necesites o usa /ayuda para ver los comandos disponibles.`;
    case '/ayuda':
    case '/help':
      return HELP_TEXT;
    case '/estado':
      return null; // → forward al LLM con texto "Dame el estado actual de la casa"
    case '/luces':
      return null;
    case '/temperatura':
      return null;
    case '/scan':
      return null;
    default:
      return null; // cualquier /comando desconocido → forward al LLM
  }
}

// Texto que se manda al LLM cuando el usuario usa un slash command
function commandToText(cmd) {
  const map = {
    '/estado':      'Dame un resumen del estado actual de la casa: luces, temperatura, dispositivos activos y cualquier alerta.',
    '/luces':       'Lista todas las luces y dime cuáles están encendidas ahora mismo.',
    '/temperatura': 'Dame las temperaturas actuales de las habitaciones de la casa.',
    '/scan':        'Haz un escaneo rápido de la instalación y dime si hay algo que revisar.',
  };
  const base = cmd.split(' ')[0].toLowerCase();
  return map[base] || cmd.replace('/', '');
}

// ── Estado por conversación (historial compacto) ─────────────────────────────
// Guardar un historial muy corto por chat_id para mantener contexto inmediato
const MAX_HISTORY = 6; // pares usuario/asistente máximos en memoria
const chatHistories = new Map(); // chatId → [{role, content}]

function addToHistory(chatId, role, content) {
  if (!chatHistories.has(chatId)) chatHistories.set(chatId, []);
  const h = chatHistories.get(chatId);
  h.push({ role, content });
  if (h.length > MAX_HISTORY * 2) h.splice(0, 2);
}

// ── Loop de polling ──────────────────────────────────────────────────────────
async function pollLoop() {
  const st = loadJSON(STATE_FILE, { offset: 0, learnedChatId: null });
  console.log('[tg-bot] Iniciando long-polling...');

  // Verificar que el token es válido
  const me = await tgCall('getMe');
  if (!me.ok) {
    console.log('[tg-bot] Token inválido o sin conectividad. Bot no iniciado.');
    return;
  }
  console.log(`[tg-bot] ✅ Bot activo: @${me.result.username}`);

  while (true) {
    try {
      const upd = await fetch(`${TG_BASE}/getUpdates?offset=${st.offset}&timeout=30&allowed_updates=["message"]`, {
        timeout: 40_000,
      });
      if (!upd.ok) { await sleep(5000); continue; }

      const data = await upd.json();
      if (!data.ok || !data.result?.length) continue;

      for (const update of data.result) {
        st.offset = update.update_id + 1;
        saveJSON(STATE_FILE, st);

        const msg = update.message;
        if (!msg || !msg.text) continue;

        const chatId = msg.chat.id;
        const text   = msg.text.trim();
        const isCmd  = text.startsWith('/');

        // ─ Autorización ─
        const allowed = getAllowedIds(st);
        if (allowed.length > 0 && !isAllowed(chatId, st)) {
          // Si no hay IDs configuradas aún, aprender este chat_id
          if (!C.TELEGRAM_ALLOWED_IDS && !st.learnedChatId) {
            st.learnedChatId = chatId;
            saveJSON(STATE_FILE, st);
            console.log(`[tg-bot] Primer usuario aprendido: chat_id ${chatId}`);
          } else {
            console.log(`[tg-bot] Mensaje rechazado de chat_id ${chatId} (no autorizado)`);
            await sendMessage(chatId, '⛔ No estás autorizado para usar este bot.');
            continue;
          }
        }

        // Si no hay IDs configuradas y tampoco aprendida todavía → aprender ahora
        if (!C.TELEGRAM_ALLOWED_IDS && !st.learnedChatId) {
          st.learnedChatId = chatId;
          saveJSON(STATE_FILE, st);
          console.log(`[tg-bot] Primer usuario aprendido: chat_id ${chatId}`);
        }

        console.log(`[tg-bot] Mensaje de ${chatId}: ${text.slice(0, 80)}`);

        // ─ Comandos que no pasan por el LLM ─
        if (isCmd) {
          const directReply = await handleCommand(text, chatId);
          if (directReply) {
            await sendMessage(chatId, directReply);
            continue;
          }
        }

        // ─ Forwarding al LLM ─
        const userText = isCmd ? commandToText(text) : text;
        await sendTyping(chatId);
        addToHistory(chatId, 'user', userText);

        const history = chatHistories.get(chatId) || [];
        const reply   = await askJarvis(userText, history.slice(0, -1));

        addToHistory(chatId, 'assistant', reply);
        await sendMessage(chatId, reply);
      }
    } catch (e) {
      console.log(`[tg-bot] Error en poll loop: ${e.message}`);
      await sleep(5000);
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Punto de entrada ─────────────────────────────────────────────────────────
async function startTelegramBot() {
  if (!C.TELEGRAM_BOT_TOKEN) {
    console.log('[tg-bot] Sin TELEGRAM_BOT_TOKEN — bot de Telegram desactivado.');
    return;
  }
  // Esperamos a que el servidor esté listo antes de empezar
  await sleep(6_000);
  pollLoop().catch(e => console.log(`[tg-bot] Error fatal: ${e.message}`));
}

module.exports = { startTelegramBot };
