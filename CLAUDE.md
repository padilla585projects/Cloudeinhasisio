# Jarvis AI Agent — Add-on para Home Assistant

## Qué es este proyecto
Agente IA especializado en Home Assistant. No es un chatbot — es un ingeniero domótico privado con acceso total a la instalación: dispositivos, archivos, automatizaciones, internet y memoria permanente. Se llama **Jarvis**.

## Arquitectura
```
HA Panel Lateral → index.html (UI chat) → server.js (Express Node.js)
                                               ↓           ↓          ↓
                                        API OpenAI/    API HA    Filesystem
                                        Anthropic      (REST)    (/config)
```

## Stack
- **Backend**: Node.js + Express (CommonJS, require())
- **Frontend**: HTML/CSS/JS vanilla en un solo archivo index.html
- **Modelo principal**: gpt-4.1-mini (MODEL) / gpt-4o-mini (BG_MODEL)
- **Modelo alternativo**: claude-sonnet-4-6 / claude-haiku-4-5-20251001 (si se configura Anthropic)
- **Dependencias**: express, node-fetch v2.x (CommonJS), cors, node-edge-tts, js-yaml
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
├── ARQUITECTURA_JARVIS.txt  # Arquitectura interna detallada
├── LICENSE                  # MIT
└── jarvis/                  # ← CARPETA DEL ADD-ON (HA busca config.yaml aquí)
    ├── config.yaml          # Definición del add-on (versión, slug, permisos)
    ├── Dockerfile           # Alpine + Node.js
    ├── run.sh               # Lee config con bashio, exporta vars, lanza server.js
    ├── server.js            # SERVIDOR PRINCIPAL — agente con ~60 tools (8698 líneas)
    ├── index.html           # UI del chat (dark theme, DM Sans, SSE)
    └── package.json         # Dependencias npm
