bl_info = {
    "name": "Keypoint Selector",
    "author": "Antigravity",
    "version": (1, 3),
    "blender": (4, 0, 0),
    "location": "View3D > Sidebar > Keypoints",
    "description": "Select vertices for YOLO keypoints, place exact 3D points, or use center of mass.",
    "category": "Development",
}

import bpy
import bmesh
import json
import os
import mathutils
import re

def get_project_root():
    """Finds the OC4-Digital-Twin project root directory."""
    if bpy.data.filepath:
        curr = os.path.dirname(os.path.abspath(bpy.data.filepath))
        while curr and curr != os.path.dirname(curr):
            if os.path.exists(os.path.join(curr, "src", "config", "annotation.yaml")) or os.path.exists(os.path.join(curr, "data", "models", "blender")):
                return curr
            curr = os.path.dirname(curr)

    curr = os.path.dirname(os.path.abspath(__file__))
    while curr and curr != os.path.dirname(curr):
        if os.path.exists(os.path.join(curr, "src", "config", "annotation.yaml")):
            return curr
        curr = os.path.dirname(curr)

    default_repo = "/Users/ikerchavezbragulat/OC4-Digital-Twin-iker-chavez-bragulat"
    if os.path.exists(default_repo):
        return default_repo

    if bpy.data.filepath:
        return os.path.dirname(os.path.abspath(bpy.data.filepath))
    return os.path.dirname(os.path.abspath(__file__))

def resolve_keypoints_file():
    root = get_project_root()
    target = os.path.join(root, "data", "models", "blender", "config", "keypoints.json")
    if os.path.exists(target):
        return target

    if bpy.data.filepath:
        blend_dir = os.path.dirname(bpy.data.filepath)
        candidate = os.path.join(blend_dir, "config", "keypoints.json")
        if os.path.exists(candidate):
            return candidate
        candidate_flat = os.path.join(blend_dir, "keypoints.json")
        if os.path.exists(candidate_flat):
            return candidate_flat

    legacy_app_support = os.path.expanduser("~/Library/Application Support/Blender/4.5/data/models/blender/config/keypoints.json")
    if os.path.exists(legacy_app_support) and not os.path.exists(target):
        return legacy_app_support

    return target

def load_annotation_config():
    root = get_project_root()
    paths = [
        os.path.join(root, "src", "config", "annotation.yaml"),
        os.path.join(os.path.dirname(__file__), "..", "config", "annotation.yaml"),
    ]
    if bpy.data.filepath:
        paths.append(os.path.join(os.path.dirname(bpy.data.filepath), "..", "..", "..", "src", "config", "annotation.yaml"))

    for p in paths:
        if os.path.exists(p):
            try:
                import yaml
                with open(p, 'r', encoding='utf-8') as f:
                    return yaml.safe_load(f)
            except Exception:
                pass
    return None

def get_annotation_classes():
    classes = []
    cfg = load_annotation_config()
    if cfg and 'pose' in cfg and 'classes' in cfg['pose']:
        for c in cfg['pose']['classes']:
            name = c.get('name')
            if name:
                classes.append((name, name, f"Save to class {name}"))
    if not classes:
        classes = [("Default", "Default", "Default class")]
    return classes

def infer_class_for_keypoint(kp_name):
    cfg = load_annotation_config()
    if cfg and 'pose' in cfg and 'classes' in cfg['pose']:
        kp_low = kp_name.lower()
        for c in cfg['pose']['classes']:
            c_name = c.get('name', '')
            for k in c.get('keypoints', []):
                if k.lower() == kp_low or k.lower() in kp_low or kp_low in k.lower():
                    return c_name
        if "blade" in kp_low or "rotor" in kp_low:
            return "Rotor"
        return cfg['pose']['classes'][0].get('name', 'Default')
    return "Default"

def clean_keypoint_name(raw_name):
    name = raw_name
    if name.startswith("VIS_"):
        name = name[4:]
    name = re.sub(r'\.\d+$', '', name)
    return name.strip()

def load_keypoints():
    keypoints_path = resolve_keypoints_file()
    if os.path.exists(keypoints_path):
        with open(keypoints_path, 'r') as f:
            try:
                data = json.load(f)
                return data.get("keypoints", [])
            except:
                return []
    return []

