# Claude AI Agent para Home Assistant 🤖🏠

> **Desarrollo por [padilla585projects](https://github.com/padilla585projects)**

Add-on para Home Assistant que integra un **Agente IA completo** basado en Claude (Anthropic) directamente en el panel lateral de HA. No es solo un chatbot — es un ingeniero domótico privado con acceso total a tu instalación.

## Qué puede hacer

- 🏠 **Controlar toda tu casa** — Luces, clima, media, covers, locks, switches, escenas, scripts
- ⚙️ **Crear automatizaciones** — Escribe YAML directamente en automations.yaml y recarga
- 📁 **Acceso a archivos** — Lee y edita configuration.yaml, scripts, escenas y cualquier archivo
- 🌐 **Buscar en internet** — Documentación de HA, soluciones a errores, integraciones
- 🧠 **Memoria permanente** — Recuerda tus preferencias, rutinas y configuraciones
- 🧪 **Aprende de sus errores** — Sistema de learnings que mejora con cada uso
- 🔍 **Escaneo completo** — Conoce todas tus entidades, integraciones, add-ons y archivos
- 💬 **Conversación persistente** — El historial no se pierde al cambiar de pestaña

## Herramientas del agente

| Categoría | Tools |
|-----------|-------|
| **Dispositivos** | get_entities, search_entities, get_entity_state, call_service, get_history |
| **Automatizaciones** | get_automations, create_automation, reload_config, check_config |
| **Filesystem** | read_file, write_file, append_file, list_directory |
| **Internet** | web_search, fetch_url |
| **Memoria** | save_memory, get_memory, delete_memory |
| **Aprendizaje** | learn (errores se registran automáticamente) |
| **Sistema** | scan_installation |

## Instalación

### 1. Añadir el repositorio

En Home Assistant:
**Configuración → Complementos → Tienda de complementos → ⋮ → Repositorios**

Añade:
```
https://github.com/padilla585projects/Cloudeinhasisio
```

### 2. Instalar el add-on

Busca **"Claude AI Agent"** en la tienda de complementos e instálalo.

### 3. Configurar

En la pestaña **Configuración** del add-on:

```yaml
anthropic_api_key: "sk-ant-..."   # Tu API key de Anthropic
model: "claude-sonnet-4-6"        # Modelo (default)
language: "es"                     # Idioma
```

### 4. Iniciar

Arranca el add-on. Aparecerá **"Claude AI"** en el panel lateral de HA.

La primera vez, el agente escaneará toda tu instalación para conocer tus dispositivos, integraciones y configuración.

## Cómo aprende

El agente tiene un sistema de mejora continua:

1. **Memoria** — Guarda preferencias y patrones que expresas ("me gusta la luz al 40%")
2. **Learnings** — Registra errores y soluciones. No repite errores.
3. **Contexto** — Escanea tu instalación y lo inyecta en su prompt
4. **Historial** — Mantiene la conversación entre sesiones

Cuanto más lo uses, mejor conocerá tu casa y tus preferencias.

## Arquitectura

```
Panel Lateral HA → index.html (UI chat + SSE) → server.js (Express)
                                                      ↓           ↓          ↓
                                               API Anthropic   API HA   Filesystem
                                               (Claude)        (REST)   (/config)
```

## Stack técnico

- **Backend**: Node.js + Express (CommonJS)
- **Frontend**: HTML/CSS/JS vanilla (archivo único, dark theme)
- **Modelo**: Claude Sonnet 4.6 via API REST
- **Streaming**: SSE (Server-Sent Events) al frontend
- **Persistencia**: JSON en /data (memoria, learnings, historial)
- **Docker**: Alpine + Node.js sobre ghcr.io/home-assistant/amd64-base

## Requisitos

- Home Assistant OS o Supervised
- Cuenta en [Anthropic](https://console.anthropic.com) con API key
- Recomendado: Nabu Casa (para acceso remoto)

## Licencia

MIT License — Ver archivo [LICENSE](LICENSE)

## Autor

**padilla585projects** — Idea original y desarrollo.

---

*Si te resulta útil, dale una ⭐ al repositorio*
