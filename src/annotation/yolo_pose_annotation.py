import bpy
import os
import json
from pathlib import Path
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view
from omegaconf import DictConfig

def create_yolo_pose_annotation(scene, camera, output_path, annotated_objects, keypoint_order=None, cfg: DictConfig = None):
    """
    Creates a YOLO pose annotation file supporting multiple classes and instances.
    Each class can have a different number of keypoints, padded to the global maximum.
    
    Args:
        scene: Blender scene
        camera: Camera object
        output_path: Path to save the .txt file
        annotated_objects: List of (object, class_name) tuples
        keypoint_order: (Legacy) Not used if cfg.pose.classes is present
        cfg: Configuration object (OmegaConf) containing 'pose.classes'
    """
    
    # 1. Load Classes and Keypoint Config
    classes_cfg = []
    if cfg and hasattr(cfg.pose, "classes"):
        classes_cfg = cfg.pose.classes
    
    if not classes_cfg:
        # Fallback to legacy single-class mode if no classes defined in config
        classes_cfg = [{
            "name": "Turbine",
            "id": 0,
            "keypoints": keypoint_order or []
        }]

    # Find global max keypoints for padding
    max_kpts = max([len(c["keypoints"]) for c in classes_cfg])
    class_map = {c["name"]: c for c in classes_cfg}
    
    # Map keypoints to their respective classes
    kp_to_class = {}
    for c_name, c_info in class_map.items():
        for kp in c_info["keypoints"]:
            kp_to_class[kp] = c_name

    # 2. Group Objects into Instances

    instances = {} # Map (class_name, suffix) -> { "root": obj, "class": class_info, "keypoints": { name: obj } }

    for obj, class_name in annotated_objects:
        # Strip 'VIS_' prefix if it exists to match the config
        clean_class_name = class_name
        if clean_class_name.startswith("VIS_"):
            clean_class_name = clean_class_name[4:]
            
        # Get suffix (e.g., "Turbine.001" -> ".001", "Turbine" -> "")
        # Because keypoints and objects might have slightly different suffixes in Blender,
        # we will group EVERYTHING into a single instance per class (suffix = "") 
        # unless there are explicitly multiple entire turbines in the scene.
        # For this specific Digital Twin, we only have 1 instance of WindTurbine and 1 Rotor.
        suffix = "" 
        
        target_class = None
        is_root = False
        
        # Only assign an object as a 'root' if it perfectly matches a class name
        # AND it is NOT a keypoint.
        # Keypoints are mapped first to prevent them from being mistaken as root objects.
        if clean_class_name in kp_to_class:
            target_class = kp_to_class[clean_class_name]
            is_root = False
        elif clean_class_name in class_map:
            target_class = clean_class_name
            is_root = True
        
        if not target_class:
            continue # Unknown object, not a root and not a recognized keypoint

        instance_key = (target_class, suffix)
        if instance_key not in instances:
            instances[instance_key] = {"root": None, "class": class_map[target_class], "keypoints": {}}

        if is_root:
            # Only set the root if one isn't already set to avoid duplication
            if instances[instance_key]["root"] is None:
                instances[instance_key]["root"] = obj
        else:
            instances[instance_key]["keypoints"][clean_class_name] = obj

    # 3. Process each Instance
    lines = []
    for (target_class, suffix), data in instances.items():
        root_obj = data["root"]
        class_info = data["class"]
            
        # --- Bounding Box Calculation (for this instance) ---
       
        min_x, min_y = 1.0, 1.0
        max_x, max_y = 0.0, 0.0
        found_any = False
        
        relevant_objs = list(data["keypoints"].values())
        
        # Build a list of objects whose bounding boxes should be considered
        meshes_to_bound = []
        
        # 0. Helper function to recursively add children meshes
        def add_meshes_recursive(obj):
            if obj.type == 'MESH' and obj not in meshes_to_bound:
                meshes_to_bound.append(obj)
            for child in obj.children:
                add_meshes_recursive(child)
                
        # 1. If we have a root object (e.g. WindTurbine or Rotor), include it and ALL its children
        if root_obj:
            add_meshes_recursive(root_obj)
            
        for obj in relevant_objs:
            # 2. Always include the keypoint itself
            if obj not in meshes_to_bound:
                meshes_to_bound.append(obj)
            
            # 3. Include the parent if it is a MESH
            if obj.parent and obj.parent.type == 'MESH' and obj.parent not in meshes_to_bound:
                meshes_to_bound.append(obj.parent)
                
            # 4. If there is a mesh with the same name minus 'VIS_', include it and its children
            clean_name = obj.name[4:] if obj.name.startswith("VIS_") else obj.name
            if clean_name in bpy.data.objects:
                assoc_obj = bpy.data.objects[clean_name]
                add_meshes_recursive(assoc_obj)
            
        depsgraph = bpy.context.evaluated_depsgraph_get()
        cam_eval = camera.evaluated_get(depsgraph)
        for obj in meshes_to_bound:
            obj_eval = obj.evaluated_get(depsgraph)
            matrix_world = obj_eval.matrix_world
            for corner in obj_eval.bound_box:
                world_corner = matrix_world @ Vector(corner)
                co_2d = world_to_camera_view(scene, cam_eval, world_corner)
                x, y = co_2d.x, 1.0 - co_2d.y 
                min_x, min_y = min(min_x, x), min(min_y, y)
                max_x, max_y = max(max_x, x), max(max_y, y)
                found_any = True
        
        if not found_any: continue

        # Sanitize BBox
        min_x, min_y = max(0.0, min_x), max(0.0, min_y)
        max_x, max_y = min(1.0, max_x), min(1.0, max_y)
        bbox_w, bbox_h = max_x - min_x, max_y - min_y
        if bbox_w <= 0 or bbox_h <= 0: continue
        center_x, center_y = min_x + bbox_w / 2, min_y + bbox_h / 2

        # --- Keypoint Calculation ---
        kpt_str_parts = []
        this_class_kpts = class_info["keypoints"]
        
        depsgraph = bpy.context.evaluated_depsgraph_get()
        cam_eval = camera.evaluated_get(depsgraph)
        
        for i in range(max_kpts):
            if i < len(this_class_kpts):
                kpt_name = this_class_kpts[i]
                kp_obj = data["keypoints"].get(kpt_name)
                
                if kp_obj:
                    # Use evaluated object to get current matrix_world
                    kp_eval = kp_obj.evaluated_get(depsgraph)
                    matrix_world = kp_eval.matrix_world
                    
                    # For MESH objects, use center of mass/bbox. For EMPTY, use origin.
                    if kp_eval.type == 'MESH' and len(kp_eval.bound_box) > 0:
                        bbox_coords = [matrix_world @ Vector(corner) for corner in kp_eval.bound_box]
                        target_world_pos = sum(bbox_coords, Vector()) / 8.0
                    else:
                        # Use origin for Empties or meshes without bbox
                        target_world_pos = matrix_world.to_translation()
                    
                    co_2d = world_to_camera_view(scene, cam_eval, target_world_pos)
                    kx, ky = co_2d.x, 1.0 - co_2d.y
                    
                    # Debug print for keypoint position (only for the first few renders)
                    # print(f"  [DEBUG] KP {kpt_name}: World {target_world_pos}, Image ({kx:.3f}, {ky:.3f})")
                    
                    vis = 2 if (0 <= kx <= 1 and 0 <= ky <= 1) else 0
                    kx, ky = min(1.0, max(0.0, kx)), min(1.0, max(0.0, ky))
                    kpt_str_parts.append(f"{kx:.6f} {ky:.6f} {vis}")
                else:
                    # Keypoint missing in scene for this instance
                    kpt_str_parts.append("0.000000 0.000000 0")
            else:
                # Padding for classes with fewer keypoints
                kpt_str_parts.append("0.000000 0.000000 0")
        # Create line: class_id x_c y_c w h k1_x k1_y k1_v ...
        # Add a small padding (5%) to the Bounding Box so it completely encompasses the keypoints
        padding_factor = 0.05
        bbox_w_padded = bbox_w * (1 + padding_factor)
        bbox_h_padded = bbox_h * (1 + padding_factor)
        
        # Ensure padded bbox doesn't go outside image boundaries (0-1)
        # But center stays the same
        
        line = f"{class_info['id']} {center_x:.6f} {center_y:.6f} {bbox_w_padded:.6f} {bbox_h_padded:.6f} " + " ".join(kpt_str_parts)
        lines.append(line)

    # 4. Save to file
    if lines:
        with open(output_path, 'w') as f:
            f.write("\n".join(lines) + "\n")
        print(f"[INFO] Saved {len(lines)} objects to {output_path}")
    else:
        print(f"[WARN] No objects found for annotation in {output_path}")
