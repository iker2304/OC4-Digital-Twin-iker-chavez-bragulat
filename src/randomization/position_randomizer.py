import bpy
import math
import random
from omegaconf import DictConfig

def hub_rotation_randomization(cfg: DictConfig, hub_obj: bpy.types.Object) -> None:
    if not cfg.randomization.position.enabled:
        return

    pivot = hub_obj.parent
    if pivot is None:
        pivot = bpy.data.objects.get("Empty")
    
    if pivot:
        # Random rotation around Y-axis (0 to 360 degrees)
        random_angle_deg = random.uniform(0, 360)
        # Apply to Y axis (index 1 of rotation_euler)
        pivot.rotation_euler[1] = math.radians(random_angle_deg)
        print(f"[POSE] Rotated '{pivot.name}' by {random_angle_deg:.2f} degrees on Y-axis")
    else:
        print("[POSE] Warning: 'Empty' object (parent of Hub) not found. Skipping rotation.")