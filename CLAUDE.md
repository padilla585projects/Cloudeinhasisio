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
    │   ├── llm.js           # callOpenAI, callDeepSeek, callPool, callLLM, callWhisper, poolSearch, poolWarm
    │   ├── state.js         # Estado global compartido (JARVIS_VERSION, etc.)
    │   ├── context.js       # buildDynamicContext, updateLiveContext
    │   ├── ha-api.js        # haGet, haPost, supervisorGet, supervisorPost
    │   ├── notify.js        # Canal único de avisos de los vigilantes (Telegram + HA)
    │   ├── omv-api.js       # Cliente RPC del NAS OpenMediaVault
    │   ├── persistence.js   # loadJSON / saveJSON sobre /data
    │   ├── mcp-client.js    # Cliente MCP
    │   └── scan.js          # scanInstallation
    ├── tools/
    │   ├── definitions.js   # Definición de las 96 tools (JSON schema)
    │   └── executor.js      # Switch con todos los handlers de tools
    ├── nexus/
    │   ├── experts.js       # 14 expertos con modelo, tools, módulos
    │   ├── router.js        # nexusRoute (regex + LLM), nexusPickExpert
    │   ├── modules.js       # NEXUS_MODULES (contenido de cada módulo)
    │   ├── layers.js        # assembleSystemPrompt, getScopedTools, layerStats
    │   ├── health.js        # Health scores por experto (0-100)
    │   └── assembler.js     # buildSystemPrompt legacy/fallback
    └── background/
        ├── knowledge.js      # Expansión y destilado de conocimiento
        ├── patterns.js       # Detección de rutinas/patrones del hogar
        ├── proactive.js      # Pensamientos proactivos periódicos
        ├── selfcheck.js      # Auto-reparación y boot self-check
        ├── updates.js        # Chequeo de actualizaciones HA/add-ons
        ├── netguard.js       # Monitor de red local
        ├── infraguard.js     # Monitor de add-ons/infra vía Supervisor
        ├── nasguard.js       # Monitor del NAS OpenMediaVault (cada 6h)
        ├── latido.js         # Señal de vida al centinela externo (cada 5 min)
        ├── scheduler.js      # scheduleJob: tareas de fondo con IA, 1 ejecución por intervalo aunque se reinicie (/data/bg_last_run.json)
        ├── spendwatch.js     # Avisos del gasto de IA de pago en el pool (cada 2 h, sin IA)
        ├── notifications.js  # Batching de notificaciones
        └── telegram_bot.js   # Bot de Telegram
