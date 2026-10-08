'use strict';
const path = require('path');

// ── Variables de entorno ──────────────────────────────────────────────────────
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY  || '';
const OPENAI_API_KEY     = process.env.OPENAI_API_KEY     || '';
const GEMINI_API_KEY     = process.env.GEMINI_API_KEY     || '';
const SERPER_API_KEY     = process.env.SERPER_API_KEY     || '';
const DEEPSEEK_API_KEY   = process.env.DEEPSEEK_API_KEY   || '';
const DEEPSEEK_URL       = 'https://api.deepseek.com/v1';
// ── Pool de IA local (opcional) ──────────────────────────────────────────────
// Si hay clave del pool, el chat principal y los fondos van al pool local
// (jarvis:1.0) con DeepSeek de respaldo. Sin clave, TODO a DeepSeek (igual que
// antes). La URL se pone en las opciones del add-on (no se hardcodea la IP
// interna en el repo público). Coste del pool: $0 (inferencia local).
const POOL_URL          = process.env.POOL_URL     || '';
const POOL_API_KEY      = process.env.POOL_API_KEY || '';
const POOL_MODEL        = process.env.POOL_MODEL   || 'jarvis:1.0';
// Modelo virtual del pool para trabajo de FONDO (aplazable, mas barato: p. ej. jarvis-fondo:1.0).
// Vacio = se usa POOL_MODEL (con prioridad batch igualmente).
const POOL_MODEL_FONDO  = process.env.POOL_MODEL_FONDO || '';
const USE_POOL          = !!(POOL_API_KEY && POOL_URL);
const MODEL             = USE_POOL ? POOL_MODEL : 'deepseek-v4-pro';   // Chat principal
const BG_MODEL          = USE_POOL ? POOL_MODEL : 'deepseek-v4-flash'; // Background + simples
const CLAUDE_MODEL      = USE_POOL ? POOL_MODEL : 'deepseek-v4-pro';   // Dev expert
// Trabajo de fondo (resumenes, patrones, destilado, vigilancia...). Sin pool == BG_MODEL (igual que antes).
const FONDO_MODEL       = USE_POOL ? (POOL_MODEL_FONDO || POOL_MODEL) : BG_MODEL;
// Con pool, analisis y razonamiento tambien van por el pool (alias solo de pago del Core); sin pool, DeepSeek directo.
const DEEPSEEK_MODEL    = USE_POOL ? (process.env.POOL_MODEL_ANALISIS || 'jarvis-analisis:1.0')           : 'deepseek-v4-flash'; // analisis + tools (non-thinking)
const DEEPSEEK_R1_MODEL = USE_POOL ? (process.env.POOL_MODEL_RAZONAMIENTO || 'jarvis-razonamiento:1.0')   : 'deepseek-v4-pro';   // razonamiento profundo (thinking)
// Vision de camaras: el pool (alias con imagenes -> pago) o, sin pool, OpenAI directo.
const VISION_MODEL      = USE_POOL ? (process.env.POOL_MODEL_VISION || 'jarvis-vision:1.0') : 'gpt-4o-mini';
// ¿Hay ALGUN proveedor de IA configurado? Los bucles de fondo se saltan si no. Antes miraban solo la
// clave de Anthropic (un resto de cuando Jarvis usaba Claude, hasta v3.36.0): sin ella, p. ej. el
// analisis de patrones no se ejecutaba nunca aunque el pool o DeepSeek funcionaran.
// Cifra mensual (EUR) para los avisos de gasto en el pool cuando el Core aun no tiene un tope por proyecto. Adrian: 15.
const POOL_SPEND_ALERT_EUR = Number(process.env.POOL_SPEND_ALERT_EUR) || 15;
// Busqueda web del pool (/v1/tools/search). POOL_SEARCH_READ = paginas que descarga y resume por busqueda:
// 0 = solo resultados con snippets (segundos). >0 = el pool resume cada pagina con modelos PEQUENOS de CPU
// (qwen2.5 0.5b/1.5b en moviles, NAS, MINIPC): con ellos ocupados son 60-100 s (08-10-2026). POOL_SEARCH_EXCERPT=1
// manda summarize:false: las paginas leidas vuelven con un extracto (~1800 car.) en vez de resumen, y tardan lo
// que la descarga (5-15 s). Requiere el Core desplegado con ese parametro (avisara); por eso empieza apagado.
const POOL_SEARCH_READ    = parseInt(process.env.POOL_SEARCH_READ === undefined ? '0' : process.env.POOL_SEARCH_READ, 10) || 0;
const POOL_SEARCH_EXCERPT = process.env.POOL_SEARCH_EXCERPT === '1';
const HAS_LLM           = USE_POOL || !!(process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY);
const HA_TOKEN          = process.env.HA_TOKEN;
const HA_URL            = process.env.HA_URL  || 'http://supervisor/core';
const LANGUAGE          = process.env.LANGUAGE || 'es';
const PROXMOX_URL       = process.env.PROXMOX_URL   || '';
const PROXMOX_TOKEN     = process.env.PROXMOX_TOKEN || '';
const PROXMOX_NODE      = process.env.PROXMOX_NODE  || 'pve';
const OMV_URL           = process.env.OMV_URL       || '';
const OMV_USER          = process.env.OMV_USER      || 'admin';
const OMV_PASSWORD      = process.env.OMV_PASSWORD  || '';
const NAS_DISCOS_IGNORADOS = process.env.NAS_DISCOS_IGNORADOS || '';
const CENTINELA_URL     = process.env.CENTINELA_URL   || '';
const CENTINELA_CLAVE   = process.env.CENTINELA_CLAVE || '';
const GITHUB_TOKEN      = process.env.GITHUB_TOKEN  || '';
const GITHUB_REPO       = 'padilla585projects/Cloudeinhasisio';
const GITHUB_BRANCH     = 'main';
const TELEGRAM_BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN   || '';
const TELEGRAM_ALLOWED_IDS = process.env.TELEGRAM_ALLOWED_IDS || '';

