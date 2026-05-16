#!/usr/bin/with-contenv bashio

export OPENAI_API_KEY=$(bashio::config 'openai_api_key')
export LANGUAGE=$(bashio::config 'language')
export HA_TOKEN="${SUPERVISOR_TOKEN}"
export HA_URL="http://supervisor/core"

export SERPER_API_KEY=""
if bashio::config.has_value 'serper_api_key'; then
  export SERPER_API_KEY=$(bashio::config 'serper_api_key')
fi

export ANTHROPIC_API_KEY=""
if bashio::config.has_value 'anthropic_api_key'; then
  export ANTHROPIC_API_KEY=$(bashio::config 'anthropic_api_key')
fi

# Proxmox (opcional)
export PROXMOX_URL=""
export PROXMOX_TOKEN=""
export PROXMOX_NODE="pve"

if bashio::config.has_value 'proxmox_url'; then
  export PROXMOX_URL=$(bashio::config 'proxmox_url')
fi
if bashio::config.has_value 'proxmox_token'; then
  export PROXMOX_TOKEN=$(bashio::config 'proxmox_token')
fi
if bashio::config.has_value 'proxmox_node'; then
  export PROXMOX_NODE=$(bashio::config 'proxmox_node')
fi

export GITHUB_TOKEN=""
if bashio::config.has_value 'github_token'; then
  export GITHUB_TOKEN=$(bashio::config 'github_token')
fi

# ── Ollama (IA local, opcional) ──────────────────────────────────────────────
export OLLAMA_URL="http://localhost:11434"
export OLLAMA_MODEL="qwen2.5:7b-instruct"
export OLLAMA_BG_MODEL="qwen2.5:3b-instruct"
export LOCAL_FIRST="false"
export PRIVACY_MODE="false"

if bashio::config.has_value 'ollama_url'; then
  export OLLAMA_URL=$(bashio::config 'ollama_url')
fi
if bashio::config.has_value 'ollama_model'; then
  export OLLAMA_MODEL=$(bashio::config 'ollama_model')
fi
if bashio::config.has_value 'ollama_bg_model'; then
  export OLLAMA_BG_MODEL=$(bashio::config 'ollama_bg_model')
fi
if bashio::config.has_value 'local_first'; then
  export LOCAL_FIRST=$(bashio::config 'local_first')
fi
if bashio::config.has_value 'privacy_mode'; then
  export PRIVACY_MODE=$(bashio::config 'privacy_mode')
fi

# ── GetawayAgentes (red de agentes IA, opt-in) ───────────────────────────────
export AGENT_NET_ENABLED="true"
export AGENT_NET_URL="https://getaway-gateway.alejandra-app.workers.dev"
export AGENT_NET_INVITE="getaway2026"
if bashio::config.has_value 'agent_net_enabled'; then
  export AGENT_NET_ENABLED=$(bashio::config 'agent_net_enabled')
fi
if bashio::config.has_value 'agent_net_url'; then
  export AGENT_NET_URL=$(bashio::config 'agent_net_url')
fi
if bashio::config.has_value 'agent_net_invite'; then
  export AGENT_NET_INVITE=$(bashio::config 'agent_net_invite')
fi

bashio::log.info "Iniciando Jarvis AI Agent v3.30.3..."
bashio::log.info "Modelos cloud: gpt-4o-mini (bg) + gpt-4.1-mini (principal) + claude-sonnet-4-5 (dev)"
bashio::log.info "IA local (Ollama): ${OLLAMA_URL} | modelo: ${OLLAMA_MODEL}"
if [ "${PRIVACY_MODE}" = "true" ]; then
  bashio::log.info "🔒 MODO PRIVACIDAD: todo el tráfico va a Ollama, nada de cloud"
elif [ "${LOCAL_FIRST}" = "true" ]; then
  bashio::log.info "🏠 LOCAL_FIRST: Ollama primero, cloud como fallback"
else
  bashio::log.info "☁️ Cloud primero, Ollama como fallback offline"
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

node /app/server.js
