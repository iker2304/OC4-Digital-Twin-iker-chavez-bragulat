import bpy
import random
import math
import os
from pathlib import Path
from mathutils import Vector

from omegaconf import DictConfig

_CACHED_TARGET_CENTER = None
_BACKGROUND_IMAGES_CACHE = {}

def get_image_files(image_dir: str) -> list:
    abs_dir = os.path.abspath(image_dir)
    if abs_dir in _BACKGROUND_IMAGES_CACHE and _BACKGROUND_IMAGES_CACHE[abs_dir]:
        return _BACKGROUND_IMAGES_CACHE[abs_dir]

    valid_exts = ('.png', '.jpg', '.jpeg')
    images = []
    if os.path.exists(abs_dir):
        try:
            with os.scandir(abs_dir) as entries:
                for entry in entries:
                    if entry.is_file() and entry.name.lower().endswith(valid_exts):
                        images.append(entry.path)
        except Exception:
            pass

        if not images:
            for root, _, files in os.walk(abs_dir):
                for f in files:
                    if f.lower().endswith(valid_exts):
                        images.append(os.path.join(root, f))

    if images:
        _BACKGROUND_IMAGES_CACHE[abs_dir] = images
    return images

def camera_dof_randomization(cfg: DictConfig, camera_obj: bpy.types.Object) -> Vector:
    """
    Randomization of the camera Degrees of Freedom (DoF).
    Optimized to cache the scene center.
    """
    global _CACHED_TARGET_CENTER
    
    if cfg.randomization.camera.enabled:
        radius_cfg = cfg.randomization.camera.radius
        if isinstance(radius_cfg, (list, tuple)) or (hasattr(radius_cfg, '__iter__') and not isinstance(radius_cfg, str)):
             radius = random.uniform(radius_cfg[0], radius_cfg[1])
        else:
             radius = radius_cfg

        theta_range = cfg.randomization.camera.get("theta_range", [0, 2 * math.pi])
        phi_range = cfg.randomization.camera.get("phi_range", [0, math.pi])

        theta = random.uniform(theta_range[0], theta_range[1])
        phi = random.uniform(phi_range[0], phi_range[1])

        # Calculate or use cached bounding box center
        if _CACHED_TARGET_CENTER is None:
            meshes = [obj for obj in bpy.data.objects if obj.type == 'MESH']
            if meshes:
                min_v = Vector((float('inf'), float('inf'), float('inf')))
                max_v = Vector((float('-inf'), float('-inf'), float('-inf')))
                for obj in meshes:
                    for corner in obj.bound_box:
                        world_corner = obj.matrix_world @ Vector(corner)
                        for i in range(3):
                            min_v[i] = min(min_v[i], world_corner[i])
                            max_v[i] = max(max_v[i], world_corner[i])
                _CACHED_TARGET_CENTER = (min_v + max_v) / 2.0
            else:
                _CACHED_TARGET_CENTER = Vector((0,0,0))
        
        target_point = _CACHED_TARGET_CENTER
        offset = target_point

        camera_obj.location = Vector((
            radius * math.sin(phi) * math.cos(theta),
            radius * math.sin(phi) * math.sin(theta),
            radius * math.cos(phi)
        )) + offset
        
        # Point the camera at the center
        direction_vector = target_point - camera_obj.location
        direction_vector.normalize()
        
        track_axis = '-Z'
        up_axis = 'Y'
        rot_quaternion = direction_vector.to_track_quat(track_axis, up_axis)
        
        camera_obj.rotation_mode = 'QUATERNION'
        camera_obj.rotation_quaternion = rot_quaternion
        
    return camera_obj.location

def apply_camera_shift(cfg: DictConfig, camera_obj: bpy.types.Object) -> float:
    """
    Applies horizontal shift to the camera sensor (Skew/Offset in image).
    Returns the applied shift value.
    """
    shift_val = 0.0
    # Check if horizontal_shift is configured
    if hasattr(cfg.randomization.camera, "horizontal_shift") and cfg.randomization.camera.horizontal_shift.enabled:
        shift_range = cfg.randomization.camera.horizontal_shift.range
        shift_val = random.uniform(shift_range[0], shift_range[1])
        camera_obj.data.shift_x = shift_val
        # print(f"Applied horizontal camera shift: {shift_val:.3f}")
    
    return shift_val

def lights_position_randomization(cfg: DictConfig, lights_obj: bpy.types.Object) -> Vector:
    """
    Randomization of the lights positions
    """
    if cfg.randomization.lights.enabled:
        radius = random.uniform(cfg.randomization.lights.radius[0], cfg.randomization.lights.radius[1])
        theta = random.uniform(0, 2 * math.pi)
        phi = random.uniform(0, math.pi)

        lights_obj.location = Vector((
            radius * math.sin(phi) * math.cos(theta),
            radius * math.sin(phi) * math.sin(theta),
            radius * math.cos(phi)
        ))
    
    target_point = Vector((0, 0, 0))
    direction = (target_point - lights_obj.location).normalized()

    rot_quaternion = direction.to_track_quat('-Z', 'Y')
    
    lights_obj.rotation_mode = 'QUATERNION'
    lights_obj.rotation_quaternion = rot_quaternion

    return lights_obj.location

