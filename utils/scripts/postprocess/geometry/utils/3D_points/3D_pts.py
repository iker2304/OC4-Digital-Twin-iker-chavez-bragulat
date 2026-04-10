import bpy
import json
from mathutils import Vector
from pathlib import Path

def get_bbox_center(obj):
    """Calculates the center of the bounding box in world coordinates."""
    bbox_coords = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    return sum(bbox_coords, Vector()) / 8.0

def extract_keypoints_coordinates(keypoints_file: str, output_file: str):
    """Extracts world coordinates of vertices specified in keypoints.json."""
    if not Path(keypoints_file).exists():
        print(f"Error: Keypoints file '{keypoints_file}' not found.")
        return

    with open(keypoints_file, 'r') as f:
        kp_data = json.load(f)
    
    data_points = {}
    for kp in kp_data.get("keypoints", []):
        name = kp["name"]
        obj_name = kp["object_name"]
        v_idx = kp["vertex_index"]
        
        obj = bpy.data.objects.get(obj_name)
        if obj and obj.type == 'MESH':
            if v_idx < len(obj.data.vertices):
                v = obj.data.vertices[v_idx]
                world_pos = obj.matrix_world @ v.co
                
                # Using Blender's world coordinates (X, Y, Z)
                data_points[name] = {
                    "x": round(float(world_pos.x), 3),
                    "y": round(float(world_pos.y), 3),
                    "z": round(float(world_pos.z), 3)
                }
                print(f"Mapped (Keypoint): {name}")
            else:
                print(f"Warning: vertex index {v_idx} out of range for object {obj_name}")
        else:
            print(f"Warning: object {obj_name} not found or not a mesh")

    output_path = Path(output_file)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    with open(output_path, 'w') as f:
        json.dump(data_points, f, indent=4)
    
    print(f"\nSuccessfully saved {len(data_points)} keypoints to {output_path}")

def extract_3d_coordinates(parent_name: str, output_file: str):
    parent = bpy.data.objects.get(parent_name)
    if not parent:
        print(f"Error: Parent object '{parent_name}' not found.")
        return

    # EXACT order and naming from generate_dataset_pose.py
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

    world_to_parent = parent.matrix_world.inverted()
    data_points = {}
    
    component_centers = {name: [] for name in KEYPOINT_ORDER}

    def match_logic(obj):
        """Matches an object to a keypoint name following the dataset labeling logic."""
        raw_name = obj.name
        p_name = obj.parent.name if obj.parent else ""
        
        best_match = None
        for key in KEYPOINT_ORDER:

            if key in raw_name or (p_name and key in p_name):
                if not best_match or len(key) > len(best_match):
                    best_match = key
        return best_match

    def recurse(obj):
        if obj.type == 'MESH':
            matched_key = match_logic(obj)
            if matched_key:
                center_world = get_bbox_center(obj)
                component_centers[matched_key].append(center_world)

        for child in obj.children:
            recurse(child)

    def collect_all_scene_meshes():
        for obj in bpy.data.objects:
            if obj.type == 'MESH':

                is_child_of_parent = False
                current_obj = obj
                while current_obj.parent:
                    if current_obj.parent == parent:
                        is_child_of_parent = True
                        break
                    current_obj = current_obj.parent
                
                if not is_child_of_parent:
                    matched_key = match_logic(obj)
                    if matched_key:
                        if matched_key in ["Hub", "Blade_1", "Blade_2", "Blade_3"]:
                            center_world = get_bbox_center(obj)
                            component_centers[matched_key].append(center_world)

    recurse(parent)
    
    collect_all_scene_meshes()

    for name in KEYPOINT_ORDER:
        centers = component_centers[name]
        if not centers:
            continue
            
        avg_world = sum(centers, Vector()) / len(centers)
        model_space_center = world_to_parent @ avg_world
        
        data_points[name] = {
            "x": round(float(-model_space_center.x), 3),
            "y": round(float(-model_space_center.z), 3), 
            "z": round(float(-model_space_center.y), 3)
        }
        print(f"Mapped: {name}")

    output_path = Path(output_file)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    with open(output_path, 'w') as f:
        json.dump(data_points, f, indent=4)
    
    print(f"\nSuccessfully saved {len(data_points)} labels to {output_path}")

def simple_yaml_load(filepath):
    """A very basic YAML parser for simple key-value configs."""
    config = {}
    current_key = None
    if not Path(filepath).exists():
        return config
        
    with open(filepath, 'r') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            
            if ':' in line:
                key, val = line.split(':', 1)
                key = key.strip()
                val = val.strip()
                
                if not val: 
                    current_key = key
                    config[current_key] = {}
                else:   
                    if val.lower() == 'true': val = True
                    elif val.lower() == 'false': val = False
                    elif (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                        val = val[1:-1]
                    
                    if current_key:
                        config[current_key][key] = val
                    else:
                        config[key] = val
    return config

if __name__ == "__main__":
    # Config and keypoints paths relative to project root
    CONFIG_PATH = "utils/scripts/postprocess/geometry/utils/3D_points/config/3D_points.yaml"
    KEYPOINTS_FILE = "data/models/blender/config/keypoints.json"
    TARGET_PARENT = "assembly v5"
    
    # Defaults
    point_and_click = False
    output_file = "utils/scripts/postprocess/geometry/utils/3D_points/3D_points.json"
    
    # Load configuration
    config_abs_path = Path(CONFIG_PATH)
    if config_abs_path.exists():
        try:
            config_data = simple_yaml_load(config_abs_path)
            point_and_click = config_data.get('config', {}).get('point_and_click', False)
            output_file = config_data.get('paths', {}).get('output', output_file)
        except Exception as exc:
            print(f"Error parsing config: {exc}")
    
    if point_and_click:
        print(f"Mode: point_and_click enabled. Using {KEYPOINTS_FILE}...")
        extract_keypoints_coordinates(KEYPOINTS_FILE, output_file)
    else:
        print("Mode: point_and_click disabled. Using bounding box centers...")
        extract_3d_coordinates(TARGET_PARENT, output_file)
