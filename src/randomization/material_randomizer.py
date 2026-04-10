import random
import bpy
from omegaconf import DictConfig

def get_instance_material(obj):
    """
    Ensures the object has a unique material assigned that is reused across frames.
    """
    if not obj.data.materials:
        return None
    
    current_mat = obj.data.materials[0]
    if current_mat.name.startswith("INST_"):
        return current_mat
    
    # Create or find the instance material
    inst_name = f"INST_{obj.name}_{current_mat.name}"
    inst_mat = bpy.data.materials.get(inst_name)
    
    if not inst_mat:
        inst_mat = current_mat.copy()
        inst_mat.name = inst_name
        # Optimization: Remove unused nodes if they are not Principled
        if inst_mat.use_nodes:
            # We will decorate this material later in apply_surface_defects
            pass

    obj.data.materials[0] = inst_mat
    return inst_mat

def set_random_material_color(cfg: DictConfig, object_obj: bpy.types.Object) -> dict:
    """
    Randomization of the object material color with optimized reuse.
    Returns a dictionary of applied colors per object name.
    """
    applied_colors = {}
    # Only iterate through mesh objects once
    for obj in bpy.data.objects:
        if obj.type == 'MESH':
            mat = get_instance_material(obj)
            if mat and mat.use_nodes:
                # Find BSDF
                bsdf = None
                for n in mat.node_tree.nodes:
                    if n.type == 'BSDF_PRINCIPLED':
                        bsdf = n
                        break
                
                if bsdf:
                    new_color = (random.random(), 
                                 random.random(), 
                                 random.random(), 
                                 1.0)
                    # Update input directly
                    bsdf.inputs['Base Color'].default_value = new_color
                    mat.diffuse_color = new_color
                    
                    applied_colors[obj.name] = [round(c, 4) for c in new_color]
    return applied_colors