```

## Variables de entorno (definidas en run.sh)
- `OPENAI_API_KEY` — Key de OpenAI (requerida)
- `ANTHROPIC_API_KEY` — Key de Anthropic (OPCIONAL y hoy SIN USO: desde la v3.36.0, 07-07-2026, ningún
  modelo de Jarvis es `claude-*`). No hace falta ponerla; si está, el gasto en Anthropic NO es de Jarvis.
  El 07-10-2026 Adrián vio ~59 US$/30 días en una clave llamada «Jarvis-Hassio» (Sonnet 4.6, a diario,
  con picos): era la clave de este campo y NO la usaba el código de Jarvis (ver ESTADO_PROYECTO.txt)
- `DEEPSEEK_API_KEY` — Key de DeepSeek (opcional, expertos analisis + razonamiento)
- `SERPER_API_KEY` — Key de Serper para búsqueda Google (opcional)
- `LANGUAGE` — es (default)
- `HA_TOKEN` — ${SUPERVISOR_TOKEN} (acceso completo a HA, automático)
- `HA_URL` — http://supervisor/core
- `PROXMOX_URL`, `PROXMOX_TOKEN`, `PROXMOX_NODE` — Proxmox (opcionales)
- `OMV_URL`, `OMV_USER`, `OMV_PASSWORD` — NAS OpenMediaVault (opcionales). Sin `OMV_URL`, nasguard no arranca
- `GITHUB_TOKEN` — Token GitHub para github_push (opcional)
- `CENTINELA_URL`, `CENTINELA_CLAVE` — Worker de Cloudflare que vigila la casa
  desde fuera (opcionales). Sin `CENTINELA_URL`, `latido.js` no manda nada
- `NAS_DISCOS_IGNORADOS` — discos del NAS que no deben generar avisos de
  nasguard, separados por comas (p.ej. `sdd`). Para un disco ya diagnosticado y
  en camino a garantía: sigue degradándose y avisar de ello es ruido
- `POOL_URL`, `POOL_API_KEY`, `POOL_MODEL` — Pool de IA local de casa (opcionales,
  v3.39.0). Servidor OpenAI-compatible en la LAN (modelo `jarvis:1.0`). Con URL +
  clave, TODO va por el pool y NO hay respaldos propios (v3.44.0); sin ellas, modo
  directo (DeepSeek/OpenAI con sus claves) como antes del pool. La URL puede llevar o no `/openai/v1` al final
  (v3.39.1). La dirección concreta, en las opciones del add-on — no se publica aquí.
- `POOL_SPEND_ALERT_EUR` — cifra mensual (EUR) de los avisos de gasto en el pool cuando el Core aún no
  tiene tope por proyecto (v3.45.0; 15 por defecto = lo que fijó Adrián). Sin opción en el add-on.
- `POOL_MODEL_FONDO` — modelo virtual del pool para trabajo de fondo (opcional, v3.42.0). Vacío o el antiguo
  `jarvis-fondo:1.0` = se usa `jarvis-fondo-local:1.0` (SOLO local, sin pago; v3.47.3; `POOL_FONDO_LOCAL=0` lo desactiva). Lo usan las tareas marcadas
  `{background:true}` (`C.FONDO_MODEL`); van con `X-AI-Pool-Priority: batch`.

## Reglas del proyecto

### 🔴 REGLA DE ORO: Impacto de tokens (OBLIGATORIO en cada cambio)
Toda modificación o mejora debe incluir análisis de impacto de consumo de tokens.
- **Si el cambio añade o modifica una llamada LLM**: estimar modelo, frecuencia, tokens in/out, coste diario incremental
- **Si el impacto es negativo** (aumenta coste): justificarlo explícitamente o mitigarlo en el mismo cambio
- **Jerarquía de modelos** (usar el más barato que cumpla el objetivo):
  1. `gpt-4o-mini` ($0.15/$0.60 /MTok) — background, clasificación, resúmenes
  2. `gpt-4.1-mini` ($0.40/$1.60 /MTok) — chat principal, análisis moderado
  3. `deepseek-chat` ($0.27/$1.10 /MTok) — análisis avanzado
  4. `deepseek-reasoner` ($0.55/$2.19 /MTok) — razonamiento profundo, con cautela
  5. `claude-sonnet-4-5` ($3/$15 /MTok) — SOLO tareas de código/dev explícitas
- **Loops de background**: BG_MODEL por defecto, frecuencia en horas (no minutos), MAX_ITER ≤ 6
- **Todo `fetch` a una API de LLM** debe pasar por `callLLM`/`callOpenAI`/etc. (tracking centralizado en llm.js)
- Referencia: coste base actual ~$0.30-0.35/día (v3.33.20). Cualquier feature nueva no debe subirlo más de $0.05/día sin justificación.

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
// CON pool configurado (v3.44.0): TODO → callPool, sin respaldos. Un modelo que no es del
// pool (jarvis*/qwen*) se manda a jarvis:1.0. Si falla, lanza.
// SIN pool (modo directo):
if (model.startsWith('claude-'))   → error (Anthropic ya no existe en Jarvis)
if (model.startsWith('deepseek-')) → callDeepSeek  // R1 no usa tools
default                            → callOpenAI
```

### Bucle agéntico
- Ejecuta TODAS las tools de un turno antes de push al historial
- Un push de assistant message + un push con todos los tool_results por turno
- NUNCA cortar el historial (límite de 60, resumen automático) dejando un `tool` sin su llamada, ni una
  llamada sin su resultado: Anthropic/DeepSeek devuelven 400 ("unexpected tool_use_id found") y el pool
  responde 502 tras probar TODOS los pasos. `repairToolPairs()` (llm.js) lo evita: se aplica antes de enviar
  al pool y al guardar el historial. Si tocas cómo se recorta/resume el historial, conserva esa llamada
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

