import cv2
import csv
from ultralytics import YOLO
import hydra
from omegaconf import DictConfig
import os
import json
import sys
import numpy as np
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
import socketserver

class ThreadedHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
    """Handle requests in separate threads."""
    allow_reuse_address = True  # Prevents "Address already in use" on restart
    daemon_threads = True

# Global variables for streaming
# Initialize with a placeholder to prevent browser timeouts
output_frame = None

def create_placeholder(text="Initializing..."):
    import numpy as np
    import cv2
    img = np.zeros((480, 640, 3), dtype=np.uint8)
    cv2.putText(img, text, (180, 240), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (200, 200, 200), 2)
    _, buffer = cv2.imencode('.jpg', img)
    return buffer.tobytes()

output_frame = create_placeholder()
lock = threading.Lock()

# Shared state for camera source switching from the MJPEG server
_requested_source = None
_source_change_event = threading.Event()
_source_lock = threading.Lock()
_current_source = 0
_switch_failed = False  # True if last switch attempt could not open the target camera


class CameraCapture:
    """Threaded camera capture to decouple frame grabbing from inference.

    Runs a background thread that continuously reads frames from the camera so
    that by the time the main loop asks for a frame it is always the freshest
    one, eliminating the blocking wait that causes jitter.
    """

    def __init__(self, cap):
        self._cap = cap
        self._frame = None
        self._ret = False
        self._lock = threading.Lock()
        self._running = True
        self._thread = threading.Thread(target=self._reader, daemon=True)
        self._thread.start()

    def _reader(self):
        while self._running:
            ret, frame = self._cap.read()
            with self._lock:
                self._ret = ret
                self._frame = frame
            if not ret:
                time.sleep(0.01)

    def read(self):
        with self._lock:
            frame = self._frame.copy() if self._frame is not None else None
            return self._ret, frame

    def isOpened(self):
        return self._cap.isOpened()

    def release(self):
        self._running = False
        # Do a dummy read to unblock if it's somehow stuck (unlikely but safe)
        self._thread.join(timeout=2.0)
        
        # Only release cap after ensuring the thread isn't about to read from it
        self._cap.release()
        
        # Give macOS AVFoundation a moment to free the camera device
        # before the caller tries to open another one.
        if sys.platform == "darwin":
            import time
            time.sleep(0.5)

    def get(self, prop):
        return self._cap.get(prop)

    @property
    def is_threaded(self):
        return True


class MJPEGServer(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress per-request logs to avoid noise
        pass

    def _parse_query(self):
        """Return a dict of query parameters from self.path."""
        from urllib.parse import urlparse, parse_qs
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        return parsed.path, {k: v[0] for k, v in qs.items()}

    def do_GET(self):
        global _requested_source, _current_source, output_frame
        path, params = self._parse_query()
        client_ip = self.client_address[0]

        if path == '/video_feed':
            print(f"[NET] Connection request for /video_feed from {client_ip}")
            # Limit to cameras 0-4
            allowed_sources = [0, 1, 2, 3, 4]
            if 'source' in params:
                try:
                    requested = int(params['source'])
                    if requested in allowed_sources:
                        with _source_lock:
                            if requested != _current_source:
                                print(f"[CAM] Switch requested via URL to {requested}")
                                _requested_source = requested
                                _source_change_event.set()
                except ValueError:
                    pass  # non-integer source – ignore

            self.send_response(200)
            self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            try:
                # Track the source this connection was established for
                with _source_lock:
                    my_source = _current_source

                last_sent_frame = None
                while True:
                    # If the camera source has changed globally, terminate this old stream
                    # so the browser is forced to drop it and avoid connection limits.
                    with _source_lock:
                        if _current_source != my_source:
                            print(f"[NET] Terminating old video_feed for source {my_source} (now {_current_source})")
                            break

                    with lock:
                        if output_frame is not None:
                            last_sent_frame = output_frame
                        frame_curr = last_sent_frame

                    if frame_curr:
                        # Leading \r\n--frame ensures browsers decode the first frame correctly
                        self.wfile.write(b'\r\n--frame\r\n')
                        self.wfile.write(b'Content-Type: image/jpeg\r\n')
                        self.wfile.write(f'Content-Length: {len(frame_curr)}\r\n\r\n'.encode())
                        self.wfile.write(frame_curr)
                        self.wfile.write(b'\r\n')
                        self.wfile.flush()
                    
                    time.sleep(0.04)
            except Exception:
                pass

        elif path == '/health':
            body = b'{"status": "ok"}'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body)

        elif path == '/current_source':
            import json as _json
            with _source_lock:
                body = _json.dumps({
                    'source': _current_source,
                    'switch_failed': _switch_failed,
                }).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body)

        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        """Handle POST /switch_source  body: {"source": N}"""
        global _requested_source, _current_source
        from urllib.parse import urlparse
        path = urlparse(self.path).path

        if path == '/switch_source':
            try:
                length = int(self.headers.get('Content-Length', 0))
                body_bytes = self.rfile.read(length) if length > 0 else b'{}'
                import json as _json
                data = _json.loads(body_bytes.decode())
                new_src = int(data.get('source', -1))
                allowed_sources = [0, 1, 2, 3, 4]
                if new_src in allowed_sources:
                    with _source_lock:
                        if new_src != _current_source:
                            print(f"[CAM] Switch requested via POST to {new_src}")
                            _requested_source = new_src
                            _source_change_event.set()
                    resp = _json.dumps({'ok': True, 'source': new_src}).encode()
                    self.send_response(200)
                else:
                    resp = _json.dumps({'ok': False, 'error': 'invalid source (use 0-2)'}).encode()
                    self.send_response(400)
            except Exception as e:
                resp = str(e).encode()
                self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(resp)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(resp)
        else:
            self.send_response(404)
            self.end_headers()

    def do_OPTIONS(self):
        """CORS preflight for POST /switch_source"""
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

