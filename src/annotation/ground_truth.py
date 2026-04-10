import bpy
import json
import math
from pathlib import Path
from mathutils import Vector, Matrix
from bpy_extras.object_utils import world_to_camera_view

def serialize_vector(v):
    return [round(x, 6) for x in v]

def serialize_matrix(m):
    return [serialize_vector(row) for row in m]

def save_ground_truth(filepath, scene, camera, annotated_objects, compositor_settings=None, background_image=None, material_colors=None, surface_defects=None):
    """
    Saves comprehensive ground truth data to a JSON file.
    
    Args:
        filepath (Path): Output path for the JSON file.
        scene (bpy.types.Scene): Current Blender scene.
        camera (bpy.types.Object): Active camera object.
        annotated_objects (list): List of tuples (blender_object, class_name).
        compositor_settings (dict, optional): Settings applied in the compositor.
        background_image (str, optional): Name of the background image used.
        material_colors (dict, optional): Applied random colors per object.
        surface_defects (dict, optional): Applied surface defect parameters.
    """
    
    data = {
        "timestamp": str(filepath.stem), 
        "camera": {
            "name": camera.name,
            "location": serialize_vector(camera.location),
            "rotation_euler": serialize_vector(camera.rotation_euler),
            "focal_length_mm": round(camera.data.lens, 4),
            "sensor_width_mm": round(camera.data.sensor_width, 4),
            "shift_x": round(camera.data.shift_x, 6),
            "shift_y": round(camera.data.shift_y, 6),
            "resolution": {
                "width": scene.render.resolution_x,
                "height": scene.render.resolution_y,
                "percentage": scene.render.resolution_percentage
            },
            "matrix_world": serialize_matrix(camera.matrix_world),
            "pixel_aspect_x": round(scene.render.pixel_aspect_x, 6),
            "pixel_aspect_y": round(scene.render.pixel_aspect_y, 6)
        },
        "environment": {
            "background_image": background_image,
            "compositor_settings": compositor_settings,
            "material_colors": material_colors,
            "surface_defects": surface_defects
        },
        "lights": [],
        "objects": []
    }
    
    # Capture Lights
    for obj in scene.objects:
        if obj.type == 'LIGHT':
            light_data = {
                "name": obj.name,
                "type": obj.data.type,
                "location": serialize_vector(obj.location),
                "rotation_euler": serialize_vector(obj.rotation_euler),
                "energy": round(obj.data.energy, 2),
                "color": serialize_vector(obj.data.color)
            }
            data["lights"].append(light_data)
            
    # Capture Annotated Objects
    for obj, class_name in annotated_objects:
        matrix_world = obj.matrix_world
        location = matrix_world.to_translation()
        rotation = matrix_world.to_euler()
        scale = matrix_world.to_scale()
        
      
        bbox_coords = [matrix_world @ Vector(corner) for corner in obj.bound_box]
        center = sum(bbox_coords, Vector()) / 8.0
        
        # Project center to 2D
        co_2d = world_to_camera_view(scene, camera, center)
        render_scale = scene.render.resolution_percentage / 100
        res_x = scene.render.resolution_x * render_scale
        res_y = scene.render.resolution_y * render_scale
        
        # Convert to pixels (0,0 is bottom-left in Blender usually, but typically images are top-left. Standard CV is top-left)
        # Blender world_to_camera_view returns (0,0) bottom-left, (1,1) top-right.
        # Image coordinates standard: (0,0) top-left.
        px_x = co_2d.x * res_x
        px_y = (1.0 - co_2d.y) * res_y
        
        obj_data = {
            "class_name": class_name,
            "name": obj.name,
            "location_world": serialize_vector(location),
            "rotation_euler": serialize_vector(rotation),
            "scale": serialize_vector(scale),
            "bbox_center_world": serialize_vector(center),
            "keypoint_center_2d": [round(px_x, 2), round(px_y, 2)] 
        }
        data["objects"].append(obj_data)
        
    try:
        with open(filepath, 'w') as f:
            json.dump(data, f, indent=4)
       
    except Exception as e:
        print(f"Error saving ground truth {filepath}: {e}")
