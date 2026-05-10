#!/usr/bin/with-contenv bashio

export ANTHROPIC_API_KEY=$(bashio::config 'anthropic_api_key')
export MODEL=$(bashio::config 'model')
export LANGUAGE=$(bashio::config 'language')
export HA_TOKEN="${SUPERVISOR_TOKEN}"
export HA_URL="http://supervisor/core"

# Proxmox (opcional) — defaults vacíos para evitar "unbound variable"
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

bashio::log.info "Iniciando Jarvis AI Agent..."
bashio::log.info "Modelo: ${MODEL}"
if [ -n "${PROXMOX_URL:-}" ]; then
  bashio::log.info "Proxmox: ${PROXMOX_URL} (nodo: ${PROXMOX_NODE})"
fi

node /app/server.js