def save_keypoints(data):
    keypoints_path = resolve_keypoints_file()
    os.makedirs(os.path.dirname(keypoints_path), exist_ok=True)
    with open(keypoints_path, 'w') as f:
        json.dump({"keypoints": data}, f, indent=4)
    print(f"[Keypoint Selector] Saved {len(data)} keypoints to: {keypoints_path}")

def find_closest_mesh(target_world_loc, candidate_objects=None):
    """Finds the closest mesh object based on bounding box center distance."""
    if candidate_objects is None:
        candidate_objects = [obj for obj in bpy.data.objects if obj.type == 'MESH']
    best_dist = float('inf')
    best_obj = None
    for obj in candidate_objects:
        if not obj.bound_box:
            continue
        mw = obj.matrix_world
        c = sum([mw @ mathutils.Vector(corner) for corner in obj.bound_box], mathutils.Vector()) / 8.0
        d = (target_world_loc - c).length
        if d < best_dist:
            best_dist = d
            best_obj = obj
    return best_obj

def find_closest_mesh_vertex(target_world_loc, candidate_objects=None):
    """Finds the closest mesh and vertex index to a world coordinate."""
    if candidate_objects is None:
        candidate_objects = [obj for obj in bpy.data.objects if obj.type == 'MESH']
    best_dist = float('inf')
    best_obj = None
    best_v_idx = -1
    best_v_loc = None
    
    for obj in candidate_objects:
        if not obj.data or not obj.data.vertices:
            continue
        mw = obj.matrix_world
        if obj.bound_box:
            bbox_center = sum([mw @ mathutils.Vector(c) for c in obj.bound_box], mathutils.Vector()) / 8.0
            bbox_radius = max((mw @ mathutils.Vector(c) - bbox_center).length for c in obj.bound_box)
            dist_to_center = (target_world_loc - bbox_center).length
            if dist_to_center - bbox_radius > best_dist:
                continue

        for idx, v in enumerate(obj.data.vertices):
            v_world = mw @ v.co
            d = (v_world - target_world_loc).length
            if d < best_dist:
                best_dist = d
                best_obj = obj
                best_v_idx = idx
                best_v_loc = v_world
                
    return best_obj, best_v_idx, best_dist, best_v_loc

def spawn_visualizer(name, location, parent_obj=None):
    vis_name = f"VIS_{name}"
    if vis_name in bpy.data.objects:
        empty = bpy.data.objects[vis_name]
    else:
        empty = bpy.data.objects.new(vis_name, None)
        coll = bpy.context.collection if bpy.context.collection else bpy.context.scene.collection
        coll.objects.link(empty)

    empty.empty_display_type = 'SPHERE'
    empty.empty_display_size = 0.1
    empty.show_name = True
    empty.color = (1.0, 0.5, 0.0, 1.0) # Orange

    if parent_obj:
        empty.parent = parent_obj
        empty.matrix_parent_inverse = parent_obj.matrix_world.inverted()
        empty.matrix_world.translation = location
    else:
        empty.location = location

    return empty

def update_visualizers():
    data = load_keypoints()
    scene_objects = {obj.name: obj for obj in bpy.data.objects if obj.type == 'MESH'}
    
    for kp in data:
        obj_name = kp.get('object_name')
        obj = scene_objects.get(obj_name)
        loc = None
        kp_type = kp.get('type', 'vertex')

        # 1. Exact Offset / Relative Coordinate mode (does NOT jump to vertices)
        if kp_type in ('offset', 'relative') or 'relative_coords' in kp:
            if obj and 'relative_coords' in kp:
                rel = mathutils.Vector(kp['relative_coords'])
                loc = obj.matrix_world @ rel
            elif 'world_coords' in kp:
                loc = mathutils.Vector(kp['world_coords'])

        # 2. Specific Vertex Index mode
        elif kp_type == 'vertex' and kp.get('vertex_index', -1) >= 0:
            if obj:
                idx = kp['vertex_index']
                if idx < len(obj.data.vertices):
                    loc = obj.matrix_world @ obj.data.vertices[idx].co

        # 3. Center of Mass / Bounding Box mode
        elif kp_type == 'center' and obj:
            bbox_coords = [obj.matrix_world @ mathutils.Vector(corner) for corner in obj.bound_box]
            loc = sum(bbox_coords, mathutils.Vector()) / 8.0

        if loc:
            spawn_visualizer(kp['name'], loc, parent_obj=obj)

