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

# Global variables for streaming
output_frame = None
lock = threading.Lock()

class MJPEGServer(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/video_feed':
            self.send_response(200)
            self.send_header('Content-type', 'multipart/x-mixed-replace; boundary=frame')
            self.end_headers()
            try:
                while True:
                    with lock:
                        if output_frame is None:
                            time.sleep(0.01) # Reduce sleep time
                            continue
                        frame_data = output_frame
                    
                    self.wfile.write(b'--frame\r\n')
                    self.wfile.write(b'Content-Type: image/jpeg\r\n\r\n')
                    self.wfile.write(frame_data)
                    self.wfile.write(b'\r\n')
                    time.sleep(0.01) # Reduce sleep time for higher FPS
            except Exception as e:
                pass
        else:
            self.send_response(404)
            self.end_headers()

def start_stream_server(port=8001):
    try:
        server = HTTPServer(('0.0.0.0', port), MJPEGServer)
        print(f"MJPEG Streaming Server started on port {port}")
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
    global output_frame
    # Ensure path compatibility (handle Windows backslashes on non-Windows systems)
    model_path = cfg.detection.paths.models
    if isinstance(model_path, str):
        model_path = model_path.replace('\\', os.sep).replace('/', os.sep)
        
    base_models_path = os.path.abspath(model_path)
    best_model = get_latest_model(base_models_path)
    
    if not best_model or not os.path.exists(best_model):
        print("Error: Not find best.pt in the models folder.")
        return

    print(f"Loading model: {best_model}")
    model = YOLO(best_model)

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
            # Subscribe to config topic
            mqtt_client.client.subscribe("oc4/config")
            mqtt_client.on_message_callback = on_config_message
            print(f"MQTT client connected. Listening for config on 'oc4/config'")
        except Exception as e:
            print(f"WARNING: Failed to connect to MQTT broker: {e}")
            mqtt_client = None

    source = current_cfg["camera_source"]
    
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
            return MobileCapture()

        if isinstance(src, int):
            # On Windows, MSMF can fail to grab frames in some drivers; try DirectShow first.
            if sys.platform.startswith("win") and hasattr(cv2, "CAP_DSHOW"):
                cap = cv2.VideoCapture(src, cv2.CAP_DSHOW)
                if cap.isOpened():
                    return cap
                cap.release()
            if sys.platform == "darwin" and hasattr(cv2, "CAP_AVFOUNDATION"):
                return cv2.VideoCapture(src, cv2.CAP_AVFOUNDATION)
        return cv2.VideoCapture(src)

    cap = open_capture(source)
    if not cap.isOpened():
        print(f"Error: Could not open video source {source}")
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
    
    # Rate Limiting for MQTT
    last_mqtt_publish_time = 0
    mqtt_publish_interval = 0.1 
    consecutive_read_failures = 0

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
        with cfg_lock:
            if camera_restart_requested:
                restart_now = True
                camera_restart_requested = False
                next_source = current_cfg["camera_source"]

        if restart_now and next_source != source:
            old_source = source
            cap.release()

            cap = open_capture(next_source)
            if cap.isOpened():
                source = next_source
                consecutive_read_failures = 0
                
                # Update FPS for new source
                source_fps = cap.get(cv2.CAP_PROP_FPS)
                if source_fps <= 0 or np.isnan(source_fps):
                    source_fps = 30.0
                frame_interval_s = 1.0 / source_fps
                if current_cfg["recording_fps"] <= 0: # Update recording fps if not forced
                    current_cfg["recording_fps"] = source_fps
                
                start_time_wall = time.time()
                next_frame_time = start_time_wall
                frame_indx = 0

                if isinstance(source, int):
                    print(f"Switched to camera source: Camera {source} (FPS: {source_fps:.2f})")
                else:
                    print(f"Switched to camera source: {source} (FPS: {source_fps:.2f})")
            else:
                cap.release()
                cap = open_capture(old_source)
                source = old_source
                with cfg_lock:
                    current_cfg["camera_source"] = old_source
                if cap.isOpened():
                    print(f"Error: Could not open video source {next_source}. Reverted to {old_source}.")
                else:
                    print(f"Error: Could not reopen previous video source {old_source}.")
                    break

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
        if not ret:
            consecutive_read_failures += 1
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
            
            if consecutive_read_failures % 30 == 0:
                print(f"Warning: Camera read failed {consecutive_read_failures} times. Retrying connection...")
                cap.release()
                time.sleep(2)
                # Try to alternate between 0 and 1 if it's an integer source
                if isinstance(source, int):
                    new_src = 1 if source == 0 else 0
                    print(f"Switching from camera {source} to {new_src} to see if it works...")
                    cap = open_capture(new_src)
                    # We don't update 'source' globally to keep the original intent, but we try the alternative
                else:
                    cap = open_capture(source)
            
            time.sleep(0.1)
            continue
        
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
            max_det=1,
            verbose=False
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

            if i.keypoints is not None and current_cfg["pnp_enabled"]:
                kpts = i.keypoints.xy.cpu().numpy()
                classes = i.boxes.cls.cpu().numpy()
                names = i.names
                
                obj_ids = i.boxes.id.cpu().numpy().astype(int) if i.boxes.id is not None else range(len(kpts))
                for idx, obj_idx in enumerate(range(len(kpts))):
                    class_name = names[int(classes[obj_idx])]
                    track_id = obj_ids[idx]
                    
                    pnp_points = {}
                    rvec, tvec = None, None
                    obj_payload = {
                        "frame": frame_indx,
                        "obj_id": int(track_id),
                        "class": class_name,
                        "points": pnp_points
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
                            
                            # Dynamic keypoint naming based on detection count
                            num_kpts = len(kpts[obj_idx])
                            if num_kpts == 11:
                                kp_name = KEYPOINT_ORDER_11[kp_idx]
                            elif num_kpts == 32:
                                kp_name = KEYPOINT_ORDER_32[kp_idx]
                            else:
                                kp_name = f"kp_{kp_idx}"
                            
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

                    # Push payload to cumulative result
                    all_detections.append(obj_payload)

                    # Final publish with Rate Limiting
                    current_time = time.time()
                    if mqtt_client and (current_time - last_mqtt_publish_time) >= mqtt_publish_interval:
                        mqtt_client.publish(obj_payload)
                        last_mqtt_publish_time = current_time
                        # Visual indicator
                        cv2.circle(annotated_frame, (30, 30), 10, (0, 255, 0), -1)
                        cv2.putText(annotated_frame, "MQTT TX", (50, 35), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
                    elif mqtt_client:
                        # Visual indicator (Idle)
                        cv2.circle(annotated_frame, (30, 30), 10, (255, 255, 0), -1) # Cyan for Idle
                        cv2.putText(annotated_frame, "MQTT IDLE", (50, 35), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 0), 2)
                    else:
                        cv2.circle(annotated_frame, (30, 30), 10, (0, 0, 255), -1)
                        cv2.putText(annotated_frame, "NO MQTT", (50, 35), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)


        # Always update stream frame, even when there are no detections.
        try:
            ret_enc, buffer = cv2.imencode('.jpg', annotated_frame)
            if ret_enc:
                with lock:
                    output_frame = buffer.tobytes()
        except Exception as e:
            print(f"Error encoding frame: {e}")

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
