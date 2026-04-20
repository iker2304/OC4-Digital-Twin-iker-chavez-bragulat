"""
MQTT REST + SSE router
-----------------------
GET  /api/mqtt/messages/{node_id}          – poll buffered messages
GET  /api/mqtt/stream/{node_id}            – SSE live stream of incoming messages
POST /api/mqtt/subscribe                   – manually subscribe a node
DELETE /api/mqtt/subscribe/{node_id}       – unsubscribe a node
GET  /api/mqtt/status/{node_id}            – connection status
"""

from __future__ import annotations

import asyncio
import json
import logging
import queue
import threading
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.mqtt import manager as mqtt_mgr

logger = logging.getLogger("app.mqtt_router")

router = APIRouter(tags=["mqtt"])


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class SubscribeRequest(BaseModel):
    nodeId: str
    broker: str = "localhost"
    port: int = 1883
    topic: str
    qos: int = 0


# ---------------------------------------------------------------------------
# REST helpers
# ---------------------------------------------------------------------------

@router.post("/subscribe")
async def subscribe(req: SubscribeRequest):
    conn = mqtt_mgr.subscribe_node(req.nodeId, req.broker, req.port, req.topic, req.qos)
    return {
        "status": "subscribed",
        "nodeId": req.nodeId,
        "broker": req.broker,
        "port": req.port,
        "topic": req.topic,
        "connected": conn.is_connected(),
    }


@router.delete("/subscribe/{node_id}")
async def unsubscribe(node_id: str, broker: str = "localhost", port: int = 1883):
    mqtt_mgr.unsubscribe_node(node_id, broker, port)
    return {"status": "unsubscribed", "nodeId": node_id}


@router.get("/messages/{node_id}")
async def get_messages(node_id: str, broker: str = "localhost", port: int = 1883):
    msgs = mqtt_mgr.get_messages(node_id, broker, port)
    return {"nodeId": node_id, "messages": msgs, "count": len(msgs)}


@router.get("/status/{node_id}")
async def status(node_id: str, broker: str = "localhost", port: int = 1883):
    conn = mqtt_mgr.get_connection(broker, port)
    return {
        "nodeId": node_id,
        "broker": broker,
        "port": port,
        "connected": conn.is_connected(),
    }


# ---------------------------------------------------------------------------
# SSE live stream
# ---------------------------------------------------------------------------

@router.get("/stream/{node_id}")
async def sse_stream(
    node_id: str,
    request: Request,
    broker: str = "localhost",
    port: int = 1883,
    topic: str = "#",
    qos: int = 0,
):
    """
    Open a Server-Sent Events stream that forwards every MQTT message
    received on the topic to the browser in real time.

    The node is automatically subscribed when the SSE connection opens
    and the existing message buffer is flushed first.
    """
    # Ensure we're subscribed
    mqtt_mgr.subscribe_node(node_id, broker, port, topic, qos)

    # Thread-safe queue to bridge the paho callback thread → async generator
    msg_queue: queue.Queue = queue.Queue()

    def on_message(entry: Dict):
        msg_queue.put(entry)

    mqtt_mgr.add_listener(node_id, broker, port, on_message)

    async def event_generator():
        # First, flush any buffered messages
        conn = mqtt_mgr.get_connection(broker, port)
        buffered = conn.get_messages(node_id)
        for msg in buffered:
            yield _fmt(msg)

        # Send connection status event
        yield _fmt_event(
            "status",
            {
                "connected": conn.is_connected(),
                "broker": broker,
                "port": port,
                "topic": topic,
                "nodeId": node_id,
            },
        )

        try:
            while True:
                if await request.is_disconnected():
                    break
                # Drain the thread-safe queue
                drained = False
                while True:
                    try:
                        entry = msg_queue.get_nowait()
                        yield _fmt(entry)
                        drained = True
                    except queue.Empty:
                        break
                if not drained:
                    # Nothing arrived — keep-alive comment + small sleep
                    yield ": keep-alive\n\n"
                    await asyncio.sleep(0.2)
        finally:
            mqtt_mgr.remove_listener(node_id, broker, port, on_message)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


def _fmt(entry: Dict) -> str:
    return f"event: mqtt_message\ndata: {json.dumps(entry)}\n\n"


def _fmt_event(event: str, data: Dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"
