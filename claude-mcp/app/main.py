import os
import json
import asyncio
import uuid
from typing import Optional
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse
import uvicorn
import mcp_server

app = FastAPI(title="Claude MCP Server for Home Assistant")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

PORT = int(os.environ.get("PORT", 8765))

# Almacén de sesiones activas
sessions = {}

@app.get("/")
async def root():
    return {"status": "Claude MCP Server running", "tools": len(mcp_server.TOOLS)}

@app.get("/health")
async def health():
    return {"status": "ok"}

@app.get("/sse")
async def sse_endpoint(request: Request):
    """Endpoint SSE principal para MCP"""
    session_id = str(uuid.uuid4())
    queue = asyncio.Queue()
    sessions[session_id] = queue

    async def event_generator():
        # Enviar endpoint de mensajes al cliente
        yield {
            "event": "endpoint",
            "data": f"/messages/{session_id}"
        }
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    message = await asyncio.wait_for(queue.get(), timeout=30.0)
                    yield {
                        "event": "message",
                        "data": json.dumps(message)
                    }
                except asyncio.TimeoutError:
                    # Keepalive ping
                    yield {
                        "event": "ping",
                        "data": ""
                    }
        finally:
            sessions.pop(session_id, None)

    return EventSourceResponse(event_generator())

@app.post("/messages/{session_id}")
async def handle_message(session_id: str, request: Request):
    """Recibe mensajes JSON-RPC del cliente MCP"""
    body = await request.json()
    queue = sessions.get(session_id)

    method = body.get("method", "")
    msg_id = body.get("id")

    if method == "initialize":
        response = {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {}
                },
                "serverInfo": {
                    "name": "claude-ha-mcp",
                    "version": "1.0.0"
                }
            }
        }

    elif method == "tools/list":
        response = {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "tools": mcp_server.TOOLS
            }
        }

    elif method == "tools/call":
        params = body.get("params", {})
        tool_name = params.get("name")
        arguments = params.get("arguments", {})

        result = await mcp_server.execute_tool(tool_name, arguments)

        response = {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps(result, ensure_ascii=False, indent=2)
                    }
                ]
            }
        }

    elif method == "notifications/initialized":
        return Response(status_code=200)

    else:
        response = {
            "jsonrpc": "2.0",
            "id": msg_id,
            "error": {
                "code": -32601,
                "message": f"Método no encontrado: {method}"
            }
        }

    if queue:
        await queue.put(response)

    return Response(status_code=202)

if __name__ == "__main__":
    print(f"🤖 Claude MCP Server arrancando en puerto {PORT}...")
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
