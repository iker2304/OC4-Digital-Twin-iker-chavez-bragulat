import bpy
import json
import os
import sys
import glob
from pathlib import Path
from mathutils import Vector, Matrix, Euler

# Add src to sys.path
src_path = str(Path(__file__).resolve().parent)
if src_path not in sys.path:
    sys.path.append(src_path)

from annotation.yolo_pose_annotation import create_yolo_pose_annotation
from omegaconf import OmegaConf

def load_config(project_root):
    config_path = project_root / "src" / "config" / "annotation.yaml"
    if config_path.exists():
        return OmegaConf.load(config_path)
    return None

def main():
    # 0. Setup Paths
    # robustly find project root
    script_path = Path(__file__).resolve()
    # src/regenerate_labels.py -> src -> project_root
    project_root = script_path.parent.parent
    
    cfg = load_config(project_root)
    
    pose_root = project_root / "data" / "synthetic_dataset" / "pose"
    gt_path = pose_root / "ground_truth"
    labels_path = pose_root / "labels"
    
    print(f"Project root: {project_root}")
    print(f"Ground truth path: {gt_path}")
    
    # Config (Manual or from a file, matching generation)
    # We assume 'config/main.yaml' settings for FBX path
    # But simpler: look for the FBX in known location
    blend_path = project_root / "data/models/blender/OC4.blend"
    
    if not gt_path.exists():
        print(f"Error: Ground truth path not found: {gt_path}")
        # list parent dir
        if pose_root.exists():
             print(f"Contents of {pose_root}: {[p.name for p in pose_root.iterdir()]}")
        else:
             print(f"Pose root {pose_root} does not exist.")
        return

    # 2. Load Blend File
    if not blend_path.exists():
        print(f"Error: Blend file not found at {blend_path}")
        return
        
    bpy.ops.wm.open_mainfile(filepath=str(blend_path))
    print(f"Opened Blend file: {blend_path}")
    
    # 1. Setup Scene (AFTER loading blend)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES' 
    
    # Ensure all objects are visible
    for obj in bpy.data.objects:
        obj.hide_viewport = False
        obj.hide_render = False

    # 3. Iterate Ground Truth Files
    json_files = sorted(list(gt_path.glob("*.json")))
    print(f"Found {len(json_files)} ground truth files.")
    
    processed_count = 0
    
    for json_file in json_files:
        try:
            with open(json_file, 'r') as f:
                gt_data = json.load(f)
            
            # 3.1 Setup Camera
            cam_data = gt_data['camera']
            
            # Find or create camera
            camera = bpy.data.objects.get(cam_data['name'])
            if not camera:
                # If name mismatch, check if ANY camera exists, else create
                cams = [o for o in bpy.data.objects if o.type == 'CAMERA']
                if cams:
                    camera = cams[0]
                else:
                    c_data = bpy.data.cameras.new("Camera")
                    camera = bpy.data.objects.new("Camera", c_data)
                    scene.collection.objects.link(camera)
            
            # Restore Camera Transform
            camera.location = Vector(cam_data['location'])
            camera.rotation_euler = Euler(cam_data['rotation_euler'])
            
            # Restore Camera Intrinsics
            camera.data.lens = cam_data['focal_length_mm']
            camera.data.sensor_width = cam_data['sensor_width_mm']
            camera.data.shift_x = cam_data.get('shift_x', 0.0)
            camera.data.shift_y = cam_data.get('shift_y', 0.0)
            
            # Set Resolution
            res_data = cam_data['resolution']
            scene.render.resolution_x = res_data['width']
            scene.render.resolution_y = res_data['height']
            scene.render.resolution_percentage = res_data['percentage']
            
            # Restore Pixel Aspect Ratio (Critical for correct projection)
            scene.render.pixel_aspect_x = cam_data.get('pixel_aspect_x', 1.0)
            scene.render.pixel_aspect_y = cam_data.get('pixel_aspect_y', 1.0)
            
            # 3.2 Restore Object Transforms
            annotated_objects = []
            
            for obj_data in gt_data.get('objects', []):
                obj_name = obj_data['name']
                blender_obj = bpy.data.objects.get(obj_name)
                
                if blender_obj:
                    # Apply transform
                    blender_obj.location = Vector(obj_data['location_world'])
                    blender_obj.rotation_euler = Euler(obj_data['rotation_euler'])
                    blender_obj.scale = Vector(obj_data['scale'])
                    
                    # Add to list for annotation
                    class_name = obj_data['class_name']
                    annotated_objects.append((blender_obj, class_name))
                else:
                    pass
            
            # Verify we have scene update so parented objects (like keypoints) follow their parents
            bpy.context.view_layer.update()
            
            # Re-discover keypoints that might not have been saved in GT (like EMPTY VIS_ objects)
            # Find global max keypoints from config to know what to look for
            keypoint_names = []
            class_names = []
            if hasattr(cfg, 'pose') and hasattr(cfg.pose, 'classes'):
                for cls in cfg.pose.classes:
                    if hasattr(cls, 'keypoints'):
                        keypoint_names.extend(list(cls.keypoints))
                    if hasattr(cls, 'name'):
                        class_names.append(cls.name)
            
            # Add any missing keypoint objects to annotated_objects
            existing_objs = {obj.name for obj, _ in annotated_objects}
            for obj in bpy.data.objects:
                if obj.name in existing_objs:
                    continue
                
                raw_name = obj.name
                parent_name = obj.parent.name if obj.parent else ""
                search_str = f"{parent_name}_{raw_name}" if parent_name else raw_name
                search_str_low = search_str.lower()
                
                best_match = None
                for kp in keypoint_names:
                    if kp.lower() in search_str_low:
                        if best_match is None or len(kp) > len(best_match):
                            best_match = kp
                            
                if best_match:
                    annotated_objects.append((obj, best_match))
            
            # 3.3 Re-generate Label
            
            file_stem = json_file.stem
            label_output = labels_path / f"{file_stem}.txt"
            
            create_yolo_pose_annotation(
                scene,
                camera,
                label_output,
                annotated_objects,
                cfg=cfg
            )
            
            processed_count += 1
            if processed_count % 100 == 0:
                print(f"Processed {processed_count}/{len(json_files)}")
                
        except Exception as e:
            print(f"Error processing {json_file.name}: {e}")
            continue

    print(f"Finished regenerating labels for {processed_count} files.")

if __name__ == "__main__":
    main()
