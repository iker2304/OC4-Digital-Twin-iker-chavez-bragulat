import os
import sys
import site
from pathlib import Path
import subprocess
import importlib.util
import bpy
import math
import random
import json
 
user_site = site.getusersitepackages()
if user_site not in sys.path:
    sys.path.append(user_site)
potential_user_site = os.path.expandvars(r'%APPDATA%\Python\Python311\site-packages')
if os.path.exists(potential_user_site) and potential_user_site not in sys.path:
    sys.path.append(potential_user_site)

def install_requirements():
    project_root = Path(__file__).resolve().parent.parent
    requirements_file = project_root / "requirements.txt"
    if not requirements_file.exists():
        return
    IMPORT_NAMES = {
        "hydra-core": "hydra",
        "opencv-python": "cv2",
        "scikit-learn": "sklearn",
        "pyyaml": "yaml"
    }
    try:
        with open(requirements_file, 'r') as f:
            requirements = [line.strip() for line in f if line.strip() and not line.startswith('#')]
    except:
        return
    python_exe = sys.executable
    for req in requirements:
        pkg_install_name = req.split("==")[0].split(">=")[0].split("<")[0]
        if pkg_install_name.lower() in ['bpy', 'mathutils']:
            continue
        pkg_import_name = IMPORT_NAMES.get(pkg_install_name.lower(), pkg_install_name.replace("-", "_"))
        spec = importlib.util.find_spec(pkg_import_name)
        if spec is None:
            try:
                subprocess.run([python_exe, '-m', 'pip', 'install', '--user', req], check=True)
            except subprocess.CalledProcessError:
                pass

install_requirements()

src_path = str(Path(__file__).resolve().parent)
if src_path not in sys.path:
    sys.path.append(src_path)

import hydra
from omegaconf import DictConfig
from randomization.scene_randomizer import (
    camera_dof_randomization,
    lights_position_randomization,
    light_randomization,
    randomize_background,
    intrinsic_matrix_randomization,
    compositor_randomization
)
from randomization.material_randomizer import set_random_material_color, apply_surface_defects
from randomization.position_randomizer import hub_rotation_randomization
from annotation.ground_truth import save_ground_truth
from annotation.yolo_pose_annotation import create_yolo_pose_annotation

CLASS_MAPPING = {
    "Blade": 0, "Hub": 1, "Pilar_base": 2, "Pilar_base_top": 2,
    "Pilar_mid": 3, "Pilar_mid_b": 3, "Pilar_mid_t": 4,
    "Pontoon_top": 5, "pontoon_top": 5, "Tapa_inf_gondola": 6, "Tapa_sup_gondola": 7,
    "Tubo_184mm": 8, "Tubo_230mm": 9, "Tubo_309mm": 10,
    "Tubo_353mm": 11, "Tubo_444mm": 12, "pontoon_base": 13
}