def apply_surface_defects(cfg: DictConfig) -> dict:
    """
    Applies surface imperfections (noise, scratch-like textures via bump/color mix) to all materials.
    Optimized to reuse nodes instead of recreating them.
    Returns a dictionary with applied parameters.
    """
    applied_defects = {}
    if not hasattr(cfg.randomization, "surface_defects") or not cfg.randomization.surface_defects.enabled:
        return applied_defects

    mix = cfg.randomization.surface_defects
    cracks = cfg.randomization.get("cracks")
    cracks_enabled = cracks.enabled if cracks else False
        
    for obj in bpy.data.objects:
        if obj.type != 'MESH' or not obj.data.materials:
            continue
        
        # Use our instance material helper
        mat = get_instance_material(obj)
        if not mat or not mat.use_nodes:
            continue
            
        tree = mat.node_tree
        nodes = tree.nodes
        links = tree.links
        
        # Find Principled BSDF
        bsdf = next((n for n in nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if not bsdf:
            continue

        def get_node(name, node_type, location):
            node = nodes.get(name)
            if not node:
                node = nodes.new(type=node_type)
                node.name = name
                node.location = location
            return node

        obj_defects = {}

        # 1. Coordinate Setup
        tex_coord = get_node("Rand_TexCoord", 'ShaderNodeTexCoord', (-1600, 200))
        mapping = get_node("Rand_Mapping", 'ShaderNodeMapping', (-1400, 200))
        if not mapping.inputs['Vector'].is_linked:
            links.new(tex_coord.outputs['Generated'], mapping.inputs['Vector'])
        
        shift_x = random.uniform(mix.mapping_shift[0], mix.mapping_shift[1])
        shift_y = random.uniform(mix.mapping_shift[0], mix.mapping_shift[1])
        mapping.inputs['Location'].default_value[0] = shift_x
        mapping.inputs['Location'].default_value[1] = shift_y
        
        obj_defects["mapping_shift"] = [round(shift_x, 4), round(shift_y, 4)]
            
        # 2. Main Noise (Generic stains)
        noise = get_node("Rand_Noise", 'ShaderNodeTexNoise', (-1200, 200))
        if not noise.inputs['Vector'].is_linked:
            links.new(mapping.outputs['Vector'], noise.inputs['Vector'])
        
        noise_scale = random.uniform(mix.noise_scale[0], mix.noise_scale[1])
        noise_dist = random.uniform(mix.distortion[0], mix.distortion[1])
        noise.inputs['Scale'].default_value = noise_scale
        noise.inputs['Distortion'].default_value = noise_dist
        noise.inputs['Detail'].default_value = 2.0 
        
        obj_defects["noise_scale"] = round(noise_scale, 4)
        obj_defects["noise_distortion"] = round(noise_dist, 4)
        
        # 3. Noise Bump
        bump_noise = get_node("Rand_Bump_Noise", 'ShaderNodeBump', (-900, 200))
        bump_noise.inputs['Strength'].default_value = 0.5 
        if not bump_noise.inputs['Height'].is_linked:
            links.new(noise.outputs['Fac'], bump_noise.inputs['Height'])
        
        last_normal_output = bump_noise.outputs['Normal']
        crack_mask_output = None 

        # 4. Cracks (Conditional)
        if cracks_enabled:
            voronoi = get_node("Rand_Voronoi_Crack", 'ShaderNodeTexVoronoi', (-1200, -100))
            voronoi.feature = 'DISTANCE_TO_EDGE'
            if not voronoi.inputs['Vector'].is_linked:
                links.new(mapping.outputs['Vector'], voronoi.inputs['Vector'])
            
            crack_scale = random.uniform(cracks.scale[0], cracks.scale[1])
            crack_randomness = random.uniform(cracks.randomness[0], cracks.randomness[1])
            
            voronoi.inputs['Scale'].default_value = crack_scale
            voronoi.inputs['Randomness'].default_value = crack_randomness
            
            obj_defects["crack_scale"] = round(crack_scale, 4)
            obj_defects["crack_randomness"] = round(crack_randomness, 4)
            
            ramp = get_node("Rand_Crack_Ramp", 'ShaderNodeValToRGB', (-1000, -100))
            if not ramp.inputs['Fac'].is_linked:
                links.new(voronoi.outputs['Distance'], ramp.inputs['Fac'])
            
            ramp.color_ramp.elements[0].position = 0.005
            ramp.color_ramp.elements[0].color = (1, 1, 1, 1) # Crack Mask
            ramp.color_ramp.elements[1].position = 0.02
            ramp.color_ramp.elements[1].color = (0, 0, 0, 1) # Surface
            
            crack_mask_output = ramp.outputs['Color']
            
            bump_crack = get_node("Rand_Bump_Crack", 'ShaderNodeBump', (-600, 100))
            bump_strength = random.uniform(cracks.bump_strength[0], cracks.bump_strength[1])
            bump_crack.inputs['Strength'].default_value = bump_strength
            bump_crack.invert = True 
            
            obj_defects["crack_bump_strength"] = round(bump_strength, 4)
            
            if not bump_crack.inputs['Height'].is_linked:
                links.new(ramp.outputs['Color'], bump_crack.inputs['Height'])
            if not bump_crack.inputs['Normal'].is_linked:
                links.new(bump_noise.outputs['Normal'], bump_crack.inputs['Normal'])
            last_normal_output = bump_crack.outputs['Normal']

        # Link Final Normal
        links.new(last_normal_output, bsdf.inputs['Normal'])

        # 5. Color Mixing
        mix_stains = get_node("Rand_MixStains", 'ShaderNodeMixRGB', (-600, 400))
        mix_stains.blend_type = 'MULTIPLY'
        mix_factor = random.uniform(mix.mix_factor[0], mix.mix_factor[1])
        mix_stains.inputs['Fac'].default_value = mix_factor
        
        obj_defects["mix_factor"] = round(mix_factor, 4)
        
        if not mix_stains.inputs[2].is_linked:
            links.new(noise.outputs['Color'], mix_stains.inputs[2])
        
        last_color_output = mix_stains.outputs['Color']
        
        if cracks_enabled and crack_mask_output:
            mix_cracks = get_node("Rand_MixCracks", 'ShaderNodeMixRGB', (-400, 400))
            mix_cracks.blend_type = 'MULTIPLY'
            if not mix_cracks.inputs['Fac'].is_linked:
                links.new(crack_mask_output, mix_cracks.inputs['Fac'])
            mix_cracks.inputs[2].default_value = (0.05, 0.05, 0.05, 1.0)
            if not mix_cracks.inputs[1].is_linked:
                links.new(mix_stains.outputs['Color'], mix_cracks.inputs[1])
            last_color_output = mix_cracks.outputs['Color']
        
        # Connect to Base Color
        current_base = bsdf.inputs['Base Color'].default_value[:]
        mix_stains.inputs[1].default_value = current_base
        links.new(last_color_output, bsdf.inputs['Base Color'])
        
        applied_defects[obj.name] = obj_defects
        
    return applied_defects