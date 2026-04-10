import bpy
import sys

# Get filepath from args after --
filepath = ""
if "--" in sys.argv:
    filepath = sys.argv[sys.argv.index("--") + 1]

if filepath:
    bpy.ops.wm.open_mainfile(filepath=filepath)
    print(f"\n--- Objects in {filepath} ---")
    for obj in bpy.data.objects:
        if obj.type == 'MESH':
            print(f"MESH: {obj.name}")
    print("--- End ---\n")
else:
    print("No filepath provided.")
