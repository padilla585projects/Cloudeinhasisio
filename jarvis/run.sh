#!/usr/bin/with-contenv bashio

export ANTHROPIC_API_KEY=$(bashio::config 'anthropic_api_key')
export MODEL=$(bashio::config 'model')
export LANGUAGE=$(bashio::config 'language')
export HA_TOKEN="${SUPERVISOR_TOKEN}"
export HA_URL="http://supervisor/core"

bashio::log.info "Iniciando Claude AI Chat..."
bashio::log.info "Modelo: ${MODEL}"

node /app/server.js