def randomize_background(cfg: DictConfig, background_obj: bpy.types.Object) -> str:
    """
    Sets a random image from image_dir as the world background.
    Uses Window coordinates for screen-space mapping.
    Returns the filename of the background image used, or None.
    """
    if cfg.randomization.background.enabled:
        image_dir = cfg.randomization.background.path
        if not os.path.isabs(image_dir):
            project_root = Path(__file__).resolve().parent.parent.parent
            candidate = project_root / image_dir
            if candidate.exists():
                image_dir = str(candidate)

        if not os.path.exists(image_dir):
             print(f"DEBUG: Image directory does not exist: {os.path.abspath(image_dir)}")
             return None
              
        image_paths = get_image_files(image_dir)
        if not image_paths:
            print(f"Warning: No images found in {image_dir}")
            return None
            
        image_path = random.choice(image_paths)
        image_name = os.path.basename(image_path)
        
        try: 
    
            img = None
            for i in bpy.data.images:
                if i.filepath == image_path:
                    img = i
                    break
            if img is None:
                img = bpy.data.images.load(image_path)
        except Exception as e:
            print(f"Error loading image {image_path}: {e}")
            return None
        
        world = bpy.context.scene.world
        if not world: 
            world = bpy.data.worlds.new("World")
            bpy.context.scene.world = world
        
        world.use_nodes = True # Enable node editor
        nodes = world.node_tree.nodes
        links = world.node_tree.links

        # Clear existing nodes
        nodes.clear()
        
        # Create nodes
        node_output = nodes.new(type='ShaderNodeOutputWorld')
        node_output.location = (200, 0)
        
        node_background = nodes.new(type='ShaderNodeBackground')
        node_background.location = (0, 0)
        
        node_tex_image = nodes.new(type='ShaderNodeTexImage')
        node_tex_image.location = (-300, 0)
        node_tex_image.image = img
        
        node_coord = nodes.new(type='ShaderNodeTexCoord')
        node_coord.location = (-500, 0)
        
        # Link Window coords to Vector 
        links.new(node_coord.outputs['Window'], node_tex_image.inputs['Vector'])
        links.new(node_tex_image.outputs['Color'], node_background.inputs['Color'])
        links.new(node_background.outputs['Background'], node_output.inputs['Surface'])
        
        return image_name
    return None
def light_randomization(cfg: DictConfig, light_obj: bpy.types.Object) -> Vector:
    """
    Randomization of the light type, number of lights and energy
    """
    if cfg.randomization.lights.enabled:
        for obj in bpy.data.objects:
            if obj.type == 'LIGHT':
                bpy.data.objects.remove(obj, do_unlink=True)
                
        num_lights = random.randint(cfg.randomization.lights.num[0], cfg.randomization.lights.num[1])
        
        for i in range(num_lights):
            light_type_i = random.choice(cfg.randomization.lights.type)
            
            light_data = bpy.data.lights.new(name=f'Light_{i}', type=light_type_i)
            light = bpy.data.objects.new(name=f'Light_{i}', object_data=light_data)
            bpy.context.collection.objects.link(light)

            if light_type_i == 'SUN':
                light.data.energy = random.uniform(cfg.randomization.lights.energy_sun[0], cfg.randomization.lights.energy_sun[1])
            else:
                light.data.energy = random.uniform(cfg.randomization.lights.energy_else[0], cfg.randomization.lights.energy_else[1])
            
            light_data.color = (random.uniform(0.8, 1), 
                                random.uniform(0.8, 1), 
                                random.uniform(0.8, 1))
            
            light_location = lights_position_randomization(cfg, light)
    else:
        for obj in bpy.data.objects:
            if obj.type == 'LIGHT':
                bpy.data.objects.remove(obj, do_unlink=True)

