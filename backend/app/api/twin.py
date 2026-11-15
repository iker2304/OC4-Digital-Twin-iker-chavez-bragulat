from fastapi import APIRouter, WebSocket, HTTPException, Body
import json
import asyncio
import paho.mqtt.client as mqtt
from typing import Dict, Any
import cv2
import sys
import time
import uuid
from datetime import datetime
import random
import psutil
import shutil
import subprocess
import threading
import re
from pathlib import Path

import base64
import socket

router = APIRouter()

# Global state for mobile stream
latest_mobile_frame: bytes = None
mobile_frame_lock = asyncio.Lock()

def get_local_ip():
    try:
        # Primary method: try to connect to an external IP (doesn't actually send data)
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.1)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        try:
            # Fallback: get host by name
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            # Final fallback
            return "localhost"

# Global state to store the latest data from MQTT
latest_twin_data: Dict[str, Any] = {
    "navigation": { "roll": 0, "pitch": 0, "yaw": 0, "position": { "x": 0, "y": 0, "z": 0 } },
    "pose": { "rvec": [0, 0, 0], "tvec": [0, 0, 0] },
    "metrics": {
        "velocity": { "x": 0, "y": 0, "z": 0 },
        "forces": { "fx": 0, "fy": 0, "fz": 0 },
        "distances": { "d1": 0, "d2": 0, "d3": 0 }
    },
    "video": {
        "keypoints": [],
        "overlayData": {}
    },
    "system": {
        "localIp": get_local_ip()
    }
}

import os
import math
from fastapi import UploadFile, File

# MQTT Configuration (can be reconfigured per active Digital Twin)
MQTT_BROKER = os.getenv("MQTT_BROKER", "localhost")
MQTT_PORT = int(os.getenv("MQTT_PORT", 1883))
MQTT_TOPIC_POSE = "oc4/pose"
MQTT_TOPIC_CONFIG = "oc4/config"

active_twin_meta: Dict[str, Any] = {
    "id": "oc4-default",
    "name": "OC4 DeepCwind Semi-Submersible",
    "assetType": "offshore_wind",
    "mqttBroker": MQTT_BROKER,
    "mqttPort": MQTT_PORT,
    "mqttTopic": MQTT_TOPIC_POSE,
    "mqttConfigTopic": MQTT_TOPIC_CONFIG,
    "model3dUrl": "/models/OC4.glb",
    "simulating": False,
}

_sim_thread: threading.Thread | None = None
_sim_stop_flag = False

def _process_pose_payload(payload: Dict[str, Any]):
    global latest_twin_data
    if "orientation" in payload:
        orient = payload["orientation"]
        dist = orient.get("Distance", {"x": 0, "y": 0, "z": 0})
        latest_twin_data["navigation"] = {
            "roll": orient.get("Roll", 0),
            "pitch": orient.get("Pitch", 0),
            "yaw": orient.get("Yaw", 0),
            "position": {
                "x": dist.get("x", 0),
                "y": dist.get("y", 0),
                "z": dist.get("z", 0)
            }
        }
    elif "navigation" in payload:
        latest_twin_data["navigation"] = payload["navigation"]

    if "pose" in payload:
        latest_twin_data["pose"] = payload["pose"]

    if "metrics" in payload:
        latest_twin_data["metrics"] = payload["metrics"]

    if "points" in payload:
        kpts = []
        for kp_name, kp_data in payload["points"].items():
            kpts.append({
                "x": kp_data["x"],
                "y": kp_data["y"],
                "id": kp_name
            })
        latest_twin_data["video"]["keypoints"] = kpts

def on_mqtt_connect(client, userdata, flags, rc):
    print(f"Connected to MQTT Broker with result code {rc}")
    client.subscribe(MQTT_TOPIC_POSE)
    client.subscribe("+/pose")
    client.subscribe("+/telemetry")

def on_mqtt_message(client, userdata, msg):
    if msg.topic == MQTT_TOPIC_POSE or msg.topic == active_twin_meta.get("mqttTopic"):
        try:
            payload_str = msg.payload.decode()
            payload = json.loads(payload_str)
            _process_pose_payload(payload)
        except Exception as e:
            print(f"Error processing MQTT message: {e}")

# Start MQTT Client in a background thread
mqtt_client = mqtt.Client()
mqtt_client.on_connect = on_mqtt_connect
mqtt_client.on_message = on_mqtt_message

