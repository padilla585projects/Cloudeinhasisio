#!/usr/bin/with-contenv bashio

# Leer configuración del addon
export ANTHROPIC_API_KEY=$(bashio::config 'anthropic_api_key')
export HA_TOKEN=$(bashio::config 'ha_token')
export PORT=$(bashio::config 'port')
export HA_URL="http://supervisor/core"
export SUPERVISOR_TOKEN="${SUPERVISOR_TOKEN}"

bashio::log.info "Iniciando Claude MCP Server en puerto ${PORT}..."
bashio::log.info "Conectando con Home Assistant..."

cd /app
python3 main.py
