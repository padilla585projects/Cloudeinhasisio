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
- **Modelos**: gpt-4.1-mini (principal) + gpt-4o-mini (background/reparación) via OpenAI API
- **Búsqueda**: DuckDuckGo por defecto, Google via Serper API (si se configura)
- **Dependencias**: express, node-fetch v2.x (CommonJS), cors
- **Base Docker**: ghcr.io/home-assistant/amd64-base:latest
- **Persistencia**: JSON en /data (memoria, learnings, historial, knowledge_db, contexto casa)

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
- `OPENAI_API_KEY` — Key de OpenAI (required — modelos gpt-4.1-mini y gpt-4o-mini)
- `SERPER_API_KEY` — Key de Serper para búsqueda Google (opcional)
- `ANTHROPIC_API_KEY` — Key de Anthropic (opcional, reservado)
- `LANGUAGE` — es (default)
- `HA_TOKEN` — ${SUPERVISOR_TOKEN} (acceso completo a HA, automático)
- `HA_URL` — http://supervisor/core
- `PROXMOX_URL`, `PROXMOX_TOKEN`, `PROXMOX_NODE` — Proxmox (opcionales)
- `GITHUB_TOKEN` — Token GitHub para github_push (opcional)

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
- Actualizar ARQUITECTURA_JARVIS.txt con cualquier cambio funcional (tools nuevas, procesos, UI, modelos)

### Código
- server.js usa CommonJS (require), NO ES modules (import)
- node-fetch DEBE ser v2.x (la v3 es ESM only y no funciona con require)
- El frontend es un solo archivo index.html, no separar en múltiples archivos
- No añadir frameworks ni build tools — vanilla JS siempre
- La comunicación frontend→backend es fetch + SSE, no WebSocket
- Rutas de fetch en el frontend: SIEMPRE relativas ("api/chat", NO "/api/chat")
  porque ingress de HA prefija las rutas

### API de OpenAI (bucle agéntico)
- El bucle agéntico ejecuta TODAS las tools de un turno antes de hacer push al historial
- Un solo push de assistant message + un solo push con todos los tool_results por turno
- Máximo 15 iteraciones del bucle agéntico
- get_entities siempre limitar a 100 entidades máximo por respuesta
- get_entities usa caché de 30s para no sobrecargar HA
- Errores de tools se auto-registran como learnings
- gpt-4.1-mini para chat con usuario, gpt-4o-mini para background y autoreparación

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

## Tools disponibles en Jarvis (63 total)

### Dispositivos (5)
1. `get_entities` — Lista entidades por dominio (caché 30s, máx 100)
2. `search_entities` — Búsqueda fuzzy por nombre
3. `get_entity_state` — Estado y atributos de una entidad
4. `call_service` — Ejecutar servicios HA
5. `get_history` — Historial de estados (máx 48h)

### Automatizaciones (3)
6. `get_automations` — Lista automatizaciones
7. `create_automation` — Escribe YAML en automations.yaml + verifica includes + reload
8. `reload_config` — Recarga config (automations/scripts/scenes/core/all)

### Filesystem (6)
9. `read_file` — Lee archivos en /config, /addons, /share, /media, /data
10. `write_file` — Escribe en /config, /share, /data (whitelist + backup + YAML check)
11. `append_file` — Añade al final (whitelist + backup + YAML check)
12. `list_directory` — Lista directorio (recursivo opcional)
13. `patch_file` — Modifica sección específica de un archivo YAML/texto
14. `rollback` — Restaura backup de cualquier archivo (list | restore)

### Internet (2)
15. `web_search` — DuckDuckGo (defecto) o Google via Serper
16. `fetch_url` — Obtiene contenido de una URL

### Memoria y aprendizaje (5)
17. `save_memory` — Guarda preferencias/rutinas/info
18. `get_memory` — Consulta memoria
19. `delete_memory` — Elimina nota
20. `learn` — Registra aprendizaje (error/success/pattern/optimization)
21. `knowledge_db` — Base de datos de conocimiento persistente (add/query/list/delete)