def intrinsic_matrix_randomization(cfg: DictConfig, camera_obj: bpy.types.Object) -> Vector:
    """
    Randomization of the camera intrinsic matrix
    """
    if cfg.randomization.intrinsic_matrix.enabled:
        #Focal Length (mm)
        focal_x = random.uniform(
            cfg.randomization.intrinsic_matrix.focal_length_x[0], 
            cfg.randomization.intrinsic_matrix.focal_length_x[1]
        )
        focal_y = random.uniform(
            cfg.randomization.intrinsic_matrix.focal_length_y[0], 
            cfg.randomization.intrinsic_matrix.focal_length_y[1]
        )
        
        # Focal_y / Focal_x = Pixel_Aspect_Y / Pixel_Aspect_X
        pixel_aspect_ratio = focal_y / focal_x
        
        camera_obj.data.lens = focal_x
        camera_obj.data.lens_unit = 'MILLIMETERS'
        camera_obj.data.sensor_width = 36  
        camera_obj.data.sensor_height = 24
        
        bpy.context.scene.render.pixel_aspect_x = 1.0
        bpy.context.scene.render.pixel_aspect_y = pixel_aspect_ratio
        
        # Principal Point (Shift)
        pp_x = random.uniform(
            cfg.randomization.intrinsic_matrix.principal_point_x[0],
            cfg.randomization.intrinsic_matrix.principal_point_x[1]
        )
        pp_y = random.uniform(
            cfg.randomization.intrinsic_matrix.principal_point_y[0],
            cfg.randomization.intrinsic_matrix.principal_point_y[1]
        )
        
        # Blender Shift: 
        camera_obj.data.shift_x = (0.5 - pp_x)
        camera_obj.data.shift_y = (pp_y - 0.5) 
        
        print(f"Intrinsic Randomization: Focal X={focal_x:.1f}mm, Focal Y={focal_y:.1f}mm (Aspect Y={pixel_aspect_ratio:.2f}), Shift=({camera_obj.data.shift_x:.3f}, {camera_obj.data.shift_y:.3f})")

def compositor_randomization(cfg: DictConfig) -> dict:
    """
    Randomization of the compositor nodes (Blur, Distortion, Burn/Exposure)
    Returns a dictionary with the applied settings.
    """
    settings = {}
    
    # Check if compositor section exists in config
    if not hasattr(cfg.randomization, "compositor") or not cfg.randomization.compositor.enabled:
        # If disabled, ensure we turn off compositor or clear nodes so previous renders don't affect this one
        if bpy.context.scene.use_nodes:
             bpy.context.scene.use_nodes = False
        return settings

    scene = bpy.context.scene
    scene.use_nodes = True
    tree = scene.node_tree
    
    # Clear existing nodes
    for node in tree.nodes:
        tree.nodes.remove(node)
        
    # Create input and output
    rl_node = tree.nodes.new('CompositorNodeRLayers')
    rl_node.location = (-400, 0)
    
    comp_node = tree.nodes.new('CompositorNodeComposite')
    comp_node.location = (800, 0)
    
    # Keep track of the last node to link from
    last_node = rl_node
    current_x = -200
    
    # Distortion
    if hasattr(cfg.randomization.compositor, "distortion") and cfg.randomization.compositor.distortion.enabled:
        if random.random() < cfg.randomization.compositor.distortion.probability:
            dist_node = tree.nodes.new('CompositorNodeLensdist')
            dist_node.location = (current_x, 0)
            
            dist_amount = random.uniform(
                cfg.randomization.compositor.distortion.distort[0],
                cfg.randomization.compositor.distortion.distort[1]
            )
            disp_amount = random.uniform(
                cfg.randomization.compositor.distortion.dispersion[0],
                cfg.randomization.compositor.distortion.dispersion[1]
            )
            
            dist_node.inputs['Distortion'].default_value = dist_amount
            dist_node.inputs['Dispersion'].default_value = disp_amount
            dist_node.inputs['Jitter'].default_value = True
            
            settings['distortion'] = {
                'amount': round(dist_amount, 4),
                'dispersion': round(disp_amount, 4)
            }
            
            tree.links.new(last_node.outputs['Image'], dist_node.inputs['Image'])
            last_node = dist_node
            current_x += 200

    # Blur
    if hasattr(cfg.randomization.compositor, "blur") and cfg.randomization.compositor.blur.enabled:
        if random.random() < cfg.randomization.compositor.blur.probability:
            blur_node = tree.nodes.new('CompositorNodeBlur')
            blur_node.location = (current_x, 0)
            
            size_x = random.randint(
                cfg.randomization.compositor.blur.size_x[0],
                cfg.randomization.compositor.blur.size_x[1]
            )
            size_y = random.randint(
                cfg.randomization.compositor.blur.size_y[0],
                cfg.randomization.compositor.blur.size_y[1]
            )
            
            blur_node.size_x = size_x
            blur_node.size_y = size_y
            
            settings['blur'] = {
                'size_x': size_x,
                'size_y': size_y
            }
            
            tree.links.new(last_node.outputs['Image'], blur_node.inputs['Image'])
            last_node = blur_node
            current_x += 200
            
    #Exposure
    if hasattr(cfg.randomization.compositor, "burn") and cfg.randomization.compositor.burn.enabled:
        if random.random() < cfg.randomization.compositor.burn.probability:
            exp_node = tree.nodes.new('CompositorNodeExposure')
            exp_node.location = (current_x, 0)
            
            exposure_val = random.uniform(
                cfg.randomization.compositor.burn.exposure.low,
                cfg.randomization.compositor.burn.exposure.high
            )
            
            exp_node.inputs['Exposure'].default_value = exposure_val
            
            settings['exposure'] = {
                'value': round(exposure_val, 4)
            }
            
            tree.links.new(last_node.outputs['Image'], exp_node.inputs['Image'])
            last_node = exp_node
            current_x += 200
            
    tree.links.new(last_node.outputs['Image'], comp_node.inputs['Image'])
    
    return settings
