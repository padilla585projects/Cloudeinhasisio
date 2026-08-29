#!/usr/bin/with-contenv bashio

export OPENAI_API_KEY="$(bashio::config 'openai_api_key')"
export LANGUAGE="$(bashio::config 'language')"
export HA_TOKEN="${SUPERVISOR_TOKEN}"
export HA_URL="http://supervisor/core"

export SERPER_API_KEY=""
if bashio::config.has_value 'serper_api_key'; then
  export SERPER_API_KEY="$(bashio::config 'serper_api_key')"
fi

export ANTHROPIC_API_KEY=""
if bashio::config.has_value 'anthropic_api_key'; then
  export ANTHROPIC_API_KEY="$(bashio::config 'anthropic_api_key')"
fi

export DEEPSEEK_API_KEY=""
if bashio::config.has_value 'deepseek_api_key'; then
  export DEEPSEEK_API_KEY="$(bashio::config 'deepseek_api_key')"
fi

# Proxmox (opcional)
export PROXMOX_URL=""
export PROXMOX_TOKEN=""
export PROXMOX_NODE="pve"

if bashio::config.has_value 'proxmox_url'; then
  export PROXMOX_URL="$(bashio::config 'proxmox_url')"
fi
if bashio::config.has_value 'proxmox_token'; then
  export PROXMOX_TOKEN="$(bashio::config 'proxmox_token')"
fi
if bashio::config.has_value 'proxmox_node'; then
  export PROXMOX_NODE="$(bashio::config 'proxmox_node')"
fi

export GITHUB_TOKEN=""
if bashio::config.has_value 'github_token'; then
  export GITHUB_TOKEN="$(bashio::config 'github_token')"
fi

export TELEGRAM_BOT_TOKEN=""
if bashio::config.has_value 'telegram_bot_token'; then
  export TELEGRAM_BOT_TOKEN="$(bashio::config 'telegram_bot_token')"
fi

export TELEGRAM_ALLOWED_IDS=""
if bashio::config.has_value 'telegram_allowed_ids'; then
  export TELEGRAM_ALLOWED_IDS="$(bashio::config 'telegram_allowed_ids')"
fi

export GEMINI_API_KEY=""
if bashio::config.has_value 'gemini_api_key'; then
  export GEMINI_API_KEY="$(bashio::config 'gemini_api_key')"
fi

# NAS OpenMediaVault (opcional) — vigilancia de discos/servicios/contenedores
export OMV_URL=""
export OMV_USER="admin"
export OMV_PASSWORD=""
if bashio::config.has_value 'omv_url'; then
  export OMV_URL="$(bashio::config 'omv_url')"
fi
if bashio::config.has_value 'omv_user'; then
  export OMV_USER="$(bashio::config 'omv_user')"
fi
if bashio::config.has_value 'omv_password'; then
  export OMV_PASSWORD="$(bashio::config 'omv_password')"
fi


bashio::log.info "Iniciando Jarvis AI Agent v3.38.0..."
bashio::log.info "Modelos cloud: DeepSeek V4 Flash (bg) + V4 Pro (principal/dev)"
bashio::log.info "Nucleos activos:"
if [ -n "${DEEPSEEK_API_KEY:-}" ]; then
  bashio::log.info "  · DeepSeek V4: flash (bg/rapido) + pro (principal/dev/razonamiento)"
else
  bashio::log.info "  · DeepSeek: NO CONFIGURADO (configurar deepseek_api_key)"
fi
if [ -n "${OPENAI_API_KEY:-}" ]; then
  bashio::log.info "  · OpenAI: disponible (fallback + Whisper STT)"
fi
if [ -n "${GEMINI_API_KEY:-}" ]; then
  bashio::log.info "  · Google: Gemini Imagen 3 (generacion de imagenes)"
fi
if [ -n "${SERPER_API_KEY:-}" ]; then
  bashio::log.info "Busqueda: Google (Serper)"
else
  bashio::log.info "Busqueda: DuckDuckGo (sin SERPER_API_KEY)"
fi
if [ -n "${PROXMOX_URL:-}" ]; then
  bashio::log.info "Proxmox: ${PROXMOX_URL} (nodo: ${PROXMOX_NODE})"
fi
if [ -n "${OMV_URL:-}" ]; then
  bashio::log.info "NAS OpenMediaVault: ${OMV_URL} (vigilancia cada 6h)"
else
  bashio::log.info "NAS OpenMediaVault: desactivado (configurar omv_url para vigilarlo)"
fi
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
  bashio::log.info "📱 Bot Telegram: ACTIVO (acceso remoto habilitado)"
else
  bashio::log.info "Bot Telegram: desactivado (configurar telegram_bot_token para acceso remoto)"
fi

# Garantiza que todas las deps están instaladas (por si el layer npm está cacheado)
cd /app
if ! node -e "require('node-cron')" 2>/dev/null; then
  bashio::log.info "Instalando dependencias npm faltantes..."
  npm install --production
fi

node /app/server.js