class KEYPOINT_OT_add(bpy.types.Operator):
    """Add active object/vertex/empty as keypoint"""
    bl_idname = "keypoint.add"
    bl_label = "Add / Register Keypoint"
    
    use_center: bpy.props.BoolProperty(name="Use Center of Mass", default=False)
    position_mode: bpy.props.EnumProperty(
        name="Position Mode",
        description="Choose how to attach this point to the model",
        items=[
            ('EXACT', "Exact 3D Position (Offset)", "Keeps exact 3D position by attaching relative offset to nearest part of turbine (Recommended, never jumps)"),
            ('SNAP', "Snap to Nearest Vertex", "Snaps directly to closest mesh vertex")
        ],
        default='EXACT'
    )
    keypoint_name: bpy.props.StringProperty(name="Keypoint Name")
    class_name: bpy.props.EnumProperty(
        name="Global Class",
        description="Select the class from annotation.yaml to associate this keypoint with",
        items=lambda self, context: get_annotation_classes()
    )

    def invoke(self, context, event):
        obj = context.active_object
        if obj:
            base_name = clean_keypoint_name(obj.name)
            self.keypoint_name = base_name
            self.class_name = infer_class_for_keypoint(base_name)
        return context.window_manager.invoke_props_dialog(self)

    def draw(self, context):
        layout = self.layout
        obj = context.active_object
        if not obj:
            layout.label(text="No active object selected", icon='ERROR')
            return

        if obj.type == 'EMPTY':
            box = layout.box()
            box.label(text=f"Selected Empty: '{obj.name}'", icon='EMPTY_DATA')
            box.label(text="Keeps exact position relative to turbine model.", icon='INFO')
            layout.prop(self, "class_name")
            layout.prop(self, "keypoint_name")
            layout.separator()
            layout.prop(self, "position_mode", expand=True)

        elif obj.type == 'MESH':
            if context.mode == 'EDIT_MESH':
                layout.label(text=f"Mesh Edit Mode: '{obj.name}'", icon='EDITMODE_HLT')
                layout.label(text="Will save selected vertex.", icon='INFO')
                layout.prop(self, "class_name")
                layout.prop(self, "keypoint_name")
            else:
                layout.label(text=f"Mesh Object: '{obj.name}'", icon='MESH_DATA')
                layout.prop(self, "class_name")
                layout.prop(self, "keypoint_name")
                layout.prop(self, "use_center")
        else:
            layout.label(text=f"Object: '{obj.name}' ({obj.type})", icon='OBJECT_DATA')
            layout.prop(self, "class_name")
            layout.prop(self, "keypoint_name")
            layout.prop(self, "position_mode", expand=True)

    def execute(self, context):
        obj = context.active_object
        if not obj:
            self.report({'ERROR'}, "No active object")
            return {'CANCELLED'}

        final_name = self.keypoint_name.strip() if self.keypoint_name.strip() else clean_keypoint_name(obj.name)
        target_loc = None
        mesh_name = obj.name
        v_idx = -1
        kp_type = "offset"
        rel_coords = None
        world_coords = None
        ref_mesh = None

        # Case 1: Active object is an EMPTY (or custom point)
        if obj.type == 'EMPTY':
            world_loc = obj.matrix_world.translation.copy()
            world_coords = [round(float(world_loc.x), 5), round(float(world_loc.y), 5), round(float(world_loc.z), 5)]

            # Determine reference mesh (parent mesh or closest mesh)
            if obj.parent and obj.parent.type == 'MESH':
                ref_mesh = obj.parent
            else:
                ref_mesh = find_closest_mesh(world_loc)

            if not ref_mesh:
                self.report({'ERROR'}, "Could not find any mesh object nearby")
                return {'CANCELLED'}

            mesh_name = ref_mesh.name

            if self.position_mode == 'EXACT':
                # EXACT MODE: Maintain the exact 3D position where the user placed it
                local_co = ref_mesh.matrix_world.inverted() @ world_loc
                rel_coords = [round(float(c), 5) for c in local_co]
                target_loc = world_loc
                kp_type = "offset"
                v_idx = -1

                # Parent empty to ref_mesh so it moves with waves/rotation
                obj.name = f"VIS_{final_name}"
                obj.parent = ref_mesh
                obj.matrix_parent_inverse = ref_mesh.matrix_world.inverted()
                obj.matrix_world.translation = world_loc
                obj.empty_display_type = 'SPHERE'
                obj.empty_display_size = 0.1
                obj.show_name = True
                obj.color = (1.0, 0.5, 0.0, 1.0)

            else:
                # SNAP MODE: Snap to nearest vertex
                closest_obj, closest_idx, dist, v_loc = find_closest_mesh_vertex(world_loc)
                if not closest_obj or closest_idx < 0:
                    self.report({'ERROR'}, "No vertex found to snap to")
                    return {'CANCELLED'}
                mesh_name = closest_obj.name
                v_idx = closest_idx
                target_loc = v_loc
                kp_type = "vertex"
                obj.name = f"VIS_{final_name}"
                obj.parent = closest_obj
                obj.matrix_parent_inverse = closest_obj.matrix_world.inverted()
                obj.matrix_world.translation = v_loc
                obj.empty_display_type = 'SPHERE'
                obj.empty_display_size = 0.1
                obj.show_name = True
                obj.color = (1.0, 0.5, 0.0, 1.0)

        # Case 2: Active object is a MESH
        elif obj.type == 'MESH':
            ref_mesh = obj
            mesh_name = obj.name
            if not self.use_center:
                if context.mode != 'EDIT_MESH':
                    self.report({'ERROR'}, "Must be in Edit Mode to select a vertex, or check 'Use Center of Mass'")
                    return {'CANCELLED'}
                
                bm = bmesh.from_edit_mesh(obj.data)
                if hasattr(bm.select_history, "active") and isinstance(bm.select_history.active, bmesh.types.BMVert):
                    v_idx = bm.select_history.active.index
                    target_loc = obj.matrix_world @ bm.select_history.active.co
                else:
                    selected_verts = [v for v in bm.verts if v.select]
                    if selected_verts:
                        v_idx = selected_verts[0].index
                        target_loc = obj.matrix_world @ selected_verts[0].co
                    else:
                        self.report({'ERROR'}, "No vertex selected")
                        return {'CANCELLED'}
                kp_type = "vertex"
            else:
                bbox_coords = [obj.matrix_world @ mathutils.Vector(corner) for corner in obj.bound_box]
                target_loc = sum(bbox_coords, mathutils.Vector()) / 8.0
                kp_type = "center"
                v_idx = -1

        else:
            world_loc = obj.matrix_world.translation.copy()
            ref_mesh = find_closest_mesh(world_loc)
            if not ref_mesh:
                self.report({'ERROR'}, "No mesh found nearby")
                return {'CANCELLED'}
            mesh_name = ref_mesh.name
            local_co = ref_mesh.matrix_world.inverted() @ world_loc
            rel_coords = [round(float(c), 5) for c in local_co]
            world_coords = [round(float(c), 5) for c in world_loc]
            target_loc = world_loc
            kp_type = "offset"

        kp_data = {
            "name": final_name,
            "object_name": mesh_name,
            "class_name": self.class_name,
            "type": kp_type,
            "vertex_index": v_idx
        }
        if rel_coords is not None:
            kp_data["relative_coords"] = rel_coords
        if world_coords is not None:
            kp_data["world_coords"] = world_coords

        data = load_keypoints()
        data = [k for k in data if k["name"] != kp_data["name"]]
        data.append(kp_data)
        save_keypoints(data)

        if target_loc:
            spawn_visualizer(kp_data['name'], target_loc, parent_obj=ref_mesh)

        if kp_type == "offset":
            self.report({'INFO'}, f"Saved keypoint '{final_name}' at exact 3D position (attached to {mesh_name})")
        else:
            self.report({'INFO'}, f"Saved keypoint '{final_name}' on {mesh_name} (V[{v_idx}])")
        return {'FINISHED'}