```

## Variables de entorno (definidas en run.sh)
- `OPENAI_API_KEY` — Key de OpenAI (proveedor principal actual)
- `ANTHROPIC_API_KEY` — Key de Anthropic (proveedor alternativo)
- `MODEL` — gpt-4.1-mini (default)
- `LANGUAGE` — es (default)
- `HA_TOKEN` — ${SUPERVISOR_TOKEN} (acceso completo a HA, automático)
- `HA_URL` — http://supervisor/core
- `PROXMOX_URL`, `PROXMOX_TOKEN`, `PROXMOX_NODE` — Proxmox (opcional)
- `GITHUB_TOKEN` — GitHub API (opcional)
- `SERPER_API_KEY` — Búsqueda web mejorada (opcional)

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
- Actualizar ARQUITECTURA_JARVIS.txt y ESTADO_PROYECTO.txt con cualquier cambio funcional relevante

### Código
- server.js usa CommonJS (require), NO ES modules (import)
- node-fetch DEBE ser v2.x (la v3 es ESM only y no funciona con require)
- El frontend es un solo archivo index.html, no separar en múltiples archivos
- No añadir frameworks ni build tools — vanilla JS siempre
- La comunicación frontend→backend es fetch + SSE, no WebSocket
- Rutas de fetch en el frontend: SIEMPRE relativas ("api/chat", NO "/api/chat")
  porque ingress de HA prefija las rutas

### API LLM (dual provider)
- Proveedor actual: OpenAI (gpt-4.1-mini / gpt-4o-mini)
- Proveedor alternativo: Anthropic (claude-sonnet-4-6 / claude-haiku-4-5-20251001)
- El bucle agéntico ejecuta TODAS las tools de un turno antes de hacer push al historial
- Un solo push de assistant message + un solo push con todos los tool_results por turno
- Máximo 15 iteraciones del bucle agéntico
- get_entities siempre limitar a 100 entidades máximo por respuesta
- get_entities usa caché de 30s para no sobrecargar HA
- Errores de tools se auto-registran como learnings

### Seguridad
- NUNCA exponer OPENAI_API_KEY, ANTHROPIC_API_KEY ni SUPERVISOR_TOKEN al frontend
- El frontend solo habla con api/chat y api/history, nunca directamente con OpenAI/Anthropic ni HA
- No loguear tokens ni API keys en consola
- Filesystem limitado a: /config, /addons (ro), /share, /media (ro), /data
- append_file y write_file exigen adrian_confirmed:true para archivos críticos de HA
- patch_file: edición quirúrgica (busca texto exacto, falla sin tocar si no lo encuentra)

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

## Tools disponibles en Jarvis (~60 total)

### Dispositivos (5)
1. `get_entities` — Lista entidades por dominio (caché 30s, máx 100)
2. `search_entities` — Búsqueda fuzzy por nombre
3. `get_entity_state` — Estado y atributos de una entidad
4. `call_service` — Ejecutar servicios HA
5. `get_history` — Historial de estados (máx 48h)

### Automatizaciones (3)
6. `get_automations` — Lista automatizaciones
7. `create_automation` — Escribe YAML en automations.yaml + reload + validación previa
8. `reload_config` — Recarga config (automations/scripts/scenes/core/all)

### Filesystem (6)
9. `read_file` — Lee archivos en /config, /addons, /share, /media, /data
10. `write_file` — Escribe en /config, /share, /data (valida YAML, protege críticos)
11. `append_file` — Añade al final (requiere adrian_confirmed para archivos críticos)
12. `patch_file` — Edición quirúrgica: busca texto exacto y reemplaza (como Edit tool de Claude Code)
13. `validate_yaml` — Valida sintaxis YAML con número de línea exacto del error
14. `list_directory` — Lista directorio (recursivo opcional)

### Internet (2)
15. `web_search` — Búsqueda web (DuckDuckGo / Serper)
16. `fetch_url` — Obtiene contenido de una URL

### Memoria y aprendizaje (5)
17. `save_memory` — Guarda preferencias/rutinas/info
18. `get_memory` — Consulta memoria
19. `delete_memory` — Elimina nota
20. `learn` — Registra aprendizaje (error/success/pattern/optimization)
21. `knowledge_db` — CRUD de base de conocimiento permanente

### Dashboards (5)
22. `get_dashboards` — Lista todos los dashboards Lovelace
23. `get_dashboard_config` — Lee config completa de un dashboard
24. `update_dashboard` — Modifica un dashboard (con backup auto)
25. `get_installed_frontend` — Detecta cards custom/HACS/temas
26. `search_hacs_resources` — Busca herramientas en la comunidad HA

### Instalación y conocimiento (5)
27. `scan_installation` — Escanea toda la instalación de HA
28. `check_config` — Verifica que la config es válida
29. `install_hacs_resource` — Descarga e instala cards/integraciones
30. `ha_knowledge` — Consulta documentación oficial de HA
31. `review_dashboard` — Auditoría profesional de dashboards (semanal automática)

### Logs y sistema HA (4)
32. `get_system_logs` — Logs de core, supervisor, host, add-ons (con filtro)
33. `get_error_log` — home-assistant.log directo
34. `get_notifications` — Notificaciones activas de HA
35. `get_repairs` — Issues de reparación pendientes en HA

### Telegram (3)
36. `telegram_send` — Envía mensaje por Telegram
37. `telegram_send_image` — Envía imagen/snapshot de cámara
38. `telegram_get_updates` — Lee mensajes recibidos por el bot

### Proxmox (1)
39. `proxmox_api` — Gestión completa: VMs, snapshots, storage, red, estado

### Voz y multimedia (2)
40. `speak` — Habla por altavoces del hogar (Alexa + Piper)
41. `alexa_bidirectional` — Control bidireccional de Alexa

### Red y agentes (3)
42. `network` — arp_table, scan_subnet, ping, port_scan, http_request, wol
43. `agent_communicate` — Comunicación con otros agentes IA
44. `agent_chat` — Habla con Ollama, LM Studio, LocalAI (OpenAI-compatible)

### GitHub y desarrollo (4)
45. `github_push` — Push de cambios al repo (requiere adrian_confirmed)
46. `analyze_github_repos` — Análisis de repositorios GitHub
47. `create_custom_tool` — Crea herramientas custom en runtime
48. `run_custom_tool` — Ejecuta herramientas custom

### IA y autonomía (6)
49. `proactive_thought` — Genera pensamientos proactivos para Adrián
50. `update_self` — Auto-actualización del add-on
51. `ha_supervisor` — API del Supervisor (add-ons, OS, host, network)
52. `nexus_manage` — Crea/edita/elimina expertos y módulos NEXUS dinámicamente
53. `exec_command` — Ejecuta bash/Python/Node.js dentro del contenedor Docker
54. `analyze_patterns` — Análisis de patrones de uso

### Creación y visualización (5)
55. `generate_image` — Genera imágenes con DALL-E 3
56. `render_floorplan` — Renderiza plano SVG de la casa con áreas HA
57. `update_ui` — Inserta HTML/componentes inline en el chat
58. `create_addon` — Crea add-ons completos para HA
59. `rollback` — Rollback de cambios a versiones anteriores

### Usuarios y emergencias (3)
60. `manage_users` — Gestión de usuarios de HA
61. `emergency_config` — Configuración de emergencia
62. `local_file` — Lee archivos del PC via File System Access API
