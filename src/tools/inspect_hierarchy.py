import bpy

bpy.ops.wm.open_mainfile(filepath="data/models/blender/OC4.blend")

keypoints = ["VIS_Hub", "VIS_pontoon_front_1", "VIS_blade_red_1"]

for kp_name in keypoints:
    obj = bpy.data.objects.get(kp_name)
    if obj:
        print(f"Keypoint: {kp_name}")
        curr = obj
        while curr.parent:
            print(f"  -> Parent: {curr.parent.name} (Type: {curr.parent.type})")
            curr = curr.parent
    else:
        print(f"Keypoint {kp_name} not found.")