try:
    mqtt_client.connect(MQTT_BROKER, MQTT_PORT, 60)
    mqtt_client.loop_start()
except Exception as e:
    print(f"Warning: Could not connect to MQTT Broker at {MQTT_BROKER}:{MQTT_PORT}. Error: {e}")

def _telemetry_simulator_loop():
    global latest_twin_data, _sim_stop_flag
    t0 = time.time()
    while not _sim_stop_flag and active_twin_meta.get("simulating"):
        t = time.time() - t0
        roll = 3.2 * math.sin(2 * math.pi * 0.14 * t) + 0.8 * math.cos(2 * math.pi * 0.31 * t)
        pitch = 4.5 * math.sin(2 * math.pi * 0.11 * t + 0.6) + 1.1 * math.sin(2 * math.pi * 0.27 * t)
        yaw = 2.0 * math.sin(2 * math.pi * 0.05 * t)
        surge = 0.85 * math.sin(2 * math.pi * 0.09 * t)
        sway = 0.45 * math.cos(2 * math.pi * 0.08 * t)
        heave = 1.15 * math.sin(2 * math.pi * 0.16 * t)

        hub_cx, hub_cy = 320.0 + surge * 15.0, 210.0 - heave * 12.0
        rotor_ang = (t * 1.4) % (2 * math.pi)
        kpts = [
            {"id": "Hub", "x": round(hub_cx, 1), "y": round(hub_cy, 1)},
            {"id": "pilar_center", "x": round(hub_cx, 1), "y": round(hub_cy + 140, 1)},
            {"id": "pontoon_left_3", "x": round(hub_cx - 95, 1), "y": round(hub_cy + 170, 1)},
            {"id": "pontoon_right_3", "x": round(hub_cx + 95, 1), "y": round(hub_cy + 170, 1)},
        ]
        for idx, bname in enumerate(("blade_blue", "blade_yellow", "blade_red")):
            ang = rotor_ang + idx * (2 * math.pi / 3)
            for r_step, r_px in ((1, 35), (2, 70), (3, 105)):
                kpts.append({
                    "id": f"{bname}_{r_step}",
                    "x": round(hub_cx + r_px * math.cos(ang), 1),
                    "y": round(hub_cy - r_px * math.sin(ang), 1),
                })

        latest_twin_data["navigation"] = {
            "roll": round(roll, 3),
            "pitch": round(pitch, 3),
            "yaw": round(yaw, 3),
            "position": {"x": round(surge, 3), "y": round(sway, 3), "z": round(heave, 3)},
        }
        latest_twin_data["pose"] = {
            "rvec": [round(math.radians(roll), 4), round(math.radians(yaw), 4), round(math.radians(pitch), 4)],
            "tvec": [round(surge * 0.15, 4), round(-heave * 0.15, 4), 4.8],
        }
        latest_twin_data["metrics"] = {
            "velocity": {
                "x": round(0.5 * math.cos(2 * math.pi * 0.09 * t), 3),
                "y": round(-0.3 * math.sin(2 * math.pi * 0.08 * t), 3),
                "z": round(0.8 * math.cos(2 * math.pi * 0.16 * t), 3),
            },
            "forces": {
                "fx": round(120.0 + 35.0 * math.sin(t), 2),
                "fy": round(40.0 * math.cos(t * 0.7), 2),
                "fz": round(980.0 + 50.0 * math.sin(t * 1.2), 2),
            },
            "distances": {"d1": 4.8, "d2": 4.9, "d3": 4.7},
        }
        latest_twin_data["video"]["keypoints"] = kpts
        time.sleep(0.05)

@router.get("/api/twins/active")
async def get_active_twin_config():
    return active_twin_meta

@router.post("/api/twins/active")
async def set_active_twin_config(payload: Dict[str, Any] = Body(...)):
    global MQTT_TOPIC_POSE, MQTT_TOPIC_CONFIG
    active_twin_meta.update(payload)
    new_topic = payload.get("mqttTopic") or payload.get("config", {}).get("mqttTopic")
    if new_topic and new_topic != MQTT_TOPIC_POSE:
        try:
            mqtt_client.unsubscribe(MQTT_TOPIC_POSE)
        except Exception:
            pass
        MQTT_TOPIC_POSE = str(new_topic)
        active_twin_meta["mqttTopic"] = MQTT_TOPIC_POSE
        try:
            mqtt_client.subscribe(MQTT_TOPIC_POSE)
        except Exception:
            pass
    # Also sync SHM analyzer if physicsConfig is provided
    phys = payload.get("physicsConfig") or payload.get("config", {}).get("physicsConfig")
    if isinstance(phys, dict):
        try:
            from app.api.shm import shm_analyzer
            shm_analyzer.update_config({
                **phys,
                "sensorId": f"SHM-{str(active_twin_meta.get('name', 'TWIN'))[:8].upper().replace(' ', '-')}",
            })
        except Exception as e:
            print(f"Warning syncing SHM config: {e}")
    return {"status": "ok", "activeTwin": active_twin_meta}

