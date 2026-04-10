import cv2
import os
import random
import yaml
import argparse
from pathlib import Path

# Constants
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATASET_PATH = PROJECT_ROOT / "data" / "synthetic_dataset" / "bbox"
IMAGES_PATH = DATASET_PATH / "images"
LABELS_PATH = DATASET_PATH / "labels"
OUTPUT_PATH =  PROJECT_ROOT / "experiments" / "visualizations"
CLASSES_FILE = LABELS_PATH / "classes.txt"

def load_class_names():
    if CLASSES_FILE.exists():
        classes = {}
        with open(CLASSES_FILE, 'r') as f:
            lines = f.readlines()
            for idx, line in enumerate(lines):
                classes[idx] = line.strip()
        return classes
    else:
        print(f"Warning: {CLASSES_FILE} not found. Trying to fallback or using basic colors.")
        return {}

CLASS_NAMES = load_class_names()

CLASS_COLORS = {
    0: (0, 0, 255),    # Red
    1: (0, 255, 0),    # Green
    2: (255, 0, 0),    # Blue
    3: (255, 255, 0)   # Cyan
}


def visualize_dataset(target_image=None, show_mode='all'):
    if not IMAGES_PATH.exists() or not LABELS_PATH.exists():
        print(f"Error: Dataset paths not found:\nImages: {IMAGES_PATH}\nLabels: {LABELS_PATH}")
        return

    OUTPUT_PATH.mkdir(parents=True, exist_ok=True)
    
    # Filter images
    if target_image:
        # Check if extension provided
        if not target_image.lower().endswith(('.png', '.jpg', '.jpeg')):
             # Try appending .png
             target_image += ".png"
             
        if not (IMAGES_PATH / target_image).exists():
             print(f"Error: Image '{target_image}' not found in {IMAGES_PATH}")
             return
        samples = [target_image]
    else:
        # Default behavior: process all 
        all_images = [f for f in os.listdir(IMAGES_PATH) if f.lower().endswith(('.png', '.jpg', '.jpeg'))]
        if not all_images:
            print("No images found.")
            return
        samples = all_images
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
            
            # Parsing
            if len(parts) == 5:
                # BBox only
                cls_id = int(parts[0])
                cx, cy, w, h = map(float, parts[1:])
                kx, ky, vis = 0, 0, 0
            elif len(parts) == 8:
                # BBox + Keypoint
                cls_id = int(parts[0])
                cx, cy, w, h, kx, ky, vis = map(float, parts[1:])
            else:
                continue
            
            # Visualization Logic
            color = CLASS_COLORS.get(cls_id, (255, 255, 255))
            label_text = CLASS_NAMES.get(cls_id, str(cls_id))

            # Draw BBox
            if show_mode in ['all', 'bbox']:
                # De-normalize BBox
                _cx = cx * width
                _cy = cy * height
                _w = w * width
                _h = h * height
                
                x1 = int(_cx - _w / 2)
                y1 = int(_cy - _h / 2)
                x2 = int(_cx + _w / 2)
                y2 = int(_cy + _h / 2)
                
                cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)
                cv2.putText(img, label_text, (x1, y1 - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)
            
            # Draw Keypoint
            if show_mode in ['all', 'keypoints']:
                # Even if mode is Keypoints, we need valid data
                # Even if mode is Keypoints, we need valid data
                if vis > 0:
                    k_x = int(kx * width)
                    k_y = int(ky * height)
                    
                    # Highlight keypoint
                    if int(vis) == 2:
                         # Visible (Yellow within class ring)
                        cv2.circle(img, (k_x, k_y), 6, color, -1) 
                        cv2.circle(img, (k_x, k_y), 3, (0, 255, 255), -1)
                    else:
                        # Occluded (Red cross/dot)
                        cv2.circle(img, (k_x, k_y), 6, (0, 0, 255), 2) # Empty red ring
                        cv2.drawMarker(img, (k_x, k_y), (0, 0, 255), cv2.MARKER_CROSS, 8, 2) 

        out_file = OUTPUT_PATH / ("vis_" + img_file)
        cv2.imwrite(str(out_file), img)
        print(f"Saved visualization: {out_file}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Visualize YOLO annotations (BBox & Keypoints)")
    parser.add_argument("--image", type=str, help="Specific image file to visualize (e.g., 'image_0000.png' or just 'image_0000')")
    parser.add_argument("--show", type=str, choices=['all', 'bbox', 'keypoints'], default='all', help="What to visualize: 'bbox', 'keypoints', or 'all' (default)")
    
    args = parser.parse_args()
    
    visualize_dataset(target_image=args.image, show_mode=args.show)
