"""FEM load simulation router.

REST   GET  /api/fem/loads          – current load state
REST   POST /api/fem/loads          – push a load case manually
WS          /api/fem/ws             – live loads pushed by flow_executor
WS          /api/fem/mqtt-ws        – bridge an MQTT topic → FEM loads
"""
import asyncio
import json
import logging
import math
import queue
import threading
import uuid
from typing import Any, Dict

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fastapi.params import Query
from pydantic import BaseModel

logger = logging.getLogger("app.api.fem")

router = APIRouter()

# ── In-memory state ────────────────────────────────────────────────────────────
_current_loads: Dict[str, Any] = {}
_ws_clients: list[WebSocket] = []


# ── Public helper called by flow_executor ──────────────────────────────────────
def update_fem_loads(loads: Dict[str, Any]) -> None:
    global _current_loads
    _current_loads = loads
    asyncio.get_event_loop().call_soon_threadsafe(
        asyncio.ensure_future, _broadcast(loads)
    )


async def _broadcast(payload: Dict[str, Any]) -> None:
    dead = []
    for ws in _ws_clients:
        try:
            await ws.send_text(json.dumps(payload))
        except Exception:
            dead.append(ws)
    for ws in dead:
        _ws_clients.remove(ws)


# ── REST endpoints ─────────────────────────────────────────────────────────────
class LoadCase(BaseModel):
    Fx: float = 0.0
    Fy: float = 0.0
    Fz: float = 0.0
    Mx: float = 0.0
    My: float = 0.0
    Mz: float = 0.0
    node_forces: Dict[str, list] = {}
    source: str = "manual"


@router.get("/loads")
async def get_loads():
    return _current_loads or {"Fx": 0, "Fy": 0, "Fz": 0, "Mx": 0, "My": 0, "Mz": 0, "node_forces": {}, "source": "none"}


@router.post("/loads")
async def post_loads(body: LoadCase):
    update_fem_loads(body.model_dump())
    return {"status": "ok"}


# ── WebSocket (flow_executor pushes here) ─────────────────────────────────────
@router.websocket("/ws")
async def fem_ws(websocket: WebSocket):
    await websocket.accept()
    _ws_clients.append(websocket)
    logger.info("[FEM] WS client connected (%d total)", len(_ws_clients))
    await websocket.send_text(json.dumps(
        _current_loads or {"Fx": 0, "Fy": 0, "Fz": 0, "Mx": 0, "My": 0, "Mz": 0, "node_forces": {}, "source": "none"}
    ))
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        if websocket in _ws_clients:
            _ws_clients.remove(websocket)
        logger.info("[FEM] WS client disconnected (%d total)", len(_ws_clients))


# ── Helpers: MQTT payload → LoadCase dict ─────────────────────────────────────
def _wind_to_loads(payload: Dict) -> Dict:
    """Convert {windSpeed, windDirection, ...} to {Fx,Fy,Fz,Mx,My,Mz}."""
    v = float(payload.get("windSpeed", payload.get("wind_speed", payload.get("speed", 0))))
    theta = float(payload.get("windDirection", payload.get("wind_direction", payload.get("direction", 0))))
    rho = float(payload.get("airDensity", 1.225))
    D = float(payload.get("rotorDiameter", 126))
    Ct = float(payload.get("thrustCoefficient", payload.get("Ct", 0.8)))
    hub_height = float(payload.get("hubHeight", 90.0))

    A = math.pi * (D / 2) ** 2
    T = 0.5 * rho * Ct * A * v ** 2
    rad = math.radians(theta)
    Fx = T * math.cos(rad)
    Fy = T * math.sin(rad)
    return {
        "Fx": round(Fx, 1), "Fy": round(Fy, 1), "Fz": 0.0,
        "Mx": round(Fy * hub_height, 1), "My": round(-Fx * hub_height, 1), "Mz": 0.0,
        "node_forces": {}, "source": "mqtt_wind",
        "_meta": {"speed_ms": v, "direction_deg": theta, "thrust_N": round(T, 1)},
    }


def _wave_to_loads(payload: Dict) -> Dict:
    """Convert {waveHeight, wavePeriod, ...} to {Fx,Fy,Fz,Mx,My,Mz} via simplified Morison."""
    H = float(payload.get("waveHeight", payload.get("wave_height", payload.get("height", 1.0))))
    T = float(payload.get("wavePeriod", payload.get("wave_period", payload.get("period", 10.0))))
    rho = float(payload.get("waterDensity", 1025.0))
    d = float(payload.get("memberDiameter", 6.5))   # OC4 column diameter (m)
    L = float(payload.get("waterDepth", 200.0))      # effective member length

    omega = 2 * math.pi / max(T, 0.1)
    Cm = float(payload.get("Cm", 2.0))
    Cd = float(payload.get("Cd", 1.0))
    A_m = math.pi * (d / 2) ** 2

    # Max inertia force (Morison, simplified, at surface)
    F_inertia = rho * Cm * A_m * (H / 2) * omega ** 2 * L / 2
    # Max drag force (approximate)
    F_drag = 0.5 * rho * Cd * d * L * (H * omega / 2) ** 2

    Fx = F_inertia + F_drag
    My = -Fx * (L / 2)
    return {
        "Fx": round(Fx, 1), "Fy": 0.0, "Fz": 0.0,
        "Mx": 0.0, "My": round(My, 1), "Mz": 0.0,
        "node_forces": {}, "source": "mqtt_wave",
        "_meta": {"waveHeight_m": H, "wavePeriod_s": T, "force_N": round(Fx, 1)},
    }


