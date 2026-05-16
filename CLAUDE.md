# Jarvis AI Agent — Add-on para Home Assistant

## Qué es este proyecto
Agente IA especializado en Home Assistant. No es un chatbot — es un ingeniero domótico privado con acceso total a la instalación: dispositivos, archivos, automatizaciones, internet y memoria permanente. Se llama **Jarvis**.

## Arquitectura
```
HA Panel Lateral → index.html (UI chat) → server.js (Express Node.js)
                                               ↓           ↓          ↓
                                        APIs IA (4)    API HA    Filesystem
                                     (OpenAI/Anthropic  (REST)    (/config)
                                      /DeepSeek)
```

## Stack
- **Backend**: Node.js + Express (CommonJS, require())
- **Frontend**: HTML/CSS/JS vanilla en un solo archivo index.html
- **Modelos activos**:
  - `gpt-4.1-mini` — principal (MODEL)
  - `gpt-4o-mini` — background/rápido (BG_MODEL)
  - `claude-sonnet-4-5` — experto dev (CLAUDE_MODEL)
  - `deepseek-chat` — experto análisis (DEEPSEEK_MODEL)
  - `deepseek-reasoner` — experto razonamiento R1 (DEEPSEEK_R1_MODEL)
- **Búsqueda**: DuckDuckGo por defecto, Google via Serper API (si se configura)
- **Dependencias**: express, node-fetch v2.x, cors, node-edge-tts, js-yaml, form-data, multer, ws, node-cron
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
└── jarvis/                  # ← CARPETA DEL ADD-ON
    ├── config.yaml          # Definición del add-on (versión, slug, permisos)
    ├── Dockerfile           # Alpine + Node.js + ARG VERSION (bust cache Docker)
    ├── run.sh               # Lee config con bashio, exporta vars, lanza server.js
    ├── server.js            # Servidor principal + agentic loop
    ├── index.html           # UI del chat (dark theme, cabeza 3D, slash commands)
    ├── package.json         # Dependencias npm
    ├── utils/
    │   ├── constants.js     # Todas las constantes (modelos, rutas, API keys)
    │   ├── llm.js           # callOpenAI, callAnthropic, callDeepSeek, callLLM
    │   ├── state.js         # Estado global compartido (JARVIS_VERSION, etc.)
    │   ├── context.js       # buildDynamicContext, updateLiveContext
    │   ├── ha-api.js        # haGet, haPost
    │   └── scan.js          # scanInstallation
    ├── tools/
    │   ├── definitions.js   # Definición de las 67 tools (JSON schema)
    │   └── executor.js      # Switch con todos los handlers de tools
    ├── nexus/
    │   ├── experts.js       # 14 expertos con modelo, tools, módulos
    │   ├── router.js        # nexusRoute (regex + LLM), nexusPickExpert
    │   ├── modules.js       # NEXUS_MODULES (contenido de cada módulo)
    │   ├── layers.js        # assembleSystemPrompt, getScopedTools, layerStats
    │   ├── health.js        # Health scores por experto (0-100)
    │   └── assembler.js     # buildSystemPrompt legacy/fallback
    └── background/
        └── agent_network.js # GetawayAgentes WebSocket (envuelto en try/catch en server.js)