### Dashboards (6)
22. `get_dashboards` — Lista todos los dashboards Lovelace
23. `get_dashboard_config` — Lee config completa de un dashboard
24. `update_dashboard` — Modifica dashboard (con backup auto rolling x10)
25. `get_installed_frontend` — Detecta cards custom/HACS/temas
26. `search_hacs_resources` — Busca herramientas en la comunidad HA
27. `review_dashboard` — Auditoría profesional automática del dashboard

### Instalación y conocimiento (5)
28. `scan_installation` — Escanea toda la instalación de HA
29. `check_config` — Verifica que la config es válida
30. `install_hacs_resource` — Descarga e instala cards/integraciones
31. `ha_knowledge` — Consulta documentación oficial de HA
32. `validate_yaml` — Valida YAML sin escribirlo

### Logs (2)
33. `get_system_logs` — Logs de core, supervisor, host, add-ons (con filtro)
34. `get_error_log` — home-assistant.log directo

### Telegram (3)
35. `telegram_send` — Envía mensaje por Telegram
36. `telegram_send_image` — Envía imagen/snapshot de cámara
37. `telegram_get_updates` — Lee mensajes recibidos por el bot

### Proxmox (1)
38. `proxmox_api` — Gestión completa: VMs, snapshots, storage, red, estado

### Generación de contenido (2)
39. `generate_image` — DALL-E 3, guarda en /share/jarvis/images/
40. `render_floorplan` — Plano SVG de la instalación

### Ejecución de código (1)
41. `exec_command` — Ejecuta bash o python (whitelist de dirs: /app, /config, /data, /share)

### Interfaz y UI (2)
42. `update_ui` — Modifica la propia interfaz de Jarvis
43. `house_3d_map` — Mapa 3D interactivo de la casa (Three.js)

### Voz (2)
44. `speak` — Habla por altavoces del hogar (Alexa x6, all_alexa, ha_tts Piper)
45. `alexa_bidirectional` — Comandos bidireccionales con Alexa

### NEXUS y agentes (4)
46. `nexus_manage` — Crea/edita/borra expertos y módulos NEXUS
47. `run_custom_tool` — Ejecuta herramienta custom definida por Adrián
48. `create_custom_tool` — Define nueva herramienta custom
49. `agent_communicate` — Comunicación con otros agentes de la red

### Red local (2)
50. `network` — arp_table, scan_subnet, ping, port_scan, http_request, discover_agents, wol
51. `agent_chat` — Habla con Ollama, LM Studio, LocalAI (OpenAI-compatible)

### HA avanzado (7)
52. `ha_supervisor` — Gestiona add-ons, snapshots, info del supervisor
53. `update_self` — Auto-actualiza el propio código de Jarvis
54. `create_addon` — Crea nuevo add-on de HA desde cero
55. `github_push` — Sube cambios al repositorio de GitHub
56. `analyze_github_repos` — Analiza repos del usuario en GitHub
57. `emergency_config` — Configuración de emergencia del sistema
58. `manage_users` — Gestiona usuarios de HA

### Notificaciones HA (2)
59. `get_notifications` — Lee notificaciones del sistema HA
60. `get_repairs` — Lee repairs/alertas de HA

### Patrones y rutinas (2)
61. `analyze_patterns` — Analiza snapshots de estado para detectar rutinas
62. `proactive_thought` — Registra/consulta pensamientos proactivos de Jarvis

### Archivos del PC (1)
63. `local_file` — Lee archivos del PC via File System Access API

## Documentos de referencia en la raíz

- `FUTURAS_MEJORAS.txt` — roadmap oficial con sprints priorizados por el usuario
- `ANALISIS_MEJORAS.txt` — audit de deuda técnica, seguridad y quick wins
  (referencia para cuando el usuario pida "limpiar", "refactorizar", "mejorar
  seguridad" o "qué se puede mejorar"). Contiene orden sugerido por tamaño de PR.
- `ESTADO_PROYECTO.txt` — estado actual completo del proyecto
- `ARQUITECTURA_JARVIS.txt` — arquitectura y cambios funcionales
- `CHANGELOG.txt` — historial de versiones

Si el usuario pide trabajar en mejoras de calidad/seguridad/refactor, leer
primero `ANALISIS_MEJORAS.txt` antes de proponer nada.
