import bpy
import bpy_extras
from mathutils import Vector
from pathlib import Path
from typing import List, Dict, Tuple

def get_visible_mesh_objects(parent_name: str) -> List[bpy.types.Object]:
    parent = bpy.data.objects.get(parent_name)
    if not parent:
        return []
    
    mesh_objects = []
    
    def recurse(obj):
        if obj.type == 'MESH':
            mesh_objects.append(obj)
        for child in obj.children:
            recurse(child)
            
    recurse(parent)

    if parent.type == 'MESH':
       mesh_objects.append(parent)
       
    return mesh_objects

def get_bounding_box(scene, camera, obj):
    """
    Returns the bounding box of an object in normalized camera coordinates.
    """
    matrix_world = obj.matrix_world
    min_x = 1.0
    max_x = 0.0
    min_y = 1.0
    max_y = 0.0
    
    vertices_in_frame = False
    
    for coord in obj.bound_box:
        co_3d = matrix_world @ Vector(coord)
        co_2d = bpy_extras.object_utils.world_to_camera_view(scene, camera, co_3d)
        
        if co_2d.z > 0: 
            min_x = min(min_x, co_2d.x)
            max_x = max(max_x, co_2d.x)
            min_y = min(min_y, co_2d.y)
            max_y = max(max_y, co_2d.y)
            vertices_in_frame = True
            
    if not vertices_in_frame:
        return None
        
    min_x = max(0.0, min_x)
    max_x = min(1.0, max_x)
    min_y = max(0.0, min_y)
    max_y = min(1.0, max_y)
    
    if min_x >= max_x or min_y >= max_y:
        return None
        
    return (min_x, min_y, max_x, max_y)

LOCAL_CENTER_CACHE = {}

def get_center_of_volume(obj):
    """
    Calculates the center of volume (approximated by vertex average) in WORLD coordinates.
    Cached for performance (avoids duplicate/transform/origin_set operators).
    """
    if obj.name in LOCAL_CENTER_CACHE:
        local_center = LOCAL_CENTER_CACHE[obj.name]
    else:
        # Calculate local center from vertices
        if obj.type == 'MESH':
            # v.co is in local object space
            vertices = obj.data.vertices
            if len(vertices) > 0:
                avg_pos = Vector((0, 0, 0))
                for v in vertices:
                    avg_pos += v.co
                local_center = avg_pos / len(vertices)
            else:
                local_center = Vector((0, 0, 0))
        else:
             local_center = Vector((0, 0, 0))
        
        LOCAL_CENTER_CACHE[obj.name] = local_center

    # Transform local center to world space
    return obj.matrix_world @ LOCAL_CENTER_CACHE[obj.name]

def is_visible(scene, camera, target_obj, point_3d):
    origin = camera.location
    
    direction = (point_3d - origin).normalized()
    total_dist = (point_3d - origin).length
    
    dist_bias = 0.05
    
    result, hit_loc, hit_normal, hit_index, hit_obj, matrix = scene.ray_cast(
        bpy.context.view_layer.depsgraph,
        origin,
        direction,
        distance=total_dist - dist_bias 
    )
    
    if result:
        if hit_obj != target_obj:
             return 0
             
    return 2

def create_yolo_annotation(scene, camera, target_object_name: str, output_path: Path, class_mapping: Dict[str, int]):
    """
    Generates a YOLO format text file with Pose Keypoints.
    Row format: <class_id> <x_center> <y_center> <width> <height> <kx> <ky> <vis>
    """
    if target_object_name not in bpy.data.objects:
         return

    objects_to_annotate = get_visible_mesh_objects(target_object_name)
    
    annotations = []
    
    sorted_keys = sorted(class_mapping.keys(), key=len, reverse=True)
    
    for obj in objects_to_annotate:
        raw_name = obj.name
        parent_name = obj.parent.name if obj.parent else ""
        
        class_id = -1
        matched_key = None
        
        for key in sorted_keys:
            if key in raw_name or (parent_name and key in parent_name):
                class_id = class_mapping[key]
                matched_key = key
                break
        
        if class_id != -1:
            bbox = get_bounding_box(scene, camera, obj)
            if bbox:
                min_x, min_y, max_x, max_y = bbox
                
                width = max_x - min_x
                height = max_y - min_y
                
                center_x = min_x + width / 2
                center_y = 1.0 - (min_y + height / 2.0)
                
                kp_world = get_center_of_volume(obj)
                
                co_2d = bpy_extras.object_utils.world_to_camera_view(scene, camera, kp_world)
                
                kx = co_2d.x
                ky = 1.0 - co_2d.y
                
                vis = 2
                if co_2d.z < 0 or kx < 0 or kx > 1 or ky < 0 or ky > 1:
                    vis = 0
                else:
                    is_clear = is_visible(scene, camera, obj, kp_world)
                    if is_clear == 2:
                        vis = 2
                    else:
                        vis = 1 # Occluded but tracked
                
                annotations.append(f"{class_id} {center_x:.6f} {center_y:.6f} {width:.6f} {height:.6f} {kx:.6f} {ky:.6f} {vis}")
            else:
                pass
            
    if annotations:
         with open(output_path, 'w') as f:
             f.write("\n".join(annotations))