@hydra.main(config_path="config", config_name="main", version_base=None)
def main(cfg: DictConfig) -> None:
    num_renders = cfg.blender.config.num_renders
    project_root = Path(__file__).resolve().parent.parent
    output_base = project_root / "data/synthetic_dataset/pose"
    images_path = output_base / "images"
    labels_path = output_base / "labels"
    gt_path = output_base / "ground_truth"
    images_path.mkdir(parents=True, exist_ok=True)
    labels_path.mkdir(parents=True, exist_ok=True)
    gt_path.mkdir(parents=True, exist_ok=True)
    print(f"[POSE] Output images: {images_path}")
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.render.resolution_x = cfg.blender.config.resolution_x
    scene.render.resolution_y = cfg.blender.config.resolution_y
    scene.render.image_settings.file_format = 'PNG'
    # --- GPU Setup ---
    try:
        preferences = bpy.context.preferences
        cycles_prefs = preferences.addons['cycles'].preferences
        
        cycles_prefs.get_devices()
        device_types = [d.type for d in cycles_prefs.devices]
        
        if 'OPTIX' in device_types:
            cycles_prefs.compute_device_type = 'OPTIX'
        elif 'CUDA' in device_types:
            cycles_prefs.compute_device_type = 'CUDA'
        else:
            cycles_prefs.compute_device_type = 'NONE'

        # Enable all GPU devices
        found_gpu = False
        for device in cycles_prefs.devices:
            if device.type in {'OPTIX', 'CUDA'}:
                device.use = True
                found_gpu = True
                print(f"[POSE] Enabled GPU: {device.name} ({device.type})")
            else:
                device.use = False # Disable CPU for rendering if GPU found
        
        if found_gpu:
            scene.cycles.device = 'GPU'
            print(f"[POSE] Cycles set to GPU (using {cycles_prefs.compute_device_type})")
        else:
            scene.cycles.device = 'CPU'
            print("[POSE] No GPU found or enabled. Using CPU.")

    except Exception as e:
        print(f"[POSE] Error configuring GPU: {e}. Defaulting to CPU.")
        scene.cycles.device = 'CPU'
    

    blend_path_cfg = cfg.blender.scene.object.get("blend_path", "")
    blend_path = project_root / blend_path_cfg if blend_path_cfg else None
    target_obj_name = cfg.blender.scene.object.load
    use_blend = False
    if blend_path and blend_path.exists():
        try:
            bpy.ops.wm.open_mainfile(filepath=str(blend_path))
            print(f"[POSE] Opened BLEND: {blend_path}")
            use_blend = True
        except Exception:
            print(f"[POSE] Failed to open BLEND: {blend_path}")
            use_blend = False
    if not use_blend:
        camera_name = cfg.blender.scene.camera.load
        bpy.ops.object.select_all(action='SELECT')
        if camera_name in bpy.data.objects:
            bpy.data.objects[camera_name].select_set(False)
        bpy.ops.object.delete()
        fbx_path = project_root / cfg.blender.scene.object.fbx_path
        bpy.ops.import_scene.fbx(filepath=str(fbx_path))
        print(f"[POSE] Imported FBX: {fbx_path}")
    for obj in bpy.data.objects:
        obj.hide_viewport = False
        obj.hide_render = False

    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.render.resolution_x = cfg.blender.config.resolution_x
    scene.render.resolution_y = cfg.blender.config.resolution_y
    scene.render.image_settings.file_format = 'PNG'

    scene.cycles.samples = 16  
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.adaptive_threshold = 0.1 
    
    scene.cycles.use_denoising = True
    scene.cycles.denoiser = 'OPTIX' 
    
    scene.cycles.max_bounces = 1 
    scene.cycles.diffuse_bounces = 1
    scene.cycles.glossy_bounces = 1
    scene.cycles.transparent_max_bounces = 2
    scene.cycles.transmission_bounces = 1
    scene.cycles.volume_bounces = 0
    
    # Efficient Raytracing Enhancements
    scene.cycles.use_fast_gi = True 
    scene.cycles.ao_bounces = 1
    scene.cycles.ao_bounces_render = 1
    scene.render.use_persistent_data = True 
    scene.render.use_persistent_data = True 
    
    try:
         scene.cycles.device = 'GPU'
         print("[POSE] Re-asserted GPU device usage.")
    except:
         pass
    camera = bpy.data.objects.get(cfg.blender.scene.camera.load)
    if camera is None:
        cams = [o for o in bpy.data.objects if o.type == 'CAMERA']
        if cams:
            camera = cams[0]
            print(f"[POSE] Using first camera found: {camera.name}")
        else:
            cam_data = bpy.data.cameras.new(cfg.blender.scene.camera.load)
            camera = bpy.data.objects.new(cfg.blender.scene.camera.load, cam_data)
            bpy.context.scene.collection.objects.link(camera)
            print(f"[POSE] Created camera: {camera.name}")
    scale_factor = cfg.blender.scene.object.get("scale", 0.004)
    target_obj = bpy.data.objects.get(target_obj_name)
    hub_obj = None
    if not use_blend and target_obj:
        target_obj.scale = (scale_factor, scale_factor, scale_factor)
        target_obj.rotation_euler = (0, 0, 0)
    hub_obj = bpy.data.objects.get(cfg.blender.scene.object.Hub) if hasattr(cfg.blender.scene.object, "Hub") else bpy.data.objects.get("Hub")
    if hub_obj:
        print(f"[POSE] Hub found: {hub_obj.name}")
    else:
        print("[POSE] Hub not found; rotation will be skipped")
    start_count = 0
    existing_files = list(images_path.glob("image_*.png"))
    if existing_files:
        indices = []
        for p in existing_files:
            try:
                idx = int(p.stem.split('_')[-1])
                indices.append(idx)
            except ValueError:
                pass
        if indices:
            start_count = max(indices) + 1
    generated_count = start_count
    attempts = 0
    max_attempts = num_renders * 5
    
    # YOLO Pose Annotation - Configuration
    print(f"[POSE] Loading keypoint configuration...")
    
    KEYPOINT_ORDER = []
    json_items = [] # Store full data for matching inside the loop
    
    # 1. Check if we should use the JSON as the source of truth for keypoint names/order
    ann_cfg = cfg.randomization.get("annotation")
    if ann_cfg and ann_cfg.get("method") == "json_coords":
        json_path = ann_cfg.get("json_path")
        if json_path:
            # Resolve absolute path
            abs_json_path = os.path.abspath(os.path.join(os.getcwd(), json_path)) if not os.path.isabs(json_path) else json_path
            if os.path.exists(abs_json_path):
                try:
                    with open(abs_json_path, 'r') as f:
                        data = json.load(f)
                        if "keypoints" in data:
                            json_items = data["keypoints"]
                            # Use the names from the JSON file in the order they appear
                            KEYPOINT_ORDER = [item["name"] for item in json_items if "name" in item]
                            print(f"[POSE] Loaded {len(KEYPOINT_ORDER)} keypoint names from source JSON: {json_path}")
                except Exception as e:
                    print(f"[POSE] Error reading keypoint names from JSON: {e}")

    # 2. Fallback to Hydra config if JSON loading failed or was not requested
    if not KEYPOINT_ORDER:
        try:
            # Standard Hydra path: cfg.annotation.pose.keypoints
            if hasattr(cfg, 'annotation') and cfg.annotation:
                ann = cfg.annotation
                if hasattr(ann, 'pose') and ann.pose:
                    if hasattr(ann.pose, 'keypoints') and ann.pose.keypoints:
                        KEYPOINT_ORDER = list(ann.pose.keypoints)
                        print(f"[POSE] Found keypoints in cfg.annotation.pose.keypoints")
            
            # Alternative
            if not KEYPOINT_ORDER and hasattr(cfg, 'pose') and cfg.pose:
                if hasattr(cfg.pose, 'keypoints') and cfg.pose.keypoints:
                    KEYPOINT_ORDER = list(cfg.pose.keypoints)
                    print(f"[POSE] Found keypoints in cfg.pose.keypoints")

            # Last fallback
            if not KEYPOINT_ORDER:
                KEYPOINT_ORDER = ["Hub", "Pilar_base", "Pilar_mid_b", "Tapa_sup_gondola"]
                print(f"[POSE] WARNING: No keypoints found in YAML. Using internal fallbacks.")
                
        except Exception as e:
            print(f"[POSE] ERROR while reading config: {e}")
            KEYPOINT_ORDER = ["Hub", "Pilar_base"]

    print(f"[POSE] ACTIVE KEYPOINTS ({len(KEYPOINT_ORDER)}):")
    for i, kp in enumerate(KEYPOINT_ORDER):
        print(f"  {i}: {kp}")

    # Generate metadata file for reference
    keypoints_info_path = labels_path / "keypoints_info.txt"
    with open(keypoints_info_path, 'w') as f:
        f.write("# Keypoint Index lookup for YOLO Pose\n")
        f.write("# This file is generated based on your src/config/annotation.yaml\n")
        for idx, name in enumerate(KEYPOINT_ORDER):
            f.write(f"{idx}: {name}\n")
    print(f"[POSE] Reference metadata saved to: {keypoints_info_path}")

    # --- Cache static data for performance ---
    all_meshes = [obj for obj in bpy.data.objects if obj.type == 'MESH']
    print(f"[POSE] Cached {len(all_meshes)} mesh objects.")

    while generated_count < num_renders and attempts < max_attempts:
        attempts += 1
        
        # Periodically purge orphans to keep memory clean
        if generated_count % 20 == 0 and generated_count > 0:
            bpy.ops.outliner.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)

        try:
            print(f"[POSE] Rendering {generated_count+1}/{num_renders}")
            camera_dof_randomization(cfg, camera)
            light_randomization(cfg, None)
            set_random_material_color(cfg, None)
            apply_surface_defects(cfg)
            randomize_background(cfg, None)
            hub_rotation_randomization(cfg, hub_obj)
            intrinsic_matrix_randomization(cfg, camera)
            compositor_randomization(cfg)
            file_name_base = f"image_{generated_count:04d}"
            file_name = f"{file_name_base}.png"
            scene.render.filepath = str(images_path / file_name)
            bpy.context.view_layer.update()
            bpy.ops.render.render(write_still=True)
            print(f"[POSE] Saved: {scene.render.filepath}")
            
            gt_file = gt_path / f"{file_name_base}.json"
            gt_annotated_objects = []

            method = cfg.randomization.annotation.get("method", "center_of_mass")
            
            def find_best_match(name, candidates):
                name_low = name.lower()
                best_match = None
                for cand in candidates:
                    cand_low = cand.lower()
                    if cand_low in name_low:
                        if best_match is None or len(cand) > len(best_match):
                            best_match = cand
                return best_match

            if method == "json_coords":
                # Use cached meshes
                for obj in all_meshes:
                    # Check against JSON object_names - an object might have MULTIPLE keypoints
                    matched_for_this_obj = []
                    for item in json_items:
                        json_obj_name = item.get("object_name", "").lower()
                        if json_obj_name == obj.name.lower():
                            matched_for_this_obj.append(item.get("name"))
                    
                    # BBox match (General classes) for fallback or non-keypoint objects
                    parent_name = obj.parent.name if obj.parent else ""
                    search_str = f"{parent_name}_{obj.name}" if parent_name else obj.name
                    matched_class = find_best_match(search_str, CLASS_MAPPING.keys())
                    
                    if matched_for_this_obj:
                        for kpt_name in matched_for_this_obj:
                            gt_annotated_objects.append((obj, kpt_name))
                    elif matched_class:
                        gt_annotated_objects.append((obj, matched_class))

            else:
                # Use cached meshes
                for obj in all_meshes:
                    raw_name = obj.name
                    parent_name = obj.parent.name if obj.parent else ""
                    search_str = f"{parent_name}_{raw_name}" if parent_name else raw_name
                    
                    matched_kpt = find_best_match(search_str, KEYPOINT_ORDER)
                    matched_class = find_best_match(search_str, CLASS_MAPPING.keys())
                    
                    final_match = matched_kpt if matched_kpt else matched_class
                    if final_match:
                        gt_annotated_objects.append((obj, final_match))
            
            print(f"[POSE] Found {len(gt_annotated_objects)} total parts to annotate.")

            save_ground_truth(
                gt_file,
                scene,
                camera,
                gt_annotated_objects
            )
            
            # create_yolo_pose_annotation will only label keypoints that exist in KEYPOINT_ORDER
            yolo_path = labels_path / f"{file_name_base}.txt"
            create_yolo_pose_annotation(
                scene, 
                camera, 
                yolo_path, 
                gt_annotated_objects, 
                KEYPOINT_ORDER,
                cfg
            )

            generated_count += 1
        except Exception as e:
            import traceback
            print(f"[POSE] Error in attempt {attempts}: {e}")
            traceback.print_exc()
            continue

if __name__ == "__main__":
    new_argv = [sys.argv[0]]
    if "--" in sys.argv:
        new_argv.extend(sys.argv[sys.argv.index("--") + 1:])
    sys.argv = new_argv
    main()