## Tools disponibles (97 total)

### Dispositivos (5)
1. `get_entities` — Lista entidades por dominio (caché 30s, máx 100)
2. `search_entities` — Búsqueda fuzzy por nombre
3. `get_entity_state` — Estado y atributos de una entidad
4. `call_service` — Ejecutar servicios HA
5. `get_history` — Historial de estados (máx 48h)

### Automatizaciones y scripts (7)
6. `get_automations` — Lista automatizaciones
7. `create_automation` — Escribe YAML en automations.yaml + reload
8. `edit_automation` — Edita automatización existente por alias/id + reload
9. `delete_automation` — Elimina automatización por alias/id + reload
10. `edit_script` — Edita un script existente en scripts.yaml por ID
11. `delete_script` — Elimina un script de scripts.yaml (backup + reload)
12. `reload_config` — Recarga config (automations/scripts/scenes/core/all)

### Filesystem (6)
13. `read_file` — Lee archivos en /config, /addons, /share, /media, /data
14. `write_file` — Escribe en /config, /share, /data (whitelist + backup + YAML check)
15. `append_file` — Añade al final (whitelist + backup + YAML check)
16. `list_directory` — Lista directorio (recursivo opcional)
17. `patch_file` — Modifica sección específica de un archivo YAML/texto
18. `rollback` — Restaura backup de cualquier archivo (list | restore)

### Internet (3)
19. `web_search` — DuckDuckGo (defecto) o Google via Serper
20. `web_search_native` — Búsqueda web nativa de GPT-4.1 (tool integrada, lee páginas)
21. `fetch_url` — Obtiene contenido de una URL (pública: por el pool; red de casa y ficheros crudos: directo)

### Memoria y aprendizaje (5)
22. `save_memory` — Guarda preferencias/rutinas/info (cap: 500 notas)
23. `get_memory` — Consulta memoria
24. `delete_memory` — Elimina nota
25. `learn` — Registra aprendizaje (error/success/pattern/optimization)
26. `knowledge_db` — Base de datos de conocimiento persistente (add/query/list/delete)

### Dashboards (6)
27. `get_dashboards` — Lista todos los dashboards Lovelace
28. `get_dashboard_config` — Lee config completa de un dashboard
29. `update_dashboard` — Modifica dashboard (con backup auto rolling x10)
30. `get_installed_frontend` — Detecta cards custom/HACS/temas
31. `search_hacs_resources` — Busca herramientas en la comunidad HA
32. `review_dashboard` — Auditoría profesional automática del dashboard

### Instalación y conocimiento (7)
33. `scan_installation` — Escanea toda la instalación de HA
34. `score_installation` — Puntuación 0-100 de la instalación con recomendaciones
35. `check_config` — Verifica que la config es válida
36. `install_hacs_resource` — Descarga e instala cards/integraciones
37. `ha_knowledge` — Consulta documentación oficial de HA
38. `validate_yaml` — Valida YAML sin escribirlo
39. `simulate_automation` — Simula una automatización sin ejecutarla (dry-run paso a paso)

### Template (1)
40. `template_render` — Renderiza template Jinja2 via HA API

### Logs y diagnóstico (3)
41. `get_system_logs` — Logs de core, supervisor, host, add-ons (con filtro)
42. `get_error_log` — home-assistant.log directo
43. `get_logbook` — Logbook de eventos de entidades (más legible que get_history)

### Telegram y notificaciones (4)
44. `telegram_send` — Envía mensaje por Telegram
45. `telegram_send_image` — Envía imagen/snapshot de cámara
46. `telegram_get_updates` — Lee mensajes recibidos por el bot
47. `notify_all` — Notifica por Telegram + push HA + TTS a la vez

### Proxmox (1)
48. `proxmox_api` — Gestión completa: VMs, snapshots, storage, red, estado

### Generación de contenido (4)
49. `generate_image` — DALL-E 3, guarda en /share/jarvis/images/
50. `generate_image_gemini` — Genera imágenes con Google Gemini Imagen 4
51. `image_edit` — Edita una imagen existente con DALL-E (inpainting)
52. `render_floorplan` — Plano SVG de la instalación

