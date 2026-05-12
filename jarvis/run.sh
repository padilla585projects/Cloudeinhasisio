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

bashio::log.info "Iniciando Jarvis AI Agent v3.15.0..."
bashio::log.info "Modelos: gpt-4o-mini (simple) + gpt-4.1-mini (complejo)"
if [ -n "${SERPER_API_KEY:-}" ]; then
  bashio::log.info "Busqueda: Google (Serper)"
else
  bashio::log.info "Busqueda: DuckDuckGo (sin SERPER_API_KEY)"
fi
if [ -n "${PROXMOX_URL:-}" ]; then
  bashio::log.info "Proxmox: ${PROXMOX_URL} (nodo: ${PROXMOX_NODE})"
fi

node /app/server.js
