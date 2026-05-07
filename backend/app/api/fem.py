"""FEM load simulation router.

REST   GET  /api/fem/loads                – current load state
REST   POST /api/fem/loads                – push a load case manually
REST   POST /api/fem/live-scripts/start   – launch signal_processing.py subprocess
REST   POST /api/fem/live-scripts/stop    – stop the subprocess
WS          /api/fem/ws                   – live loads pushed by flow_executor
WS          /api/fem/mqtt-ws              – bridge an MQTT topic → FEM loads
WS          /api/fem/modal-live-ws        – real-time FFT modal analysis from oc4/pose
"""
import asyncio
from datetime import datetime
from collections import deque
import json
import logging
import math
import os
import queue
import subprocess
import sys
import threading
import uuid
from typing import Any, Dict, List

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fastapi.params import Query
from pydantic import BaseModel

logger = logging.getLogger("app.api.fem")

router = APIRouter()

# ── In-memory state ────────────────────────────────────────────────────────────
_current_loads: Dict[str, Any] = {}
_ws_clients: list[WebSocket] = []

# ── Live script subprocess management ─────────────────────────────────────────
_live_proc: subprocess.Popen | None = None
_live_proc_lock = threading.Lock()

_FEM_SCRIPTS_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..",
                 "utils", "scripts", "postprocess", "FEM_Modal_Analysis")
)


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


# ── Live script process management ────────────────────────────────────────────

@router.post("/live-scripts/start")
async def start_live_scripts():
    """Launch signal_processing.py as a background subprocess."""
    global _live_proc
    with _live_proc_lock:
        # Kill stale process if needed
        if _live_proc is not None and _live_proc.poll() is None:
            return {"status": "already_running", "pid": _live_proc.pid}

        script = os.path.join(_FEM_SCRIPTS_DIR, "signal_processing.py")
        if not os.path.isfile(script):
            return {"status": "error", "message": f"Script not found: {script}"}

        # Build env: inherit current env + set PYTHONPATH to repo root
        env = os.environ.copy()
        repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
        existing_pp = env.get("PYTHONPATH", "")
        env["PYTHONPATH"] = f"{repo_root}{os.pathsep}{existing_pp}" if existing_pp else repo_root

        try:
            _live_proc = subprocess.Popen(
                [sys.executable, "signal_processing.py"],
                cwd=_FEM_SCRIPTS_DIR,
                env=env,
            )
            logger.info("[FEM] Launched signal_processing.py PID=%d", _live_proc.pid)
            return {"status": "started", "pid": _live_proc.pid}
        except Exception as exc:
            logger.error("[FEM] Failed to launch signal_processing.py: %s", exc)
            return {"status": "error", "message": str(exc)}


@router.post("/live-scripts/stop")
async def stop_live_scripts():
    """Terminate the signal_processing.py subprocess if running."""
    global _live_proc
    with _live_proc_lock:
        if _live_proc is None or _live_proc.poll() is not None:
            return {"status": "not_running"}
        _live_proc.terminate()
        try:
            _live_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _live_proc.kill()
        pid = _live_proc.pid
        _live_proc = None
        logger.info("[FEM] Stopped signal_processing.py PID=%d", pid)
        return {"status": "stopped", "pid": pid}


# ── WebSocket MQTT bridge ──────────────────────────────────────────────────────
@router.websocket("/mqtt-ws")
async def fem_mqtt_ws(
    websocket: WebSocket,
    topic: str = Query("oc4/wind"),
    broker: str = Query(default=None),
    port: int = Query(1883),
):
    """Subscribe to an MQTT topic and stream converted loads to the FEM page."""
    if broker is None:
        broker = os.getenv("MQTT_BROKER", "localhost")
    await websocket.accept()
    node_id = f"fem_mqtt_{uuid.uuid4().hex[:8]}"
    logger.info("[FEM] MQTT-WS connected topic=%s node=%s broker=%s", topic, node_id, broker)

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


# ── RealtimeReconstructor (lazy singleton) ────────────────────────────────────

_reconstructor = None
_reconstructor_lock = threading.Lock()


