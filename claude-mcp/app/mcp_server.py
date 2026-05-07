import json
import asyncio
from typing import Any
import ha_client as ha

# Definición de todas las herramientas MCP disponibles
TOOLS = [
    {
        "name": "get_states",
        "description": "Obtiene el estado de todos los dispositivos y entidades de Home Assistant",
        "inputSchema": {
            "type": "object",
            "properties": {
                "domain": {
                    "type": "string",
                    "description": "Filtrar por dominio (light, switch, sensor, automation, etc.). Opcional."
                }
            }
        }
    },
    {
        "name": "get_state",
        "description": "Obtiene el estado de una entidad específica",
        "inputSchema": {
            "type": "object",
            "properties": {
                "entity_id": {"type": "string", "description": "ID de la entidad, ej: light.salon"}
            },
            "required": ["entity_id"]
        }
    },
    {
        "name": "get_automations",
        "description": "Lista todas las automatizaciones de Home Assistant con su estado",
        "inputSchema": {"type": "object", "properties": {}}
    },
    {
        "name": "get_automation_config",
        "description": "Obtiene la configuración completa (YAML/JSON) de una automatización específica",
        "inputSchema": {
            "type": "object",
            "properties": {
                "automation_id": {"type": "string", "description": "ID numérico de la automatización"}
            },
            "required": ["automation_id"]
        }
    },
    {
        "name": "create_automation",
        "description": "Crea una nueva automatización en Home Assistant",
        "inputSchema": {
            "type": "object",
            "properties": {
                "alias": {"type": "string", "description": "Nombre de la automatización"},
                "description": {"type": "string", "description": "Descripción opcional"},
                "triggers": {"type": "array", "description": "Lista de disparadores"},
                "conditions": {"type": "array", "description": "Lista de condiciones (opcional)"},
                "actions": {"type": "array", "description": "Lista de acciones"}
            },
            "required": ["alias", "triggers", "actions"]
        }
    },
    {
        "name": "update_automation",
        "description": "Modifica una automatización existente",
        "inputSchema": {
            "type": "object",
            "properties": {
                "automation_id": {"type": "string", "description": "ID numérico de la automatización"},
                "config": {"type": "object", "description": "Configuración completa de la automatización"}
            },
            "required": ["automation_id", "config"]
        }
    },
    {
        "name": "delete_automation",
        "description": "Elimina una automatización",
        "inputSchema": {
            "type": "object",
            "properties": {
                "automation_id": {"type": "string", "description": "ID numérico de la automatización"}
            },
            "required": ["automation_id"]
        }
    },
    {
        "name": "trigger_automation",
        "description": "Dispara manualmente una automatización",
        "inputSchema": {
            "type": "object",
            "properties": {
                "entity_id": {"type": "string", "description": "entity_id de la automatización, ej: automation.luz_pasillo"}
            },
            "required": ["entity_id"]
        }
    },
    {
        "name": "enable_automation",
        "description": "Habilita una automatización desactivada",
        "inputSchema": {
            "type": "object",
            "properties": {
                "entity_id": {"type": "string"}
            },
            "required": ["entity_id"]
        }
    },
    {
        "name": "disable_automation",
        "description": "Deshabilita una automatización",
        "inputSchema": {
            "type": "object",
            "properties": {
                "entity_id": {"type": "string"}
            },
            "required": ["entity_id"]
        }
    },
    {
        "name": "turn_on",
        "description": "Enciende una entidad (luz, switch, etc.)",
        "inputSchema": {
            "type": "object",
            "properties": {
                "entity_id": {"type": "string", "description": "ID de la entidad a encender"}
            },
            "required": ["entity_id"]
        }
    },
    {
        "name": "turn_off",
        "description": "Apaga una entidad (luz, switch, etc.)",
        "inputSchema": {
            "type": "object",
            "properties": {
                "entity_id": {"type": "string", "description": "ID de la entidad a apagar"}
            },
            "required": ["entity_id"]
        }
    },
    {
        "name": "call_service",
        "description": "Llama a cualquier servicio de Home Assistant",
        "inputSchema": {
            "type": "object",
            "properties": {
                "domain": {"type": "string", "description": "Dominio del servicio, ej: light"},
                "service": {"type": "string", "description": "Nombre del servicio, ej: turn_on"},
                "data": {"type": "object", "description": "Datos adicionales para el servicio"}
            },
            "required": ["domain", "service"]
        }
    },
    {
        "name": "get_history",
        "description": "Obtiene el historial de estados de una entidad",
        "inputSchema": {
            "type": "object",
            "properties": {
                "entity_id": {"type": "string"},
                "hours": {"type": "integer", "description": "Horas hacia atrás (default 24)"}
            },
            "required": ["entity_id"]
        }
    },
    {
        "name": "render_template",
        "description": "Renderiza una plantilla Jinja2 de Home Assistant",
        "inputSchema": {
            "type": "object",
            "properties": {
                "template": {"type": "string", "description": "Plantilla Jinja2"}
            },
            "required": ["template"]
        }
    },
    {
        "name": "reload_automations",
        "description": "Recarga todas las automatizaciones de Home Assistant",
        "inputSchema": {"type": "object", "properties": {}}
    }
]

async def execute_tool(name: str, arguments: dict) -> Any:
    try:
        if name == "get_states":
            states = await ha.get_states()
            if "domain" in arguments and arguments["domain"]:
                states = [s for s in states if s["entity_id"].startswith(arguments["domain"] + ".")]
            return states

        elif name == "get_state":
            return await ha.get_state(arguments["entity_id"])

        elif name == "get_automations":
            return await ha.get_automations()

        elif name == "get_automation_config":
            return await ha.get_automation_config(arguments["automation_id"])

        elif name == "create_automation":
            config = {
                "alias": arguments["alias"],
                "description": arguments.get("description", ""),
                "triggers": arguments["triggers"],
                "conditions": arguments.get("conditions", []),
                "actions": arguments["actions"],
                "mode": "single"
            }
            return await ha.create_automation(config)

        elif name == "update_automation":
            return await ha.save_automation(arguments["automation_id"], arguments["config"])

        elif name == "delete_automation":
            return await ha.delete_automation(arguments["automation_id"])

        elif name == "trigger_automation":
            return await ha.trigger_automation(arguments["entity_id"])

        elif name == "enable_automation":
            return await ha.enable_automation(arguments["entity_id"])

        elif name == "disable_automation":
            return await ha.disable_automation(arguments["entity_id"])

        elif name == "turn_on":
            return await ha.turn_on(arguments["entity_id"])

        elif name == "turn_off":
            return await ha.turn_off(arguments["entity_id"])

        elif name == "call_service":
            return await ha.call_service(
                arguments["domain"],
                arguments["service"],
                arguments.get("data", {})
            )

        elif name == "get_history":
            return await ha.get_history(
                arguments["entity_id"],
                arguments.get("hours", 24)
            )

        elif name == "render_template":
            return await ha.render_template(arguments["template"])

        elif name == "reload_automations":
            return await ha.reload_automations()

        else:
            return {"error": f"Herramienta desconocida: {name}"}

    except Exception as e:
        return {"error": str(e)}