### Ejecución de código (2)
53. `exec_command` — Ejecuta bash o python (whitelist de dirs)
54. `dev_workspace` — Workspace privado para prototipar/probar código sin tocar /config

### Interfaz y UI (2)
55. `update_ui` — Modifica la propia interfaz de Jarvis
56. `house_3d_map` — Mapa 3D interactivo de la casa (Three.js)

### Voz y audio (3)
57. `speak` — Habla por altavoces del hogar (Alexa, ha_tts Piper)
58. `alexa_bidirectional` — Comandos bidireccionales con Alexa
59. `multi_room_audio` — Audio multi-habitación con altavoces Alexa/HA

### NEXUS y agentes (4)
60. `nexus_manage` — Crea/edita/borra expertos y módulos NEXUS
61. `run_custom_tool` — Ejecuta herramienta custom definida por Adrián
62. `create_custom_tool` — Define nueva herramienta custom
63. `agent_communicate` — Comunicación con otros agentes de la red

### Red local y dispositivos IoT (4)
64. `network` — arp_table, scan_subnet, ping, port_scan, http_request, wol
65. `agent_chat` — Habla con LM Studio, LocalAI (OpenAI-compatible)
66. `mqtt_publish` — Publica mensajes MQTT (Zigbee2MQTT, Tasmota, ESPHome)
67. `zigbee_manage` — Gestiona Zigbee2MQTT: emparejar, renombrar, red, OTA

### HA avanzado (10)
68. `ha_supervisor` — Gestiona add-ons, snapshots, info del supervisor
69. `update_self` — Auto-actualiza el propio código de Jarvis
70. `create_addon` — Crea nuevo add-on de HA desde cero
71. `github_push` — Sube cambios al repositorio de GitHub
72. `analyze_github_repos` — Analiza repos del usuario en GitHub
73. `emergency_config` — Configuración de emergencia del sistema
74. `manage_users` — Gestiona usuarios de HA
75. `backup_restore` — Lista/crea/restaura/elimina snapshots de HA
76. `system_info` — Info de hardware, host, red, DNS, almacenamiento
77. `integration_repair` — Diagnostica y repara integraciones (list/reload/etc.)

### Notificaciones HA (2)
78. `get_notifications` — Lee notificaciones del sistema HA
79. `get_repairs` — Lee repairs/alertas de HA

### Patrones y rutinas (2)
80. `analyze_patterns` — Analiza snapshots de estado para detectar rutinas
81. `proactive_thought` — Registra/consulta pensamientos proactivos de Jarvis

### Archivos del PC (1)
82. `local_file` — Lee archivos del PC via File System Access API

### Dispositivos avanzados e integraciones (2)
83. `zha_matter_manage` — Gestiona dispositivos ZHA y Matter/Thread
84. `esphome_manage` — Gestiona dispositivos ESPHome (listar/config/flash/logs)

### Energía y clima (3)
85. `energy_query` — Consumo, producción solar y coste desde estadísticas HA
86. `climate_optimize` — Analiza y optimiza uso de HVAC, sugiere automatizaciones
87. `weather_forecast` — Previsión meteorológica interpretada para decisiones domóticas

### Inteligencia y análisis del hogar (9)
88. `show_house_status` — Panel visual en el chat con el estado de la casa
89. `presence_predict` — Analiza patrones de presencia y predice comportamiento
90. `input_manage` — Gestiona input helpers (boolean/number/text/select/datetime)
91. `automation_analytics` — Uso/rendimiento de automatizaciones (más/menos usadas, sin usar)
92. `camera_analyze` — Snapshot de cámara + análisis con IA de visión (GPT-4o)
93. `area_manage` — Gestiona áreas/habitaciones de HA (list/create/devices)
94. `smart_schedule` — Horarios inteligentes combinando PVPC + presencia + clima
95. `device_health` — Batería, última actividad, firmware y señal de dispositivos
96. `anomaly_detect` — Detecta anomalías comparando con línea base histórica