```

## Variables de entorno (definidas en run.sh)
- `OPENAI_API_KEY` — Key de OpenAI (requerida)
- `ANTHROPIC_API_KEY` — Key de Anthropic (opcional, experto dev)
- `DEEPSEEK_API_KEY` — Key de DeepSeek (opcional, expertos analisis + razonamiento)
- `SERPER_API_KEY` — Key de Serper para búsqueda Google (opcional)
- `LANGUAGE` — es (default)
- `HA_TOKEN` — ${SUPERVISOR_TOKEN} (acceso completo a HA, automático)
- `HA_URL` — http://supervisor/core
- `PROXMOX_URL`, `PROXMOX_TOKEN`, `PROXMOX_NODE` — Proxmox (opcionales)
- `GITHUB_TOKEN` — Token GitHub para github_push (opcional)

## Reglas del proyecto

### Estructura del repo (CRÍTICO)
- Los archivos del add-on VAN SIEMPRE dentro de `jarvis/`
- NUNCA poner config.yaml, Dockerfile, server.js, etc. en la raíz
- `repository.yaml` SÍ va en la raíz
- Si esto se rompe, HA no detecta actualizaciones

### Versionado
- Cada cambio DEBE incrementar la versión en:
  1. `jarvis/config.yaml` (version field)
  2. `jarvis/run.sh` (bashio::log.info mensaje)
  3. `jarvis/utils/state.js` (JARVIS_VERSION)
  4. `jarvis/Dockerfile` (ARG VERSION=X.Y.Z — rompe cache Docker)
- Documentar en CHANGELOG.txt antes de push
- Formato semántico: MAJOR.MINOR.PATCH

### Código
- server.js y todos los módulos usan CommonJS (require), NO ES modules (import)
- node-fetch DEBE ser v2.x (v3 es ESM only)
- index.html es un solo archivo, no separar — vanilla JS siempre
- Comunicación frontend→backend: fetch + SSE, no WebSocket
- Rutas en frontend: SIEMPRE relativas ("api/chat", NO "/api/chat") — ingress de HA prefija rutas

### Añadir tools nuevas
1. Definir en `tools/definitions.js` (objeto `{name, description, input_schema}`)
2. Añadir `case 'nombre_tool':` en `tools/executor.js` (antes del `default:` final)
3. Añadir el nombre a `tools[]` del experto relevante en `nexus/experts.js`
4. Verificar con `node --check tools/executor.js && node --check tools/definitions.js`

### callLLM — routing por modelo
```javascript
if (model.startsWith('claude-'))   → callAnthropic
if (model.startsWith('deepseek-')) → callDeepSeek  // R1 no usa tools
default                            → callOpenAI
```

### Bucle agéntico
- Ejecuta TODAS las tools de un turno antes de push al historial
- Un push de assistant message + un push con todos los tool_results por turno
- Máximo 15 iteraciones
- get_entities: caché 30s, máx 100 entidades
- Errores de tools se auto-registran como learnings

### Seguridad
- NUNCA exponer SUPERVISOR_TOKEN ni API keys al frontend
- Frontend solo habla con api/chat y api/history
- No loguear tokens/keys en consola
- Filesystem limitado a: /config, /addons (ro), /share, /media (ro), /data

### Home Assistant
- El add-on usa ingress (panel lateral), no puerto directo
- slug: jarvis_ai_agent
- Para probar: push → actualizar add-on en HA → reiniciar
- Si HA no detecta actualización: quitar repo → volver a añadir

### GitHub
- Repo: https://github.com/padilla585projects/Cloudeinhasisio
- Carpeta del add-on: jarvis/
- Siempre actualizar CHANGELOG.txt antes de push

## NEXUS — Sistema de expertos (14 expertos)

| Experto | Modelo | Especialidad | Activa con... |
|---------|--------|-------------|---------------|
| rapido | gpt-4o-mini | Comandos cortos | "hola", "enciende", longitud <80 |
| ha_control | gpt-4.1-mini | Control general HA | fallback general |
| diagnostico | gpt-4.1-mini | Diagnóstico, logs, errores | "no funciona", "error", "caído" |
| automatizacion | gpt-4.1-mini | Automatizaciones, dashboards | "automatización", "lovelace" |
| archivo | gpt-4.1-mini | Filesystem, YAML | "archivo", "config", "yaml" |
| emergencia | gpt-4.1-mini | Emergencias críticas | "emergencia", "urgente" |
| dev | claude-sonnet-4-5 | Código, GitHub, add-ons | "crea", "modifica", "github" |
| multimedia | gpt-4.1-mini | Alexa, TTS, música | "alexa", "música", "volumen" |
| energia | gpt-4.1-mini | PVPC, consumo, solar | "pvpc", "consumo", "kwh" |
| seguridad | gpt-4.1-mini | Cámaras, Frigate, alarmas | "cámara", "frigate", "alarma" |
| red | gpt-4.1-mini | Proxmox, NAS, Docker, VPN | "proxmox", "docker", "vpn" |
| aprendizaje | gpt-4.1-mini | Memoria, patrones | "recuerda", "aprende", "memoria" |
| analisis | deepseek-chat | Investigación, síntesis web | "investiga", "analiza", "compara" |
| razonamiento | deepseek-reasoner R1 | Análisis profundo (sin tools) | "razona", "análisis profundo", "r1" |

**Router dual:** Capa 1 regex (0 tokens) → Capa 1.5 dynamic keywords → Capa 2 LLM BG_MODEL → fallback ha_control

## Tools disponibles (67 total)

### Dispositivos (5)
1. `get_entities` — Lista entidades por dominio (caché 30s, máx 100)
2. `search_entities` — Búsqueda fuzzy por nombre
3. `get_entity_state` — Estado y atributos de una entidad
4. `call_service` — Ejecutar servicios HA
5. `get_history` — Historial de estados (máx 48h)

### Automatizaciones (5)
6. `get_automations` — Lista automatizaciones
7. `create_automation` — Escribe YAML en automations.yaml + reload
8. `edit_automation` — Edita automatización existente por alias/id + reload
9. `delete_automation` — Elimina automatización por alias/id + reload
10. `reload_config` — Recarga config (automations/scripts/scenes/core/all)

### Filesystem (6)
11. `read_file` — Lee archivos en /config, /addons, /share, /media, /data
12. `write_file` — Escribe en /config, /share, /data (whitelist + backup + YAML check)
13. `append_file` — Añade al final (whitelist + backup + YAML check)
14. `list_directory` — Lista directorio (recursivo opcional)
15. `patch_file` — Modifica sección específica de un archivo YAML/texto
16. `rollback` — Restaura backup de cualquier archivo (list | restore)

### Internet (2)
17. `web_search` — DuckDuckGo (defecto) o Google via Serper
18. `fetch_url` — Obtiene contenido de una URL

### Memoria y aprendizaje (5)
19. `save_memory` — Guarda preferencias/rutinas/info (cap: 500 notas)
20. `get_memory` — Consulta memoria
21. `delete_memory` — Elimina nota
22. `learn` — Registra aprendizaje (error/success/pattern/optimization)
23. `knowledge_db` — Base de datos de conocimiento persistente (add/query/list/delete)

### Dashboards (6)
24. `get_dashboards` — Lista todos los dashboards Lovelace
25. `get_dashboard_config` — Lee config completa de un dashboard
26. `update_dashboard` — Modifica dashboard (con backup auto rolling x10)
27. `get_installed_frontend` — Detecta cards custom/HACS/temas
28. `search_hacs_resources` — Busca herramientas en la comunidad HA
29. `review_dashboard` — Auditoría profesional automática del dashboard

### Instalación y conocimiento (6)
30. `scan_installation` — Escanea toda la instalación de HA
31. `score_installation` — Puntuación 0-100 de la instalación con recomendaciones
32. `check_config` — Verifica que la config es válida
33. `install_hacs_resource` — Descarga e instala cards/integraciones
34. `ha_knowledge` — Consulta documentación oficial de HA
35. `validate_yaml` — Valida YAML sin escribirlo

### Template (1)
36. `template_render` — Renderiza template Jinja2 via HA API

### Logs (2)
37. `get_system_logs` — Logs de core, supervisor, host, add-ons (con filtro)
38. `get_error_log` — home-assistant.log directo

### Telegram (3)
39. `telegram_send` — Envía mensaje por Telegram
40. `telegram_send_image` — Envía imagen/snapshot de cámara
41. `telegram_get_updates` — Lee mensajes recibidos por el bot

### Proxmox (1)
42. `proxmox_api` — Gestión completa: VMs, snapshots, storage, red, estado

### Generación de contenido (2)
43. `generate_image` — DALL-E 3, guarda en /share/jarvis/images/
44. `render_floorplan` — Plano SVG de la instalación

### Ejecución de código (1)
45. `exec_command` — Ejecuta bash o python (whitelist de dirs)

### Interfaz y UI (2)
46. `update_ui` — Modifica la propia interfaz de Jarvis
47. `house_3d_map` — Mapa 3D interactivo de la casa (Three.js)

### Voz (2)
48. `speak` — Habla por altavoces del hogar (Alexa, ha_tts Piper)
49. `alexa_bidirectional` — Comandos bidireccionales con Alexa

### NEXUS y agentes (4)
50. `nexus_manage` — Crea/edita/borra expertos y módulos NEXUS
51. `run_custom_tool` — Ejecuta herramienta custom definida por Adrián
52. `create_custom_tool` — Define nueva herramienta custom
53. `agent_communicate` — Comunicación con otros agentes de la red

### Red local (2)
54. `network` — arp_table, scan_subnet, ping, port_scan, http_request, wol
55. `agent_chat` — Habla con LM Studio, LocalAI (OpenAI-compatible)

### HA avanzado (7)
56. `ha_supervisor` — Gestiona add-ons, snapshots, info del supervisor
57. `update_self` — Auto-actualiza el propio código de Jarvis
58. `create_addon` — Crea nuevo add-on de HA desde cero
59. `github_push` — Sube cambios al repositorio de GitHub
60. `analyze_github_repos` — Analiza repos del usuario en GitHub
61. `emergency_config` — Configuración de emergencia del sistema
62. `manage_users` — Gestiona usuarios de HA

### Notificaciones HA (2)
63. `get_notifications` — Lee notificaciones del sistema HA
64. `get_repairs` — Lee repairs/alertas de HA

### Patrones y rutinas (2)
65. `analyze_patterns` — Analiza snapshots de estado para detectar rutinas
66. `proactive_thought` — Registra/consulta pensamientos proactivos de Jarvis

### Archivos del PC (1)
67. `local_file` — Lee archivos del PC via File System Access API

## UI — Funcionalidades actuales

- **Cabeza holográfica 3D** (Three.js r128): wireframe, estados idle/thinking/speaking
- **Modo Voz fullscreen**: MediaRecorder → Whisper STT, TTS siempre activo
- **Slash commands**: `/` en el input muestra menú con /estado, /scan, /score, /diagnostico, /backup, /logs, /memoria, /ayuda
- **Adjuntar archivos**: imágenes y documentos al chat
- **Panel lateral**: estado de la casa en tiempo real

## Documentos de referencia en la raíz

- `FUTURAS_MEJORAS.txt` — roadmap oficial con sprints priorizados
- `ANALISIS_MEJORAS.txt` — audit de deuda técnica (leer antes de refactorizar)
- `ESTADO_PROYECTO.txt` — estado actual completo
- `CHANGELOG.txt` — historial de versiones
