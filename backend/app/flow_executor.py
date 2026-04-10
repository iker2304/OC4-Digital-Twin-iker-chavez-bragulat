import base64
import json
import logging
import os
import threading
import time
from collections import deque
from datetime import datetime
from typing import Any, Dict, List, Optional

import cv2
import numpy as np

try:
    from ultralytics import YOLO

    YOLO_AVAILABLE = True
except ImportError:
    YOLO_AVAILABLE = False
    print("[FlowExecutor] Warning: ultralytics not installed. AI inference will be disabled.")


logger = logging.getLogger("app.flow_executor")


def _coerce_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _basename(path: str) -> str:
    return os.path.basename(path) if path else ""


class VideoReader:
    def __init__(self, video_path: str, loop: bool = False):
        self.video_path = video_path
        self.loop = loop
        self.cap = None
        self.frame_count = 0
        self.total_frames = 0
        self.fps = 0.0
        self.width = 0
        self.height = 0
        self.last_error: Optional[str] = None
        self.last_read_ms = 0.0
        self._open()

    def _open(self):
        if self.cap:
            self.cap.release()

        self.cap = None
        self.last_error = None

        if not self.video_path:
            self.last_error = "No video path specified"
            logger.error("[FlowExecutor] VideoReader open failed: %s", self.last_error)
            return

        if not os.path.exists(self.video_path):
            self.last_error = f"Video file not found: {self.video_path}"
            logger.error("[FlowExecutor] VideoReader open failed: %s", self.last_error)
            return

        self.cap = cv2.VideoCapture(self.video_path)
        if not self.cap.isOpened():
            self.last_error = f"Unable to open video: {self.video_path}"
            logger.error("[FlowExecutor] VideoReader open failed: %s", self.last_error)
            self.cap.release()
            self.cap = None
            return

        self.total_frames = int(self.cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        self.fps = float(self.cap.get(cv2.CAP_PROP_FPS) or 0.0)
        self.width = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        self.height = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        logger.info(
            "[FlowExecutor] Video opened path=%s fps=%.2f resolution=%sx%s total_frames=%s",
            self.video_path,
            self.fps,
            self.width,
            self.height,
            self.total_frames,
        )

    def read_frame(self):
        started = time.perf_counter()

        if not self.cap or not self.cap.isOpened():
            self.last_error = self.last_error or f"Video source unavailable: {self.video_path}"
            return None

        ret, frame = self.cap.read()
        if not ret:
            if self.loop:
                self._open()
                if not self.cap or not self.cap.isOpened():
                    return None
                ret, frame = self.cap.read()
                if not ret:
                    self.last_error = f"Unable to read looped video frame: {self.video_path}"
                    return None
            else:
                self.last_error = None
                return None

        self.frame_count += 1
        self.last_read_ms = (time.perf_counter() - started) * 1000
        return frame

    def release(self):
        if self.cap:
            self.cap.release()
            self.cap = None

    def get_info(self):
        current_frame = 0
        if self.cap and self.cap.isOpened():
            current_frame = int(self.cap.get(cv2.CAP_PROP_POS_FRAMES) or 0)

        return {
            "frame_count": self.frame_count,
            "total_frames": self.total_frames,
            "fps": self.fps,
            "current_frame": current_frame,
            "width": self.width,
            "height": self.height,
            "resolution": f"{self.width}x{self.height}" if self.width and self.height else "unknown",
            "source_exists": os.path.exists(self.video_path) if self.video_path else False,
            "source_path": self.video_path,
            "source_name": _basename(self.video_path),
            "is_open": bool(self.cap and self.cap.isOpened()),
            "last_error": self.last_error,
            "capture_latency_ms": round(self.last_read_ms, 3),
        }


class YOLOModel:
    def __init__(self, model_path: str, device: Optional[str] = None):
        self.model_path = model_path
        self.device = device
        self.model = None
        self.last_error: Optional[str] = None
        self._load()

    def _load(self):
        self.last_error = None
        if not YOLO_AVAILABLE:
            self.last_error = "ultralytics is not installed"
            logger.error("[FlowExecutor] YOLO unavailable: %s", self.last_error)
            return

        try:
            self.model = YOLO(self.model_path)
            logger.info(
                "[FlowExecutor] YOLO model loaded path=%s device=%s exists=%s",
                self.model_path,
                self.device or "default",
                os.path.exists(self.model_path),
            )
        except Exception as exc:
            self.last_error = str(exc)
            logger.exception("[FlowExecutor] Error loading YOLO model path=%s", self.model_path)
            self.model = None

    def predict(
        self,
        frame: np.ndarray,
        conf: float = 0.5,
        keypoint_conf: float = 0.7,
        keypoint_labels: Optional[List[str]] = None,
        discard_empty_keypoints: bool = True,
    ) -> Dict[str, Any]:
        if frame is None or not hasattr(frame, "shape"):
            return {
                "predictions": [],
                "metrics": {
                    "mode": "invalid_frame",
                    "raw_detection_count": 0,
                    "retained_detection_count": 0,
                    "retained_keypoint_count": 0,
                    "inference_ms": 0.0,
                    "postprocess_ms": 0.0,
                },
                "error": "Invalid frame received by inference node",
            }

        if self.model is None:
            return {
                "predictions": [],
                "metrics": {
                    "mode": "model_unavailable",
                    "raw_detection_count": 0,
                    "retained_detection_count": 0,
                    "retained_keypoint_count": 0,
                    "inference_ms": 0.0,
                    "postprocess_ms": 0.0,
                },
                "error": self.last_error or "YOLO model is not available",
            }

        label_names = keypoint_labels or []

        try:
            inference_started = time.perf_counter()
            try:
                results = self.model(frame, conf=conf, verbose=False, device=self.device)
            except TypeError:
                results = self.model(frame, conf=conf, verbose=False)
            inference_ms = (time.perf_counter() - inference_started) * 1000

            postprocess_started = time.perf_counter()
            predictions: List[Dict[str, Any]] = []
            raw_detection_count = 0
            retained_keypoint_count = 0
            dropped_keypoints = 0
            dropped_detections = 0

            for result in results:
                boxes = result.boxes if getattr(result, "boxes", None) is not None else []
                names = getattr(result, "names", {}) or {}

                keypoints_data = None
                keypoints_conf_data = None
                if hasattr(result, "keypoints") and result.keypoints is not None:
                    if getattr(result.keypoints, "xy", None) is not None:
                        keypoints_data = result.keypoints.xy.cpu().numpy()
                    if getattr(result.keypoints, "conf", None) is not None:
                        keypoints_conf_data = result.keypoints.conf.cpu().numpy()

                for index, box in enumerate(boxes):
                    raw_detection_count += 1
                    x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
                    conf_score = float(box.conf[0])
                    cls = int(box.cls[0])

                    if isinstance(names, dict):
                        class_name = names.get(cls, str(cls))
                    elif isinstance(names, (list, tuple)) and cls < len(names):
                        class_name = names[cls]
                    else:
                        class_name = str(cls)

                    prediction: Dict[str, Any] = {
                        "bbox": [float(x1), float(y1), float(x2), float(y2)],
                        "confidence": conf_score,
                        "class": class_name,
                        "class_id": cls,
                    }

                    filtered_keypoints: List[Dict[str, Any]] = []
                    if keypoints_data is not None and index < len(keypoints_data):
                        keypoints = keypoints_data[index]
                        kp_confs = keypoints_conf_data[index] if keypoints_conf_data is not None and index < len(keypoints_conf_data) else None

                        for kp_index, keypoint in enumerate(keypoints):
                            # Cada keypoint se valida individualmente para eliminar puntos espurios
                            # sin perder el resto de la detección si sigue siendo útil.
                            kp_conf_value = float(kp_confs[kp_index]) if kp_confs is not None and kp_index < len(kp_confs) else None
                            if kp_conf_value is not None and kp_conf_value < keypoint_conf:
                                dropped_keypoints += 1
                                continue

                            kp_label = label_names[kp_index] if kp_index < len(label_names) else f"kpt_{kp_index}"
                            filtered_keypoints.append(
                                {
                                    "x": float(keypoint[0]),
                                    "y": float(keypoint[1]),
                                    "id": kp_label,
                                    "confidence": kp_conf_value,
                                }
                            )

                        if filtered_keypoints:
                            prediction["keypoints"] = filtered_keypoints
                            prediction["keypoint_count"] = len(filtered_keypoints)
                            retained_keypoint_count += len(filtered_keypoints)
                        elif discard_empty_keypoints:
                            dropped_detections += 1
                            continue

                    predictions.append(prediction)

            postprocess_ms = (time.perf_counter() - postprocess_started) * 1000
            return {
                "predictions": predictions,
                "metrics": {
                    "mode": "yolo",
                    "raw_detection_count": raw_detection_count,
                    "retained_detection_count": len(predictions),
                    "retained_keypoint_count": retained_keypoint_count,
                    "dropped_keypoints": dropped_keypoints,
                    "dropped_detections": dropped_detections,
                    "inference_ms": round(inference_ms, 3),
                    "postprocess_ms": round(postprocess_ms, 3),
                },
                "error": None,
            }
        except Exception as exc:
            logger.exception("[FlowExecutor] YOLO prediction error path=%s", self.model_path)
            return {
                "predictions": [],
                "metrics": {
                    "mode": "prediction_error",
                    "raw_detection_count": 0,
                    "retained_detection_count": 0,
                    "retained_keypoint_count": 0,
                    "inference_ms": 0.0,
                    "postprocess_ms": 0.0,
                },
                "error": str(exc),
            }


class StreamPublisher:
    def __init__(self, persist_url: str = "http://127.0.0.1:8000/persist"):
        self.persist_url = persist_url

    def publish(self, stream_id: str, data: Any):
        import urllib.request

        try:
            payload = json.dumps(
                {
                    "lastValue": data,
                    "updatedAt": datetime.now().isoformat(),
                }
            ).encode("utf-8")

            req = urllib.request.Request(
                f"{self.persist_url}/stream-values/{stream_id}",
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=2) as response:
                return response.status == 200
        except Exception as exc:
            logger.error("[FlowExecutor] Stream publish error stream_id=%s error=%s", stream_id, exc)
            return False


class FlowExecutor:
    def __init__(self):
        self.video_readers: Dict[str, VideoReader] = {}
        self.yolo_models: Dict[str, YOLOModel] = {}
        self.stream_publisher = StreamPublisher()
        self.running = False
        self.flow_thread: Optional[threading.Thread] = None
        self._node_outputs: Dict[str, Any] = {}
        self._trace_history: deque = deque(maxlen=250)

    def _push_trace(self, node_id: str, node_type: str, stage: str, status: str, **details: Any):
        event = {
            "timestamp": datetime.now().isoformat(),
            "nodeId": node_id,
            "nodeType": node_type,
            "stage": stage,
            "status": status,
            "details": details,
        }
        self._trace_history.append(event)
        logger.info("[FlowExecutor] %s %s %s %s", node_type, node_id, stage, details)

    def _store_output(self, node_id: str, result: Dict[str, Any]):
        self._node_outputs[node_id] = result
        return result

    def _error_result(self, node_id: str, node_type: str, message: str, **details: Any) -> Dict[str, Any]:
        diagnostics = {
            "nodeId": node_id,
            "nodeType": node_type,
            "error": message,
            **details,
        }
        self._push_trace(node_id, node_type, "error", "failed", **details, error=message)
        return self._store_output(node_id, {"error": message, "diagnostics": diagnostics})

    def _summarize_outputs(self) -> Dict[str, Any]:
        summary: Dict[str, Any] = {}
        for node_id, value in self._node_outputs.items():
            if isinstance(value, dict):
                summary[node_id] = {
                    "keys": list(value.keys()),
                    "error": value.get("error"),
                    "latency_ms": value.get("latency_ms"),
                    "detection_count": value.get("detection_count"),
                    "confidence": value.get("confidence"),
                    "published": value.get("published"),
                }
            else:
                summary[node_id] = {"type": type(value).__name__}
        return summary

    def get_diagnostics(self) -> Dict[str, Any]:
        return {
            "running": self.running,
            "videoReaders": list(self.video_readers.keys()),
            "yoloModels": list(self.yolo_models.keys()),
            "nodeOutputs": self._summarize_outputs(),
            "recentTraces": list(self._trace_history),
        }

    def execute_file_reader(self, node_id: str, config: Dict) -> Dict[str, Any]:
        started = time.perf_counter()
        uploaded_file = str(config.get("uploadedFile", "") or "")
        loop = bool(config.get("loop", False))

        if not uploaded_file:
            return self._error_result(node_id, "file_reader", "No file specified")

        reader = self.video_readers.get(node_id)
        if reader is None or reader.video_path != uploaded_file or reader.loop != loop:
            if reader:
                reader.release()
            self.video_readers[node_id] = VideoReader(uploaded_file, loop=loop)
            reader = self.video_readers[node_id]

        frame = reader.read_frame()
        frame_info = reader.get_info()
        if frame is None:
            result = {
                "file_data": None,
                "file_name": _basename(uploaded_file),
                "frame_info": frame_info,
                "EOF": True,
                "diagnostics": {
                    "nodeId": node_id,
                    "nodeType": "file_reader",
                    "capture": frame_info,
                    "latency_ms": round((time.perf_counter() - started) * 1000, 3),
                },
            }
            self._push_trace(
                node_id,
                "file_reader",
                "capture",
                "eof",
                file=uploaded_file,
                frame=frame_info.get("current_frame"),
                resolution=frame_info.get("resolution"),
                error=frame_info.get("last_error"),
            )
            return self._store_output(node_id, result)

        encode_started = time.perf_counter()
        ok, buffer = cv2.imencode(".jpg", frame)
        if not ok:
            return self._error_result(node_id, "file_reader", "Failed to encode frame", frame_info=frame_info)

        frame_base64 = base64.b64encode(buffer).decode("utf-8")
        total_ms = (time.perf_counter() - started) * 1000
        diagnostics = {
            "nodeId": node_id,
            "nodeType": "file_reader",
            "capture": frame_info,
            "encoding_ms": round((time.perf_counter() - encode_started) * 1000, 3),
            "latency_ms": round(total_ms, 3),
        }

        self._push_trace(
            node_id,
            "file_reader",
            "capture",
            "ok",
            file=uploaded_file,
            frame=frame_info.get("current_frame"),
            fps=frame_info.get("fps"),
            resolution=frame_info.get("resolution"),
            latency_ms=round(total_ms, 3),
        )
        return self._store_output(
            node_id,
            {
                "file_data": frame_base64,
                "file_name": _basename(uploaded_file),
                "frame_info": frame_info,
                "diagnostics": diagnostics,
            },
        )

    def execute_ai_inference(self, node_id: str, config: Dict, input_data: Any) -> Dict[str, Any]:
        started = time.perf_counter()
        # Se aceptan varias claves porque el frontend histórico y el actual no usan
        # exactamente el mismo nombre para la ruta del modelo ni para la confianza.
        model_path = str(
            config.get("modelPath")
            or config.get("modelFile")
            or config.get("model")
            or ""
        )
        device = config.get("device")
        conf_threshold = _coerce_float(config.get("confidenceThreshold", config.get("confidence", 0.5)), 0.5)
        keypoint_conf_threshold = _coerce_float(
            config.get("minKeypointConfidence", config.get("keypointConfidence", 0.7)),
            0.7,
        )
        keypoint_labels = config.get("keypointLabels") if isinstance(config.get("keypointLabels"), list) else None

        if not model_path:
            return self._error_result(
                node_id,
                "onnx_inference",
                "No model specified",
                accepted_config_keys=["modelPath", "modelFile", "model"],
            )

        cached_model = self.yolo_models.get(node_id)
        if cached_model is None or cached_model.model_path != model_path or cached_model.device != device:
            self.yolo_models[node_id] = YOLOModel(model_path, device=str(device) if device else None)

        model = self.yolo_models[node_id]

        frame_data = None
        source_frame_info = None
        source_file_name = None
        if isinstance(input_data, dict):
            source_frame_info = input_data.get("frame_info")
            source_file_name = input_data.get("file_name")
            if input_data.get("file_data"):
                frame_data = input_data["file_data"]
            elif input_data.get("frame") is not None:
                frame_data = input_data["frame"]
        elif isinstance(input_data, str):
            frame_data = input_data
        elif isinstance(input_data, np.ndarray):
            frame_data = input_data

        if frame_data is None:
            return self._error_result(
                node_id,
                "onnx_inference",
                "No frame data",
                model_path=model_path,
                source=source_file_name,
            )

        decode_started = time.perf_counter()
        if isinstance(frame_data, str):
            try:
                img_bytes = base64.b64decode(frame_data)
                nparr = np.frombuffer(img_bytes, np.uint8)
                frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            except Exception as exc:
                return self._error_result(
                    node_id,
                    "onnx_inference",
                    f"Failed to decode frame data: {exc}",
                    model_path=model_path,
                )
        else:
            frame = frame_data

        if frame is None or not hasattr(frame, "shape"):
            return self._error_result(
                node_id,
                "onnx_inference",
                "Decoded frame is empty",
                model_path=model_path,
            )

        decode_ms = (time.perf_counter() - decode_started) * 1000
        frame_h, frame_w = frame.shape[:2]
        inference_result = model.predict(
            frame,
            conf=conf_threshold,
            keypoint_conf=keypoint_conf_threshold,
            keypoint_labels=keypoint_labels,
        )

        if isinstance(inference_result, dict):
            predictions = inference_result.get("predictions", [])
            inference_metrics = inference_result.get("metrics", {})
            inference_error = inference_result.get("error")
        else:
            predictions = inference_result
            inference_metrics = {}
            inference_error = None

        all_keypoints: List[Dict[str, Any]] = []
        keypoint_groups: List[Dict[str, Any]] = []
        all_bboxes: List[List[float]] = []
        all_labels: List[str] = []
        for index, prediction in enumerate(predictions):
            keypoints = prediction.get("keypoints", [])
            keypoint_groups.append(
                {
                    "detection_index": index,
                    "class": prediction.get("class"),
                    "confidence": prediction.get("confidence"),
                    "keypoints": keypoints,
                }
            )
            all_keypoints.extend(keypoints)
            if "bbox" in prediction:
                all_bboxes.append(prediction["bbox"])
            if "class" in prediction:
                all_labels.append(prediction["class"])

        avg_conf = sum(p.get("confidence", 0.0) for p in predictions) / len(predictions) if predictions else 0.0
        total_ms = (time.perf_counter() - started) * 1000
        diagnostics = {
            "nodeId": node_id,
            "nodeType": "onnx_inference",
            "model": {
                "path": model_path,
                "exists_on_disk": os.path.exists(model_path),
                "device": device or "default",
                "load_error": model.last_error,
            },
            "input": {
                "file_name": source_file_name,
                "frame_width": frame_w,
                "frame_height": frame_h,
                "resolution": f"{frame_w}x{frame_h}",
                "source_frame_info": source_frame_info,
            },
            "thresholds": {
                "detection_confidence": conf_threshold,
                "keypoint_confidence": keypoint_conf_threshold,
            },
            "timings_ms": {
                "decode": round(decode_ms, 3),
                "inference": inference_metrics.get("inference_ms", 0.0),
                "postprocess": inference_metrics.get("postprocess_ms", 0.0),
                "total": round(total_ms, 3),
            },
            "metrics": {
                "raw_detection_count": inference_metrics.get("raw_detection_count", len(predictions)),
                "retained_detection_count": len(predictions),
                "retained_keypoint_count": len(all_keypoints),
                "dropped_keypoints": inference_metrics.get("dropped_keypoints", 0),
                "dropped_detections": inference_metrics.get("dropped_detections", 0),
                "average_confidence": round(avg_conf, 6),
            },
            "error": inference_error,
        }

        self._push_trace(
            node_id,
            "onnx_inference",
            "inference",
            "ok" if not inference_error else "warning",
            model_path=model_path,
            resolution=diagnostics["input"]["resolution"],
            detections=len(predictions),
            keypoints=len(all_keypoints),
            confidence=round(avg_conf, 6),
            latency_ms=round(total_ms, 3),
            error=inference_error,
        )

        return self._store_output(
            node_id,
            {
                "predictions": predictions,
                "detection_count": len(predictions),
                "raw_detection_count": inference_metrics.get("raw_detection_count", len(predictions)),
                "keypoints": all_keypoints,
                "keypoint_groups": keypoint_groups,
                "bounding_boxes": all_bboxes,
                "confidence": avg_conf,
                "labels": all_labels,
                "raw_tensor": predictions,
                "latency_ms": round(total_ms, 3),
                "diagnostics": diagnostics,
                "error": inference_error,
            },
        )

    def execute_dashboard_stream(self, node_id: str, config: Dict, input_data: Any) -> Dict[str, Any]:
        started = time.perf_counter()
        stream_id = config.get("streamId", node_id)
        stream_label = config.get("streamLabel", "Sensor Data")

        value = None
        if isinstance(input_data, dict):
            if "predictions" in input_data:
                value = len(input_data["predictions"])
            elif "confidence" in input_data:
                value = input_data["confidence"]
            elif "lastValue" in input_data:
                value = input_data["lastValue"]
            else:
                value = input_data.get("file_data") or input_data
        elif isinstance(input_data, list):
            value = len(input_data)

        if value is None:
            value = input_data

        success = self.stream_publisher.publish(stream_id, value)
        total_ms = (time.perf_counter() - started) * 1000
        diagnostics = {
            "nodeId": node_id,
            "nodeType": "dashboard_stream",
            "streamId": stream_id,
            "streamLabel": stream_label,
            "valueType": type(value).__name__,
            "published": success,
            "latency_ms": round(total_ms, 3),
        }
        self._push_trace(
            node_id,
            "dashboard_stream",
            "publish",
            "ok" if success else "failed",
            stream_id=stream_id,
            value=value,
            value_type=type(value).__name__,
            latency_ms=round(total_ms, 3),
        )

        return self._store_output(
            node_id,
            {
                "streamId": stream_id,
                "streamLabel": stream_label,
                "value": value,
                "published": success,
                "diagnostics": diagnostics,
            },
        )

    def execute_node(self, node_type: str, node_id: str, config: Dict, input_data: Any = None) -> Dict[str, Any]:
        if node_type == "file_reader":
            return self.execute_file_reader(node_id, config)
        if node_type == "ai_inference" or node_type == "onnx_inference":
            return self.execute_ai_inference(node_id, config, input_data)
        if node_type == "dashboard_stream" or node_type == "number_viewer":
            return self.execute_dashboard_stream(node_id, config, input_data)
        return self._error_result(node_id, node_type, f"Unknown node type: {node_type}")

    def execute_flow(self, flow: Dict) -> List[Dict]:
        nodes = flow.get("nodes", [])
        edges = flow.get("edges", [])

        node_map = {node["id"]: node for node in nodes}
        outputs: Dict[str, Dict[str, Any]] = {}

        for edge in edges:
            source_id = edge.get("source")
            target_id = edge.get("target")
            source_handle = edge.get("sourceHandle", "file_data")

            if source_id in node_map and target_id in node_map:
                source_node = node_map[source_id]
                target_node = node_map[target_id]

                if source_id not in outputs:
                    outputs[source_id] = self.execute_node(
                        source_node["data"]["type"],
                        source_node["id"],
                        source_node["data"].get("config", {}),
                        None,
                    )

                target_input = outputs.get(source_id, {}).get(source_handle)
                outputs[target_id] = self.execute_node(
                    target_node["data"]["type"],
                    target_node["id"],
                    target_node["data"].get("config", {}),
                    target_input,
                )

        return [{"nodeId": node_id, "result": result} for node_id, result in outputs.items()]

    def run_flow_loop(self, flow: Dict, interval: float = 0.1):
        nodes = flow.get("nodes", [])
        edges = flow.get("edges", [])
        node_map = {node["id"]: node for node in nodes}
        iteration = 0

        logger.info(
            "[FlowExecutor] Starting flow loop nodes=%s edges=%s node_ids=%s",
            len(nodes),
            len(edges),
            [node["id"] for node in nodes],
        )

        while self.running:
            iteration += 1
            outputs: Dict[str, Dict[str, Any]] = {}

            for edge in edges:
                source_id = edge.get("source")
                target_id = edge.get("target")
                source_handle = edge.get("sourceHandle", "file_data")

                if source_id in node_map and target_id in node_map:
                    source_node = node_map[source_id]
                    target_node = node_map[target_id]

                    if source_id not in outputs:
                        outputs[source_id] = self.execute_node(
                            source_node["data"]["type"],
                            source_node["id"],
                            source_node["data"].get("config", {}),
                            None,
                        )

                    target_input = outputs.get(source_id, {}).get(source_handle)
                    outputs[target_id] = self.execute_node(
                        target_node["data"]["type"],
                        target_node["id"],
                        target_node["data"].get("config", {}),
                        target_input,
                    )

            if iteration <= 3:
                logger.info(
                    "[FlowExecutor] Iteration=%s outputs=%s",
                    iteration,
                    {node_id: list(result.keys()) for node_id, result in outputs.items() if isinstance(result, dict)},
                )

            time.sleep(interval)

    def start_flow(self, flow: Dict, interval: float = 0.1):
        if self.running:
            self.stop_flow()

        self.running = True
        self._trace_history.clear()
        self.flow_thread = threading.Thread(target=self.run_flow_loop, args=(flow, interval))
        self.flow_thread.daemon = True
        self.flow_thread.start()

    def stop_flow(self):
        self.running = False
        if self.flow_thread:
            self.flow_thread.join(timeout=2)
            self.flow_thread = None

    def cleanup(self):
        self.stop_flow()
        for reader in self.video_readers.values():
            reader.release()
        self.video_readers.clear()
        self.yolo_models.clear()


executor = FlowExecutor()
