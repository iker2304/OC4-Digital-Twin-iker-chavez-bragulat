from ultralytics import YOLO
import hydra
import torch
import os
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
from omegaconf import DictConfig
import yaml 

@hydra.main(config_path="config", config_name="train", version_base=None)
def main(cfg: DictConfig) -> None:
    
    original_cwd = hydra.utils.get_original_cwd()
    
    model_path = cfg.config.model
    if not os.path.isabs(model_path) and not os.path.exists(model_path):
        model_path = os.path.join(original_cwd, model_path)
        
    model = YOLO(model_path)
        
    dataset_path = os.path.join(original_cwd, cfg.paths.dataset)
    original_yaml_path = os.path.join(dataset_path, 'data.yaml')
    
    with open(original_yaml_path, 'r') as f:
        data_yaml = yaml.safe_load(f)
    
    data_yaml['path'] = dataset_path
    
    # Overwrite dataset config with values from train hydra config
    if hasattr(cfg.config, 'kpt_shape'):
        data_yaml['kpt_shape'] = list(cfg.config.kpt_shape)
    if hasattr(cfg.config, 'sigmas'):
        data_yaml['sigmas'] = list(cfg.config.sigmas)
    
    temp_yaml_path = os.path.join(dataset_path, 'data_temp_abs.yaml')
    with open(temp_yaml_path, 'w') as f:
        yaml.dump(data_yaml, f)

    try:
        results = model.train(
            data=temp_yaml_path, 
            epochs=cfg.config.epochs,
            imgsz=cfg.config.imgsz,
            batch=cfg.config.batch_size,
            device= cfg.config.device if torch.cuda.is_available() else 'cpu',
            plots= True, 
            pose= cfg.config.pose,
            workers= cfg.Optimization_and_Hardware.workers, 
            cos_lr= cfg.Optimization_and_Hardware.cos_lr,
            cache= cfg.Optimization_and_Hardware.cache,
            amp=True,
            patience= cfg.config.patience,
            rect= cfg.config.rect,
            degrees= cfg.Augmentations.degrees,
            scale= cfg.Augmentations.scale,
            fliplr= cfg.Augmentations.fliplr,
            mosaic= cfg.Augmentations.mosaic,
            project=os.path.join(original_cwd, "data/models/CV/pose"),
            name= cfg.output.name,
            exist_ok=True,
            resume=cfg.config.resume,
        )
    finally:
        if os.path.exists(temp_yaml_path):
            os.remove(temp_yaml_path)
    
    print("Exporting model...")
    model.export(format="pt")
    print("Model exported successfully")

if __name__ == "__main__":
    main()