### NAS OpenMediaVault (1)
97. `omv_status` — Estado del NAS vía API RPC de OMV (discos/SMART, volúmenes, servicios, contenedores). Solo lectura. Requiere `omv_url`+`omv_user`+`omv_password`. **Usar la IP de Tailscale del NAS**, no la de su LAN: HA tiene el complemento Tailscale con *"Accept routes"* DESACTIVADO, así que no alcanza la red del NAS aunque este anuncie esa ruta. (La dirección concreta, en las opciones del add-on — no se publica aquí.)

## UI — Funcionalidades actuales

- **Cabeza holográfica 3D** (Three.js r128): wireframe, estados idle/thinking/speaking
- **Modo Voz fullscreen**: MediaRecorder → Whisper STT, TTS siempre activo
- **Slash commands**: `/` en el input muestra menú con /estado, /scan, /score, /diagnostico, /backup, /logs, /memoria, /ayuda
- **Adjuntar archivos**: imágenes y documentos al chat
- **Panel lateral**: estado de la casa en tiempo real

## Avisos, vigilantes y el NAS — lecciones que cuestan caras

### El canal de avisos
Todo vigilante de background (`netguard`, `infraguard`, `nasguard`) avisa por
`utils/notify.js`, NUNCA con un `haPost` suelto envuelto en un `catch {}` vacío.
Un aviso que se pierde en silencio es peor que no tenerlo: el 29-08-2026 un
disco del NAS se pasó a solo lectura, nasguard lo detectó, y no se supo en
catorce días.

### Hay TRES bots de Telegram y no son intercambiables
1. **El de la integración de HA** — servicios `telegram_bot.send_message` /
   `notify.telegram`. Configurado en el `configuration.yaml` de HA.
2. **El propio del add-on** — opción `telegram_bot_token`, lo sondea
   `background/telegram_bot.js`. Es el único con el que se puede CONVERSAR.
3. **El del centinela externo** — vive como secreto del Worker de Cloudflare.
   Solo avisos, de una dirección.

No compartir token entre ellos: dos sondeos de `getUpdates` sobre el mismo bot
se comen los mensajes el uno al otro. Y al depurar cualquier cosa de Telegram,
la primera pregunta es **de qué bot hablamos** (`getMe` lo dice sin exponer el
token). En v3.38.4 la guarda preguntaba por el bot 2 y la acción llamaba al 1,
y por eso los avisos del NAS no salían.

### La API RPC de OMV no está documentada NI versionada
Puede cambiar en una actualización del NAS sin que nadie lo anuncie, y romper
`utils/omv-api.js` en silencio. Pasó el 12-09-2026: OMV 8.5.7 convirtió
`Session.login` en dos pasos y cambió `{authenticated: true}` por
`{status: "authenticated"}`, así que un login válido se leía como credenciales
rechazadas.

**Al depurarla, leer el código que corre en la máquina**, no suponer:
`/var/www/openmediavault/rpc/*.inc` y
`/usr/share/openmediavault/engined/rpc/*.inc`. Y `omv-rpc -u admin <Servicio>
<metodo> '<json>'` por SSH ejecuta las mismas llamadas en local, sin contraseña
web: sirve para comprobar que los métodos y sus campos siguen existiendo.

⚠️ `HTTP 200` en nginx y `Authorized login` en el log de OMV pueden ser las dos
cosas ciertas y aun así el cliente dar el login por fallido. No fiarse de un
código de estado como prueba de éxito.

### Reparar automáticamente solo lo que se acaba de romper
Contar entidades `unavailable` NO sirve para decidir si hay una avería: en esta
casa hay entidades muertas de forma crónica. Lo que delata una avería real es
que cayeran TODAS A LA VEZ (ventana de 3 min, `caidaSimultanea` en
`background/proactive.js`). Con el contador a secas, Jarvis reiniciaba
Zigbee2MQTT cuatro veces al día por culpa de unos sensores de un NAS apagado.

Y el reinicio de un servicio lo decide UNA sola pieza, la que mira la señal
correcta. Dos vigilantes sobre lo mismo, cada uno con su contador, no son el
doble de seguros.

