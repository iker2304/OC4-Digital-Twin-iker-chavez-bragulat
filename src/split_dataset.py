import os
import shutil
import random
from pathlib import Path
import yaml

def split_dataset(source_dir, output_dir, train_ratio=0.8, val_ratio=0.1, test_ratio=0.1):
    """
    Divide un dataset de YOLO en carpetas train, val y test.
    """
    # Definir rutas
    img_dir = Path(source_dir) / "images"
    lbl_dir = Path(source_dir) / "labels"
    
    if not img_dir.exists() or not lbl_dir.exists():
        print(f"Error: No se encontraron las carpetas 'images' o 'labels' en {source_dir}")
        return

    # Obtener lista de imágenes (solo archivos .png o .jpg)
    images = [f for f in os.listdir(img_dir) if f.lower().endswith(('.png', '.jpg', '.jpeg'))]
    random.shuffle(images)

    total = len(images)
    train_end = int(total * train_ratio)
    val_end = train_end + int(total * val_ratio)

    splits = {
        'train': images[:train_end],
        'val': images[train_end:val_end],
        'test': images[val_end:]
    }

    # Crear estructura de carpetas YOLO
    for split in splits:
        (Path(output_dir) / split / "images").mkdir(parents=True, exist_ok=True)
        (Path(output_dir) / split / "labels").mkdir(parents=True, exist_ok=True)

    # Mover archivos (para ahorrar espacio en disco)
    print(f"Procesando {total} imágenes...")
    for split, split_images in splits.items():
        print(f"Moviendo {len(split_images)} archivos a {split}...")
        for img_name in split_images:
            # Ruta imagen
            shutil.move(img_dir / img_name, Path(output_dir) / split / "images" / img_name)
            
            # Ruta etiqueta (.txt con el mismo nombre)
            lbl_name = os.path.splitext(img_name)[0] + ".txt"
            if (lbl_dir / lbl_name).exists():
                shutil.move(lbl_dir / lbl_name, Path(output_dir) / split / "labels" / lbl_name)

    # Crear archivo data.yaml
    data_yaml = {
        'path': os.path.abspath(output_dir),
        'train': 'train/images',
        'val': 'val/images',
        'test': 'test/images',
        'names': {
            0: 'WindTurbine',
            1: 'Rotor'
        },
        'kpt_shape': [11, 3] # Ajustado según annotation.yaml (WindTurbine tiene 11 kpts)
    }
    
    # Nota: YOLOv8 usa kpt_shape para definir el número de keypoints y sus dimensiones [puntos, [x,y,v]]
    # Como tenemos clases con distinto número de kpts, esto es una simplificación.
    # Para pose estimation multiclase, es mejor usar el máximo o definirlo por clase si el framework lo permite.

    with open(Path(output_dir) / "data.yaml", 'w') as f:
        yaml.dump(data_yaml, f, default_flow_style=False)
    
    print(f"\n¡Split completado con éxito!")
    print(f"Dataset organizado en: {output_dir}")
    print(f"Archivo de configuración generado: {Path(output_dir) / 'data.yaml'}")

if __name__ == "__main__":
    # Configuración de rutas
    SOURCE = "data/synthetic_dataset/pose"
    OUTPUT = "data/synthetic_dataset/yolo_ready"
    
    split_dataset(SOURCE, OUTPUT)
