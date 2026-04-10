import cv2
import os
import argparse
from pathlib import Path

# Constants
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATASET_PATH = PROJECT_ROOT / "data" / "synthetic_dataset" / "pose"
IMAGES_PATH = DATASET_PATH / "images"
LABELS_PATH = DATASET_PATH / "labels"
KEYPOINT_MAP_FILE = DATASET_PATH / "keypoint_map.txt"
OUTPUT_PATH = PROJECT_ROOT / "experiments" / "visualizations_pose"

def load_keypoint_map():
    if KEYPOINT_MAP_FILE.exists():
        kp_map = {}
        with open(KEYPOINT_MAP_FILE, 'r') as f:
            for line in f:
                if ':' in line:
                    parts = line.strip().split(':', 1)
                    if len(parts) == 2:
                        idx_str, name = parts
                        try:
                            kp_map[int(idx_str)] = name.strip()
                        except ValueError:
                            continue
        return kp_map
    else:
        return {}

KP_NAMES = load_keypoint_map()

def visualize_pose(target_image=None):
    if not IMAGES_PATH.exists() or not LABELS_PATH.exists():
        print(f"Error: Dataset paths not found:\nImages: {IMAGES_PATH}\nLabels: {LABELS_PATH}")
        return

    OUTPUT_PATH.mkdir(parents=True, exist_ok=True)
    
    # Filter images
    if target_image:
        if not target_image.lower().endswith(('.png', '.jpg', '.jpeg')):
             target_image += ".png"
        if not (IMAGES_PATH / target_image).exists():
             print(f"Error: Image '{target_image}' not found in {IMAGES_PATH}")
             return
        samples = [target_image]
    else:
        samples = [f for f in os.listdir(IMAGES_PATH) if f.lower().endswith(('.png', '.jpg', '.jpeg'))]
        print(f"Found {len(samples)} images. Visualizing...")

    for img_file in samples:
        img_path = IMAGES_PATH / img_file
        label_file = LABELS_PATH / (Path(img_file).stem + ".txt")
        
        if not label_file.exists():
            print(f"Warning: No label file for {img_file}")
            continue
            
        img = cv2.imread(str(img_path))
        if img is None:
            continue
            
        height, width, _ = img.shape
        
        with open(label_file, 'r') as f:
            lines = f.readlines()
            
        for line in lines:
            parts = line.strip().split()
            
            # YOLO Pose Format: class cx cy w h k1x k1y k1v k2x k2y k2v ...
            if len(parts) < 5:
                continue
                
            cls_id = int(parts[0])
            # BBox (Optional to draw, usually helpful context)
            cx, cy, w, h = map(float, parts[1:5])
            
            # Draw BBox
            _cx, _cy, _w, _h = cx * width, cy * height, w * width, h * height
            x1, y1 = int(_cx - _w/2), int(_cy - _h/2)
            x2, y2 = int(_cx + _w/2), int(_cy + _h/2)
            cv2.rectangle(img, (x1, y1), (x2, y2), (0, 255, 0), 2)
            
            # Keypoints
            kp_data = parts[5:]
            num_kps = len(kp_data) // 3
            
            for i in range(num_kps):
                base = i * 3
                kx = float(kp_data[base])
                ky = float(kp_data[base+1])
                kvis = int(float(kp_data[base+2])) # 2=visible, 1=occluded, 0=invisible
                
                # Verify coordinates are normalized
                if kx <= 0 or ky <= 0 or kx >= 1 or ky >= 1:
                    # Often 0,0 is used for missing
                    continue
                    
                pixel_x = int(kx * width)
                pixel_y = int(ky * height)
                
                color = (0, 0, 255) # Red default
                if kvis == 2:
                    color = (0, 255, 255) # Yellow
                elif kvis == 1:
                    color = (255, 0, 255) # Purple (Occluded)
                
                if kvis > 0:
                    cv2.circle(img, (pixel_x, pixel_y), 4, color, -1)
                    
                    # Draw ID
                    label = KP_NAMES.get(i, f"{i}")
                        
                    cv2.putText(img, label, (pixel_x + 5, pixel_y - 5), 
                                cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1)

        out_file = OUTPUT_PATH / ("vis_" + img_file)
        cv2.imwrite(str(out_file), img)
        print(f"Saved visualization: {out_file}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Visualize YOLO Pose annotations")
    parser.add_argument("--image", type=str, help="Specific image file to visualize")
    args = parser.parse_args()
    
    visualize_pose(target_image=args.image)