### El backup de Proxmox puede dejar a HA "sin internet" sin estarlo
HA es la VM 101 de Proxmox. Su backup nocturno (03:00, modo snapshot) la PAUSA
unos 15 s, y eso puede dejar la red de HA OS medio rota: puerto 80 de salida
colgado y `host_internet: false` con `supervisor_internet: true`. El Supervisor
entonces BLOQUEA las actualizaciones y se caen enchufes y ESPHome. Lo cura
reiniciar el anfitrión, y desde v3.38.11 lo hace `infraguard` solo, con
guardarraíles (nunca en la ventana de backups, máximo una vez al día).

Para diagnosticarlo a mano, desde la terminal de HA:
`ha network info` (mira `host_internet`) y
`curl http://checkonline.home-assistant.io/online.txt` — si el HTTP plano no
responde pero el HTTPS sí, es esto.

⚠️ La terminal de HA va en una pestaña del navegador: si el frontend se recarga,
la pestaña vuelve al panel y lo que tecleas se convierte en ATAJOS de teclado
(la "a" abre Assist, la "e" el buscador de entidades, la "m" Mi enlace).
Comprobar SIEMPRE que se ve el prompt `[core-ssh ~]$` antes de escribir.

### El pool de IA local: que el log diga "ACTIVO" NO significa que funcione
`run.sh` imprime `Pool IA local: ACTIVO` solo porque las variables existen, no
porque el pool responda. En v3.39.0 la URL llevaba ya `/openai/v1` (así la da el
panel del pool) y `callPool` le añadía otro `/openai/v1/chat/completions` → 404
→ caía a DeepSeek en silencio, con el arranque diciendo "ACTIVO". Se arregló en
v3.39.1 (se acepta la URL con o sin sufijo).

Para validar de verdad, mirar el log del add-on tras una petición real:
- `[llm] pool OK: <modelo>@<worker> | prompt N (cache C, nuevos N-C) | out M` →
  entra al pool (traza añadida en v3.39.2).
- `[llm] pool ERROR (<ruta>): ...` → falló (v3.44.0: SIN respaldo, la llamada falla); el
  motivo va detrás. `pool error 503: no online device...` = el pool no tiene equipo libre;
  `The user aborted a request` = nuestro plazo (120 s interactivo / 180 s fondo).

Reglas de convivencia con el pool (la GPU es compartida, de una petición en una):
- Un solo intento, SIN respaldos propios (el Core lleva local → pago); NUNCA ráfagas en paralelo.
- `callPool` manda `X-AI-Pool-Timeout` para que el pool saque de su cola lo que
  ya cortamos nosotros, y `X-AI-Pool-Use` (chat_<experto>, router, fondo_*, proactivo, voz,
  busqueda, lectura, voz_tts, imagen, camara) para el desglose de gasto en `GET /v1/spend/usage?by=use` del Core.
- El tiempo lo marcan los tokens NUEVOS por vuelta (`prompt_tokens − cached_tokens`),
  a ~90 tok/s con la GPU libre. Las 96 tools se cachean; los estados de HA y los
  resultados de tools no. Ver la optimización de payload en `FUTURAS_MEJORAS.txt`.
- No usar streaming con tools (400). `callPool` manda `thinking: {"type":"disabled"}` POR DEFECTO (formato
  objeto de DeepSeek; el tramo local lo ignora) y `{"type":"enabled"}` solo si la ruta pide razonar
  (`thinking:true|'max'`: experto razonamiento). NO se manda a `jarvis-vision`. Sin esto, el razonamiento
  de v4-pro/flash se come el `max_tokens` y una respuesta vacía acaba en Haiku (el Core solo lo apaga solo
  con `max_tokens` ≤256).
- Modelos virtuales: `jarvis:1.0` (chat), `jarvis-fondo:1.0` (fondo, batch), `jarvis-analisis:1.0`,
  `jarvis-razonamiento:1.0` y `jarvis-vision:1.0` (cámaras, solo pago). Voz, búsqueda web y visión
  también por el pool; quedan directos (el pool no los sirve): Edge TTS (gratis). Voz (`voz:1.0`) e imágenes/edición (`imagen:1.0`, con `aspect_ratio` y `mask`) van por el pool (v3.47.0). `fetch_url`, `search_hacs_resources` y `ha_knowledge`
  van por `/v1/tools/read` y `/v1/tools/search` (v3.46.0); `fetch_url` sigue directo solo para la red de casa y ficheros crudos/APIs.

