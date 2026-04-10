import bpy
import os
import json
from pathlib import Path
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view
from omegaconf import DictConfig

def create_yolo_pose_annotation(scene, camera, output_path, annotated_objects, keypoint_order, cfg: DictConfig = None):
    """
    Creates a YOLO pose annotation file with configurable keypoint methods.
    
    Args:
        scene: Blender scene
        camera: Camera object
        output_path: Path to save the .txt file
        annotated_objects: List of (object, class_name) tuples
        keypoint_order: List of class_names representing the ordered keypoints
        cfg: Configuration object (OmegaConf) containing annotation settings
    """
    
    # Defaults
    method = "center_of_mass"
    json_path = None
    
    if cfg and hasattr(cfg.randomization, "annotation"):
        method = cfg.randomization.annotation.method
        json_path = cfg.randomization.annotation.json_path

    # Load JSON if needed
    keypoint_data_map = {} # Map (object_name, keypoint_name) -> data
    if method == "json_coords" and json_path:
        if not os.path.isabs(json_path):
             json_path = os.path.abspath(json_path)
             
        if os.path.exists(json_path):
            with open(json_path, 'r') as f:
                try:
                    data = json.load(f)
                    if "keypoints" in data:
                        for item in data["keypoints"]:
                            obj_name = item.get("object_name", "").lower()
                            kpt_name = item.get("name", "").lower()
                            keypoint_data_map[(obj_name, kpt_name)] = item
                except Exception as e:
                    print(f"[ERROR] Failed to load keypoints JSON: {e}")
        else:
            print(f"[WARNING] Keypoints JSON not found at: {json_path}")
    
    min_x, min_y = 1.0, 1.0
    max_x, max_y = 0.0, 0.0
    
    keypoints = {name: None for name in keypoint_order}
    found_any = False
    
    for obj, class_name in annotated_objects:
        # --- Bounding Box Calculation ---
        for corner in obj.bound_box:
            world_corner = obj.matrix_world @ Vector(corner)
            co_2d = world_to_camera_view(scene, camera, world_corner)
            
            x = co_2d.x
            y = 1.0 - co_2d.y 
            
            min_x = min(min_x, x)
            min_y = min(min_y, y)
            max_x = max(max_x, x)
            max_y = max(max_y, y)
            found_any = True

        # --- Keypoint Location Calculation ---  
        # Identify which keypoint this object represents
        matched_kpt = None
        if class_name in keypoints:
            matched_kpt = class_name
        else:
            possible_matches = []
            for kpt_name in keypoint_order:
                if kpt_name.lower() in obj.name.lower():
                    possible_matches.append(kpt_name)
            if possible_matches:
                possible_matches.sort(key=len, reverse=True)
                matched_kpt = possible_matches[0]
        
        target_world_pos = None
        method_used = "Center of Mass (BBox)"

        if method == "json_coords" and matched_kpt:
             item = None
             
             # 1. Exact Match: JSON 'name' matches YOLO class name
             for (json_obj, json_name), data in keypoint_data_map.items():
                 if json_name == matched_kpt.lower():
                     item = data
                     # If object name also matches, definitely the right one
                     if json_obj == obj.name.lower():
                         break
             
             # 2. Object Match: JSON 'object_name' matches YOLO class OR Blender object name
             if not item:
                 for (json_obj, json_name), data in keypoint_data_map.items():
                     if json_obj == matched_kpt.lower() or json_obj == obj.name.lower():
                         item = data
                         # If there's "center" in the name, prioritize it
                         if "center" in json_name:
                             break

             if item:
                 if item.get("type") == "center":
                     # Explicitly requested center of mass for this specific keypoint
                     bbox_coords = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
                     target_world_pos = sum(bbox_coords, Vector()) / 8.0
                     method_used = f"JSON Center of Mass ('{item.get('name')}')"
                 
                 elif "vertex_index" in item and item["vertex_index"] >= 0:
                     v_idx = item["vertex_index"]
                     if v_idx < len(obj.data.vertices):
                        target_world_pos = obj.matrix_world @ obj.data.vertices[v_idx].co
                        method_used = f"JSON Vertex {v_idx} ('{item.get('name')}')"
                     else:
                        print(f"  [WARN] Vertex index {v_idx} out of range for {obj.name}")

                 elif "coordinates" in item:
                     local_pos = Vector(item["coordinates"])
                     target_world_pos = obj.matrix_world @ local_pos
                     method_used = f"JSON Local Coords {item['coordinates']} ('{item.get('name')}')"
             else:
                  # Log if we expected to find it in JSON but didn't
                  print(f"  [INFO] No JSON entry for keypoint '{matched_kpt}' (Obj: '{obj.name}'). Falling back to BBox center.")
        
        # Default / Fallback: Center of Mass (Bounding Box Center)
        if target_world_pos is None:
             bbox_coords = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
             target_world_pos = sum(bbox_coords, Vector()) / 8.0
        
        # Project to 2D
        co_2d = world_to_camera_view(scene, camera, target_world_pos)
        kx = co_2d.x
        ky = 1.0 - co_2d.y
        
        # Visibility
        vis = 2 if (0 <= kx <= 1 and 0 <= ky <= 1) else 0 
        
        if matched_kpt:
            # Clamp keypoints to [0, 1]
            kx = min(1.0, max(0.0, kx))
            ky = min(1.0, max(0.0, ky))
            keypoints[matched_kpt] = (kx, ky, vis, method_used)

    if not found_any:
        return 

    # Sanitize BBox
    min_x = min(1.0, max(0.0, min_x))
    min_y = min(1.0, max(0.0, min_y))
    max_x = min(1.0, max(0.0, max_x))
    max_y = min(1.0, max(0.0, max_y))
    
    if max_x <= min_x or max_y <= min_y:
        return

    # YOLO format center_x, center_y, w, h
    bbox_w = max_x - min_x
    bbox_h = max_y - min_y
    center_x = min_x + bbox_w / 2
    center_y = min_y + bbox_h / 2
    
    if bbox_w <= 0 or bbox_h <= 0:
        return

    # Construct Keypoint string
    kpt_str_parts = []
    print(f"[DEBUG] Generating annotation line (Method: {method})...")
    
    for i, kpt_name in enumerate(keypoint_order):
        data = keypoints.get(kpt_name)
        if data:
            # data is (kx, ky, vis, method_used)
            kpt_str_parts.append(f"{data[0]:.6f} {data[1]:.6f} {data[2]}")
            method_desc = data[3]
            if data[2] == 0:
                print(f"  - Point {i} ({kpt_name}): Outside frame (0) | Method: {method_desc}")
            else:
                print(f"  - Point {i} ({kpt_name}): Visible at ({data[0]:.2f}, {data[1]:.2f}) | Method: {method_desc}")
        else:
            kpt_str_parts.append("0.000000 0.000000 0")
            print(f"  - Point {i} ({kpt_name}): NOT FOUND IN SCENE")

    # Class 0 for "Turbine"
    line = f"0 {center_x:.6f} {center_y:.6f} {bbox_w:.6f} {bbox_h:.6f} " + " ".join(kpt_str_parts)
    
    with open(output_path, 'w') as f:
        f.write(line + "\n")