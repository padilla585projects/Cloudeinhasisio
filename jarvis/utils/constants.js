'use strict';
const path = require('path');

// ── Variables de entorno ──────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || '';
const SERPER_API_KEY    = process.env.SERPER_API_KEY    || '';
const MODEL             = 'gpt-4.1-mini';             // Consultas complejas (OpenAI)
const BG_MODEL          = 'gpt-4o-mini';             // Background + consultas simples (OpenAI)
const CLAUDE_MODEL      = 'claude-sonnet-4-5';        // Razonamiento profundo (Anthropic)
const OLLAMA_URL        = process.env.OLLAMA_URL   || 'http://localhost:11434';
const OLLAMA_MODEL      = process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct';   // Modelo principal local
const OLLAMA_BG_MODEL   = process.env.OLLAMA_BG_MODEL || 'qwen2.5:3b-instruct'; // Modelo background local (más pequeño)
const LOCAL_FIRST       = (process.env.LOCAL_FIRST || 'false').toLowerCase() === 'true';  // Local como principal
const PRIVACY_MODE      = (process.env.PRIVACY_MODE || 'false').toLowerCase() === 'true'; // Todo local, nada de cloud
const HA_TOKEN          = process.env.HA_TOKEN;
const HA_URL            = process.env.HA_URL  || 'http://supervisor/core';
const LANGUAGE          = process.env.LANGUAGE || 'es';
const PROXMOX_URL       = process.env.PROXMOX_URL   || '';
const PROXMOX_TOKEN     = process.env.PROXMOX_TOKEN || '';
const PROXMOX_NODE      = process.env.PROXMOX_NODE  || 'pve';
const GITHUB_TOKEN      = process.env.GITHUB_TOKEN  || '';
const GITHUB_REPO       = 'padilla585projects/Cloudeinhasisio';
const GITHUB_BRANCH     = 'main';

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
  ANTHROPIC_API_KEY, OPENAI_API_KEY, SERPER_API_KEY,
  MODEL, BG_MODEL, CLAUDE_MODEL,
  OLLAMA_URL, OLLAMA_MODEL, OLLAMA_BG_MODEL, LOCAL_FIRST, PRIVACY_MODE,
  HA_TOKEN, HA_URL, LANGUAGE,
  PROXMOX_URL, PROXMOX_TOKEN, PROXMOX_NODE,
  GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH,
  DATA_DIR, HA_CONFIG, HA_ADDONS, HA_SHARE, HA_MEDIA,
  MEMORY_FILE, HISTORY_FILE, LEARNINGS_FILE,
  HOUSE_CONTEXT_FILE, INSTALLATION_MAP_FILE,
  BACKUPS_DIR, USERS_FILE, EMERGENCY_CONFIG_FILE,
  ALEXA_VOICE_FILE, DASHBOARD_REVIEWS_FILE,
  SCHEDULED_TASKS_FILE, PENDING_TASK_FILE,
};
