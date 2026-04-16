"""
SSE (Server-Sent Events) router for real-time config sync across browser tabs/windows.

Clients authenticate via Bearer token (same JWT used elsewhere in the app).
All connections belonging to the same user_id receive broadcast updates when
that user POSTs to /api/sse/update-config.
"""

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse

from .auth import get_current_user
from ..auth import decode_access_token
from ..database import get_user_by_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sse", tags=["sse"])

# In-memory store: user_id → list of asyncio.Queue objects (one per open connection)
_clients: dict[str, list[asyncio.Queue]] = {}

# In-memory store: user_id → latest config dict
_configs: dict[str, dict[str, Any]] = {}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _add_client(user_id: str) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    _clients.setdefault(user_id, []).append(q)
    logger.info("SSE client connected  user=%s  total=%d", user_id, len(_clients[user_id]))
    return q


def _remove_client(user_id: str, q: asyncio.Queue) -> None:
    if user_id in _clients:
        try:
            _clients[user_id].remove(q)
        except ValueError:
            pass
        if not _clients[user_id]:
            del _clients[user_id]
    logger.info("SSE client disconnected user=%s", user_id)


async def _broadcast(user_id: str, payload: dict) -> None:
    """Push a payload to every open connection for user_id."""
    queues = list(_clients.get(user_id, []))
    for q in queues:
        await q.put(payload)
    logger.info("SSE broadcast user=%s  recipients=%d", user_id, len(queues))


def _format_sse(data: Any, event: str = "config_update") -> str:
    """Format a dict as an SSE message."""
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


# ---------------------------------------------------------------------------
# GET /api/sse/events  – SSE stream
# ---------------------------------------------------------------------------

async def _resolve_user(request: Request, token: str | None = Query(default=None)):
    """
    Resolve the current user from either:
      1. Authorization: Bearer <token>  header  (fetch / XHR)
      2. ?token=<jwt>                   query   (EventSource – cannot set headers)
    """
    # Prefer query param so EventSource works transparently
    raw_token = token or request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    if not raw_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="No autenticado")

    payload = decode_access_token(raw_token)
    if payload is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token inválido o expirado")

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token inválido")

    user = get_user_by_id(user_id)
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Usuario no encontrado o inactivo")

    return user


@router.get("/events")
async def sse_events(
    request: Request,
    current_user=Depends(_resolve_user),
):
    """
    Open a persistent SSE connection for the authenticated user.

    The Bearer token must be sent either as:
      - Authorization: Bearer <token>   (standard header)
      - Query param ?token=<token>      (for EventSource which can't set headers)
    """
    user_id: str = current_user.id
    q = _add_client(user_id)

    async def event_generator():
        # Send the current config immediately so the new tab is in sync
        current_config = _configs.get(user_id)
        if current_config is not None:
            yield _format_sse(
                {
                    "config": current_config,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "source": "initial_sync",
                },
            )
        else:
            # Let the client know the stream is alive
            yield _format_sse(
                {
                    "config": {},
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "source": "connected",
                },
            )

        try:
            while True:
                # Check if the client has disconnected
                if await request.is_disconnected():
                    break

                try:
                    # Wait up to 25 s for a new event, then send a keep-alive
                    payload = await asyncio.wait_for(q.get(), timeout=25)
                    yield _format_sse(payload)
                except asyncio.TimeoutError:
                    # SSE comment used as keep-alive (ignored by EventSource)
                    yield ": keep-alive\n\n"
        finally:
            _remove_client(user_id, q)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",   # disable nginx buffering
            "Connection": "keep-alive",
        },
    )


# ---------------------------------------------------------------------------
# POST /api/sse/update-config  – broadcast a new config
# ---------------------------------------------------------------------------

@router.post("/update-config", status_code=status.HTTP_200_OK)
async def update_config(
    request: Request,
    current_user=Depends(get_current_user),
):
    """
    Accept a JSON config body, persist it in memory, and broadcast it to all
    browser tabs/windows currently connected for this user.
    """
    try:
        config: dict = await request.json()
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Request body must be valid JSON.",
        )

    user_id: str = current_user.id
    _configs[user_id] = config

    payload = {
        "config": config,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "source": "update",
        "user_id": user_id,
    }
    await _broadcast(user_id, payload)

    return {
        "status": "ok",
        "recipients": len(_clients.get(user_id, [])),
        "timestamp": payload["timestamp"],
    }


# ---------------------------------------------------------------------------
# GET /api/sse/config  – retrieve current config without opening a stream
# ---------------------------------------------------------------------------

@router.get("/config")
async def get_config(current_user=Depends(get_current_user)):
    """Return the latest saved config for the authenticated user."""
    user_id: str = current_user.id
    config = _configs.get(user_id, {})
    return {
        "config": config,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