def start_stream_server(port=8001):
    try:
        server = ThreadedHTTPServer(('0.0.0.0', port), MJPEGServer)
        print(f"MJPEG Streaming Server started on port {port} (Threading Enabled)")
        server.serve_forever()
    except Exception as e:
        print(f"Failed to start streaming server: {e}")

project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if project_root not in sys.path:
    sys.path.append(project_root)

from utils.scripts.comm.mqtt import MqttClient
from utils.scripts.postprocess.geometry import pnp_solver as pnp_tools
from utils.scripts.postprocess.geometry import orientation as orientation_tools
from utils.scripts.detection.kalman_utils import KeypointSmoother

# Load dynamic keypoint mapping if available
keypoint_mapping = {}
mapping_path = os.path.join(project_root, "utils", "scripts", "postprocess", "geometry", "utils", "3D_points", "keypoint_mapping.json")
try:
    if os.path.exists(mapping_path):
        with open(mapping_path, 'r') as f:
            mapping_data = json.load(f)
            for k, v in mapping_data.items():
                keypoint_mapping[int(k)] = v
        print(f"Loaded {len(keypoint_mapping)} keypoint names from mapping.")
except Exception as e:
    print(f"Warning: Could not load keypoint mapping from {mapping_path}: {e}")

# Fallback hardcoded mappings
KEYPOINT_ORDER_32 = [
    "Blade_1", "Blade_2", "Blade_3",
    "Hub",
    "Pilar_base", "Pilar_base_top",
    "Pilar_mid", "Pilar_mid_b", "Pilar_mid_t",
    "pontoon_base_front", "pontoon_base_left", "pontoon_base_right",
    "Pontoon_top_front", "Pontoon_top_left", "pontoon_top_right",
    "Tapa_inf_gondola", "Tapa_sup_gondola",
    "Tubo_184mm_front", "Tubo_184mm_left", "Tubo_184mm_right",
    "Tubo_230mm_front", "Tubo_230mm_left", "Tubo_230mm_right",
    "Tubo_309mm_front", "Tubo_309mm_left", "Tubo_309mm_right",
    "Tubo_353mm_back", "Tubo_353mm_left", "Tubo_353mm_right",
    "Tubo_444mm_back", "Tubo_444mm_left", "Tubo_444mm_right"
]

KEYPOINT_ORDER_11 = [
    "pontoon_right_3",
    "pontoon_left_3",
    "pontoon_left_1",
    "pontoon_front_1",
    "pontoon_front_2",
    "pontoon_front_3",
    "Hub",
    "pontoon_center_left",
    "pontoon_center_right",
    "pontoon_center_front",
    "pilar_center"
]

KEYPOINT_ORDER_9 = [
    "blade_red_1", "blade_red_2", "blade_red_3",
    "blade_blue_1", "blade_blue_2", "blade_blue_3",
    "blade_yellow_1", "blade_yellow_2", "blade_yellow_3"
]

# Maps class name → ordered keypoint names for that class
CLASS_KEYPOINT_ORDERS = {
    "WindTurbine": KEYPOINT_ORDER_11,
    "Rotor": KEYPOINT_ORDER_9,
}

def get_latest_model(path):
    if not os.path.exists(path):
        print(f"La ruta {path} no existe.")
        return None
    
    if os.path.isfile(path) and path.endswith('.pt'):
        return path
        
    if os.path.isdir(path):
        folders = [os.path.join(path, d) for d in os.listdir(path) 
                   if os.path.isdir(os.path.join(path, d))]
        
        if not folders:
            potential_model = os.path.join(path, "best.pt")
            if os.path.exists(potential_model):
                return potential_model
            return None
        
        latest_folder = max(folders, key=os.path.getmtime)
        model_path = os.path.join(latest_folder, "weights", "best.pt")
        
        if not os.path.exists(model_path):
            model_path_root = os.path.join(latest_folder, "best.pt")
            if os.path.exists(model_path_root):
                return model_path_root
        
        return model_path
    
    return None