def _raw_to_loads(payload: Dict, topic: str) -> Dict:
    """Route payload to the appropriate converter based on keys / topic."""
    if isinstance(payload, dict):
        # Already a load case
        if any(k in payload for k in ("Fx", "Fy", "Fz")):
            return {
                "Fx": float(payload.get("Fx", 0)), "Fy": float(payload.get("Fy", 0)),
                "Fz": float(payload.get("Fz", 0)), "Mx": float(payload.get("Mx", 0)),
                "My": float(payload.get("My", 0)), "Mz": float(payload.get("Mz", 0)),
                "node_forces": payload.get("node_forces", {}), "source": "mqtt_raw",
            }
        if any(k in payload for k in ("windSpeed", "wind_speed", "speed")):
            return _wind_to_loads(payload)
        if any(k in payload for k in ("waveHeight", "wave_height", "height")):
            return _wave_to_loads(payload)
    # Fallback: try topic-based heuristic
    t = topic.lower()
    if "wind" in t and isinstance(payload, (int, float)):
        return _wind_to_loads({"windSpeed": payload})
    if "wave" in t and isinstance(payload, (int, float)):
        return _wave_to_loads({"waveHeight": payload})
    return {"Fx": 0, "Fy": 0, "Fz": 0, "Mx": 0, "My": 0, "Mz": 0, "node_forces": {}, "source": "mqtt_unknown"}


# ── WebSocket MQTT bridge ──────────────────────────────────────────────────────
@router.websocket("/mqtt-ws")
async def fem_mqtt_ws(
    websocket: WebSocket,
    topic: str = Query("oc4/wind"),
    broker: str = Query("localhost"),
    port: int = Query(1883),
):
    """Subscribe to an MQTT topic and stream converted loads to the FEM page."""
    await websocket.accept()
    node_id = f"fem_mqtt_{uuid.uuid4().hex[:8]}"
    logger.info("[FEM] MQTT-WS connected topic=%s node=%s", topic, node_id)

    # Thread-safe queue to bridge paho callback → asyncio
    msg_queue: queue.Queue = queue.Queue()

    def on_message(entry: Dict):
        msg_queue.put(entry)

    try:
        from app.mqtt import manager as mqtt_mgr
        mqtt_mgr.subscribe_node(node_id, broker, port, topic, qos=0)
        conn = mqtt_mgr.get_connection(broker, port)
        conn.add_listener(node_id, on_message)

        # Confirm connection
        await websocket.send_text(json.dumps({
            "type": "connected", "topic": topic, "broker": broker, "port": port,
        }))

        loop = asyncio.get_event_loop()

        while True:
            # Drain MQTT messages
            drained = False
            while True:
                try:
                    entry = msg_queue.get_nowait()
                    payload = entry.get("payload", {})
                    loads = _raw_to_loads(payload, topic)
                    # Also push to the global FEM state (so /api/fem/ws clients see it too)
                    loop.call_soon_threadsafe(
                        asyncio.ensure_future, _broadcast(loads)
                    )
                    global _current_loads
                    _current_loads = loads
                    await websocket.send_text(json.dumps(loads))
                    drained = True
                except queue.Empty:
                    break

            if not drained:
                # Keep-alive + check for client disconnect
                await asyncio.sleep(0.05)

    except WebSocketDisconnect:
        logger.info("[FEM] MQTT-WS disconnected topic=%s", topic)
    except Exception as exc:
        logger.error("[FEM] MQTT-WS error: %s", exc)
        try:
            await websocket.send_text(json.dumps({"type": "error", "message": str(exc)}))
        except Exception:
            pass
    finally:
        try:
            from app.mqtt import manager as mqtt_mgr
            conn = mqtt_mgr.get_connection(broker, port)
            conn.remove_listener(node_id, on_message)
            mqtt_mgr.unsubscribe_node(node_id, broker, port)
        except Exception:
            pass
        logger.info("[FEM] MQTT-WS cleanup done topic=%s", topic)


# ── Pre-calculated simulation params ──────────────────────────────────────────
class SimParams(BaseModel):
    mode: str = "wind"       # "wind" | "wave"
    windSpeed: float = 5.0   # m/s
    waveHs: float = 1.0      # m
    waveTp: float = 10.0     # s


_sim_params: Dict[str, Any] = {"mode": "wind", "windSpeed": 5.0, "waveHs": 1.0, "waveTp": 10.0}
_sim_ws_clients: list[WebSocket] = []


@router.post("/sim-params")
async def post_sim_params(body: SimParams):
    global _sim_params
    _sim_params = body.model_dump()
    dead = []
    for ws in _sim_ws_clients:
        try:
            await ws.send_text(json.dumps(_sim_params))
        except Exception:
            dead.append(ws)
    for ws in dead:
        _sim_ws_clients.remove(ws)
    return {"status": "ok"}


@router.websocket("/sim-ws")
async def fem_sim_ws(websocket: WebSocket):
    await websocket.accept()
    _sim_ws_clients.append(websocket)
    logger.info("[FEM] sim-ws client connected (%d total)", len(_sim_ws_clients))
    await websocket.send_text(json.dumps(_sim_params))
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in _sim_ws_clients:
            _sim_ws_clients.remove(websocket)
        logger.info("[FEM] sim-ws client disconnected (%d total)", len(_sim_ws_clients))