class KEYPOINT_OT_add_selected(bpy.types.Operator):
    """Save all currently selected objects/empties at their exact positions as keypoints"""
    bl_idname = "keypoint.add_selected"
    bl_label = "Save Selected as Keypoints"

    def execute(self, context):
        selected = context.selected_objects
        if not selected:
            self.report({'ERROR'}, "No objects selected")
            return {'CANCELLED'}

        data = load_keypoints()
        existing_map = {k["name"]: k for k in data}
        saved_count = 0

        for obj in selected:
            clean_name = clean_keypoint_name(obj.name)
            if not clean_name:
                continue

            world_loc = obj.matrix_world.translation.copy()
            
            # Find reference mesh
            if obj.parent and obj.parent.type == 'MESH':
                ref_mesh = obj.parent
            else:
                ref_mesh = find_closest_mesh(world_loc)
            if not ref_mesh:
                continue

            # Compute exact local offset
            local_co = ref_mesh.matrix_world.inverted() @ world_loc

            c_name = existing_map.get(clean_name, {}).get("class_name")
            if not c_name:
                c_name = infer_class_for_keypoint(clean_name)

            kp_data = {
                "name": clean_name,
                "object_name": ref_mesh.name,
                "class_name": c_name,
                "type": "offset",
                "relative_coords": [round(float(c), 5) for c in local_co],
                "world_coords": [round(float(world_loc.x), 5), round(float(world_loc.y), 5), round(float(world_loc.z), 5)],
                "vertex_index": -1
            }
            existing_map[clean_name] = kp_data
            saved_count += 1

            # Format visualizer empty in scene at exact position
            if obj.type == 'EMPTY':
                obj.name = f"VIS_{clean_name}"
                obj.parent = ref_mesh
                obj.matrix_parent_inverse = ref_mesh.matrix_world.inverted()
                obj.matrix_world.translation = world_loc
                obj.empty_display_type = 'SPHERE'
                obj.empty_display_size = 0.1
                obj.show_name = True
                obj.color = (1.0, 0.5, 0.0, 1.0)

        save_keypoints(list(existing_map.values()))
        self.report({'INFO'}, f"Saved {saved_count} keypoint(s) at exact positions")
        return {'FINISHED'}

