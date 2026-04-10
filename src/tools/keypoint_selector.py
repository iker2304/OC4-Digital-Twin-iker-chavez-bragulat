bl_info = {
    "name": "Keypoint Selector",
    "author": "Antigravity",
    "version": (1, 0),
    "blender": (4, 0, 0),
    "location": "View3D > Sidebar > Keypoints",
    "description": "Select vertices for YOLO keypoints or use center of mass.",
    "category": "Development",
}

import bpy
import bmesh
import json
import os
import mathutils

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
KEYPOINTS_FILE = os.path.join(PROJECT_ROOT, "data", "models", "blender", "config", "keypoints.json")

def load_keypoints():
    if os.path.exists(KEYPOINTS_FILE):
        with open(KEYPOINTS_FILE, 'r') as f:
            try:
                data = json.load(f)
                return data.get("keypoints", [])
            except:
                return []
    return []

def save_keypoints(data):
    os.makedirs(os.path.dirname(KEYPOINTS_FILE), exist_ok=True)
    with open(KEYPOINTS_FILE, 'w') as f:
        json.dump({"keypoints": data}, f, indent=4)

def spawn_visualizer(name, location):
    # Remove existing visualizer if any
    vis_name = f"VIS_{name}"
    if vis_name in bpy.data.objects:
        bpy.data.objects.remove(bpy.data.objects[vis_name], do_unlink=True)
    
    # Create Empty (Sphere type)
    bpy.ops.object.empty_add(type='SPHERE', radius=0.1, location=location)
    empty = bpy.context.active_object
    empty.name = vis_name
    empty.show_name = True
    empty.color = (1.0, 0.5, 0.0, 1.0) # Orange
    return empty

def update_visualizers():
    data = load_keypoints()
    # Cache objects
    scene_objects = {obj.name: obj for obj in bpy.data.objects if obj.type == 'MESH'}
    
    for kp in data:
        obj_name = kp['object_name']
        if obj_name not in scene_objects:
            continue
            
        obj = scene_objects[obj_name]
        loc = None
        
        if kp['type'] == 'vertex':
            idx = kp['vertex_index']
            if idx < len(obj.data.vertices):
                loc = obj.matrix_world @ obj.data.vertices[idx].co
        else:
             # Center
            bbox_coords = [obj.matrix_world @ mathutils.Vector(corner) for corner in obj.bound_box]
            loc = sum(bbox_coords, mathutils.Vector()) / 8.0
            
        if loc:
            spawn_visualizer(kp['name'], loc)

class KEYPOINT_OT_add(bpy.types.Operator):
    """Add active object/vertex as keypoint"""
    bl_idname = "keypoint.add"
    bl_label = "Add Keypoint"
    
    use_center: bpy.props.BoolProperty(name="Use Center of Mass", default=False)
    keypoint_name: bpy.props.StringProperty(name="Keypoint Name")

    def invoke(self, context, event):
        return context.window_manager.invoke_props_dialog(self)

    def draw(self, context):
        layout = self.layout
        layout.prop(self, "keypoint_name")
        layout.prop(self, "use_center")

    def execute(self, context):
        obj = context.active_object
        if not obj or obj.type != 'MESH':
            self.report({'ERROR'}, "Active object must be a Mesh")
            return {'CANCELLED'}

        kp_data = {
            "name": self.keypoint_name if self.keypoint_name else obj.name,
            "object_name": obj.name,
            "type": "center" if self.use_center else "vertex",
            "vertex_index": -1
        }

        target_loc = None

        if not self.use_center:
            # Get active vertex in Edit Mode
            if context.mode != 'EDIT_MESH':
                self.report({'ERROR'}, "Must be in Edit Mode to select a vertex")
                return {'CANCELLED'}
            
            bm = bmesh.from_edit_mesh(obj.data)
            # Find active element
            if hasattr(bm.select_history, "active") and isinstance(bm.select_history.active, bmesh.types.BMVert):
                kp_data["vertex_index"] = bm.select_history.active.index
            
                target_loc = obj.matrix_world @ bm.select_history.active.co
            else:
                # Fallback: find first selected
                selected_verts = [v for v in bm.verts if v.select]
                if selected_verts:
                    kp_data["vertex_index"] = selected_verts[0].index
                    target_loc = obj.matrix_world @ selected_verts[0].co
                else:
                    self.report({'ERROR'}, "No vertex selected")
                    return {'CANCELLED'}
        else:
            # Center
            bbox_coords = [obj.matrix_world @ mathutils.Vector(corner) for corner in obj.bound_box]
            target_loc = sum(bbox_coords, mathutils.Vector()) / 8.0
        
        # Load, Append, Save
        data = load_keypoints()
        data = [k for k in data if k["name"] != kp_data["name"]]
        data.append(kp_data)
        save_keypoints(data)
        
        # Visualize immediately
        if target_loc:
             prev_mode = context.mode
             if prev_mode == 'EDIT_MESH':
                 bpy.ops.object.mode_set(mode='OBJECT')
             
             spawn_visualizer(kp_data['name'], target_loc)
             
             if prev_mode == 'EDIT_MESH':
                 # Re-enter edit mode and re-select object
                 bpy.context.view_layer.objects.active = obj
                 bpy.ops.object.mode_set(mode='EDIT_MESH')
        
        self.report({'INFO'}, f"Saved keypoint: {kp_data['name']}")
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
            
            # Remove visualizer
            vis_name = f"VIS_{kp['name']}"
            if vis_name in bpy.data.objects:
                bpy.data.objects.remove(bpy.data.objects[vis_name], do_unlink=True)
                
        return {'FINISHED'}

class KEYPOINT_OT_visualize_all(bpy.types.Operator):
    """Refreshes all keypoint visualizers"""
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
        
        # Add Button
        layout.operator("keypoint.add", icon='ADD')
        layout.operator("keypoint.visualize_all", icon='RESTRICT_VIEW_OFF')
        
        box = layout.box()
        box.label(text="Instructions:", icon='INFO')
        box.label(text="1. Vertex Mode (Uncheck 'Center'):")
        box.label(text="   - Enter Edit Mode (TAB)")
        box.label(text="   - Select ONE vertex")
        box.label(text="   - Click Add -> Uncheck 'Center'")
        box.label(text="2. Center Mode (Check 'Center'):")
        box.label(text="   - Select Object")
        box.label(text="   - Click Add -> Check 'Center'")
        
        # List
        layout.label(text="Defined Keypoints:")
        data = load_keypoints()
        
        for i, kp in enumerate(data):
            row = layout.row()
            desc = f"{kp['name']} ({kp['object_name']})"
            if kp['type'] == 'vertex':
                desc += f" : V[{kp['vertex_index']}]"
            else:
                desc += " : Center"
                
            row.label(text=desc)
            op = row.operator("keypoint.remove", text="", icon='X')
            op.index = i

def register():
    bpy.utils.register_class(KEYPOINT_OT_add)
    bpy.utils.register_class(KEYPOINT_OT_remove)
    bpy.utils.register_class(KEYPOINT_OT_visualize_all)
    bpy.utils.register_class(KEYPOINT_PT_main)

def unregister():
    bpy.utils.unregister_class(KEYPOINT_PT_main)
    bpy.utils.unregister_class(KEYPOINT_OT_visualize_all)
    bpy.utils.unregister_class(KEYPOINT_OT_remove)
    bpy.utils.unregister_class(KEYPOINT_OT_add)

if __name__ == "__main__":
    register()