def _get_reconstructor():
    """Lazy-load the RealtimeReconstructor once; return None if unavailable."""
    global _reconstructor
    if _reconstructor is not None:
        return _reconstructor
    with _reconstructor_lock:
        if _reconstructor is not None:
            return _reconstructor
        try:
            if _FEM_SCRIPTS_DIR not in sys.path:
                sys.path.insert(0, _FEM_SCRIPTS_DIR)
            from realtime_reconstructor import RealtimeReconstructor  # type: ignore
            mesh_dir = os.path.join(_FEM_SCRIPTS_DIR, "utils")
            modal_path = os.path.join(mesh_dir, "OC4-modal_res.json")
            mesh_path  = os.path.join(mesh_dir, "OC4-modal_mesh.json")
            if not os.path.isfile(modal_path) or not os.path.isfile(mesh_path):
                logger.warning("[FEM] Modal JSON files not found — mesh reconstruction disabled.")
                return None
            _reconstructor = RealtimeReconstructor(
                modal_shapes_json_path=modal_path,
                mesh_json_path=mesh_path,
                sample_rate_hz=_LIVE_DEFAULT_SR,
            )
            logger.info("[FEM] RealtimeReconstructor loaded successfully.")
        except Exception as exc:
            logger.warning("[FEM] Could not load RealtimeReconstructor: %s", exc)
    return _reconstructor


# ── Modal Live WebSocket (real-time FFT from oc4/pose) ────────────────────────
#
# Subscribes to the same MQTT topic as signal_processing.py, performs a
# lightweight FFT, matches peaks against the FEM modal frequencies defined in
# spectrum_to_mesh.py, and streams the results to the FEM page.

_FEM_MODAL_FREQUENCIES: Dict[int, float] = {
    1: 0.7196,  2: 0.7197,  3: 4.224,  4: 4.224,  5: 6.527,
    6: 10.62,   7: 10.84,   8: 10.84,  9: 18.57,  10: 18.57,
    11: 18.79,  12: 18.80,  13: 19.03, 14: 19.11,  15: 19.48,
    16: 19.48,  17: 19.57,  18: 20.04, 19: 20.88,  20: 20.95,
    21: 21.51,  22: 21.79,  23: 22.91, 24: 23.49,  25: 23.51,
    26: 27.16,  27: 27.17,
}

_LIVE_BUFFER_SIZE   = 512
_LIVE_FFT_SIZE      = 256
_LIVE_MIN_SAMPLES   = 64
_LIVE_COMPUTE_EVERY = 5        # Run FFT every N new MQTT samples
_LIVE_DEFAULT_SR    = 10.0     # Hz — overridden by "fps" in MQTT payload