class KEYPOINT_OT_sync_scene_visualizers(bpy.types.Operator):
    """Detects all VIS_ objects in the scene, updates moved positions without jumping, and saves them"""
    bl_idname = "keypoint.sync_scene_visualizers"
    bl_label = "Update from Scene Visualizers"

    def execute(self, context):
        vis_objects = [obj for obj in bpy.data.objects if obj.name.startswith("VIS_")]
        if not vis_objects:
            self.report({'WARNING'}, "No 'VIS_' visualizer objects found in the scene")
            return {'CANCELLED'}

        data = load_keypoints()
        existing_map = {k["name"]: k for k in data}
        updated_count = 0

        for obj in vis_objects:
            kp_name = clean_keypoint_name(obj.name)
            if not kp_name:
                continue

            world_loc = obj.matrix_world.translation.copy()
            if obj.parent and obj.parent.type == 'MESH':
                ref_mesh = obj.parent
            else:
                ref_mesh = find_closest_mesh(world_loc)
            if not ref_mesh:
                continue

            local_co = ref_mesh.matrix_world.inverted() @ world_loc

            c_name = existing_map.get(kp_name, {}).get("class_name")
            if not c_name:
                c_name = infer_class_for_keypoint(kp_name)

            existing_map[kp_name] = {
                "name": kp_name,
                "object_name": ref_mesh.name,
                "class_name": c_name,
                "type": "offset",
                "relative_coords": [round(float(c), 5) for c in local_co],
                "world_coords": [round(float(world_loc.x), 5), round(float(world_loc.y), 5), round(float(world_loc.z), 5)],
                "vertex_index": -1
            }
            # Maintain parenting and exact location
            obj.parent = ref_mesh
            obj.matrix_parent_inverse = ref_mesh.matrix_world.inverted()
            obj.matrix_world.translation = world_loc
            updated_count += 1

        save_keypoints(list(existing_map.values()))
        self.report({'INFO'}, f"Synced {updated_count} visualizers at exact positions")
        return {'FINISHED'}

