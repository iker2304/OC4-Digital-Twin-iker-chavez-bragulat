import bpy
import math
import mathutils
import random
from omegaconf import DictConfig

def hub_rotation_randomization(cfg: DictConfig, hub_obj: bpy.types.Object) -> float:
    if not cfg.randomization.position.enabled:
        return 0.0

    # 1. Try to find the "rotation" object (parent of rotor parts)
    rotation_obj = bpy.data.objects.get("rotation")
    
    # 2. Fallback to hub_obj if provided and "rotation" not found
    if not rotation_obj:
        if hub_obj:
            rotation_obj = hub_obj
            print(f"[POSE] Using provided hub_obj '{hub_obj.name}' for rotation.")
        else:
            print("[POSE] Warning: 'rotation' object not found and no hub_obj provided. Skipping hub rotation.")
            return 0.0
    
    # 3. Clear any animation data (keyframes) that might be overriding the rotation during render
    if rotation_obj.animation_data:
        rotation_obj.animation_data_clear()

    # 4. Ensure all blade keypoints are parented to the rotation object
    # This is the most reliable way to make them follow the rotation automatically
    for obj in bpy.data.objects:
        if obj.name.startswith("VIS_Blade") or obj.name.startswith("VIS_blade") or obj.name.startswith("VIS_Hub"):
            if obj.parent != rotation_obj:
                # Store world matrix to preserve global position during parenting
                old_matrix = obj.matrix_world.copy()
                obj.parent = rotation_obj
                obj.matrix_parent_inverse = rotation_obj.matrix_world.inverted()
                # Restore world matrix just in case, though usually matrix_parent_inverse is enough
                obj.matrix_world = old_matrix
                print(f"[POSE] Parented {obj.name} to {rotation_obj.name}")

    # 5. Apply random absolute rotation on local Y axis
    random_angle_deg = random.uniform(0, 360)
    random_angle_rad = math.radians(random_angle_deg)

    rotation_obj.rotation_mode = 'XYZ'
    rotation_obj.rotation_euler.y = random_angle_rad

    # 6. Explicitly insert a keyframe for the rotation object
    # Sometimes the render engine evaluates the timeline and resets un-keyframed properties.
    rotation_obj.keyframe_insert(data_path="rotation_euler", frame=bpy.context.scene.frame_current)

    # 7. Force Blender to update the scene graph so the new rotation is registered
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    depsgraph.update()

    print(f"[POSE] Rotated 'rotation' object by {random_angle_deg:.2f} deg on local Y axis")
    return random_angle_deg