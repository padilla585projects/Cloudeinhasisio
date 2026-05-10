# Jarvis AI Agent para Home Assistant

> **Tu ingeniero domotico privado con IA**

Add-on para Home Assistant que integra un **Agente IA autonomo** basado en Claude (Anthropic) directamente en el panel lateral de HA. No es un chatbot — es un ingeniero domotico que controla tu casa, diagnostica problemas, gestiona dashboards, instala herramientas y aprende con cada uso.

## Que puede hacer

- **Controlar toda tu casa** — Luces, clima, media, covers, locks, switches, escenas, scripts
- **Crear automatizaciones** — Lenguaje natural a YAML, recarga automatica
- **Gestionar dashboards** — Analiza, crea y modifica paneles Lovelace completos
- **Instalar herramientas** — Busca y descarga cards/integraciones de HACS automaticamente
- **Diagnosticar problemas** — Lee logs del sistema, detecta errores, busca soluciones
- **Buscar en internet** — Documentacion HA, soluciones, integraciones, mejores practicas
- **Memoria permanente** — Recuerda preferencias, rutinas y configuraciones
- **Aprender de errores** — Sistema de learnings que mejora con cada uso
- **Telegram** — Envia mensajes, fotos y alertas por Telegram
- **Proxmox** — Gestiona el servidor de virtualizacion (VMs, snapshots, backups)
- **Conocimiento experto** — Consulta la wiki de HA, sabe de protocolos, hardware, HACS

## Herramientas del agente (28 tools)

| Categoria | Tools |
|-----------|-------|
| **Dispositivos** | get_entities, search_entities, get_entity_state, call_service, get_history |
| **Automatizaciones** | get_automations, create_automation, reload_config |
| **Filesystem** | read_file, write_file, append_file, list_directory |
| **Internet** | web_search, fetch_url |
| **Memoria** | save_memory, get_memory, delete_memory, learn |
| **Dashboards** | get_dashboards, get_dashboard_config, update_dashboard, get_installed_frontend, search_hacs_resources |
| **Instalacion** | scan_installation, check_config, install_hacs_resource, ha_knowledge |
| **Logs** | get_system_logs, get_error_log |
| **Telegram** | telegram_send, telegram_send_image, telegram_get_updates |
| **Proxmox** | proxmox_api (VMs, snapshots, storage, red, estado) |

## Instalacion

### 1. Anadir el repositorio

En Home Assistant:
**Configuracion -> Complementos -> Tienda de complementos -> ... -> Repositorios**

Anade:
```
https://github.com/padilla585projects/Cloudeinhasisio
```

### 2. Instalar el add-on

Busca **"Jarvis AI Agent"** en la tienda de complementos e instalalo.

### 3. Configurar

En la pestana **Configuracion** del add-on:

```yaml
anthropic_api_key: "sk-ant-..."   # Tu API key de Anthropic
model: "claude-sonnet-4-6"        # Modelo (default)
language: "es"                     # Idioma

# Opcional: Proxmox
proxmox_url: "https://192.168.1.100:8006"
proxmox_token: "user@pam!tokenid=secret"
proxmox_node: "pve"
```

### 4. Iniciar

Arranca el add-on. Aparecera **"Jarvis"** en el panel lateral de HA.

La primera vez, Jarvis escaneara toda tu instalacion para conocer tus dispositivos, integraciones y configuracion.

## Inteligencia

Jarvis tiene un sistema de mejora continua:

1. **Contexto en tiempo real** — Sabe quien esta en casa, que luces hay encendidas, temperaturas, alertas (se actualiza cada 60s)
2. **Memoria** — Guarda preferencias y patrones ("me gusta la luz al 40%")
3. **Learnings** — Registra errores y soluciones. No repite errores.
4. **Conocimiento** — Consulta documentacion oficial de HA cuando necesita info
5. **Proactividad** — Sugiere mejoras, detecta problemas, notifica por Telegram

Cuanto mas lo uses, mejor conocera tu casa y tus preferencias.

## Arquitectura

```
Panel Lateral HA -> index.html (UI chat + SSE) -> server.js (Express)
                                                      |           |          |
                                               API Anthropic   API HA   Filesystem
                                               (Claude)        (REST)   (/config)
                                                                 |
                                                          Proxmox / Telegram
```

## Stack tecnico

- **Backend**: Node.js + Express (CommonJS)
- **Frontend**: HTML/CSS/JS vanilla (archivo unico, dark theme)
- **Modelo**: Claude Sonnet 4.6 via API REST
- **Streaming**: SSE (Server-Sent Events) al frontend
- **Persistencia**: JSON en /data (memoria, learnings, historial, dashboards backup)
- **Docker**: Alpine + Node.js sobre ghcr.io/home-assistant/amd64-base

## Requisitos

- Home Assistant OS o Supervised
- Cuenta en [Anthropic](https://console.anthropic.com) con API key
- Opcional: Bot de Telegram configurado en HA
- Opcional: Proxmox con API token para gestion del servidor

## Licencia

MIT License

## Autor

**padilla585projects**

---

*Si te resulta util, dale una estrella al repositorio*
