import os
import random
from pathlib import Path
import shutil
from omegaconf import DictConfig
import hydra
import yaml

@hydra.main(config_path="config", config_name="train", version_base=None)
def split_dataset(cfg: DictConfig) -> None:
    
    train_ratio = cfg.config.dataset.train_ratio

    project_root = Path(__file__).resolve().parent.parent.parent.parent
    base_dataset_path = project_root / "data" / "synthetic_dataset"

    input_img_folder = base_dataset_path / "pose" / "images"
    input_label_folder = base_dataset_path / "pose" / "labels"
    output_folder = base_dataset_path / "dataset"

    if output_folder.exists():
        shutil.rmtree(output_folder)
    output_folder.mkdir(parents=True)
    
    dirs = [
        (output_folder, "train", "images"),
        (output_folder, "val", "images"),
        (output_folder, "train", "labels"),
        (output_folder, "val", "labels")]

    for path_parts in dirs: 
        os.makedirs(os.path.join(*path_parts), exist_ok=True)
    
    print(f"Folders created correctly at {output_folder}")
    
    if not input_img_folder.exists():
        print(f"Error: Input folder {input_img_folder} does not exist.")
        return

    files = [f.name for f in input_img_folder.iterdir() 
             if f.suffix.lower() in cfg.config.images_extensions]
    
    random.shuffle(files)
    train_size = int(len(files) * train_ratio)
    train_files = files[:train_size]
    val_files = files[train_size:]

    print(f"Total images: {len(files)}")
    print(f"Train images: {len(train_files)}")
    print(f"Val images: {len(val_files)}")

    def process_files(file_list, split_type):
        for filename in file_list:
            src_img = input_img_folder / filename
            
            name_no_ext = Path(filename).stem
            label_name = name_no_ext + '.txt'
            src_label = input_label_folder / label_name
            
            if not src_label.exists():
                print(f"Error: Image {filename} has no corresponding label")
                continue
            
            # Destination paths
            dst_img = output_folder / split_type / "images" / filename
            dst_label = output_folder / split_type / "labels" / label_name
            
            # Copy
            try:
                shutil.copy2(str(src_img), str(dst_img))
                shutil.copy2(str(src_label), str(dst_label))
            except Exception as e:
                print(f"Error copying {filename}: {e}")
                continue

    print(f"Copying files of train set...") 
    process_files(train_files, 'train')     
    print(f"Copying files of val set...")
    process_files(val_files, 'val')
    
    # Determine keypoint count from annotation.yaml
    annotation_yaml_path = project_root / "src" / "config" / "annotation.yaml"
    num_kpts = 13 # Default fallback
    
    if annotation_yaml_path.exists():
        try:
            with open(annotation_yaml_path, 'r') as f:
                ann_data = yaml.safe_load(f)
                # Check for possible structures based on recent edits
                kpts_list = []
                if 'pose' in ann_data and 'keypoints' in ann_data['pose']:
                     kpts_list = ann_data['pose']['keypoints']
                elif 'annotation' in ann_data and 'pose' in ann_data['annotation'] and 'keypoints' in ann_data['annotation']['pose']:
                     kpts_list = ann_data['annotation']['pose']['keypoints']
                
                if kpts_list:
                    num_kpts = len(kpts_list)
                    print(f"Detected {num_kpts} keypoints from annotation.yaml")
        except Exception as e:
            print(f"Warning: Could not read annotation.yaml: {e}. Using default {num_kpts}.")
    
    # Create data.yaml
    data_yaml_content = {
        'path': str(output_folder.resolve()),
        'train': 'train/images',
        'val': 'val/images',
        'names': {0: 'WindTurbine'},
        'kpt_shape': [num_kpts, 3] # [num_keypoints, dim]
    }
    
    with open(output_folder / 'data.yaml', 'w') as f:
        yaml.dump(data_yaml_content, f)

    print(f"Files copied correctly to {output_folder} and data.yaml created.")

if __name__ == "__main__":
    split_dataset()