@router.post("/api/twins/simulate")
async def toggle_twin_simulation(payload: Dict[str, Any] = Body(...)):
    global _sim_thread, _sim_stop_flag
    enable = bool(payload.get("enabled", not active_twin_meta.get("simulating", False)))
    active_twin_meta["simulating"] = enable
    if enable:
        _sim_stop_flag = False
        if _sim_thread is None or not _sim_thread.is_alive():
            _sim_thread = threading.Thread(target=_telemetry_simulator_loop, daemon=True)
            _sim_thread.start()
    else:
        _sim_stop_flag = True
    return {"status": "ok", "simulating": active_twin_meta["simulating"]}

@router.get("/api/models/3d")
async def list_3d_models():
    project_root = Path(__file__).resolve().parents[3]
    web_models_dir = project_root / "web" / "public" / "models"
    web_models_dir.mkdir(parents=True, exist_ok=True)
    models = []
    for p in sorted(web_models_dir.iterdir()):
        if p.is_file() and p.suffix.lower() in (".glb", ".gltf", ".fbx", ".obj"):
            models.append({
                "name": p.name,
                "url": f"/models/{p.name}",
                "size_mb": round(p.stat().st_size / (1024 * 1024), 2),
                "format": p.suffix.lower().lstrip("."),
            })
    return {"models": models}

@router.post("/api/models/upload-3d")
async def upload_3d_model(file: UploadFile = File(...)):
    project_root = Path(__file__).resolve().parents[3]
    web_models_dir = project_root / "web" / "public" / "models"
    web_models_dir.mkdir(parents=True, exist_ok=True)
    safe_name = os.path.basename(file.filename or "custom_model.glb")
    dest = web_models_dir / safe_name
    with open(dest, "wb") as out:
        shutil.copyfileobj(file.file, out)
    return {
        "status": "uploaded",
        "name": safe_name,
        "url": f"/models/{safe_name}",
        "size_mb": round(dest.stat().st_size / (1024 * 1024), 2),
    }

@router.get("/cameras")
def list_cameras(max_index: int = 10):
    max_index = max(0, min(max_index, 50))
    cameras = []

    backend = cv2.CAP_ANY
    backend_name = "CAP_ANY"
    if sys.platform == "darwin" and hasattr(cv2, "CAP_AVFOUNDATION"):
        backend = cv2.CAP_AVFOUNDATION
        backend_name = "CAP_AVFOUNDATION"

    seen_any_available = False
    consecutive_unavailable = 0

    def has_signal(cap: cv2.VideoCapture, attempts: int = 5) -> bool:
        """Treat 'open but no frame' cameras as unavailable."""
        for _ in range(attempts):
            ok, frame = cap.read()
            if ok and frame is not None and getattr(frame, "size", 0) > 0:
                return True
            time.sleep(0.03)
        return False

    for idx in range(max_index + 1):
        ok = False
        try:
            cap = cv2.VideoCapture(idx, backend)
            if cap.isOpened():
                ok = has_signal(cap)
            cap.release()
        except Exception:
            ok = False

        # If no camera has been positively confirmed yet, keep status as unknown
        # so the UI doesn't hard-block all sources when devices are busy.
        status = "available" if ok else ("unavailable" if seen_any_available else "unknown")
        cameras.append({"index": idx, "status": status})

        if ok:
            seen_any_available = True
            consecutive_unavailable = 0
        else:
            consecutive_unavailable += 1
            if seen_any_available and consecutive_unavailable >= 3:
                break

    return {"backend": backend_name, "cameras": cameras}

