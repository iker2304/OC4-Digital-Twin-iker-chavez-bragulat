import cv2
from ultralytics import YOLO
import hydra
from omegaconf import DictConfig
import os
import json
import sys
import numpy as np

project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if project_root not in sys.path:
    sys.path.append(project_root)

from utils.scripts.comm.mqtt import MqttClient
from utils.scripts.postprocess.geometry import pnp_solver as pnp_tools
from utils.scripts.postprocess.geometry import orientation as orientation_tools

KEYPOINT_ORDER = [
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

class PoseKalmanFilter:
    def __init__(self, fps=30):
        # 12 state variables: [tx, ty, tz, rx, ry, rz, vtx, vty, vtz, vrx, vry, vrz]
        # 6 measurements: [tx, ty, tz, rx, ry, rz]
        self.kalman = cv2.KalmanFilter(12, 6)
        
        dt = 1.0 / fps
        
        # Transition Matrix (Physics model: position + velocity * dt)
        self.kalman.transitionMatrix = np.eye(12, dtype=np.float32)
        # Position update
        self.kalman.transitionMatrix[0, 6] = dt
        self.kalman.transitionMatrix[1, 7] = dt
        self.kalman.transitionMatrix[2, 8] = dt
        # Rotation update
        self.kalman.transitionMatrix[3, 9] = dt
        self.kalman.transitionMatrix[4, 10] = dt
        self.kalman.transitionMatrix[5, 11] = dt
        
        # Measurement Matrix (We observe position and rotation directly)
        self.kalman.measurementMatrix = np.eye(6, 12, dtype=np.float32)
        
        # Process Noise Covariance (Q) - Trust in model
        # Lower value = smoother but more lag. Higher value = faster response but more jitter.
        self.kalman.processNoiseCov = np.eye(12, dtype=np.float32) * 1e-4
        
        # Measurement Noise Covariance (R) - Trust in measurement
        # Higher value = trust measurement less (smoother)
        self.kalman.measurementNoiseCov = np.eye(6, dtype=np.float32) * 1e-1
        
        # Error Covariance (P) - Initial uncertainty
        self.kalman.errorCovPost = np.eye(12, dtype=np.float32)

    def predict(self):
        """Differs from standard implementation: predict step returns the prio estimate."""
        return self.kalman.predict()

    def update(self, tvec, rvec):
        """Update with new measurement and return corrected state."""
        measurement = np.array([
            tvec[0], tvec[1], tvec[2],
            rvec[0], rvec[1], rvec[2]
        ], dtype=np.float32)
        
        # First predict to update state transition
        self.kalman.predict()
        
        # Then correct with measurement
        corrected_state = self.kalman.correct(measurement)
        
        pred_tvec = corrected_state[0:3]
        pred_rvec = corrected_state[3:6]
        
        return pred_tvec, pred_rvec

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
    base_models_path = os.path.abspath(cfg.detection.paths.models)
    best_model = get_latest_model(base_models_path)
    
    if not best_model or not os.path.exists(best_model):
        print("Error: Not find best.pt in the models folder.")
        return
        
    print(f"Loading model: {best_model}")
    model = YOLO(best_model)

    # Pre-load PnP Data if enabled
    points_3d = None
    intrinsic_matrix = None
    distortion_coefficients = None
    pose_history = []
    orientation_history = []

    if cfg.pnp.enabled:
        cfg.pnp.paths.points_3d = os.path.join(project_root, cfg.pnp.paths.points_3d)
        cfg.pnp.paths.intrinsic_matrix = os.path.join(project_root, cfg.pnp.paths.intrinsic_matrix)
        
        try:
            points_3d = pnp_tools.load_3d_points(cfg)
            intrinsic_matrix = pnp_tools.load_intrinsic_matrix(cfg)
            distortion_coefficients = pnp_tools.load_distortion_coefficients(cfg)
            print("PnP Data loaded successfully.")
        except Exception as e:
            print(f"Error loading PnP Data: {e}")
            cfg.pnp.enabled = False

    # Initialize MQTT
    mqtt_client = None
    if cfg.mqtt.enabled:
        mqtt_client = MqttClient(cfg.mqtt.broker, cfg.mqtt.port, cfg.mqtt.topic)
        print(f"MQTT client connected to {cfg.mqtt.broker}:{cfg.mqtt.port} on topic {cfg.mqtt.topic}")

    source = cfg.detection.source
    if isinstance(source, int):
        print(f"Starting real-time detection (Camera {source})...")
    else:
        print(f"Starting detection in: {source}")

    results = model.track(
        source=source,
        conf=cfg.detection.conf,
        iou=cfg.detection.iou,
        show=False, 
        save=cfg.detection.save,
        project=os.path.abspath(cfg.detection.paths.output),
        name="pred_filtered", # Changed name
        stream=True,
        persist=True,   
        boxes=cfg.detection.boxes,
    )
    
    frame_indx = 0
    video_writer = None
    
    # Kalman Filters dictionary: {track_id: PoseKalmanFilter}
    kalman_filters = {} 

    for i in results:
        annotated_frame = i.plot()
        frame_h, frame_w = annotated_frame.shape[:2]

        # Automatic Intrinsic Scaling
        current_intrinsic = np.array(intrinsic_matrix, dtype=np.float32)
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
            names = i.names
            
            obj_ids = i.boxes.id.cpu().numpy().astype(int) if i.boxes.id is not None else range(len(kpts))
            for idx, obj_idx in enumerate(range(len(kpts))):
                class_name = names[int(classes[obj_idx])]
                track_id = int(obj_ids[idx])
                
                # Initialize Kalman filter for this object if not exists
                if track_id not in kalman_filters:
                    kalman_filters[track_id] = PoseKalmanFilter(fps=30) # Assuming 30fps

                pnp_points = {}
                rvec, tvec = None, None
                obj_payload = {
                    "frame": frame_indx,
                    "obj_id": track_id,
                    "class": class_name,
                    "points": pnp_points
                }
                
                for kp_idx, (x, y) in enumerate(kpts[obj_idx]):
                    if x > 0 and y > 0:
                        conf = float(i.keypoints.conf[obj_idx][kp_idx])
                        kp_name = KEYPOINT_ORDER[kp_idx] if kp_idx < len(KEYPOINT_ORDER) else f"kp_{kp_idx}"
                        pnp_points[kp_name] = {
                            "x": float(x),
                            "y": float(y),
                            "confidence": round(conf, 4),
                            "id": kp_idx
                        }
                        label = f"ID:{track_id} P:{kp_idx}"
                        # Optional: Draw text
                        # cv2.putText(annotated_frame, label, (int(x), int(y) - 7), 
                        #             cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 0), 1)

                if cfg.pnp.enabled and points_3d is not None:
                    p3d, p2d, names_used = pnp_tools.match_points(cfg, points_3d, pnp_points)
                    
                    if len(p3d) >= 4:
                        raw_rvec, raw_tvec = pnp_tools.pnp_solver(cfg, p3d, p2d, current_intrinsic, distortion_coefficients)
                        
                        if raw_rvec is not None:
                            # -------- APPLY KALMAN FILTER --------
                            kf = kalman_filters[track_id]
                            rvec, tvec = kf.update(raw_tvec, raw_rvec) # Note: update takes (tvec, rvec)
                            
                            # Use filtered values for payload and visualization
                            pose_data = {
                                "rvec": rvec.flatten().tolist(),
                                "tvec": tvec.flatten().tolist(),
                                "points_used": names_used,
                                "is_filtered": True
                            }
                            obj_payload["pose"] = pose_data
                            pose_history.append({
                                "frame": frame_indx,
                                "obj_id": track_id,
                                "pose": pose_data
                            })
                            
                            dist = np.linalg.norm(tvec)
                            cv2.putText(annotated_frame, f"Dist (KF): {dist:.2f}", (int(p2d[0][0]), int(p2d[0][1]) - 40), 
                                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 2)
                        
                if cfg.orientation.enabled and cfg.pnp.enabled and rvec is not None:
                    # Use filtered rvec/tvec here
                    R = orientation_tools.rodriguez_exponential(rvec)
                    phi, theta_y, psi = orientation_tools.euler_angles(R)
                    global_distance, x_distance, y_distance, z_distance = orientation_tools.distance(cfg, tvec, R)
                    
                    if all(v is not None for v in (phi, theta_y, psi)):
                        orientation_data = {
                            "Pitch": float(theta_y),
                            "Yaw": float(phi),
                            "Roll": float(psi),
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
                            "obj_id": track_id,
                            "orientation": orientation_data
                        })

                if 'all_detections' not in locals():
                    all_detections = []
                all_detections.append(obj_payload)

                if mqtt_client:
                    mqtt_client.publish(obj_payload)

        if cfg.detection.save:
            if video_writer is None:
                os.makedirs(i.save_dir, exist_ok=True)
                save_path = os.path.join(i.save_dir, "video_filtered.mp4")
                h, w = annotated_frame.shape[:2]
                fps = 30 
                video_writer = cv2.VideoWriter(save_path, cv2.VideoWriter_fourcc(*'mp4v'), fps, (w, h))
                print(f"Saving filtered video in: {save_path}")
            video_writer.write(annotated_frame)

        if cfg.detection.show:
            cv2.imshow("YOLOv8 Pose Tracking - Kalman Filtered", annotated_frame)
            if cv2.waitKey(1) & 0xFF == ord('q'):
                break
        
        frame_indx += 1

    if video_writer:
        video_writer.release()
        print("Video saved successfully.")

    if mqtt_client:
        mqtt_client.disconnect()
        print("MQTT client disconnected.")

    cv2.destroyAllWindows()
 
if __name__ == "__main__":
    main()
