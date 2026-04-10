import json
import os
from fastapi import APIRouter, Body
from typing import Any
from datetime import datetime

router = APIRouter()

DB_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "db")
os.makedirs(DB_DIR, exist_ok=True)

STREAM_VALUES_FILE = os.path.join(DB_DIR, "stream_values.json")

def load_stream_values():
    if os.path.exists(STREAM_VALUES_FILE):
        try:
            with open(STREAM_VALUES_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}

def save_stream_values(data):
    with open(STREAM_VALUES_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f)

@router.get("/stream-values/{stream_id}")
async def get_stream_value(stream_id: str):
    values = load_stream_values()
    return values.get(stream_id, {"lastValue": None, "updatedAt": None})

@router.get("/stream-values")
async def get_all_stream_values():
    return load_stream_values()

@router.post("/stream-values/{stream_id}")
async def update_stream_value(stream_id: str, data: dict = Body(...)):
    values = load_stream_values()
    values[stream_id] = {
        "lastValue": data.get("lastValue"),
        "updatedAt": data.get("updatedAt", datetime.now().isoformat())
    }
    save_stream_values(values)
    return {"status": "success", "streamId": stream_id}

@router.get("/{store_key}")
async def get_store(store_key: str):
    file_path = os.path.join(DB_DIR, f"{store_key}.json")
    if os.path.exists(file_path):
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return []
    return []

@router.post("/{store_key}")
async def save_store(store_key: str, data: Any = Body(...)):
    file_path = os.path.join(DB_DIR, f"{store_key}.json")
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(data, f)
    return {"status": "success"}