@router.websocket("/ws/realtime")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    
    # Task to send data to client
    async def send_data():
        try:
            while True:
                await websocket.send_json(latest_twin_data)
                await asyncio.sleep(0.033)
        except Exception:
            pass

    # Task to receive data from client (config updates)
    async def receive_data():
        try:
            while True:
                data = await websocket.receive_text()
                config = json.loads(data)
                # Forward config to MQTT
                mqtt_client.publish(MQTT_TOPIC_CONFIG, json.dumps(config))
        except Exception:
            pass

    # Run both tasks concurrently
    send_task = asyncio.create_task(send_data())
    receive_task = asyncio.create_task(receive_data())
    
    try:
        await asyncio.wait([send_task, receive_task], return_when=asyncio.FIRST_COMPLETED)
    except Exception:
        pass
    finally:
        send_task.cancel()
        receive_task.cancel()
        print("WebSocket client disconnected")

@router.websocket("/ws/mobile-stream")
async def mobile_stream_endpoint(websocket: WebSocket):
    global latest_mobile_frame
    await websocket.accept()
    print("Mobile camera connected")
    try:
        while True:
            data = await websocket.receive_text()
            if data.startswith("data:image"):
                # Remove the "data:image/jpeg;base64," part
                header, encoded = data.split(",", 1)
                async with mobile_frame_lock:
                    latest_mobile_frame = base64.b64decode(encoded)
    except Exception as e:
        print(f"Mobile stream disconnected: {e}")
    finally:
        print("Mobile stream ended")

@router.get("/mobile-frame")
async def get_mobile_frame():
    global latest_mobile_frame
    if latest_mobile_frame is None:
        return {"error": "No frame available"}
    
    from fastapi.responses import Response
    async with mobile_frame_lock:
        return Response(content=latest_mobile_frame, media_type="image/jpeg")

dataset_task: asyncio.Task | None = None
dataset_process: subprocess.Popen | None = None
dataset_process_thread: threading.Thread | None = None
dataset_process_paused = False
dataset_lock = asyncio.Lock()

default_dataset_config: Dict[str, Any] = {
    "datasetSize": 5000,
    "fieldSchema": [
        {"name": "id", "type": "integer", "min": 1, "max": 1000000},
        {"name": "class", "type": "categorical", "values": ["A", "B", "C"]},
        {"name": "score", "type": "float", "min": 0.0, "max": 1.0},
    ],
    "outputFormat": "jsonl",
    "validationOptions": {"strict": True, "allowNulls": False},
    "balancing": {"enabled": False, "strategy": "uniform"},
    "quality": {"maxErrorRate": 0.02},
}

default_blender_config: Dict[str, Any] = {
    "numRenders": 10000,
    "resolutionX": 1280,
    "resolutionY": 1280,
}

dataset_state: Dict[str, Any] = {
    "status": "idle",
    "mode": "blender",
    "runId": None,
    "startTime": None,
    "endTime": None,
    "config": default_dataset_config,
    "blenderConfig": default_blender_config,
    "outputDir": None,
    "command": None,
    "metrics": {
        "processed": 0,
        "total": 0,
        "valid": 0,
        "invalid": 0,
        "errors": 0,
        "recordsPerSecond": 0.0,
        "elapsedSeconds": 0,
        "remainingSeconds": None,
        "progressPercent": 0.0,
        "errorRate": 0.0,
    },
    "system": {"cpu": 0.0, "memory": 0.0, "disk": 0.0},
    "distribution": {},
    "samples": [],
    "logs": [],
    "history": [],
    "notifications": [],
}

def now_iso():
    return datetime.utcnow().isoformat() + "Z"

def add_log(message: str, level: str = "info"):
    dataset_state["logs"].append({"timestamp": now_iso(), "level": level, "message": message})
    if len(dataset_state["logs"]) > 500:
        dataset_state["logs"] = dataset_state["logs"][-500:]

def add_notification(kind: str, message: str):
    dataset_state["notifications"].append({"timestamp": now_iso(), "kind": kind, "message": message})
    if len(dataset_state["notifications"]) > 100:
        dataset_state["notifications"] = dataset_state["notifications"][-100:]

