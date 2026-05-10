# Jarvis AI Agent — Add-on para Home Assistant

## Qué es este proyecto
Agente IA especializado en Home Assistant. No es un chatbot — es un ingeniero domótico privado con acceso total a la instalación: dispositivos, archivos, automatizaciones, internet y memoria permanente. Se llama **Jarvis**.

## Arquitectura
```
HA Panel Lateral → index.html (UI chat) → server.js (Express Node.js)
                                               ↓           ↓          ↓
                                        API Anthropic   API HA    Filesystem
                                        (Claude)        (REST)    (/config)
```

## Stack
- **Backend**: Node.js + Express (CommonJS, require())
- **Frontend**: HTML/CSS/JS vanilla en un solo archivo index.html
- **Modelo**: Claude Sonnet 4.6 via API REST (NO streaming a Anthropic, sí SSE al frontend)
- **Dependencias**: express, node-fetch v2.x (CommonJS), cors
- **Base Docker**: ghcr.io/home-assistant/amd64-base:latest
- **Persistencia**: JSON en /data (memoria, learnings, historial, contexto casa)

## Estructura del repositorio

⚠️ **IMPORTANTE**: HA add-on repos REQUIEREN que cada add-on esté en su PROPIA SUBCARPETA.
Si los archivos están en la raíz, HA no detecta actualizaciones. NUNCA mover archivos a la raíz.

```
/ (raíz del repo)
├── repository.yaml          # Metadata del repositorio (HA lee esto primero)
├── README.md                # Documentación pública del proyecto
├── CLAUDE.md                # ESTE ARCHIVO — normas del proyecto
├── CHANGELOG.txt            # Historial de cambios por versión
├── ESTADO_PROYECTO.txt      # Estado actual completo del proyecto
├── FUTURAS_MEJORAS.txt      # Roadmap con prioridades
├── LICENSE                  # MIT
└── jarvis/                  # ← CARPETA DEL ADD-ON (HA busca config.yaml aquí)
    ├── config.yaml          # Definición del add-on (versión, slug, permisos)
    ├── Dockerfile           # Alpine + Node.js
    ├── run.sh               # Lee config con bashio, exporta vars, lanza server.js
    ├── server.js            # SERVIDOR PRINCIPAL — agente con 17+ tools
    ├── index.html           # UI del chat (dark theme, DM Sans, SSE)
    └── package.json         # Dependencias npm
```

## Variables de entorno (definidas en run.sh)
- `ANTHROPIC_API_KEY` — Key de Anthropic (la pone el usuario en config del add-on)
- `MODEL` — claude-sonnet-4-6 (default)
- `LANGUAGE` — es (default)
- `HA_TOKEN` — ${SUPERVISOR_TOKEN} (acceso completo a HA, automático)
- `HA_URL` — http://supervisor/core

## Reglas del proyecto

### Estructura del repo (CRÍTICO)
- Los archivos del add-on VAN SIEMPRE dentro de `jarvis/`
- NUNCA poner config.yaml, Dockerfile, server.js, etc. en la raíz
- `repository.yaml` SÍ va en la raíz (es lo que HA lee para descubrir add-ons)
- Docs del proyecto (CHANGELOG, README, CLAUDE.md, etc.) van en la raíz
- Si esto se rompe, HA no detecta actualizaciones

### Versionado
- Cada cambio que se suba al repo DEBE incrementar la versión en jarvis/config.yaml
- HA solo detecta actualizaciones si la versión cambia
- Formato semántico: MAJOR.MINOR.PATCH
- Documentar cada versión en CHANGELOG.txt

### Código
- server.js usa CommonJS (require), NO ES modules (import)
- node-fetch DEBE ser v2.x (la v3 es ESM only y no funciona con require)
- El frontend es un solo archivo index.html, no separar en múltiples archivos
- No añadir frameworks ni build tools — vanilla JS siempre
- La comunicación frontend→backend es fetch + SSE, no WebSocket
- Rutas de fetch en el frontend: SIEMPRE relativas ("api/chat", NO "/api/chat")
  porque ingress de HA prefija las rutas

### API de Claude
- El bucle agéntico ejecuta TODAS las tools de un turno antes de hacer push al historial
- Un solo push de assistant message + un solo push con todos los tool_results por turno
- Máximo 15 iteraciones del bucle agéntico
- get_entities siempre limitar a 100 entidades máximo por respuesta
- get_entities usa caché de 30s para no sobrecargar HA
- Errores de tools se auto-registran como learnings

### Seguridad
- NUNCA exponer ANTHROPIC_API_KEY ni SUPERVISOR_TOKEN al frontend
- El frontend solo habla con api/chat y api/history, nunca directamente con Anthropic ni HA
- No loguear tokens ni API keys en consola
- Filesystem limitado a: /config, /addons (ro), /share, /media (ro), /data

### Home Assistant
- El add-on usa ingress (panel lateral de HA), no puerto directo
- SUPERVISOR_TOKEN da acceso completo sin token externo
- El slug del add-on es: jarvis_ai_agent
- Para probar cambios: push al repo → actualizar add-on en HA → reiniciar
- El Dockerfile se construye desde dentro de jarvis/
- Si HA no detecta la actualización: quitar repo → volver a añadirlo → buscar

### GitHub
- Repo: https://github.com/padilla585projects/Cloudeinhasisio
- Carpeta del add-on: jarvis/
- Siempre actualizar CHANGELOG.txt antes de hacer push
- El agente se llama JARVIS en todas partes (UI, prompt, logs, config)

## Tools disponibles en Jarvis (17 total)

### Dispositivos
1. `get_entities` — Lista entidades por dominio (caché 30s, máx 100)
2. `search_entities` — Búsqueda fuzzy por nombre
3. `get_entity_state` — Estado y atributos de una entidad
4. `call_service` — Ejecutar servicios HA
5. `get_history` — Historial de estados (máx 48h)

### Automatizaciones
6. `get_automations` — Lista automatizaciones
7. `create_automation` — Escribe YAML en automations.yaml + reload
8. `reload_config` — Recarga config (automations/scripts/scenes/core/all)
9. `check_config` — Verifica que la config es válida

### Filesystem
10. `read_file` — Lee archivos en /config, /addons, /share, /media, /data
11. `write_file` — Escribe en /config, /share, /data
12. `append_file` — Añade al final de un archivo
13. `list_directory` — Lista directorio (recursivo opcional)

### Internet
14. `web_search` — Búsqueda DuckDuckGo
15. `fetch_url` — Obtiene contenido de una URL

### Memoria y aprendizaje
16. `save_memory` — Guarda preferencias/rutinas/info
17. `get_memory` — Consulta memoria
18. `delete_memory` — Elimina nota
19. `learn` — Registra aprendizaje (error/success/pattern/optimization)

### Dashboards
21. `get_dashboards` — Lista todos los dashboards Lovelace
22. `get_dashboard_config` — Lee config completa de un dashboard
23. `update_dashboard` — Modifica un dashboard (con backup auto)
24. `get_installed_frontend` — Detecta cards custom/HACS/temas
25. `search_hacs_resources` — Busca herramientas en la comunidad HA

### Sistema
20. `scan_installation` — Escanea toda la instalación de HA
