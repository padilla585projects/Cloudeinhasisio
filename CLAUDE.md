# Claude AI Chat Add-on para Home Assistant

## Qué es este proyecto
Add-on para Home Assistant que añade un chat con Claude IA en el panel lateral. El usuario habla en lenguaje natural para controlar sus dispositivos domóticos.

## Arquitectura
```
HA Panel Lateral → index.html (UI chat) → server.js (Express Node.js)
                                               ↓                    ↓
                                     API Anthropic Claude    API REST de HA
                                     (claude-sonnet-4-6)     (SUPERVISOR_TOKEN)
```

## Stack
- **Backend**: Node.js + Express (CommonJS, require())
- **Frontend**: HTML/CSS/JS vanilla en un solo archivo index.html
- **API Claude**: claude-sonnet-4-6 via API REST (NO streaming a Anthropic, sí SSE al frontend)
- **Dependencias**: express, node-fetch v2.x (CommonJS), cors
- **Base Docker**: ghcr.io/home-assistant/amd64-base:latest

## Estructura de archivos
```
├── config.yaml         # Definición del add-on HA (versión, slug, puertos, ingress)
├── Dockerfile          # Alpine + Node.js
├── run.sh              # Lee config con bashio, exporta variables, lanza server.js
├── server.js           # Servidor Express + lógica de Claude + tools de HA
├── index.html          # UI del chat completa (dark theme, DM Sans, SSE)
├── package.json        # Dependencias npm
├── repository.yaml     # Metadata del repositorio de add-ons
├── CHANGELOG.txt       # Historial de cambios por versión
└── contexto-claude-code.txt  # Contexto original del proyecto
```

## Variables de entorno (definidas en run.sh)
- `ANTHROPIC_API_KEY` — Key de Anthropic (la pone el usuario en config del add-on)
- `MODEL` — modelo de Claude (default: claude-sonnet-4-6)
- `LANGUAGE` — idioma (default: es)
- `HA_TOKEN` — ${SUPERVISOR_TOKEN} (acceso completo a HA, automático)
- `HA_URL` — http://supervisor/core

## Reglas del proyecto

### Versionado
- Cada cambio que se suba al repo DEBE incrementar la versión en config.yaml
- HA solo detecta actualizaciones si la versión cambia
- Formato semántico: MAJOR.MINOR.PATCH
- Documentar cada versión en CHANGELOG.txt

### Código
- server.js usa CommonJS (require), NO ES modules (import)
- node-fetch DEBE ser v2.x (la v3 es ESM only y no funciona con require)
- El frontend es un solo archivo index.html, no separar en múltiples archivos
- No añadir frameworks ni build tools — vanilla JS siempre
- La comunicación frontend→backend es fetch + SSE, no WebSocket

### API de Claude
- El bucle agéntico ejecuta TODAS las tools de un turno antes de hacer push al historial
- Un solo push de assistant message + un solo push con todos los tool_results por turno
- get_entities siempre limitar a 100 entidades máximo por respuesta
- get_entities usa caché de 30s para no sobrecargar HA

### Seguridad
- NUNCA exponer ANTHROPIC_API_KEY ni SUPERVISOR_TOKEN al frontend
- El frontend solo habla con /api/chat, nunca directamente con Anthropic ni con HA
- No loguear tokens ni API keys en consola

### Home Assistant
- El add-on usa ingress (panel lateral de HA), no puerto directo
- SUPERVISOR_TOKEN da acceso completo sin token externo
- Para probar cambios: push al repo → actualizar add-on en HA → reiniciar add-on
- El Dockerfile copia archivos de la raíz del directorio claude-ha-chat/

### GitHub
- Repo: https://github.com/padilla585projects/Cloudeinhasisio
- Carpeta del add-on: claude-ha-chat/
- Siempre actualizar CHANGELOG.txt antes de hacer push

## Tools disponibles para Claude (en server.js)
1. `get_entities` — Lista entidades filtradas por dominio (máx 100, caché 30s)
2. `get_entity_state` — Estado y atributos de una entidad
3. `call_service` — Ejecutar servicios HA (encender luces, etc.)
4. `get_automations` — Lista automatizaciones
5. `toggle_automation` — Activar/desactivar automatización
6. `get_history` — Historial de estados (últimas N horas)
