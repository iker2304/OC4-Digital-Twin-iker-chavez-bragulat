from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
import os
from typing import List, Optional
import glob

router = APIRouter()

# Base path for the dataset
# Adjusting path to match the user's provided path structure relative to backend/app/api
# backend/app/api -> ../../../data/synthetic_dataset/dataset
# But safer to use absolute path or relative to project root.
# Assuming execution from backend/ root.
DATASET_BASE_PATH = os.path.abspath(os.path.join(os.getcwd(), "../data/synthetic_dataset/dataset"))

class DatasetStats(BaseModel):
    train_count: int
    val_count: int
    total_count: int

@router.get("/stats", response_model=DatasetStats)
async def get_dataset_stats():
    train_path = os.path.join(DATASET_BASE_PATH, "train", "images")
    val_path = os.path.join(DATASET_BASE_PATH, "val", "images")
    
    train_count = len(glob.glob(os.path.join(train_path, "*.png")))
    val_count = len(glob.glob(os.path.join(val_path, "*.png")))
    
    return DatasetStats(
        train_count=train_count,
        val_count=val_count,
        total_count=train_count + val_count
    )

@router.get("/images/{subset}", response_model=List[str])
async def list_images(subset: str):
    if subset not in ["train", "val"]:
        raise HTTPException(status_code=400, detail="Invalid subset. Use 'train' or 'val'")
        
    path = os.path.join(DATASET_BASE_PATH, subset, "images")
    if not os.path.exists(path):
        return []
        
    # Return relative filenames
    files = sorted([f for f in os.listdir(path) if f.endswith('.png')])
    return files

@router.get("/file/{subset}/images/{filename}")
async def get_image(subset: str, filename: str):
    if subset not in ["train", "val"]:
        raise HTTPException(status_code=400, detail="Invalid subset")
        
    file_path = os.path.join(DATASET_BASE_PATH, subset, "images", filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Image not found")
        
    return FileResponse(file_path)

@router.get("/file/{subset}/labels/{filename}")
async def get_label(subset: str, filename: str):
    if subset not in ["train", "val"]:
        raise HTTPException(status_code=400, detail="Invalid subset")
    
    # Label file should have .txt extension, replacing .png
    label_filename = os.path.splitext(filename)[0] + ".txt"
    file_path = os.path.join(DATASET_BASE_PATH, subset, "labels", label_filename)
    
    if not os.path.exists(file_path):
        return {"content": "No label file found"}
        
    with open(file_path, 'r') as f:
        content = f.read()
        
    return {"content": content}
