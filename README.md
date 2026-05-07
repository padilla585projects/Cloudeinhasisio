# Claude in HASIO 🤖🏠

> **Idea original y desarrollo por [padilla585projects](https://github.com/padilla585projects)**

Addon para Home Assistant que integra Claude (Anthropic) como asistente completo con acceso total a tu instalación. Permite controlar dispositivos, crear y modificar automatizaciones, leer sensores y mucho más, tanto desde el Assist de Home Assistant como desde Claude.ai.

## ¿Qué hace este addon?

- 🧠 **Claude como asistente dentro de HA** — Habla con Claude directamente desde el Assist de Home Assistant
- 🔌 **Acceso completo a la API de HA** — Claude puede leer y modificar automatizaciones, controlar dispositivos, leer sensores, etc.
- 🌐 **Acceso remoto desde Claude.ai** — Conecta tu Home Assistant con Claude.ai via servidor MCP
- ⚡ **Servidor MCP nativo** — Implementación completa del protocolo MCP (Model Context Protocol)

## Herramientas disponibles

| Herramienta | Descripción |
|---|---|
| `get_states` | Lista todos los dispositivos y su estado |
| `get_state` | Estado de una entidad específica |
| `get_automations` | Lista todas las automatizaciones |
| `get_automation_config` | Configuración completa de una automatización |
| `create_automation` | Crea una nueva automatización |
| `update_automation` | Modifica una automatización existente |
| `delete_automation` | Elimina una automatización |
| `trigger_automation` | Dispara una automatización manualmente |
| `enable_automation` | Habilita una automatización |
| `disable_automation` | Deshabilita una automatización |
| `turn_on` | Enciende cualquier entidad |
| `turn_off` | Apaga cualquier entidad |
| `call_service` | Llama a cualquier servicio de HA |
| `get_history` | Historial de estados de una entidad |
| `render_template` | Renderiza plantillas Jinja2 |
| `reload_automations` | Recarga todas las automatizaciones |

## Instalación

### 1. Añadir el repositorio a Home Assistant

En Home Assistant ve a:
**Configuración → Complementos → Tienda de complementos → ⋮ → Repositorios**

Añade esta URL:
```
https://github.com/padilla585projects/Cloudeinhasisio
```

### 2. Instalar el addon

Busca **"Claude MCP Server"** en la tienda de complementos e instálalo.

### 3. Configurar

En la pestaña **Configuración** del addon:

```yaml
anthropic_api_key: "sk-ant-..."   # Tu API key de Anthropic
ha_token: ""                       # Opcional, se usa el token del supervisor automáticamente
port: 8765
```

### 4. Conectar con Claude.ai

Una vez arrancado el addon, añade el servidor MCP en Claude.ai:

**Claude.ai → Configuración → Conectores → Añadir MCP**

```
URL: https://TU-NABU-CASA.ui.nabu.casa/api/hassio_ingress/claude_mcp/sse
```

## Requisitos

- Home Assistant OS o Supervised
- Home Assistant 2025.1 o superior
- Cuenta en [Anthropic](https://console.anthropic.com) con API key
- Nabu Casa (para acceso remoto desde Claude.ai)

## Arquitectura

```
Claude.ai ←──── MCP Protocol ────→ Claude MCP Addon ←──── API interna ────→ Home Assistant
                                          ↑
                                    Assist de HA
```

## Licencia

MIT License — Ver archivo [LICENSE](LICENSE)

## Autor

**padilla585projects** — Idea original y desarrollo completo.

---

*Si te resulta útil, dale una ⭐ al repositorio*
