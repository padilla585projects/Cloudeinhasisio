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
// MODO DE IA (v3.48.0, opcion `modo_ia`): «pool» (por defecto) = todo por el pool de casa; «pago» = APIs directas con las
// claves propias (DeepSeek chat/razonamiento, OpenAI voz/imagenes/Whisper/vision, Serper o DuckDuckGo, Gemini), como
// antes del pool. En «pago» la URL y la clave del pool se IGNORAN (quedan guardadas en las opciones): todo el codigo lo
// trata como «sin pool», que ya era el camino del modo directo. Cambiar de modo = guardar la opcion y reiniciar el add-on.
const AI_MODE           = String(process.env.AI_MODE || 'pool').toLowerCase() === 'pago' ? 'pago' : 'pool';
const POOL_URL          = AI_MODE === 'pago' ? '' : (process.env.POOL_URL     || '');
const POOL_API_KEY      = AI_MODE === 'pago' ? '' : (process.env.POOL_API_KEY || '');
const POOL_MODEL        = process.env.POOL_MODEL   || 'jarvis:1.0';
// Modelo virtual del pool para trabajo de FONDO (aplazable, mas barato: p. ej. jarvis-fondo:1.0).
// Vacio = se usa POOL_MODEL (con prioridad batch igualmente).
const POOL_MODEL_FONDO  = process.env.POOL_MODEL_FONDO || '';
const USE_POOL          = !!(POOL_API_KEY && POOL_URL);
const MODEL             = USE_POOL ? POOL_MODEL : 'deepseek-v4-pro';   // Chat principal
const BG_MODEL          = USE_POOL ? POOL_MODEL : 'deepseek-v4-flash'; // Background + simples
const CLAUDE_MODEL      = USE_POOL ? POOL_MODEL : 'deepseek-v4-pro';   // Dev expert
// Trabajo de fondo (resumenes, patrones, destilado, vigilancia...). Sin pool == BG_MODEL (igual que antes).
// v3.47.3: con pool el fondo va por jarvis-fondo-local:1.0 (SOLO local, sin ningun paso de pago; si no hay equipo en
// el plazo, 504 `timeout` y la tarea se omite hasta su siguiente ciclo). Decision de Adrian (08-10-2026): «Jarvis 100% por
// el pool» y el fondo en local. Si la opcion pool_model_fondo esta vacia o vale el antiguo jarvis-fondo:1.0, se usa el local;
// un valor distinto se respeta. POOL_FONDO_LOCAL=0 vuelve a la cadena local -> pago de jarvis-fondo:1.0.
const FONDO_LOCAL_MODEL = 'jarvis-fondo-local:1.0';
const FONDO_LOCAL       = process.env.POOL_FONDO_LOCAL !== '0';
const FONDO_MODEL       = USE_POOL
  ? ((FONDO_LOCAL && (!POOL_MODEL_FONDO || POOL_MODEL_FONDO === 'jarvis-fondo:1.0')) ? FONDO_LOCAL_MODEL : (POOL_MODEL_FONDO || POOL_MODEL))
  : BG_MODEL;
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
// Busqueda web del pool (/v1/tools/search). POOL_SEARCH_READ = paginas que descarga por busqueda. Medidas del Core
// (08-10-2026): con summarize:false (extractos de ~1800 car. en vez de resumen de un modelo pequeno de CPU) y
// read:3 tarda ~40 s (la DESCARGA por moviles/navegador del pool es lo lento); read:2 -> 15-40 s; read:0 -> segundos.
// Con resumenes (read:3) llego a 256 s. Por defecto read:2 + extractos, como recomienda el Core. POOL_SEARCH_EXCERPT=0
// vuelve a los resumenes; POOL_SEARCH_READ=0 = solo snippets (inmediato).
const POOL_SEARCH_READ    = parseInt(process.env.POOL_SEARCH_READ === undefined ? '2' : process.env.POOL_SEARCH_READ, 10) || 0;
const POOL_SEARCH_EXCERPT = process.env.POOL_SEARCH_EXCERPT !== '0';
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
  AI_MODE, POOL_URL, POOL_API_KEY, POOL_MODEL, POOL_MODEL_FONDO, USE_POOL,
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