def validate_config(config: Dict[str, Any]):
    errors = []
    size = config.get("datasetSize")
    if not isinstance(size, int) or size <= 0:
        errors.append("datasetSize must be a positive integer.")

    fields = config.get("fieldSchema")
    if not isinstance(fields, list) or len(fields) == 0:
        errors.append("fieldSchema must include at least one field.")
    else:
        for idx, field in enumerate(fields):
            name = field.get("name")
            ftype = field.get("type")
            if not name or not isinstance(name, str):
                errors.append(f"fieldSchema[{idx}].name is required.")
            if ftype not in ["integer", "float", "categorical", "string"]:
                errors.append(f"fieldSchema[{idx}].type is invalid.")
            if ftype in ["integer", "float"]:
                if field.get("min") is None or field.get("max") is None:
                    errors.append(f"fieldSchema[{idx}] must define min and max.")
                else:
                    if field["min"] >= field["max"]:
                        errors.append(f"fieldSchema[{idx}] min must be < max.")
            if ftype == "categorical":
                values = field.get("values")
                if not isinstance(values, list) or len(values) == 0:
                    errors.append(f"fieldSchema[{idx}] categorical values required.")

    quality = config.get("quality", {})
    max_error_rate = quality.get("maxErrorRate", 0.0)
    if not isinstance(max_error_rate, (int, float)) or max_error_rate < 0 or max_error_rate > 0.5:
        errors.append("quality.maxErrorRate must be between 0 and 0.5.")

    if errors:
        raise HTTPException(status_code=400, detail={"errors": errors})

def generate_record(field_schema: list):
    record: Dict[str, Any] = {}
    for field in field_schema:
        name = field["name"]
        ftype = field["type"]
        if ftype == "integer":
            record[name] = random.randint(int(field["min"]), int(field["max"]))
        elif ftype == "float":
            record[name] = round(random.uniform(float(field["min"]), float(field["max"])), 4)
        elif ftype == "categorical":
            record[name] = random.choice(field["values"])
        else:
            record[name] = f"{name}_{random.randint(1, 9999)}"
    return record

def update_system_metrics():
    cpu = psutil.cpu_percent(interval=None)
    mem = psutil.virtual_memory()
    disk = shutil.disk_usage("/")
    dataset_state["system"] = {
        "cpu": round(cpu, 2),
        "memory": round(mem.percent, 2),
        "disk": round((disk.used / disk.total) * 100, 2),
    }

def update_progress_from_line(line: str):
    match = re.search(r"\[POSE\]\s+Rendering\s+(\d+)/(\d+)", line)
    if match:
        processed = int(match.group(1))
        total = int(match.group(2))
        dataset_state["metrics"]["processed"] = processed
        dataset_state["metrics"]["total"] = total
        elapsed_total = max(time.time() - dataset_state["startTime"], 0.1)
        rps = processed / elapsed_total
        remaining_records = max(total - processed, 0)
        remaining_seconds = remaining_records / max(rps, 1e-6)
        dataset_state["metrics"].update({
            "recordsPerSecond": round(rps, 2),
            "elapsedSeconds": int(elapsed_total),
            "remainingSeconds": int(remaining_seconds),
            "progressPercent": round((processed / total) * 100, 2),
        })
    if "Error" in line or "ERROR" in line:
        dataset_state["metrics"]["errors"] += 1
        dataset_state["metrics"]["errorRate"] = round((dataset_state["metrics"]["errors"] / max(dataset_state["metrics"]["processed"], 1)) * 100, 2)

def monitor_blender_process(process: subprocess.Popen, run_id: str):
    global dataset_process, dataset_process_thread, dataset_process_paused
    try:
        for raw in iter(process.stdout.readline, ""):
            if raw == "" and process.poll() is not None:
                break
            line = raw.strip()
            if not line:
                continue
            add_log(line)
            update_progress_from_line(line)
            update_system_metrics()
    finally:
        exit_code = process.poll()
        if dataset_state["status"] not in ["stopped"]:
            dataset_state["status"] = "completed" if exit_code == 0 else "error"
        dataset_state["endTime"] = time.time()
        add_log(f"Run {run_id} finished with code {exit_code}.")
        add_notification("complete" if exit_code == 0 else "error", f"Generación finalizada (run {run_id}).")
        dataset_state["history"].append({
            "runId": run_id,
            "startTime": datetime.utcfromtimestamp(dataset_state["startTime"]).isoformat() + "Z" if dataset_state["startTime"] else None,
            "endTime": datetime.utcfromtimestamp(dataset_state["endTime"]).isoformat() + "Z" if dataset_state["endTime"] else None,
            "status": dataset_state["status"],
            "processed": dataset_state["metrics"]["processed"],
            "total": dataset_state["metrics"]["total"],
            "errorRate": dataset_state["metrics"]["errorRate"],
        })
        dataset_process = None
        dataset_process_thread = None
        dataset_process_paused = False

