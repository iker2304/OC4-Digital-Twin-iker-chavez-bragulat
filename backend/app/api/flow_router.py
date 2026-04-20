from fastapi import APIRouter, HTTPException, UploadFile, File
from pydantic import BaseModel
from typing import Any, Dict, List, Optional
import threading
import os
import shutil

from app.flow_executor import executor

router = APIRouter(tags=["flow"])

UPLOAD_DIR = "uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)

@router.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    try:
        safe_name = os.path.basename(file.filename or "uploaded_file")
        file_path = os.path.join(UPLOAD_DIR, safe_name)
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
        
        print(f"[FlowRouter] File uploaded to: {file_path}")
        return {"file_path": file_path, "filename": safe_name}
    except Exception as e:
        print(f"[FlowRouter] Error uploading file: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class FlowDeployRequest(BaseModel):
    flowId: str
    flow: Dict[str, Any]
    config: Optional[Dict[str, Any]] = None


class NodeExecutionRequest(BaseModel):
    nodeType: str
    nodeId: str
    config: Dict[str, Any]
    inputData: Optional[Any] = None


@router.post("/deploy")
async def deploy_flow(request: FlowDeployRequest):
    try:
        print(f"[FlowRouter] Received deploy request for flow: {request.flowId}")
        print(f"[FlowRouter] Flow nodes: {request.flow.get('nodes', [])}")
        
        if executor.running:
            print("[FlowRouter] Executor already running, stopping first...")
            executor.stop_flow()

        flow = request.flow
        interval = request.config.get("interval", 0.1) if request.config else 0.1
        
        print(f"[FlowRouter] Starting flow with interval: {interval}")

        executor.start_flow(flow, interval=interval)
        
        print(f"[FlowRouter] Flow started successfully")

        return {
            "status": "deployed",
            "flowId": request.flowId,
            "message": f"Flow '{request.flowId}' deployed and running"
        }
    except Exception as e:
        print(f"[FlowRouter] Error deploying flow: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/undeploy/{flow_id}")
async def undeploy_flow(flow_id: str):
    try:
        executor.stop_flow()
        executor.cleanup()

        return {
            "status": "undeployed",
            "flowId": flow_id,
            "message": f"Flow '{flow_id}' stopped and cleaned up"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/execute-node")
async def execute_single_node(request: NodeExecutionRequest):
    try:
        result = executor.execute_node(
            request.nodeType,
            request.nodeId,
            request.config,
            request.inputData
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/status")
async def get_flow_status():
    return executor.get_diagnostics()


@router.get("/diagnostics")
async def get_flow_diagnostics():
    return executor.get_diagnostics()


@router.get("/terminal/{node_id}")
async def get_terminal_output(node_id: str):
    """Return buffered lines for a terminal_output node."""
    lines = executor.get_terminal_lines(node_id)
    return {"nodeId": node_id, "lines": lines, "count": len(lines)}


@router.get("/cameras")
async def list_cameras():
    """Probe camera indices 0-9 and return those that open successfully."""
    import cv2 as _cv2
    available = []
    for idx in range(10):
        cap = _cv2.VideoCapture(idx)
        if cap.isOpened():
            w = int(cap.get(_cv2.CAP_PROP_FRAME_WIDTH) or 0)
            h = int(cap.get(_cv2.CAP_PROP_FRAME_HEIGHT) or 0)
            fps = float(cap.get(_cv2.CAP_PROP_FPS) or 0.0)
            available.append({"index": idx, "resolution": f"{w}x{h}", "fps": fps})
            cap.release()
    return {"cameras": available}


@router.post("/execute-flow")
async def execute_flow_once(flow: Dict[str, Any]):
    try:
        results = executor.execute_flow(flow)
        return {"status": "completed", "results": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