### El Core del pool también enruta a modelos de PAGO (v3.41.0)
`jarvis:1.0` = cadena local (qwen3.6 → gemma4 → prisma) → de pago (deepseek-v4-pro →
v4-flash → claude-haiku-4-5). Si el local no responde en ~10 s (interactivo) o ~60 s
(`X-AI-Pool-Priority: batch`), y nunca más del 40 % de `X-AI-Pool-Timeout`, contesta el
de pago. Cada respuesta trae `X-AI-Pool-Source: local|paid` y `X-AI-Pool-Model` (el real).
- El gasto de pago lo lleva el pool (100 €/mes TOTAL, compartido con todas las apps). Jarvis
  lo cuenta además en su guarda diario al precio del modelo real (`poolPriceKey` en `llm.js`):
  si se ignorara `X-AI-Pool-Source`, `jarvis:1.0` valdría $0 y el guarda no vería ese gasto.
- Un modelo de pago puede RAZONAR antes de responder (v4-pro): con `max_tokens` bajo puede
  salir vacío. El Core trata la respuesta vacía como error y pasa al siguiente de la cadena (sin
  apuntarla en su libro, aunque el proveedor puede cobrar los tokens de razonar). Por eso el router
  de expertos pide max_tokens 128 y no 10. El Core aún NO desactiva el razonamiento de DeepSeek.
- Con el presupuesto en critical/over el Core bloquea SOLO lo `batch`: HTTP 429 con
  `code: "budget_deferred"`. Esa tarea se omite (`e.budgetBlocked`); no hay respaldo.
- `X-AI-Pool-Model` en pago llega como `paid:proveedor/modelo` (p. ej. `paid:deepseek/deepseek-v4-pro`).
- Tope POR PROYECTO del Core = corte DURO: al alcanzarlo toda llamada de pago de Jarvis recibe 429
  `project_budget_exceeded` (distinto del global de 100 €, que solo aplaza lo `batch`). `spendwatch.js` avisa al
  70/90/100 % leyendo `GET /v1/spend/me`; el error del tope no lleva "429" en el texto para que el bucle no lo reintente.
- Contrato del Core: `ai-pool/pool/docs/plan-ia-de-pago-en-el-pool.md` (§8) y `contrato-modo-pool.md`.

### Con el pool, el prompt tiene que ser un PREFIJO ESTABLE (v3.40.0)
La caché del pool solo vale mientras el comienzo del prompt sea idéntico byte a byte.
Reglas que NO hay que romper al tocar `server.js`, `nexus/layers.js` o `utils/context.js`:
- Nada que cambie por petición (hora, nº de mensajes, estado de HA, memoria por
  relevancia) en el system prompt. Va en `_ctx` del mensaje del usuario
  (`buildTurnSnapshot`), que se guarda una vez y se expande siempre igual.
- Lo que el bucle manda (mensaje del asistente, resultados de tools) debe ser lo
  MISMO que se guarda en el historial; si se re-trunca distinto al guardar, el turno
  siguiente no coincide con el anterior.
- No acortar el historial con una ventana deslizante: mueve el comienzo en cada turno.
  Lo recorta el resumen automático, que reescribe el inicio de golpe y pocas veces.
- `warmPool()` (arranque) y `poolWarm()` (al abrir conversación, máx cada 5 min) piden el
  modelo local en caliente con `POST /v1/inference/warm` (instantáneo, sin coste). Ya NO hay
  cortacircuitos ni reintentos (v3.44.0). NO calentar mandando el prefijo entero por
  `chat/completions`: con la cadena de pago del Core lo contestaría un modelo de PAGO tras ~10 s
  locales (gasto + caché local sin calentar).

## Documentos de referencia en la raíz

- `FUTURAS_MEJORAS.txt` — roadmap oficial con sprints priorizados
- `ANALISIS_MEJORAS.txt` — audit de deuda técnica (leer antes de refactorizar)
- `ESTADO_PROYECTO.txt` — estado actual completo
- `CHANGELOG.txt` — historial de versiones
