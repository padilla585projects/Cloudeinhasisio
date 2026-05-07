import os
import aiohttp
import json
from typing import Any, Optional

HA_URL = os.environ.get("HA_URL", "http://supervisor/core")
HA_TOKEN = os.environ.get("HA_TOKEN", "")
SUPERVISOR_TOKEN = os.environ.get("SUPERVISOR_TOKEN", "")

def get_headers():
    token = SUPERVISOR_TOKEN if SUPERVISOR_TOKEN else HA_TOKEN
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }

async def ha_get(path: str) -> Any:
    async with aiohttp.ClientSession() as session:
        async with session.get(f"{HA_URL}/api{path}", headers=get_headers()) as resp:
            return await resp.json()

async def ha_post(path: str, data: dict = {}) -> Any:
    async with aiohttp.ClientSession() as session:
        async with session.post(f"{HA_URL}/api{path}", headers=get_headers(), json=data) as resp:
            try:
                return await resp.json()
            except:
                return {"status": resp.status}

async def get_states() -> list:
    return await ha_get("/states")

async def get_state(entity_id: str) -> dict:
    return await ha_get(f"/states/{entity_id}")

async def get_automations() -> list:
    states = await get_states()
    return [s for s in states if s["entity_id"].startswith("automation.")]

async def get_automation_config(automation_id: str) -> dict:
    return await ha_get(f"/config/automation/config/{automation_id}")

async def save_automation(automation_id: str, config: dict) -> dict:
    return await ha_post(f"/config/automation/config/{automation_id}", config)

async def create_automation(config: dict) -> dict:
    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{HA_URL}/api/config/automation/config",
            headers=get_headers(),
            json=config
        ) as resp:
            return await resp.json()

async def delete_automation(automation_id: str) -> dict:
    async with aiohttp.ClientSession() as session:
        async with session.delete(
            f"{HA_URL}/api/config/automation/config/{automation_id}",
            headers=get_headers()
        ) as resp:
            return {"status": resp.status}

async def call_service(domain: str, service: str, data: dict = {}) -> dict:
    return await ha_post(f"/services/{domain}/{service}", data)

async def turn_on(entity_id: str) -> dict:
    domain = entity_id.split(".")[0]
    return await call_service(domain, "turn_on", {"entity_id": entity_id})

async def turn_off(entity_id: str) -> dict:
    domain = entity_id.split(".")[0]
    return await call_service(domain, "turn_off", {"entity_id": entity_id})

async def get_scripts() -> list:
    states = await get_states()
    return [s for s in states if s["entity_id"].startswith("script.")]

async def get_scenes() -> list:
    states = await get_states()
    return [s for s in states if s["entity_id"].startswith("scene.")]

async def get_config() -> dict:
    return await ha_get("/config")

async def reload_automations() -> dict:
    return await call_service("automation", "reload")

async def trigger_automation(entity_id: str) -> dict:
    return await call_service("automation", "trigger", {"entity_id": entity_id})

async def enable_automation(entity_id: str) -> dict:
    return await call_service("automation", "turn_on", {"entity_id": entity_id})

async def disable_automation(entity_id: str) -> dict:
    return await call_service("automation", "turn_off", {"entity_id": entity_id})

async def get_history(entity_id: str, hours: int = 24) -> list:
    from datetime import datetime, timedelta
    start = (datetime.utcnow() - timedelta(hours=hours)).isoformat()
    return await ha_get(f"/history/period/{start}?filter_entity_id={entity_id}")

async def get_logbook(hours: int = 24) -> list:
    from datetime import datetime, timedelta
    start = (datetime.utcnow() - timedelta(hours=hours)).isoformat()
    return await ha_get(f"/logbook/{start}")

async def render_template(template: str) -> str:
    result = await ha_post("/template", {"template": template})
    return result if isinstance(result, str) else json.dumps(result)