@hydra.main(config_path="config", config_name="detection", version_base=None)
def main(cfg: DictConfig) -> None:
    global output_frame, _current_source, _switch_failed
    # Ensure path compatibility (handle Windows backslashes on non-Windows systems)
    model_path = cfg.detection.paths.models
    if isinstance(model_path, str):
        model_path = model_path.replace('\\', os.sep).replace('/', os.sep)
        
    base_models_path = os.path.abspath(model_path)
    best_model = get_latest_model(base_models_path)
    
    if not best_model or not os.path.exists(best_model):
        print(f"Error: Not find best.pt in the models folder: {base_models_path}")
        return

    import torch
    if torch.cuda.is_available():
        device = 'cuda'
        print(f"Using CUDA GPU: {torch.cuda.get_device_name(0)}")
    elif torch.backends.mps.is_available():
        device = 'mps'
        print("Using MPS (Metal Performance Shaders) for acceleration.")
    else:
        device = 'cpu'
        print("Using device: CPU (no GPU detected)")
        
    print(f"Loading model: {best_model}")
    model = YOLO(best_model).to(device)

    # Start Streaming Server
    print("Initializing MJPEG server thread...")
    t = threading.Thread(target=start_stream_server, args=(8001,))
    t.daemon = True
    t.start()

    # Pre-load PnP Data if enabled
    points_3d = None
    intrinsic_matrix = None
    distortion_coefficients = None
    fallback_intrinsics = False
    pose_history = []
    orientation_history = []
    trackers = {}

    if cfg.pnp.enabled:
        # Update paths to absolute for the loaders
        cfg.pnp.paths.points_3d = os.path.join(project_root, cfg.pnp.paths.points_3d)
        cfg.pnp.paths.intrinsic_matrix = os.path.join(project_root, cfg.pnp.paths.intrinsic_matrix)

        try:
            points_3d = pnp_tools.load_3d_points(cfg)
        except Exception as e:
            print(f"Error loading 3D points for PnP: {e}")
            cfg.pnp.enabled = False

        if cfg.pnp.enabled:
            try:
                intrinsic_matrix = pnp_tools.load_intrinsic_matrix(cfg)
                distortion_coefficients = pnp_tools.load_distortion_coefficients(cfg)
                print("PnP Data loaded successfully.")
            except Exception as e:
                # Keep PnP enabled with an approximate camera model when calibration file is missing.
                print(f"Warning loading camera calibration for PnP: {e}")
                print("Using fallback intrinsics (approximate). Pose will be less accurate.")
                fallback_intrinsics = True
                distortion_coefficients = np.zeros((5, 1), dtype=np.float32)

    # Initialize MQTT
    mqtt_client = None
    
    # Dynamic Configuration
    current_cfg = {
        "conf": cfg.detection.conf,
        "iou": cfg.detection.iou,
        "show_boxes": cfg.detection.show_boxes,
        "show_kpts": True,
        "pnp_enabled": cfg.pnp.enabled,
        "camera_source": cfg.detection.source,
        "recording": bool(cfg.detection.save),
        "save_csv": bool(cfg.detection.save_csv),
        "csv_filename": cfg.detection.csv_filename,
        "recording_speed": float(cfg.detection.recording_speed),
        "recording_fps": float(cfg.detection.recording_fps)
    }
    cfg_lock = threading.Lock()
    camera_restart_requested = False
    recording_active = False
    recording_start_time = None
    recording_dir = None
    recording_video_path = None
    recording_frame_index = 0
    recording_last_write_time = None
    csv_active = False
    csv_start_time = None
    csv_frame_index = 0
    csv_file = None
    csv_writer = None

    def on_config_message(config_data):
        nonlocal camera_restart_requested
        print(f"Received new config: {config_data}")
        if "conf" in config_data:
            current_cfg["conf"] = float(config_data["conf"])
        if "iou" in config_data:
            current_cfg["iou"] = float(config_data["iou"])
        if "show_boxes" in config_data:
            current_cfg["show_boxes"] = bool(config_data["show_boxes"])
        if "show_kpts" in config_data:
            current_cfg["show_kpts"] = bool(config_data["show_kpts"])
        if "pnp_enabled" in config_data:
            current_cfg["pnp_enabled"] = bool(config_data["pnp_enabled"])
        if "recording" in config_data:
            current_cfg["recording"] = bool(config_data["recording"])
        if "save_csv" in config_data:
            current_cfg["save_csv"] = bool(config_data["save_csv"])
        if "recording_speed" in config_data:
            try:
                current_cfg["recording_speed"] = float(config_data["recording_speed"])
            except Exception:
                current_cfg["recording_speed"] = 1.0
        if "recording_fps" in config_data:
            try:
                current_cfg["recording_fps"] = float(config_data["recording_fps"])
            except Exception:
                current_cfg["recording_fps"] = 30.0
        if "camera_source" in config_data:
            raw_source = config_data["camera_source"]
            new_source = raw_source
            if isinstance(raw_source, str):
                s = raw_source.strip()
                if s.isdigit():
                    new_source = int(s)
                else:
                    new_source = s
            elif isinstance(raw_source, (int, float)):
                new_source = int(raw_source)

            with cfg_lock:
                if new_source != current_cfg["camera_source"]:
                    current_cfg["camera_source"] = new_source
                    camera_restart_requested = True

    if cfg.mqtt.enabled:
        try:
            # Main topic for publishing pose
            mqtt_client = MqttClient(cfg.mqtt.broker, cfg.mqtt.port, cfg.mqtt.topic)
            # Subscribe to config topic separately
            mqtt_client.client.subscribe("oc4/config")
            # Only call on_config_message for oc4/config messages, not oc4/pose
            _orig_on_message = mqtt_client.client.on_message
            def _filtered_on_message(client, userdata, msg):
                if msg.topic == "oc4/config":
                    try:
                        data = json.loads(msg.payload.decode())
                        on_config_message(data)
                    except Exception as e:
                        print(f"Error in config MQTT callback: {e}")
            mqtt_client.client.on_message = _filtered_on_message
            print(f"MQTT client connected. Listening for config on 'oc4/config'")
        except Exception as e:
            print(f"WARNING: Failed to connect to MQTT broker: {e}")
            mqtt_client = None

    source = current_cfg["camera_source"]
    # Keep global source tracker in sync from the start
    with _source_lock:
        _current_source = source if isinstance(source, int) else -1

    if isinstance(source, int):
        print(f"Starting real-time detection (Camera {source})...")
    else:
        print(f"Starting detection in: {source}")

    import requests

    def open_capture(src):
        if src == "mobile":
            # Mock capture object for mobile
            class MobileCapture:
                def isOpened(self): return True
                def release(self): pass
                def read(self):
                    try:
                        # Fetch latest frame from backend
                        response = requests.get("http://localhost:8000/mobile-frame", timeout=0.1)
                        if response.status_code == 200:
                            image_array = np.frombuffer(response.content, dtype=np.uint8)
                            frame = cv2.imdecode(image_array, cv2.IMREAD_COLOR)
                            if frame is not None:
                                return True, frame
                    except Exception:
                        pass
                    return False, None
            return CameraCapture(MobileCapture())

        if isinstance(src, int):
            # On Windows, MSMF can fail to grab frames in some drivers; try DirectShow first.
            raw_cap = None
            if sys.platform.startswith("win") and hasattr(cv2, "CAP_DSHOW"):
                raw_cap = cv2.VideoCapture(src, cv2.CAP_DSHOW)
                if not raw_cap.isOpened():
                    raw_cap.release()
                    raw_cap = None
            if raw_cap is None and sys.platform == "darwin" and hasattr(cv2, "CAP_AVFOUNDATION"):
                raw_cap = cv2.VideoCapture(src, cv2.CAP_AVFOUNDATION)
            if raw_cap is None:
                raw_cap = cv2.VideoCapture(src)
            # Wrap live cameras in a threaded reader for smooth, jitter-free capture
            return CameraCapture(raw_cap)
        return cv2.VideoCapture(src)

    def capture_has_signal(capture, timeout_s=1.5):
        """Return True only when the source provides at least one valid frame."""
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            try:
                ret, frame = capture.read()
            except Exception:
                ret, frame = False, None
            if ret and frame is not None and getattr(frame, "size", 0) > 0:
                return True
            time.sleep(0.03)
        return False

    cap = open_capture(source)
    if not cap.isOpened() or not capture_has_signal(cap):
        print(f"Error: Could not open video source {source} with valid frames")
        cap.release()
        return

    # Get source FPS for correct playback speed
    source_fps = cap.get(cv2.CAP_PROP_FPS)
    if source_fps <= 0 or np.isnan(source_fps):
        source_fps = 30.0
    frame_interval_s = 1.0 / source_fps
    print(f"Source FPS: {source_fps:.2f} (Frame interval: {frame_interval_s*1000:.1f}ms)")

    # Initialize Kalman Smoother for keypoints
    kp_smoother = KeypointSmoother()

    frame_indx = 0
    video_writer = None
    all_detections = []
    results = []

    # FPS counter
    fps_last_time = time.time()
    fps_counter = 0
    fps_display = 0.0

    # Rate Limiting for MQTT
    last_mqtt_publish_time = 0
    mqtt_publish_interval = 0.1 
    consecutive_read_failures = 0
    last_stable_source = source
    no_signal_failover_threshold = 60

    def ensure_recording_dir():
        nonlocal recording_dir
        if recording_dir is not None:
            return
        stamp = time.strftime("%Y%m%d_%H%M%S")
        recording_dir = os.path.join(project_root, "results", "recordings", stamp)
        os.makedirs(recording_dir, exist_ok=True)

    def start_csv():
        nonlocal csv_active, csv_start_time, csv_frame_index, recording_dir, csv_file, csv_writer
        if csv_active:
            return
        csv_active = True
        csv_start_time = time.time()
        csv_frame_index = 0
        ensure_recording_dir()
        csv_path = os.path.join(recording_dir, current_cfg["csv_filename"])
        csv_file = open(csv_path, "w", newline="")
        csv_writer = csv.writer(csv_file)
        csv_writer.writerow([
            "timestamp",
            "time_s",
            "frame",
            "obj_id",
            "class",
            "pitch",
            "roll",
            "yaw",
            "distance_global",
            "distance_x",
            "distance_y",
            "distance_z"
        ])
        print(f"CSV recording started. CSV: {csv_path}")

    def stop_csv():
        nonlocal csv_active, csv_start_time, csv_frame_index, recording_dir, recording_video_path, csv_file, csv_writer
        if csv_file:
            csv_file.close()
            csv_file = None
            csv_writer = None
        csv_active = False
        csv_start_time = None
        csv_frame_index = 0
        if not recording_active:
            recording_dir = None
            recording_video_path = None

    def start_recording():
        nonlocal recording_active, recording_start_time, recording_dir, recording_video_path, recording_frame_index, recording_last_write_time, video_writer
        if recording_active:
            return
        recording_active = True
        recording_start_time = time.time()
        recording_frame_index = 0
        recording_last_write_time = None
        ensure_recording_dir()
        recording_video_path = os.path.join(recording_dir, "video_with_keypoints_labels.mp4")
        if current_cfg["save_csv"] and not csv_active:
            start_csv()
        print(f"Recording started. Video: {recording_video_path}")

    def stop_recording():
        nonlocal recording_active, recording_start_time, recording_dir, recording_video_path, recording_frame_index, recording_last_write_time, video_writer
        if video_writer:
            video_writer.release()
            video_writer = None
        recording_active = False
        recording_start_time = None
        recording_video_path = None
        recording_frame_index = 0
        recording_last_write_time = None
        if not csv_active:
            recording_dir = None
        print("Recording stopped.")

    if current_cfg["recording_fps"] <= 0:
        current_cfg["recording_fps"] = source_fps

    start_time_wall = time.time()
    next_frame_time = start_time_wall
    
    while True:
        loop_start_time = time.time()
        restart_now = False
        next_source = None

        # Check for camera change requested via MJPEG ?source= URL parameter
        if _source_change_event.is_set():
            _source_change_event.clear()
            with _source_lock:
                web_source = _requested_source
            if web_source is not None and web_source != current_cfg["camera_source"]:
                with cfg_lock:
                    current_cfg["camera_source"] = web_source
                    camera_restart_requested = True

        with cfg_lock:
            if camera_restart_requested:
                restart_now = True
                camera_restart_requested = False
                next_source = current_cfg["camera_source"]

        if restart_now and next_source != source:
            old_source = source
            print(f"[CAM] Releasing camera {old_source} to switch to {next_source}...")
            # Clear any previous failure flag while the switch is in progress
            with _source_lock:
                _switch_failed = False
            cap.release()
            # Extra pause after release so AVFoundation frees the device fully
            time.sleep(0.5)

            cap = open_capture(next_source)
            if cap.isOpened() and capture_has_signal(cap):
                source = next_source
                last_stable_source = old_source
                consecutive_read_failures = 0
                # Keep global _current_source in sync; clear any previous failure flag
                with _source_lock:
                    _current_source = source if isinstance(source, int) else -1
                    _switch_failed = False

                # Update FPS for new source
                source_fps = cap.get(cv2.CAP_PROP_FPS)
                if source_fps <= 0 or np.isnan(source_fps):
                    source_fps = 30.0
                frame_interval_s = 1.0 / source_fps
                if current_cfg["recording_fps"] <= 0:  # Update recording fps if not forced
                    current_cfg["recording_fps"] = source_fps

                start_time_wall = time.time()
                next_frame_time = start_time_wall
                frame_indx = 0

                if isinstance(source, int):
                    print(f"[CAM] Switched to Camera {source} (FPS: {source_fps:.2f})")
                else:
                    print(f"[CAM] Switched to source: {source} (FPS: {source_fps:.2f})")
            else:
                print(f"[CAM] Could not open camera {next_source} with valid frames. Reverting to {old_source}.")
                cap.release()
                time.sleep(0.5)  # wait before reopening old camera
                cap = open_capture(old_source)
                source = old_source
                with cfg_lock:
                    current_cfg["camera_source"] = old_source
                with _source_lock:
                    _current_source = old_source if isinstance(old_source, int) else -1
                    _switch_failed = True  # tell the frontend the switch was rejected
                if not cap.isOpened() or not capture_has_signal(cap):
                    print(f"[CAM] Error: Could not reopen previous video source {old_source}. Stopping.")
                    break

        # Frame-skip logic only applies to file sources; live cameras (CameraCapture)
        # already drain the camera buffer in their background thread, so skipping
        # would only waste CPU and add jitter.
        if not getattr(cap, 'is_threaded', False):
            now = time.time()
            if now > next_frame_time + frame_interval_s:
                frames_to_skip = int((now - next_frame_time) / frame_interval_s)
                if frames_to_skip > 0:
                    frames_to_skip = min(frames_to_skip, 30)
                    for _ in range(frames_to_skip):
                        if not cap.grab():
                            break
                        frame_indx += 1
                        next_frame_time += frame_interval_s

        next_frame_time += frame_interval_s

        ret, frame = cap.read()
        
        # Loop video files automatically
        if not ret and isinstance(source, str) and not source.startswith(('http://', 'https://', 'rtsp://')) and source != "mobile":
            if hasattr(cap, 'set'):
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                ret, frame = cap.read()

        if not ret:
            consecutive_read_failures += 1

            # If a newly selected camera starts failing continuously, roll back
            # to the last stable camera to keep the live feed alive.
            if (
                consecutive_read_failures >= no_signal_failover_threshold
                and isinstance(source, int)
                and isinstance(last_stable_source, int)
                and last_stable_source != source
            ):
                fallback_source = last_stable_source
                print(
                    f"[CAM] Source {source} has no signal for {consecutive_read_failures} reads. "
                    f"Failing back to {fallback_source}."
                )
                cap.release()
                time.sleep(0.5)
                fallback_cap = open_capture(fallback_source)
                if fallback_cap.isOpened() and capture_has_signal(fallback_cap):
                    cap = fallback_cap
                    source = fallback_source
                    consecutive_read_failures = 0
                    with cfg_lock:
                        current_cfg["camera_source"] = fallback_source
                    with _source_lock:
                        _current_source = fallback_source
                        _switch_failed = True

                    source_fps = cap.get(cv2.CAP_PROP_FPS)
                    if source_fps <= 0 or np.isnan(source_fps):
                        source_fps = 30.0
                    frame_interval_s = 1.0 / source_fps
                    start_time_wall = time.time()
                    next_frame_time = start_time_wall
                    frame_indx = 0
                    continue
                else:
                    fallback_cap.release()
                    print(f"[CAM] Failover to {fallback_source} failed. Staying on {source}.")
                    cap = open_capture(source)
                    consecutive_read_failures = 0

            # Create a placeholder "No Signal" frame if camera fails
            placeholder = np.zeros((480, 640, 3), dtype=np.uint8)
            cv2.putText(placeholder, "No Camera Signal", (150, 240),
                        cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2)
            cv2.putText(placeholder, f"Retrying... ({consecutive_read_failures})", (150, 280),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (200, 200, 200), 1)

            with lock:
                ret_enc, buffer = cv2.imencode('.jpg', placeholder)
                if ret_enc:
                    output_frame = buffer.tobytes()

            # Keep polling for source-change requests while waiting so the user
            # can escape a dead camera by selecting a different one. Do NOT call
            # cap.release() here — that would corrupt _current_source tracking and
            # break the stream for every other camera index.
            time.sleep(0.05)  # shorter wait so picker changes are processed quickly
            continue  # skip the rest of the loop — frame is invalid

        consecutive_read_failures = 0

        if current_cfg["recording"] and not recording_active:
            start_recording()
        if recording_active and not current_cfg["recording"]:
            stop_recording()
        if current_cfg["save_csv"] and not csv_active:
            start_csv()
        if csv_active and not current_cfg["save_csv"]:
            stop_csv()

        annotated_frame = frame.copy()
        frame_h, frame_w = frame.shape[:2]
        base_dim = min(frame_w, frame_h)
        if base_dim < 480:
            plot_kpt_radius = 2
        elif base_dim < 720:
            plot_kpt_radius = 3
        elif base_dim < 1080:
            plot_kpt_radius = 4
        else:
            plot_kpt_radius = 5

        # Run tracking on current frame with latest config
        results = model.track(
            source=frame,
            conf=current_cfg["conf"],
            iou=current_cfg["iou"],
            show=False,
            persist=True,
            show_boxes=current_cfg["show_boxes"],
            max_det=2,
            verbose=False,
            device=device,
            half=(device in ('cuda', 'mps')), # FP16 is faster on GPU
            imgsz=640
        )

        for i in results:
            annotated_frame = i.plot(
                boxes=current_cfg["show_boxes"],
                kpt_radius=plot_kpt_radius if current_cfg["show_kpts"] else 0,
                kpt_line=current_cfg["show_kpts"]
            )

            frame_h, frame_w = annotated_frame.shape[:2]

            # Build approximate intrinsics if calibration file is unavailable.
            if fallback_intrinsics and intrinsic_matrix is None:
                focal = float(max(frame_w, frame_h))
                intrinsic_matrix = np.array([
                    [focal, 0.0, frame_w / 2.0],
                    [0.0, focal, frame_h / 2.0],
                    [0.0, 0.0, 1.0]
                ], dtype=np.float32)

            # Automatic Intrinsic Scaling
            current_intrinsic = np.array(intrinsic_matrix, dtype=np.float32) if intrinsic_matrix is not None else None
            if intrinsic_matrix is not None:
                cal_cx = intrinsic_matrix[0][2]
                cal_cy = intrinsic_matrix[1][2]
                scale_factor = frame_w / (cal_cx * 2)
                if abs(scale_factor - 1.0) > 0.1:
                    current_intrinsic[0, 0] *= scale_factor
                    current_intrinsic[1, 1] *= scale_factor
                    current_intrinsic[0, 2] *= scale_factor
                    current_intrinsic[1, 2] *= scale_factor

            if i.keypoints is not None:
                kpts = i.keypoints.xy.cpu().numpy()
                classes = i.boxes.cls.cpu().numpy()
                confs = i.boxes.conf.cpu().numpy()
                boxes_xyxy = i.boxes.xyxy.cpu().numpy()
                names = i.names

                obj_ids = i.boxes.id.cpu().numpy().astype(int) if i.boxes.id is not None else range(len(kpts))
                all_frame_points = {}
                all_frame_detections = []
                frame_pose = None
                frame_orientation = None
                for idx, obj_idx in enumerate(range(len(kpts))):
                    class_name = names[int(classes[obj_idx])]
                    track_id = obj_ids[idx]
                    conf_score = float(confs[obj_idx])
                    bbox = boxes_xyxy[obj_idx].tolist()

                    pnp_points = {}
                    rvec, tvec = None, None
                    obj_payload = {
                        "frame": frame_indx,
                        "obj_id": int(track_id),
                        "class": class_name,
                        "points": pnp_points
                    }
                    detection_entry = {
                        "obj_id": int(track_id),
                        "class": class_name,
                        "confidence": round(conf_score, 4),
                        "bbox": {
                            "x1": round(bbox[0], 2),
                            "y1": round(bbox[1], 2),
                            "x2": round(bbox[2], 2),
                            "y2": round(bbox[3], 2)
                        },
                        "keypoints": pnp_points
                    }
                
                    frame_timestamp = None
                    frame_time_s = None
                    frame_index = None
                    if csv_active and csv_start_time is not None:
                        frame_timestamp = time.time()
                        frame_time_s = frame_timestamp - csv_start_time
                        frame_index = csv_frame_index

                    for kp_idx, (raw_x, raw_y) in enumerate(kpts[obj_idx]):
                        if raw_x > 0 and raw_y > 0:
                            conf = float(i.keypoints.conf[obj_idx][kp_idx])
                            
                            # Apply Kalman Filter Smoothing
                            x, y = kp_smoother.update(track_id, kp_idx, raw_x, raw_y)
                            
                            # Class-aware keypoint naming: use class name first, then count-based fallback
                            num_kpts = len(kpts[obj_idx])
                            kp_order = CLASS_KEYPOINT_ORDERS.get(class_name, [])
                            if kp_idx < len(kp_order):
                                kp_name = kp_order[kp_idx]
                            elif num_kpts == 32 and kp_idx < len(KEYPOINT_ORDER_32):
                                kp_name = KEYPOINT_ORDER_32[kp_idx]
                            elif kp_idx in keypoint_mapping:
                                kp_name = keypoint_mapping[kp_idx]
                            else:
                                kp_name = f"kp_{kp_idx}"
                                if kp_idx == 0 and frame_indx % 60 == 0:
                                    print(f"Warning: Keypoint {kp_idx} not in mapping (class: {class_name}, total kpts: {num_kpts}).")
                            
                            pnp_points[kp_name] = {
                                "x": float(x),
                                "y": float(y),
                                "confidence": round(conf, 4),
                                "id": kp_idx
                            }

                            if current_cfg["show_kpts"]:
                                label = f"{kp_name}:{int(conf*100)}%"
                                cv2.putText(annotated_frame, label, (int(x), int(y) - 7), 
                                            cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 0), 1)
                                cv2.circle(annotated_frame, (int(raw_x), int(raw_y)), 2, (0, 0, 255), -1)
                

                    if cfg.pnp.enabled and points_3d is not None:
                        p3d, p2d, names_used = pnp_tools.match_points(cfg, points_3d, pnp_points)
                        
                        if len(p3d) >= 4:
                            rvec, tvec = pnp_tools.pnp_solver(cfg, p3d, p2d, current_intrinsic, distortion_coefficients)
                        else:
                            # Debug info for insufficient points
                            if frame_indx % 30 == 0: # Print only every 30 frames to avoid spam
                                print(f"DEBUG: Not enough points for PnP. Found: {len(p3d)} (Need 4+)")
                            rvec, tvec = None, None
                            
                        if rvec is not None:
                                pose_data = {
                                    "rvec": rvec.flatten().tolist(),
                                    "tvec": tvec.flatten().tolist(),
                                    "points_used": names_used
                                }
                                obj_payload["pose"] = pose_data
                                pose_history.append({
                                    "frame": frame_indx,
                                    "obj_id": int(track_id),
                                    "pose": pose_data
                                })
                                
                                dist = np.linalg.norm(tvec)
                                cv2.putText(annotated_frame, f"Dist: {dist:.2f}", (int(p2d[0][0]), int(p2d[0][1]) - 20), 
                                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 0, 0), 2)
            
                    if cfg.orientation.enabled and cfg.pnp.enabled and rvec is not None:
                        # Get or create tracker for this object
                        if track_id not in trackers:
                            trackers[track_id] = orientation_tools.PoseTracker(cfg)
                        
                        # Update tracker and get relative pose
                        pitch, roll, yaw, dists = trackers[track_id].update(rvec, tvec)
                        global_distance, x_distance, y_distance, z_distance = dists

                        # Visualize X, Y, Z components
                        base_x, base_y = int(p2d[0][0]), int(p2d[0][1])
                        cv2.putText(annotated_frame, f"X: {x_distance:.2f}m", (base_x, base_y - 40), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 2) # Red
                        cv2.putText(annotated_frame, f"Y: {y_distance:.2f}m", (base_x, base_y - 60), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2) # Green
                        cv2.putText(annotated_frame, f"Z: {z_distance:.2f}m", (base_x, base_y - 80), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 0, 0), 2) # Blue

                        print(f"Object {track_id} - Ángulos (pitch, roll, yaw): {pitch}, {roll}, {yaw}")
                        print(f"Object {track_id} - Distancia (global, x, y, z): {dists}")
                        
                        if all(v is not None for v in (pitch, roll, yaw)):
                            orientation_data = {
                                "Pitch": float(pitch),
                                "Yaw": float(yaw),
                                "Roll": float(roll),
                                "Distance": {
                                    "global": float(global_distance),
                                    "x": float(x_distance),
                                    "y": float(y_distance),
                                    "z": float(z_distance)
                                }
                            }
                            obj_payload["orientation"] = orientation_data
                            orientation_history.append({
                                "frame": frame_indx,
                                "obj_id": int(track_id),
                                "orientation": orientation_data
                            })
                            if csv_active and csv_writer and frame_timestamp is not None:
                                csv_writer.writerow([
                                    frame_timestamp,
                                    frame_time_s,
                                    frame_index,
                                    int(track_id),
                                    class_name,
                                    orientation_data["Pitch"],
                                    orientation_data["Roll"],
                                    orientation_data["Yaw"],
                                    orientation_data["Distance"]["global"],
                                    orientation_data["Distance"]["x"],
                                    orientation_data["Distance"]["y"],
                                    orientation_data["Distance"]["z"]
                                ])

                    # Propagate pose/orientation into detection_entry
                    if "pose" in obj_payload:
                        detection_entry["pose"] = obj_payload["pose"]
                    if "orientation" in obj_payload:
                        detection_entry["orientation"] = obj_payload["orientation"]

                    # Accumulate keypoints and pose/orientation across all detected objects
                    all_frame_points.update(pnp_points)
                    all_frame_detections.append(detection_entry)
                    if "pose" in obj_payload and frame_pose is None:
                        frame_pose = obj_payload["pose"]
                    if "orientation" in obj_payload and frame_orientation is None:
                        frame_orientation = obj_payload["orientation"]

                    # Push payload to cumulative result
                    all_detections.append(obj_payload)

                # Publish one combined payload per frame (after all objects processed)
                current_time = time.time()
                if mqtt_client and all_frame_detections and (current_time - last_mqtt_publish_time) >= mqtt_publish_interval:
                    combined_payload = {
                        "frame": frame_indx,
                        "num_detections": len(all_frame_detections),
                        "detections": all_frame_detections,
                        "points": all_frame_points,
                        "fps": round(fps_display, 2)
                    }
                    if frame_pose is not None:
                        combined_payload["pose"] = frame_pose
                    if frame_orientation is not None:
                        combined_payload["orientation"] = frame_orientation
                    mqtt_client.publish(combined_payload)
                    last_mqtt_publish_time = current_time
                    cv2.circle(annotated_frame, (30, 30), 10, (0, 255, 0), -1)
                    cv2.putText(annotated_frame, "MQTT TX", (50, 35), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
                elif mqtt_client:
                    cv2.circle(annotated_frame, (30, 30), 10, (255, 255, 0), -1)
                    cv2.putText(annotated_frame, "MQTT IDLE", (50, 35), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 0), 2)
                else:
                    cv2.circle(annotated_frame, (30, 30), 10, (0, 0, 255), -1)
                    cv2.putText(annotated_frame, "NO MQTT", (50, 35), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)


        # FPS overlay
        fps_counter += 1
        now_fps = time.time()
        if now_fps - fps_last_time >= 1.0:
            fps_display = fps_counter / (now_fps - fps_last_time)
            fps_counter = 0
            fps_last_time = now_fps
        cv2.putText(annotated_frame, f"FPS: {fps_display:.1f}", (10, annotated_frame.shape[0] - 10),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)

        # Always update stream frame, even when there are no detections.
        # Quality 80 strikes a good balance between image fidelity and encoding speed.
        try:
            ret_enc, buffer = cv2.imencode('.jpg', annotated_frame,
                                           [cv2.IMWRITE_JPEG_QUALITY, 80])
            if ret_enc:
                with lock:
                    output_frame = buffer.tobytes()
        except Exception as e:
            print(f"Error encoding frame for MJPEG: {e}")

        if recording_active and recording_start_time is not None:
            now_ts = time.time()
            speed = current_cfg["recording_speed"]
            if not speed or speed <= 0:
                speed = 1.0
            target_fps = current_cfg["recording_fps"]
            if not target_fps or target_fps <= 0:
                target_fps = 30.0
            logical_time = (now_ts - recording_start_time) / speed
            frame_interval = 1.0 / target_fps

            if video_writer is None and recording_video_path is not None:
                h, w = annotated_frame.shape[:2]
                video_writer = cv2.VideoWriter(recording_video_path, cv2.VideoWriter_fourcc(*'mp4v'), target_fps, (w, h))
                recording_last_write_time = -frame_interval
                print(f"Saving video with keypoints labels in: {recording_video_path}")

            if video_writer and recording_last_write_time is not None:
                while logical_time - recording_last_write_time >= frame_interval:
                    video_writer.write(annotated_frame)
                    recording_last_write_time += frame_interval

        if cfg.detection.show:
            cv2.imshow("YOLO11 Pose Tracking - Keypoint IDs", annotated_frame)
            
            # Calculate wait time to match source FPS
            elapsed = time.time() - loop_start_time
            wait_time = max(1, int((frame_interval_s - elapsed) * 1000))
            
            if cv2.waitKey(wait_time) & 0xFF == ord('q'):
                break
        
        if recording_active:
            recording_frame_index += 1
        if csv_active:
            csv_frame_index += 1
        frame_indx += 1

    # Save JSON results
    if (len(results) > 0 and results[0].save_dir is not None) or all_detections:
        # Use a default save directory
        save_dir = "results/detect"
        if len(results) > 0 and results[0].save_dir is not None:
            save_dir = results[0].save_dir
            
        run_name = os.path.basename(save_dir)
        json_dir = os.path.abspath(os.path.join(project_root, "results", "json_data", run_name))
        os.makedirs(json_dir, exist_ok=True)
        
        if all_detections:
            json_save_path = os.path.join(json_dir, "2D_points.json")
            with open(json_save_path, 'w') as f:
                json.dump(all_detections, f, indent=4)
            print(f"Detections JSON (all objects) saved to: {json_save_path}")

        # Save PnP Pose Results
        if cfg.pnp.enabled and pose_history:
            pose_save_path = os.path.join(json_dir, "pose_results.json")
            with open(pose_save_path, 'w') as f:
                json.dump(pose_history, f, indent=4)
            print(f"Pose results JSON saved to: {pose_save_path}")

        # Save Orientation Results
        if cfg.orientation.enabled and orientation_history:
            orientation_save_path = os.path.join(json_dir, "orientation_results.json")
            with open(orientation_save_path, 'w') as f:
                json.dump(orientation_history, f, indent=4)
            print(f"Orientation results JSON saved to: {orientation_save_path}")
    
    if video_writer:
        video_writer.release()
        print("Video with keypoints labels saved successfully.")
    if csv_file:
        csv_file.close()

    if mqtt_client:
        mqtt_client.disconnect()
        print("MQTT client disconnected.")

    cv2.destroyAllWindows()
 
if __name__ == "__main__":
    main()
