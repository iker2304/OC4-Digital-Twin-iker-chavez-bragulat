from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Body
from app.utils.postprocess.SHM.shm_analyzer import SHMAnalyzer
from app.api.twin import latest_twin_data
import asyncio
import json
from typing import Dict, Any

router = APIRouter()

from pydantic import BaseModel

class DamageUpdate(BaseModel):
    damage_index: float

# Global SHM Analyzer Instance
shm_analyzer = SHMAnalyzer()

@router.post("/damage")
async def update_damage_index(update: DamageUpdate):
    shm_analyzer.set_damage_index(update.damage_index)
    return {"status": "success", "new_damage_index": update.damage_index}

@router.get("/shm/config")
async def get_shm_config():
    return shm_analyzer.get_config()

@router.post("/shm/config")
async def update_shm_config(payload: Dict[str, Any] = Body(...)):
    updated = shm_analyzer.update_config(payload)
    return {"status": "success", "config": updated}

@router.websocket("/ws/shm")
async def websocket_shm_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            # 1. Get latest telemetry from Twin state
            telemetry = latest_twin_data
            
            # 2. Process SHM Logic
            shm_result = shm_analyzer.process_sensor_data(telemetry)
            
            # 3. Send results to frontend
            await websocket.send_json(shm_result)
            
            # 4. Wait for next update cycle (e.g., 100ms = 10Hz)
            await asyncio.sleep(0.1)
            
    except WebSocketDisconnect:
        print("SHM WebSocket disconnected")
    except Exception as e:
        print(f"SHM WebSocket Error: {e}")
        await websocket.close()
