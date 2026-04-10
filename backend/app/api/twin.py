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

# MQTT Configuration
MQTT_BROKER = os.getenv("MQTT_BROKER", "localhost")
MQTT_PORT = int(os.getenv("MQTT_PORT", 1883))
MQTT_TOPIC_POSE = "oc4/pose"
MQTT_TOPIC_CONFIG = "oc4/config"

def on_mqtt_connect(client, userdata, flags, rc):
    print(f"Connected to MQTT Broker with result code {rc}")
    client.subscribe(MQTT_TOPIC_POSE)

def on_mqtt_message(client, userdata, msg):
    global latest_twin_data
    if msg.topic == MQTT_TOPIC_POSE:
        try:
            payload_str = msg.payload.decode()
            payload = json.loads(payload_str)
            
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

            if "pose" in payload:
                latest_twin_data["pose"] = payload["pose"]
            
            if "points" in payload:
                kpts = []
                for kp_name, kp_data in payload["points"].items():
                    kpts.append({
                        "x": kp_data["x"],
                        "y": kp_data["y"],
                        "id": kp_name
                    })
                latest_twin_data["video"]["keypoints"] = kpts
                
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

    for idx in range(max_index + 1):
        ok = False
        try:
            cap = cv2.VideoCapture(idx, backend)
            ok = cap.isOpened()
            cap.release()
        except Exception:
            ok = False

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

def start_blender_generation(config: Dict[str, Any]):
    global dataset_process, dataset_process_thread, dataset_process_paused
    project_root = Path(__file__).resolve().parents[3]
    blender_exe = os.getenv("BLENDER_EXE", r"C:\Program Files\Blender Foundation\Blender 4.5\blender.exe")
    if not os.path.exists(blender_exe):
        raise HTTPException(status_code=400, detail=f"Blender no encontrado en {blender_exe}")

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

    env = os.environ.copy()
    env["DATASET_OUTPUT_DIR"] = str(run_folder)

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
    add_notification("start", f"Generación iniciada (run {run_id}).")

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
    if dataset_state["mode"] == "blender":
        if dataset_process is None:
            raise HTTPException(status_code=400, detail="Blender process not running.")
        psutil.Process(dataset_process.pid).suspend()
        dataset_state["status"] = "paused"
        add_log(f"Run {dataset_state['runId']} paused.")
        add_notification("pause", "Generación en pausa.")
        return {"status": dataset_state["status"]}
    dataset_state["status"] = "paused"
    add_log(f"Run {dataset_state['runId']} paused.")
    add_notification("pause", "Generación en pausa.")
    return {"status": dataset_state["status"]}

@router.post("/dataset/resume")
async def resume_dataset_generation():
    if dataset_state["status"] != "paused":
        raise HTTPException(status_code=400, detail="Dataset generation is not paused.")
    if dataset_state["mode"] == "blender":
        if dataset_process is None:
            raise HTTPException(status_code=400, detail="Blender process not running.")
        psutil.Process(dataset_process.pid).resume()
        dataset_state["status"] = "running"
        add_log(f"Run {dataset_state['runId']} resumed.")
        add_notification("resume", "Generación reanudada.")
        return {"status": dataset_state["status"]}
    dataset_state["status"] = "running"
    add_log(f"Run {dataset_state['runId']} resumed.")
    add_notification("resume", "Generación reanudada.")
    return {"status": dataset_state["status"]}

@router.post("/dataset/stop")
async def stop_dataset_generation():
    if dataset_state["status"] not in ["running", "paused"]:
        raise HTTPException(status_code=400, detail="Dataset generation is not active.")
    if dataset_state["mode"] == "blender":
        if dataset_process is None:
            raise HTTPException(status_code=400, detail="Blender process not running.")
        try:
            dataset_process.terminate()
        except Exception:
            pass
        dataset_state["status"] = "stopped"
        dataset_state["endTime"] = time.time()
        add_log(f"Run {dataset_state['runId']} stopped.")
        add_notification("stop", "Generación detenida.")
        return {"status": dataset_state["status"]}
    dataset_state["status"] = "stopped"
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
