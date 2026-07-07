'use strict';
const path = require('path');

// ── Variables de entorno ──────────────────────────────────────────────────────
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY  || '';
const OPENAI_API_KEY     = process.env.OPENAI_API_KEY     || '';
const GEMINI_API_KEY     = process.env.GEMINI_API_KEY     || '';
const SERPER_API_KEY     = process.env.SERPER_API_KEY     || '';
const DEEPSEEK_API_KEY   = process.env.DEEPSEEK_API_KEY   || '';
const DEEPSEEK_URL       = 'https://api.deepseek.com/v1';
const DEEPSEEK_MODEL     = 'deepseek-v4-flash';   // V4 Flash — análisis + tools (non-thinking)
const DEEPSEEK_R1_MODEL  = 'deepseek-v4-pro';     // V4 Pro — razonamiento profundo (thinking mode)
const MODEL             = 'deepseek-v4-pro';     // Consultas complejas (DeepSeek V4 Pro)
const BG_MODEL          = 'deepseek-v4-flash';   // Background + consultas simples (DeepSeek V4 Flash)
const CLAUDE_MODEL      = 'deepseek-v4-pro';     // Dev expert (DeepSeek V4 Pro, antes Claude)
const HA_TOKEN          = process.env.HA_TOKEN;
const HA_URL            = process.env.HA_URL  || 'http://supervisor/core';
const LANGUAGE          = process.env.LANGUAGE || 'es';
const PROXMOX_URL       = process.env.PROXMOX_URL   || '';
const PROXMOX_TOKEN     = process.env.PROXMOX_TOKEN || '';
const PROXMOX_NODE      = process.env.PROXMOX_NODE  || 'pve';
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

module.exports = {
  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, SERPER_API_KEY,
  MODEL, BG_MODEL, CLAUDE_MODEL,
  DEEPSEEK_API_KEY, DEEPSEEK_URL, DEEPSEEK_MODEL, DEEPSEEK_R1_MODEL,
  HA_TOKEN, HA_URL, LANGUAGE,
  PROXMOX_URL, PROXMOX_TOKEN, PROXMOX_NODE,
  GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH,
  TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_IDS,
  DATA_DIR, HA_CONFIG, HA_ADDONS, HA_SHARE, HA_MEDIA,
  MEMORY_FILE, HISTORY_FILE, LEARNINGS_FILE,
  HOUSE_CONTEXT_FILE, INSTALLATION_MAP_FILE,
  BACKUPS_DIR, USERS_FILE, EMERGENCY_CONFIG_FILE,
  ALEXA_VOICE_FILE, DASHBOARD_REVIEWS_FILE,
  SCHEDULED_TASKS_FILE, PENDING_TASK_FILE,
};