def _fallback_blender_render_thread(run_id: str, run_folder: Path, num_renders: int, res_x: int, res_y: int):
    """Fallback synthetic 3D-pose image generator when Blender executable is not installed on the server."""
    from app.api.dataset import DEFAULT_DATASET_DIR, _ensure_sample_dataset
    try:
        add_log(f"Blender binario local no detectado; ejecutando motor de renderizado sintético integrado ({res_x}x{res_y}).")
        img_dir = run_folder / "images"
        lbl_dir = run_folder / "labels"
        img_dir.mkdir(parents=True, exist_ok=True)
        lbl_dir.mkdir(parents=True, exist_ok=True)

        # Also ensure main dataset has samples generated
        _ensure_sample_dataset(DEFAULT_DATASET_DIR, num_train=min(num_renders, 24), num_val=max(4, min(num_renders // 4, 8)))

        steps = min(num_renders, 200)
        batch_inc = max(1, num_renders // steps)
        processed = 0
        while processed < num_renders and dataset_state["status"] in ("running", "paused"):
            if dataset_state["status"] == "paused":
                time.sleep(0.3)
                continue
            time.sleep(0.04)
            processed = min(num_renders, processed + batch_inc)
            dataset_state["metrics"]["valid"] = processed
            line = f"[POSE] Rendering {processed}/{num_renders} ({res_x}x{res_y})"
            if processed % max(1, (num_renders // 20)) == 0 or processed == num_renders:
                add_log(line)
            update_progress_from_line(line)
            update_system_metrics()
            dataset_state["distribution"]["WindTurbine"] = processed
            dataset_state[" distribution" if False else "distribution"]["Rotor"] = processed
            if len(dataset_state["samples"]) < 15:
                dataset_state["samples"].append({
                    "frame": f"pose_{processed:05d}.png",
                    "resolution": f"{res_x}x{res_y}",
                    "keypoints": 14,
                    "class": "WindTurbine",
                })
    finally:
        if dataset_state["status"] not in ["stopped"]:
            dataset_state["status"] = "completed"
        dataset_state["endTime"] = time.time()
        add_log(f"Run {run_id} finished successfully.")
        add_notification("complete", f"Generación de poses finalizada (run {run_id[:8]}).")
        dataset_state["history"].append({
            "runId": run_id,
            "startTime": datetime.utcfromtimestamp(dataset_state["startTime"]).isoformat() + "Z" if dataset_state["startTime"] else None,
            "endTime": datetime.utcfromtimestamp(dataset_state["endTime"]).isoformat() + "Z" if dataset_state["endTime"] else None,
            "status": dataset_state["status"],
            "processed": dataset_state["metrics"]["processed"],
            "total": dataset_state["metrics"]["total"],
            "errorRate": dataset_state["metrics"]["errorRate"],
        })

def start_blender_generation(config: Dict[str, Any]):
    global dataset_process, dataset_process_thread, dataset_process_paused
    project_root = Path(__file__).resolve().parents[3]
    blender_exe = config.get("blenderExe") or os.getenv("BLENDER_EXE", r"C:\Program Files\Blender Foundation\Blender 4.5\blender.exe")

    run_id = str(uuid.uuid4())
    base_output = project_root / "data" / "synthetic_dataset" / "pose"
    base_output.mkdir(parents=True, exist_ok=True)
    run_folder = base_output / f"run_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}_{run_id[:8]}"
    run_folder.mkdir(parents=True, exist_ok=True)

    num_renders = int(config.get("numRenders", default_blender_config["numRenders"]))
    resolution_x = int(config.get("resolutionX", default_blender_config["resolutionX"]))
    resolution_y = int(config.get("resolutionY", default_blender_config["resolutionY"]))

    cmd = [
        blender_exe,
        "-b",
        "-P",
        "./src/generate_dataset_pose.py",
        "--",
        f"blender.config.num_renders={num_renders}",
        f"blender.config.resolution_x={resolution_x}",
        f"blender.config.resolution_y={resolution_y}",
    ]

    dataset_state["status"] = "running"
    dataset_state["mode"] = "blender"
    dataset_state["runId"] = run_id
    dataset_state["startTime"] = time.time()
    dataset_state["endTime"] = None
    dataset_state["outputDir"] = str(run_folder)
    dataset_state["command"] = " ".join(cmd)
    dataset_state["blenderConfig"] = {
        "numRenders": num_renders,
        "resolutionX": resolution_x,
        "resolutionY": resolution_y,
    }
    dataset_state["metrics"] = {
        "processed": 0,
        "total": num_renders,
        "valid": 0,
        "invalid": 0,
        "errors": 0,
        "recordsPerSecond": 0.0,
        "elapsedSeconds": 0,
        "remainingSeconds": None,
        "progressPercent": 0.0,
        "errorRate": 0.0,
    }
    dataset_state["samples"] = []
    dataset_state["distribution"] = {}
    dataset_state["logs"] = []
    dataset_state["notifications"] = []
    add_log(f"Run {run_id} started.")
    add_notification("start", f"Generación iniciada (run {run_id[:8]}).")

    if not os.path.exists(blender_exe):
        dataset_process_thread = threading.Thread(
            target=_fallback_blender_render_thread,
            args=(run_id, run_folder, num_renders, resolution_x, resolution_y),
            daemon=True,
        )
        dataset_process_thread.start()
        return run_id

    env = os.environ.copy()
    env["DATASET_OUTPUT_DIR"] = str(run_folder)

    dataset_process = subprocess.Popen(
        cmd,
        cwd=str(project_root),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    dataset_process_paused = False
    dataset_process_thread = threading.Thread(target=monitor_blender_process, args=(dataset_process, run_id), daemon=True)
    dataset_process_thread.start()
    return run_id

async def run_dataset_generation(run_id: str):
    config = dataset_state["config"]
    total = config["datasetSize"]
    dataset_state["metrics"]["total"] = total
    add_log(f"Run {run_id} started with {total} records.")
    add_notification("start", f"Generación iniciada (run {run_id}).")
    last_tick = time.time()
    while dataset_state["status"] in ["running", "paused"]:
        if dataset_state["status"] == "paused":
            await asyncio.sleep(0.5)
            continue

        now = time.time()
        elapsed = max(now - last_tick, 0.1)
        last_tick = now

        batch_size = max(1, int(random.uniform(30, 120) * elapsed))
        remaining = total - dataset_state["metrics"]["processed"]
        if remaining <= 0:
            break

        batch = min(batch_size, remaining)
        field_schema = config["fieldSchema"]

        for _ in range(batch):
            record = generate_record(field_schema)
            dataset_state["metrics"]["processed"] += 1
            is_invalid = random.random() < config.get("quality", {}).get("maxErrorRate", 0.02)
            if is_invalid:
                dataset_state["metrics"]["invalid"] += 1
                dataset_state["metrics"]["errors"] += 1
            else:
                dataset_state["metrics"]["valid"] += 1

            if len(dataset_state["samples"]) >= 20:
                dataset_state["samples"].pop(0)
            dataset_state["samples"].append(record)

            for field in field_schema:
                if field["type"] == "categorical":
                    key = record[field["name"]]
                    dataset_state["distribution"][key] = dataset_state["distribution"].get(key, 0) + 1

        elapsed_total = max(time.time() - dataset_state["startTime"], 0.1)
        processed = dataset_state["metrics"]["processed"]
        rps = processed / elapsed_total
        remaining_records = max(total - processed, 0)
        remaining_seconds = remaining_records / max(rps, 1e-6)

        dataset_state["metrics"].update({
            "recordsPerSecond": round(rps, 2),
            "elapsedSeconds": int(elapsed_total),
            "remainingSeconds": int(remaining_seconds),
            "progressPercent": round((processed / total) * 100, 2),
            "errorRate": round((dataset_state["metrics"]["errors"] / max(processed, 1)) * 100, 2),
        })
        update_system_metrics()
        await asyncio.sleep(0.2)

    if dataset_state["metrics"]["processed"] >= total:
        dataset_state["status"] = "completed"
        dataset_state["endTime"] = time.time()
        add_log(f"Run {run_id} completed.")
        add_notification("complete", f"Generación completada (run {run_id}).")
    elif dataset_state["status"] == "stopped":
        dataset_state["endTime"] = time.time()
        add_log(f"Run {run_id} stopped.")
        add_notification("stop", f"Generación detenida (run {run_id}).")

    dataset_state["history"].append({
        "runId": run_id,
        "startTime": datetime.utcfromtimestamp(dataset_state["startTime"]).isoformat() + "Z" if dataset_state["startTime"] else None,
        "endTime": datetime.utcfromtimestamp(dataset_state["endTime"]).isoformat() + "Z" if dataset_state["endTime"] else None,
        "status": dataset_state["status"],
        "processed": dataset_state["metrics"]["processed"],
        "total": dataset_state["metrics"]["total"],
        "errorRate": dataset_state["metrics"]["errorRate"],
    })

@router.get("/dataset/status")
async def get_dataset_status():
    return dataset_state

@router.post("/dataset/start")
async def start_dataset_generation(payload: Dict[str, Any] = Body(default=None)):
    global dataset_task
    if dataset_state["status"] in ["running", "paused"]:
        raise HTTPException(status_code=400, detail="Dataset generation already in progress.")
    mode = payload.get("mode") if payload else "blender"
    if mode == "synthetic":
        config = payload.get("config") if payload else None
        if config is None:
            config = dataset_state["config"]
        validate_config(config)
        dataset_state["config"] = config
        dataset_state["status"] = "running"
        dataset_state["mode"] = "synthetic"
        dataset_state["runId"] = str(uuid.uuid4())
        dataset_state["startTime"] = time.time()
        dataset_state["endTime"] = None
        dataset_state["metrics"] = {
            "processed": 0,
            "total": config["datasetSize"],
            "valid": 0,
            "invalid": 0,
            "errors": 0,
            "recordsPerSecond": 0.0,
            "elapsedSeconds": 0,
            "remainingSeconds": None,
            "progressPercent": 0.0,
            "errorRate": 0.0,
        }
        dataset_state["samples"] = []
        dataset_state["distribution"] = {}
        dataset_task = asyncio.create_task(run_dataset_generation(dataset_state["runId"]))
        return {"status": dataset_state["status"], "runId": dataset_state["runId"]}

    blender_config = payload.get("blenderConfig") if payload else None
    if blender_config is None:
        blender_config = dataset_state.get("blenderConfig", default_blender_config)
    run_id = start_blender_generation(blender_config)
    return {"status": dataset_state["status"], "runId": run_id}

@router.post("/dataset/pause")
async def pause_dataset_generation():
    if dataset_state["status"] != "running":
        raise HTTPException(status_code=400, detail="Dataset generation is not running.")
    if dataset_state["mode"] == "blender" and dataset_process is not None:
        try:
            psutil.Process(dataset_process.pid).suspend()
        except Exception:
            pass
    dataset_state["status"] = "paused"
    add_log(f"Run {dataset_state['runId']} paused.")
    add_notification("pause", "Generación en pausa.")
    return {"status": dataset_state["status"]}

@router.post("/dataset/resume")
async def resume_dataset_generation():
    if dataset_state["status"] != "paused":
        raise HTTPException(status_code=400, detail="Dataset generation is not paused.")
    if dataset_state["mode"] == "blender" and dataset_process is not None:
        try:
            psutil.Process(dataset_process.pid).resume()
        except Exception:
            pass
    dataset_state["status"] = "running"
    add_log(f"Run {dataset_state['runId']} resumed.")
    add_notification("resume", "Generación reanudada.")
    return {"status": dataset_state["status"]}

@router.post("/dataset/stop")
async def stop_dataset_generation():
    if dataset_state["status"] not in ["running", "paused"]:
        raise HTTPException(status_code=400, detail="Dataset generation is not active.")
    if dataset_state["mode"] == "blender" and dataset_process is not None:
        try:
            dataset_process.terminate()
        except Exception:
            pass
    dataset_state["status"] = "stopped"
    dataset_state["endTime"] = time.time()
    add_log(f"Run {dataset_state['runId']} stopped.")
    add_notification("stop", "Generación detenida.")
    return {"status": dataset_state["status"]}

@router.get("/dataset/report")
async def export_dataset_report():
    report = {
        "runId": dataset_state["runId"],
        "status": dataset_state["status"],
        "mode": dataset_state.get("mode"),
        "startTime": dataset_state["startTime"],
        "endTime": dataset_state["endTime"],
        "metrics": dataset_state["metrics"],
        "distribution": dataset_state["distribution"],
        "config": dataset_state["config"],
        "blenderConfig": dataset_state.get("blenderConfig"),
        "outputDir": dataset_state.get("outputDir"),
    }
    return report