class KEYPOINT_OT_remove(bpy.types.Operator):
    """Remove keypoint"""
    bl_idname = "keypoint.remove"
    bl_label = "Remove"
    
    index: bpy.props.IntProperty()

    def execute(self, context):
        data = load_keypoints()
        if 0 <= self.index < len(data):
            kp = data.pop(self.index)
            save_keypoints(data)
            
            vis_name = f"VIS_{kp['name']}"
            if vis_name in bpy.data.objects:
                bpy.data.objects.remove(bpy.data.objects[vis_name], do_unlink=True)
                
        return {'FINISHED'}

class KEYPOINT_OT_visualize_all(bpy.types.Operator):
    """Refreshes all keypoint visualizers at their exact positions"""
    bl_idname = "keypoint.visualize_all"
    bl_label = "Show All Visualizers"

    def execute(self, context):
        update_visualizers()
        return {'FINISHED'}

class KEYPOINT_PT_main(bpy.types.Panel):
    """Creates a Panel in the 3D View Sidebar"""
    bl_label = "Keypoint Selector"
    bl_idname = "KEYPOINT_PT_main"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = 'Keypoints'

    def draw(self, context):
        layout = self.layout
        
        # Action Buttons
        col = layout.column(align=True)
        col.operator("keypoint.add", text="Add / Register Keypoint", icon='ADD')
        col.operator("keypoint.add_selected", text="Save Selected as Keypoints", icon='RESTRICT_SELECT_OFF')
        col.operator("keypoint.sync_scene_visualizers", text="Update from Scene Visualizers", icon='FILE_REFRESH')
        col.operator("keypoint.visualize_all", text="Show All Visualizers", icon='RESTRICT_VIEW_OFF')
        
        # Current file path info
        kp_file = resolve_keypoints_file()
        info_box = layout.box()
        info_box.label(text=f"Saving to:", icon='FILE_FOLDER')
        info_box.label(text=os.path.basename(kp_file))
        info_box.scale_y = 0.8
        
        # Instructions Box
        box = layout.box()
        box.label(text="Quick Guide:", icon='INFO')
        col = box.column(align=True)
        col.label(text="• Free / Copied Points: Move anywhere in 3D,")
        col.label(text="  then 'Save Selected' or 'Add' (Exact Position).")
        col.label(text="  Points never jump and follow the turbine!")
        col.label(text="• Specific Vertex: Edit Mode -> Select -> 'Add'")

        # Keypoints list
        data = load_keypoints()
        layout.separator()
        layout.label(text=f"Registered Keypoints ({len(data)}):", icon='DOT')
        
        if not data:
            layout.label(text="No keypoints registered yet.", icon='INFO')
        else:
            for i, kp in enumerate(data):
                box_kp = layout.box()
                row = box_kp.row(align=True)
                
                c_name = kp.get('class_name', 'Default')
                row.label(text=f"[{c_name}] {kp['name']}", icon='EMPTY_DATA')
                
                rem_op = row.operator("keypoint.remove", text="", icon='X')
                rem_op.index = i
                
                sub_row = box_kp.row(align=True)
                target_desc = f"Obj: {kp.get('object_name', '?')}"
                if kp.get('type') == 'offset' or 'relative_coords' in kp:
                    target_desc += "  |  Exact 3D Pos"
                elif kp.get('type') == 'vertex':
                    target_desc += f"  |  Vert: #{kp.get('vertex_index', '?')}"
                else:
                    target_desc += "  |  Center"
                sub_row.scale_y = 0.7
                sub_row.label(text=target_desc)

def register():
    bpy.utils.register_class(KEYPOINT_OT_add)
    bpy.utils.register_class(KEYPOINT_OT_add_selected)
    bpy.utils.register_class(KEYPOINT_OT_sync_scene_visualizers)
    bpy.utils.register_class(KEYPOINT_OT_remove)
    bpy.utils.register_class(KEYPOINT_OT_visualize_all)
    bpy.utils.register_class(KEYPOINT_PT_main)

def unregister():
    bpy.utils.unregister_class(KEYPOINT_PT_main)
    bpy.utils.unregister_class(KEYPOINT_OT_visualize_all)
    bpy.utils.unregister_class(KEYPOINT_OT_remove)
    bpy.utils.unregister_class(KEYPOINT_OT_sync_scene_visualizers)
    bpy.utils.unregister_class(KEYPOINT_OT_add_selected)
    bpy.utils.unregister_class(KEYPOINT_OT_add)

if __name__ == "__main__":
    register()
