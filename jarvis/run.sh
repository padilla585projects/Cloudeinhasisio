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


# ── GetawayAgentes (red de agentes IA, opt-in) ───────────────────────────────
export AGENT_NET_ENABLED="true"
export AGENT_NET_URL="https://getaway-gateway.alejandra-app.workers.dev"
export AGENT_NET_INVITE="getaway2026"
if bashio::config.has_value 'agent_net_enabled'; then
  export AGENT_NET_ENABLED="$(bashio::config 'agent_net_enabled')"
fi
if bashio::config.has_value 'agent_net_url'; then
  export AGENT_NET_URL="$(bashio::config 'agent_net_url')"
fi
if bashio::config.has_value 'agent_net_invite'; then
  export AGENT_NET_INVITE="$(bashio::config 'agent_net_invite')"
fi

bashio::log.info "Iniciando Jarvis AI Agent v3.33.19..."
bashio::log.info "Modelos cloud: gpt-4o-mini (bg) + gpt-4.1-mini (principal) + claude-sonnet-4-5 (dev)"
bashio::log.info "☁️ Núcleos activos:"
bashio::log.info "  · OpenAI: gpt-4.1-mini (principal) + gpt-4o-mini (rápido)"
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  bashio::log.info "  · Anthropic: claude-sonnet-4-5 (dev)"
fi
if [ -n "${DEEPSEEK_API_KEY:-}" ]; then
  bashio::log.info "  · DeepSeek: deepseek-chat (análisis) + deepseek-reasoner R1 (razonamiento)"
fi
if [ -n "${SERPER_API_KEY:-}" ]; then
  bashio::log.info "Busqueda: Google (Serper)"
else
  bashio::log.info "Busqueda: DuckDuckGo (sin SERPER_API_KEY)"
fi
if [ -n "${PROXMOX_URL:-}" ]; then
  bashio::log.info "Proxmox: ${PROXMOX_URL} (nodo: ${PROXMOX_NODE})"
fi
if [ "${AGENT_NET_ENABLED}" = "true" ]; then
  bashio::log.info "🤝 GetawayAgentes: HABILITADA (${AGENT_NET_URL})"
else
  bashio::log.info "GetawayAgentes: deshabilitada (poner agent_net_enabled: true para activar)"
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
