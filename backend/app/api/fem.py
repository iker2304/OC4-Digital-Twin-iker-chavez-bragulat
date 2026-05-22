"""FEM load simulation router.

REST   GET  /api/fem/loads                – current load state
REST   POST /api/fem/loads                – push a load case manually
REST   POST /api/fem/live-scripts/start   – launch signal_processing.py subprocess
REST   POST /api/fem/live-scripts/stop    – stop the subprocess
REST   GET  /api/fem/modal-shapes         – serve OC4-modal_res.json (Φ_FEM autovectors)
REST   GET  /api/fem/modal-mesh           – serve OC4-modal_mesh.json (node coordinates)
WS          /api/fem/ws                   – live loads pushed by flow_executor
WS          /api/fem/mqtt-ws              – bridge an MQTT topic → FEM loads
WS          /api/fem/modal-live-ws        – real-time FFT modal analysis from oc4/pose
WS          /api/fem/modal-filtered-ws    – bandpass IFFT modal coords q_i(t) + full spectrum
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

# SciPy FFT for the bandpass-IFFT pipeline (OMA Modal Explorer)
try:
    from scipy.fft import rfft, irfft, rfftfreq
    _SCIPY_AVAILABLE = True
except ImportError:
    _SCIPY_AVAILABLE = False
    logging.getLogger("app.api.fem").warning(
        "[FEM] scipy not installed — modal-filtered-ws bandpass will use numpy fallback."
    )

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fastapi.params import Query
from app.api.damping import calcular_amortiguamiento
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


# ── FRF corrector (optional, loaded from detection.yaml) ──────────────────────

_frf_corrector = None  # None means disabled

def _load_frf_corrector():
    """Read FEM_modal.yaml and instantiate FRFCorrector if enabled."""
    global _frf_corrector
    try:
        import yaml
        yaml_path = os.path.join(_FEM_SCRIPTS_DIR, "config", "FEM_modal.yaml")
        with open(yaml_path, "r") as fh:
            cfg = yaml.safe_load(fh)

        frf_cfg = cfg.get("frf_correction", {})
        if not frf_cfg.get("enabled", False):
            logger.info("[FEM] FRF correction disabled (FEM_modal.yaml frf_correction.enabled=false).")
            return

        if _FEM_SCRIPTS_DIR not in sys.path:
            sys.path.insert(0, _FEM_SCRIPTS_DIR)
        from frf_correction import FRFCorrector  # type: ignore
        _frf_corrector = FRFCorrector(
            zeta=float(frf_cfg.get("zeta", 0.01)),
            modal_mass=float(frf_cfg.get("modal_mass", 1.0)),
        )
        logger.info("[FEM] FRF correction enabled — zeta=%.4f", _frf_corrector.zeta)
    except Exception as exc:
        logger.warning("[FEM] Could not load FRF corrector: %s", exc)

_load_frf_corrector()


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

# ── Pixel-to-metre calibration using known 3-D reference points ───────────────
# Two keypoints whose world positions (metres, Blender scene) are known.
# At runtime their pixel distance is measured and compared to the real distance
# to produce a metres-per-pixel factor that is applied to the tracked keypoint.
_CALIB_A = "pontoon_left_3"   # world: (0.218, -0.003, 0.341)
_CALIB_B = "pontoon_right_3"  # world: (-0.216, -0.003, 0.341)
_CALIB_REAL_DIST_M: float = math.sqrt(
    (0.218 - (-0.216)) ** 2 + (-0.003 - (-0.003)) ** 2 + (0.341 - 0.341) ** 2
)  # ≈ 0.434 m


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
        baseline_y_px: float | None = None   # first detected y-pixel → displacement origin
        meters_per_pixel: float | None = None

        def _px(pts: dict, name: str):
            """Return (x, y) pixel coords for keypoint *name*, or (None, None)."""
            kp = pts.get(name)
            if isinstance(kp, dict):
                x = kp.get("x")
                y = kp.get("y")
                return (float(x) if x is not None else None,
                        float(y) if y is not None else None)
            if isinstance(kp, (int, float)):
                return None, float(kp)
            return None, None

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
                    pts = payload.get("points", {}) if isinstance(payload, dict) else {}

                    # ── Pixel-to-metre calibration ─────────────────────────
                    # Compute metres_per_pixel from the two reference keypoints
                    # whenever both are visible in this frame.
                    ax, _ = _px(pts, _CALIB_A)
                    bx, _ = _px(pts, _CALIB_B)
                    ay_v = _px(pts, _CALIB_A)[1]
                    by_v = _px(pts, _CALIB_B)[1]
                    if ax is not None and bx is not None and ay_v is not None and by_v is not None:
                        pix_dist = math.sqrt((ax - bx) ** 2 + (ay_v - by_v) ** 2)
                        if pix_dist > 1.0:
                            meters_per_pixel = _CALIB_REAL_DIST_M / pix_dist

                    # ── Extract tracked keypoint displacement in metres ─────
                    # 1. Try nested "points" dict (standard pose_detection.py output)
                    kp_x, kp_y = _px(pts, keypoint)
                    if kp_y is not None and meters_per_pixel is not None:
                        if baseline_y_px is None:
                            baseline_y_px = kp_y
                        # Vertical displacement in metres (positive = downward in image)
                        value = (kp_y - baseline_y_px) * meters_per_pixel

                    # 2. Direct top-level numeric key (legacy publishers) — kept as pixels fallback
                    if value is None:
                        raw = payload.get(keypoint) if isinstance(payload, dict) else None
                        if isinstance(raw, (int, float)):
                            value = float(raw)

                    # 3. Fallback: first element of "pose" array
                    if value is None:
                        pose = payload.get("pose") if isinstance(payload, dict) else None
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
                matched_bin_indices: List[int] = []   # spectrum bin of each matched peak
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
                    matched_bin_indices.append(int(best))

                # Apply FRF correction if enabled in detection.yaml
                if _frf_corrector is not None and matched:
                    matched = _frf_corrector.correct(matched)

                # ── Damping ratio via Half-Power Bandwidth ─────────────────
                damping_results = []
                if matched_bin_indices:
                    try:
                        damping_results = calcular_amortiguamiento(
                            freqs, mag, np.array(matched_bin_indices)
                        )
                    except Exception as dmp_exc:
                        logger.warning("[FEM] Damping estimation failed: %s", dmp_exc)

                # Attach ζ to each matched mode
                for m, dr in zip(matched, damping_results):
                    m["zeta"]  = dr.get("zeta")
                    m["f1_hz"] = dr.get("f1_hz")
                    m["f2_hz"] = dr.get("f2_hz")
                    m["bw_hz"] = dr.get("bw_hz")

                # Normalise amplitudes to [0, 1]
                max_amp = max((m["amplitude"] for m in matched), default=0.0) or 1.0
                for m in matched:
                    m["normalized_amplitude"] = m["amplitude"] / max_amp

                fft_result_dict = {
                    "type":              "modal_update",
                    "matched_modes":     matched,
                    "fps":               sample_rate,
                    "nyquist_hz":        nyquist,
                    "n_samples":         len(data_buffer),
                    "timestamp":         datetime.now().isoformat(),
                    "meters_per_pixel":  meters_per_pixel,
                    "calib_dist_m":      _CALIB_REAL_DIST_M if meters_per_pixel is not None else None,
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


# ─────────────────────────────────────────────────────────────────────────────
# REST: Serve FEM modal JSON files to the frontend
# ─────────────────────────────────────────────────────────────────────────────

_FEM_UTILS_DIR = os.path.join(_FEM_SCRIPTS_DIR, "utils")


@router.get("/modal-shapes")
async def get_modal_shapes():
    """Serve OC4-modal_res.json — φ_FEM autovectors (mode shapes) for the frontend.

    The frontend loads this once at startup to populate Φ_FEM for the
    modal superposition equation:
        x_mesh(t) = Σ Φ_FEM,i · q_i(t)
    """
    from fastapi.responses import FileResponse
    path = os.path.join(_FEM_UTILS_DIR, "OC4-modal_res.json")
    if not os.path.isfile(path):
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail=f"OC4-modal_res.json not found at {path}")
    return FileResponse(path, media_type="application/json")


@router.get("/modal-mesh")
async def get_modal_mesh():
    """Serve OC4-modal_mesh.json — FEM node coordinates for the frontend mesh renderer."""
    from fastapi.responses import FileResponse
    path = os.path.join(_FEM_UTILS_DIR, "OC4-modal_mesh.json")
    if not os.path.isfile(path):
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail=f"OC4-modal_mesh.json not found at {path}")
    return FileResponse(path, media_type="application/json")


# ─────────────────────────────────────────────────────────────────────────────
# WS: /api/fem/modal-filtered-ws
#
# Operational Modal Analysis (OMA) — Bandpass IFFT pipeline
# ----------------------------------------------------------
# 1. Receives real-time scalar displacement samples from MQTT (oc4/pose).
# 2. Accumulates them in a circular buffer of N samples.
# 3. Every FILTER_COMPUTE_EVERY new samples:
#    a. FFT the buffer.
#    b. For each FEM resonance band [f_i - δf, f_i + δf]:
#         - Apply a rectangular bandpass mask to the FFT spectrum.
#         - IFFT the masked spectrum → band-isolated signal in time.
#         - Take the LAST sample as q_i(t_current) — the modal coordinate.
#    c. Send a JSON payload to the frontend:
#         { q_modal: {mode_id: q_i}, fft_spectrum: {freqs, magnitudes} }
#
# The frontend uses q_modal to animate the deformed mesh via:
#   x_mesh(t) = Σ Φ_FEM,i · q_i(t)_IFFT        (Modo 1 — Live Mirror)
#   x_mesh(t) = A · Φ_FEM,n · sin(2π f_n t)     (Modo 2 — Modal Explorer)
# ─────────────────────────────────────────────────────────────────────────────

# Bandpass half-width in Hz — controls how much signal is extracted per mode
_FILTER_BW_HZ: float = 0.5

# Buffer and compute parameters
_FILTER_BUFFER_SIZE: int = 512       # Circular buffer length (samples)
_FILTER_FFT_SIZE: int = 512          # FFT size (zero-padded if buffer is smaller)
_FILTER_MIN_SAMPLES: int = 64        # Minimum samples before first FFT
_FILTER_COMPUTE_EVERY: int = 5       # Compute FFT every N new samples

# Pixel-to-metre calibration constants (same as modal-live-ws above)
_FILTER_CALIB_A = "pontoon_left_3"
_FILTER_CALIB_B = "pontoon_right_3"
_FILTER_CALIB_REAL_DIST_M: float = math.sqrt(
    (0.218 - (-0.216)) ** 2 + (-0.003 - (-0.003)) ** 2 + (0.341 - 0.341) ** 2
)  # ≈ 0.434 m


def _bandpass_ifft_modal_coords(
    buffer: "deque",
    sample_rate: float,
    modal_frequencies: Dict[int, float],
    bw_hz: float,
    fft_size: int,
) -> tuple:
    """Apply bandpass IFFT to extract modal coordinates q_i(t) from a signal buffer.

    Implements the OMA time-domain reconstruction:
        q_i(t) ≈ IFFT( FFT(x) · H_i(f) )[-1]
    where H_i(f) is a rectangular bandpass mask centred at f_i with half-width bw_hz.

    Parameters
    ----------
    buffer:
        Circular deque of scalar displacement samples (metres).
    sample_rate:
        Sampling frequency in Hz (camera FPS).
    modal_frequencies:
        Dict {mode_id: f_i} — FEM resonance frequencies.
    bw_hz:
        Half-bandwidth of the rectangular bandpass filter (Hz).
    fft_size:
        FFT / IFFT length (zero-padding applied if needed).

    Returns
    -------
    q_modal:
        Dict {mode_id: q_i(t_current)} — scalar modal coordinate for each mode.
    freqs:
        1-D float array of frequency bins (Hz).
    magnitudes:
        1-D float array of FFT amplitude at each bin.
    """
    import numpy as np

    n_use = min(len(buffer), fft_size)
    samples = np.array(list(buffer)[-n_use:], dtype=float)

    # ── OMA step 1: Windowed FFT ────────────────────────────────────────────
    # Hanning window reduces spectral leakage between resonance peaks.
    window = np.hanning(n_use)
    if _SCIPY_AVAILABLE:
        fft_full = rfft(samples * window, n=fft_size)
        freqs = rfftfreq(fft_size, d=1.0 / sample_rate)
    else:
        import numpy.fft as npfft
        fft_full = npfft.rfft(samples * window, n=fft_size)
        freqs = npfft.rfftfreq(fft_size, d=1.0 / sample_rate)

    magnitudes = np.abs(fft_full)
    nyquist = sample_rate / 2.0

    q_modal: Dict[int, float] = {}

    for mode_id, f_i in modal_frequencies.items():
        # Skip modes above Nyquist (they cannot be resolved at this sample rate)
        if f_i > nyquist:
            continue

        # ── OMA step 2: Rectangular bandpass mask centred at f_i ─────────
        mask = np.zeros(len(fft_full), dtype=complex)
        band_idx = np.where(np.abs(freqs - f_i) <= bw_hz)[0]

        if len(band_idx) == 0:
            # Frequency resolution too coarse — pick the nearest bin
            nearest = int(np.argmin(np.abs(freqs - f_i)))
            band_idx = np.array([nearest])

        mask[band_idx] = fft_full[band_idx]

        # ── OMA step 3: IFFT of the masked spectrum → band-isolated signal ─
        if _SCIPY_AVAILABLE:
            q_time = irfft(mask, n=fft_size)
        else:
            import numpy.fft as npfft
            q_time = npfft.irfft(mask, n=fft_size)

        # The LAST sample of the reconstructed time signal is q_i(t_current).
        # We normalise by the window energy to recover physical units.
        window_energy = float(np.sum(window)) / n_use
        q_modal[mode_id] = float(q_time[-1]) / max(window_energy, 1e-12)

    return q_modal, freqs.tolist(), magnitudes.tolist()


@router.websocket("/modal-filtered-ws")
async def fem_modal_filtered_ws(
    websocket: WebSocket,
    broker: str = Query(default=None),
    port: int = Query(default=1883),
    topic: str = Query(default="oc4/pose"),
    keypoint: str = Query(default="pilar_center"),
):
    """Subscribe to MQTT pose data, apply bandpass IFFT, and stream modal coords q_i(t).

    Payload sent to client every compute cycle:
    {
        "type": "modal_filtered",
        "q_modal": {"1": 0.0023, "2": 0.0001, ...},   // modal coords (metres)
        "fft_spectrum": {
            "freqs": [...],       // frequency bins (Hz)
            "magnitudes": [...]   // FFT amplitude
        },
        "sample_rate_hz": 10.0,
        "n_samples": 256,
        "timestamp": "2025-..."
    }
    """
    if broker is None:
        broker = os.getenv("MQTT_BROKER", "localhost")
    await websocket.accept()
    node_id = f"fem_filtered_{uuid.uuid4().hex[:8]}"
    logger.info("[FEM] modal-filtered-ws connected node=%s topic=%s", node_id, topic)

    msg_queue: queue.Queue = queue.Queue()

    def on_message(entry: Dict) -> None:
        msg_queue.put(entry)

    try:
        import numpy as np

        from app.mqtt import manager as mqtt_mgr
        mqtt_mgr.subscribe_node(node_id, broker, port, topic, qos=0)
        conn = mqtt_mgr.get_connection(broker, port)
        conn.add_listener(node_id, on_message)

        await websocket.send_text(json.dumps({
            "type": "connected", "topic": topic, "broker": broker, "port": port,
        }))

        # ── Per-connection state ───────────────────────────────────────────
        data_buffer: deque = deque(maxlen=_FILTER_BUFFER_SIZE)
        sample_count: int = 0
        sample_rate: float = _LIVE_DEFAULT_SR
        baseline_y_px: float | None = None
        meters_per_pixel: float | None = None

        def _px(pts: dict, name: str):
            kp = pts.get(name)
            if isinstance(kp, dict):
                x = kp.get("x")
                y = kp.get("y")
                return (float(x) if x is not None else None,
                        float(y) if y is not None else None)
            if isinstance(kp, (int, float)):
                return None, float(kp)
            return None, None

        while True:
            new_samples = 0

            # ── Drain MQTT queue ───────────────────────────────────────────
            while True:
                try:
                    entry = msg_queue.get_nowait()
                    payload = entry.get("payload", {})

                    # Update sample rate from real-time camera FPS
                    fps = payload.get("fps")
                    if fps and float(fps) > 0:
                        sample_rate = float(fps)

                    pts = payload.get("points", {}) if isinstance(payload, dict) else {}

                    # ── Pixel-to-metre calibration ─────────────────────────
                    ax, _ = _px(pts, _FILTER_CALIB_A)
                    bx, _ = _px(pts, _FILTER_CALIB_B)
                    ay_v = _px(pts, _FILTER_CALIB_A)[1]
                    by_v = _px(pts, _FILTER_CALIB_B)[1]
                    if ax is not None and bx is not None and ay_v is not None and by_v is not None:
                        pix_dist = math.sqrt((ax - bx) ** 2 + (ay_v - by_v) ** 2)
                        if pix_dist > 1.0:
                            meters_per_pixel = _FILTER_CALIB_REAL_DIST_M / pix_dist

                    # ── Extract displacement in metres ─────────────────────
                    value = None
                    kp_x, kp_y = _px(pts, keypoint)
                    if kp_y is not None and meters_per_pixel is not None:
                        if baseline_y_px is None:
                            baseline_y_px = kp_y
                        value = (kp_y - baseline_y_px) * meters_per_pixel

                    if value is None:
                        raw = payload.get(keypoint) if isinstance(payload, dict) else None
                        if isinstance(raw, (int, float)):
                            value = float(raw)

                    if value is not None:
                        data_buffer.append(float(value))
                        sample_count += 1
                        new_samples += 1

                except queue.Empty:
                    break

            # ── Bandpass IFFT every N new samples ─────────────────────────
            if (new_samples > 0
                    and sample_count % _FILTER_COMPUTE_EVERY == 0
                    and len(data_buffer) >= _LIVE_MIN_SAMPLES):

                q_modal, freqs, magnitudes = _bandpass_ifft_modal_coords(
                    buffer=data_buffer,
                    sample_rate=sample_rate,
                    modal_frequencies=_FEM_MODAL_FREQUENCIES,
                    bw_hz=_FILTER_BW_HZ,
                    fft_size=_FILTER_FFT_SIZE,
                )

                payload_out = {
                    "type": "modal_filtered",
                    # OMA modal coordinates q_i(t) — frontend uses these for
                    # the superposition: x_mesh(t) = Σ Φ_FEM,i · q_i(t)
                    "q_modal": {str(k): v for k, v in q_modal.items()},
                    "fft_spectrum": {
                        "freqs": freqs,
                        "magnitudes": magnitudes,
                    },
                    "sample_rate_hz": sample_rate,
                    "n_samples": len(data_buffer),
                    "timestamp": datetime.now().isoformat(),
                }

                try:
                    await websocket.send_text(json.dumps(payload_out))
                except Exception:
                    break

            await asyncio.sleep(0.05)

    except WebSocketDisconnect:
        logger.info("[FEM] modal-filtered-ws disconnected node=%s", node_id)
    except Exception as exc:
        logger.error("[FEM] modal-filtered-ws error: %s", exc, exc_info=True)
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
        logger.info("[FEM] modal-filtered-ws cleanup done node=%s", node_id)