@router.websocket("/modal-live-ws")
async def fem_modal_live_ws(
    websocket: WebSocket,
    broker: str = Query(default=None),
    port: int = Query(default=1883),
    topic: str = Query(default="oc4/pose"),
    keypoint: str = Query(default="pilar_center"),
):
    """Subscribe to MQTT pose data, compute FFT, and stream modal amplitudes."""
    if broker is None:
        broker = os.getenv("MQTT_BROKER", "localhost")
    await websocket.accept()
    node_id = f"fem_live_{uuid.uuid4().hex[:8]}"
    logger.info("[FEM] modal-live-ws connected node=%s topic=%s broker=%s", node_id, topic, broker)

    msg_queue: queue.Queue = queue.Queue()

    def on_message(entry: Dict) -> None:
        msg_queue.put(entry)

    try:
        import numpy as np  # imported here so the module loads even if numpy is absent

        from app.mqtt import manager as mqtt_mgr
        mqtt_mgr.subscribe_node(node_id, broker, port, topic, qos=0)
        conn = mqtt_mgr.get_connection(broker, port)
        conn.add_listener(node_id, on_message)

        await websocket.send_text(json.dumps({
            "type": "connected", "topic": topic, "broker": broker, "port": port,
        }))

        data_buffer: deque = deque(maxlen=_LIVE_BUFFER_SIZE)
        sample_count   = 0
        sample_rate    = _LIVE_DEFAULT_SR

        while True:
            new_samples = 0

            # ── Drain MQTT queue ───────────────────────────────────────────
            while True:
                try:
                    entry   = msg_queue.get_nowait()
                    payload = entry.get("payload", {})

                    # Update sample rate from real-time camera FPS
                    fps = payload.get("fps")
                    if fps and float(fps) > 0:
                        sample_rate = float(fps)

                    # Extract a scalar displacement from the MQTT payload.
                    # pose_detection.py publishes:
                    #   { "points": { "pilar_center": {"x":..,"y":..,"confidence":..}, ... }, ... }
                    value = None

                    # 1. Try direct top-level key (legacy / custom publishers)
                    raw = payload.get(keypoint)
                    if isinstance(raw, (int, float)):
                        value = float(raw)

                    # 2. Try nested in "points" dict (standard pose_detection.py output)
                    if value is None:
                        pts = payload.get("points", {})
                        kp = pts.get(keypoint) if isinstance(pts, dict) else None
                        if isinstance(kp, dict):
                            # Use y-coordinate (vertical image axis ≈ surge/heave)
                            v = kp.get("y", kp.get("x"))
                            if v is not None:
                                value = float(v)
                        elif isinstance(kp, (int, float)):
                            value = float(kp)

                    # 3. Fallback: first element of "pose" array
                    if value is None:
                        pose = payload.get("pose")
                        if pose and len(pose) > 0:
                            value = float(pose[0])

                    if value is not None:
                        data_buffer.append(float(value))
                        sample_count += 1
                        new_samples  += 1

                except queue.Empty:
                    break

            # ── Compute FFT every N new samples ───────────────────────────
            if new_samples > 0 and sample_count % _LIVE_COMPUTE_EVERY == 0 \
                    and len(data_buffer) >= _LIVE_MIN_SAMPLES:

                n_use   = min(len(data_buffer), _LIVE_FFT_SIZE)
                samples = np.array(list(data_buffer)[-n_use:], dtype=float)
                window  = np.hanning(n_use)
                fft_out = np.fft.rfft(samples * window, n=_LIVE_FFT_SIZE)
                freqs   = np.fft.rfftfreq(_LIVE_FFT_SIZE, d=1.0 / sample_rate)
                mag     = np.abs(fft_out)
                power   = mag ** 2

                nyquist        = sample_rate / 2.0
                freq_resolution = sample_rate / _LIVE_FFT_SIZE

                # ── Match peaks against FEM modal frequencies ──────────────
                matched: List[Dict] = []
                for mode_id, modal_freq in _FEM_MODAL_FREQUENCIES.items():
                    if modal_freq > nyquist:
                        continue
                    nearby = np.where(
                        np.abs(freqs - modal_freq) <= freq_resolution * 2
                    )[0]
                    if len(nearby) == 0:
                        continue
                    best  = nearby[int(np.argmax(power[nearby]))]
                    matched.append({
                        "mode_id":   mode_id,
                        "freq_hz":   float(modal_freq),
                        "amplitude": float(mag[best]),
                    })

                # Normalise amplitudes to [0, 1]
                max_amp = max((m["amplitude"] for m in matched), default=0.0) or 1.0
                for m in matched:
                    m["normalized_amplitude"] = m["amplitude"] / max_amp

                fft_result_dict = {
                    "type":          "modal_update",
                    "matched_modes": matched,
                    "fps":           sample_rate,
                    "nyquist_hz":    nyquist,
                    "n_samples":     len(data_buffer),
                    "timestamp":     datetime.now().isoformat(),
                }

                # Attempt full mesh reconstruction; fall back to lightweight result
                reconstructor = _get_reconstructor()
                if reconstructor is not None and matched:
                    try:
                        loop = asyncio.get_event_loop()
                        mesh_payload = await loop.run_in_executor(
                            None,
                            lambda: reconstructor.process(fft_result_dict),
                        )
                        await websocket.send_text(json.dumps(mesh_payload))
                    except Exception as rec_exc:
                        logger.warning("[FEM] Reconstruction failed, sending lightweight result: %s", rec_exc)
                        await websocket.send_text(json.dumps(fft_result_dict))
                else:
                    try:
                        await websocket.send_text(json.dumps(fft_result_dict))
                    except Exception:
                        break

            await asyncio.sleep(0.05)

    except WebSocketDisconnect:
        logger.info("[FEM] modal-live-ws disconnected node=%s", node_id)
    except Exception as exc:
        logger.error("[FEM] modal-live-ws error: %s", exc, exc_info=True)
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
        logger.info("[FEM] modal-live-ws cleanup done node=%s", node_id)