// ── Rutas del filesystem de HA ────────────────────────────────────────────────
const DATA_DIR   = '/data';
const HA_CONFIG  = '/config';
const HA_ADDONS  = '/addons';
const HA_SHARE   = '/share';
const HA_MEDIA   = '/media';

// ── Archivos del agente ───────────────────────────────────────────────────────
const MEMORY_FILE            = path.join(DATA_DIR, 'memory.json');
const HISTORY_FILE           = path.join(DATA_DIR, 'history.json');
const LEARNINGS_FILE         = path.join(DATA_DIR, 'learnings.json');
const HOUSE_CONTEXT_FILE     = path.join(DATA_DIR, 'house_context.json');
const INSTALLATION_MAP_FILE  = path.join(DATA_DIR, 'installation_map.json');
const BACKUPS_DIR            = path.join(DATA_DIR, 'backups');
const USERS_FILE             = path.join(DATA_DIR, 'users.json');
const EMERGENCY_CONFIG_FILE  = path.join(DATA_DIR, 'emergency_config.json');
const ALEXA_VOICE_FILE       = path.join(DATA_DIR, 'alexa_pending.json');
const DASHBOARD_REVIEWS_FILE = path.join(DATA_DIR, 'dashboard_reviews.json');
const SCHEDULED_TASKS_FILE   = path.join(DATA_DIR, 'scheduled_tasks.json');
const PENDING_TASK_FILE      = path.join(DATA_DIR, 'pending_task.json');
const API_USAGE_FILE         = path.join(DATA_DIR, 'api_usage.json');

module.exports = {
  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, SERPER_API_KEY,
  MODEL, BG_MODEL, CLAUDE_MODEL, FONDO_MODEL, VISION_MODEL, HAS_LLM, POOL_SPEND_ALERT_EUR, POOL_SEARCH_READ, POOL_SEARCH_EXCERPT,
  DEEPSEEK_API_KEY, DEEPSEEK_URL, DEEPSEEK_MODEL, DEEPSEEK_R1_MODEL,
  POOL_URL, POOL_API_KEY, POOL_MODEL, POOL_MODEL_FONDO, USE_POOL,
  HA_TOKEN, HA_URL, LANGUAGE,
  PROXMOX_URL, PROXMOX_TOKEN, PROXMOX_NODE,
  OMV_URL, OMV_USER, OMV_PASSWORD,
  CENTINELA_URL, CENTINELA_CLAVE,
  NAS_DISCOS_IGNORADOS,
  GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH,
  TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_IDS,
  DATA_DIR, HA_CONFIG, HA_ADDONS, HA_SHARE, HA_MEDIA,
  MEMORY_FILE, HISTORY_FILE, LEARNINGS_FILE,
  HOUSE_CONTEXT_FILE, INSTALLATION_MAP_FILE,
  BACKUPS_DIR, USERS_FILE, EMERGENCY_CONFIG_FILE,
  ALEXA_VOICE_FILE, DASHBOARD_REVIEWS_FILE,
  SCHEDULED_TASKS_FILE, PENDING_TASK_FILE, API_USAGE_FILE,
};
