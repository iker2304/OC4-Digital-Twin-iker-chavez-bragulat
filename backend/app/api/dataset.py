from fastapi import APIRouter, HTTPException, Body, Query, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel
import os
import glob
import math
import random
import shutil
from pathlib import Path
from typing import List, Optional, Dict, Any
import cv2
import numpy as np

try:
    import yaml
except ImportError:
    yaml = None

router = APIRouter()

PROJECT_ROOT = Path(__file__).resolve().parents[3]
SYNTHETIC_ROOT = PROJECT_ROOT / "data" / "synthetic_dataset"
DEFAULT_DATASET_DIR = SYNTHETIC_ROOT / "dataset"
YOLO_READY_DIR = SYNTHETIC_ROOT / "yolo_ready"
SRC_CONFIG_DIR = PROJECT_ROOT / "src" / "config"

SYNTHETIC_ROOT.mkdir(parents=True, exist_ok=True)
DEFAULT_DATASET_DIR.mkdir(parents=True, exist_ok=True)


def _resolve_dataset_dir(dataset: Optional[str] = None) -> Path:
    if not dataset or dataset in ("default", "dataset"):
        # If default is empty but yolo_ready exists and has images, use default or create sample
        return DEFAULT_DATASET_DIR
    candidate = (SYNTHETIC_ROOT / dataset).resolve()
    if str(candidate).startswith(str(SYNTHETIC_ROOT.resolve())):
        return candidate
    candidate_root = (PROJECT_ROOT / dataset).resolve()
    if str(candidate_root).startswith(str(PROJECT_ROOT.resolve())) and candidate_root.exists():
        return candidate_root
    return DEFAULT_DATASET_DIR


def _ensure_sample_dataset(ds_dir: Path, num_train: int = 12, num_val: int = 4, asset_type: str = "wind_turbine") -> None:
    """Generates synthetic annotated YOLO Pose images if the dataset folder is empty so the explorer and training work out-of-the-box."""
    train_img_dir = ds_dir / "train" / "images"
    train_lbl_dir = ds_dir / "train" / "labels"
    val_img_dir = ds_dir / "val" / "images"
    val_lbl_dir = ds_dir / "val" / "labels"

    for d in (train_img_dir, train_lbl_dir, val_img_dir, val_lbl_dir):
        d.mkdir(parents=True, exist_ok=True)

    existing_train = list(train_img_dir.glob("*.png")) + list(train_img_dir.glob("*.jpg"))
    if len(existing_train) > 0:
        return

    def render_synthetic_sample(img_path: Path, lbl_path: Path, idx: int) -> None:
        w, h = 640, 640
        img = np.zeros((h, w, 3), dtype=np.uint8)
        # Sky & sea gradient background
        horizon = int(h * random.uniform(0.48, 0.58))
        for y in range(horizon):
            ratio = y / max(horizon, 1)
            img[y, :] = [int(45 + 60 * ratio), int(30 + 45 * ratio), int(18 + 30 * ratio)]
        for y in range(horizon, h):
            ratio = (y - horizon) / max(h - horizon, 1)
            img[y, :] = [int(80 - 40 * ratio), int(55 - 25 * ratio), int(20 - 10 * ratio)]

        cx = int(w * random.uniform(0.38, 0.62))
        cy = int(horizon + random.uniform(15, 45))
        scale = random.uniform(0.85, 1.18)
        tilt_deg = random.uniform(-10.0, 10.0)
        tilt_rad = math.radians(tilt_deg)

        def rot_pt(dx: float, dy: float):
            rx = dx * math.cos(tilt_rad) - dy * math.sin(tilt_rad)
            ry = dx * math.sin(tilt_rad) + dy * math.cos(tilt_rad)
            return int(cx + rx * scale), int(cy + ry * scale)

        # 14 keypoints matching OC4 annotation.yaml
        rel_kpts = [
            (0, 45), (-95, 25), (95, 25),        # Front/Left/Right base columns
            (95, -5), (95, -35), (95, 45),       # Right pontoon column
            (-95, -5), (-95, -35), (-95, 45),    # Left pontoon column
            (0, -30), (0, 0), (0, 25),           # Center column
            (0, -45), (0, -195)                  # Tower base & Tower top (Hub)
        ]
        abs_kpts = [rot_pt(dx, dy) for dx, dy in rel_kpts]

        # Draw pontoons & braces
        cv2.line(img, abs_kpts[1], abs_kpts[2], (70, 180, 230), 6, cv2.LINE_AA)
        cv2.line(img, abs_kpts[0], abs_kpts[1], (60, 165, 215), 6, cv2.LINE_AA)
        cv2.line(img, abs_kpts[0], abs_kpts[2], (60, 165, 215), 6, cv2.LINE_AA)
        for base_idx, top_idx in [(2, 4), (1, 7), (0, 11)]:
            cv2.line(img, abs_kpts[base_idx], abs_kpts[top_idx], (45, 195, 245), 14, cv2.LINE_AA)

        # Draw tower
        cv2.line(img, abs_kpts[12], abs_kpts[13], (225, 230, 235), 9, cv2.LINE_AA)

        # Draw 3 rotor blades around Hub
        hub_x, hub_y = abs_kpts[13]
        rotor_angle = random.uniform(0, 2 * math.pi)
        blade_len = int(115 * scale)
        blade_colors = [(60, 70, 230), (230, 140, 50), (60, 215, 240)]
        all_xs = [p[0] for p in abs_kpts]
        all_ys = [p[1] for p in abs_kpts]
        for b_i in range(3):
            ang = rotor_angle + b_i * (2 * math.pi / 3)
            bx = int(hub_x + blade_len * math.cos(ang))
            by = int(hub_y + blade_len * math.sin(ang))
            cv2.line(img, (hub_x, hub_y), (bx, by), blade_colors[b_i], 4, cv2.LINE_AA)
            all_xs.append(bx)
            all_ys.append(by)
        cv2.circle(img, (hub_x, hub_y), 7, (255, 255, 255), -1, cv2.LINE_AA)

        # Compute YOLO bounding box
        min_x = max(0, min(all_xs) - 14)
        max_x = min(w - 1, max(all_xs) + 14)
        min_y = max(0, min(all_ys) - 14)
        max_y = min(h - 1, max(all_ys) + 14)
        bw = (max_x - min_x) / w
        bh = (max_y - min_y) / h
        bcx = (min_x + max_x) / (2.0 * w)
        bcy = (min_y + max_y) / (2.0 * h)

        kpt_tokens = []
        for kx, ky in abs_kpts:
            nx = min(1.0, max(0.0, kx / w))
            ny = min(1.0, max(0.0, ky / h))
            kpt_tokens.append(f"{nx:.6f} {ny:.6f} 2")

        label_line = f"0 {bcx:.6f} {bcy:.6f} {bw:.6f} {bh:.6f} " + " ".join(kpt_tokens) + "\n"
        cv2.imwrite(str(img_path), img)
        lbl_path.write_text(label_line, encoding="utf-8")

    for i in range(num_train):
        fname = f"pose_{i:04d}.png"
        render_synthetic_sample(train_img_dir / fname, train_lbl_dir / f"pose_{i:04d}.txt", i)
    for i in range(num_val):
        fname = f"pose_val_{i:04d}.png"
        render_synthetic_sample(val_img_dir / fname, val_lbl_dir / f"pose_val_{i:04d}.txt", i)

    data_yaml_path = ds_dir / "data.yaml"
    if not data_yaml_path.exists() and yaml is not None:
        with open(data_yaml_path, "w", encoding="utf-8") as f:
            yaml.safe_dump({
                "path": str(ds_dir),
                "train": "train/images",
                "val": "val/images",
                "kpt_shape": [14, 3],
                "names": {0: "WindTurbine"},
                "keypoints": [
                    "OC-1-F", "OC-3-F", "OC-2-F",
                    "OC-1-R", "OC-2-R", "OC-3-R",
                    "OC-1-L", "OC-2-L", "OC-3-L",
                    "CC-2-TOP", "CC-MID", "CC-CEL-F",
                    "CC-B", "CC-T"
                ]
            }, f, sort_keys=False)


# Ensure default dataset and yolo_ready have initial samples if empty
try:
    _ensure_sample_dataset(DEFAULT_DATASET_DIR, num_train=16, num_val=4)
    _ensure_sample_dataset(YOLO_READY_DIR, num_train=16, num_val=4)
except Exception as _e:
    print(f"[DatasetAPI] Warning initializing sample dataset: {_e}")


class DatasetStats(BaseModel):
    train_count: int
    val_count: int
    total_count: int
    dataset_name: Optional[str] = "dataset"
    path: Optional[str] = None
    classes: Optional[Dict[Any, str]] = None
    kpt_shape: Optional[List[int]] = None


@router.get("/list")
async def list_datasets():
    """List all available datasets in data/synthetic_dataset."""
    datasets = []
    if SYNTHETIC_ROOT.exists():
        for d in sorted(SYNTHETIC_ROOT.iterdir()):
            if d.is_dir():
                train_imgs = list((d / "train" / "images").glob("*.png")) + list((d / "train" / "images").glob("*.jpg"))
                val_imgs = list((d / "val" / "images").glob("*.png")) + list((d / "val" / "images").glob("*.jpg"))
                raw_imgs = list((d / "images").glob("*.png")) + list((d / "images").glob("*.jpg"))
                yaml_file = d / "data.yaml"
                yaml_data = {}
                if yaml_file.exists() and yaml is not None:
                    try:
                        yaml_data = yaml.safe_load(yaml_file.read_text(encoding="utf-8")) or {}
                    except Exception:
                        pass
                datasets.append({
                    "id": d.name,
                    "name": d.name,
                    "path": str(d.relative_to(PROJECT_ROOT)),
                    "train_count": len(train_imgs),
                    "val_count": len(val_imgs),
                    "raw_count": len(raw_imgs),
                    "total_count": len(train_imgs) + len(val_imgs) + len(raw_imgs),
                    "trainImages": len(train_imgs),
                    "valImages": len(val_imgs),
                    "rawImages": len(raw_imgs),
                    "totalImages": len(train_imgs) + len(val_imgs) + len(raw_imgs),
                    "has_yaml": yaml_file.exists(),
                    "kpt_shape": yaml_data.get("kpt_shape", [14, 3]),
                    "names": yaml_data.get("names", {0: "WindTurbine"}),
                })
    return {"datasets": datasets}


@router.post("/create")
async def create_dataset(payload: Dict[str, Any] = Body(...)):
    """Create a new dataset with custom classes, keypoints, and optional synthetic sample generation."""
    name = str(payload.get("name", "")).strip()
    if not name:
        raise HTTPException(status_code=400, detail="Dataset name is required")
    safe_name = "".join(c for c in name if c.isalnum() or c in ("_", "-", ".")).strip()
    if not safe_name:
        raise HTTPException(status_code=400, detail="Invalid dataset name")

    ds_dir = SYNTHETIC_ROOT / safe_name
    for sub in ("train/images", "train/labels", "val/images", "val/labels"):
        (ds_dir / sub).mkdir(parents=True, exist_ok=True)

    num_keypoints = int(payload.get("numKeypoints") or payload.get("keypointsCount") or 14)
    classes_list = payload.get("classes", ["WindTurbine"])
    if isinstance(classes_list, list):
        names_dict = {i: str(c) for i, c in enumerate(classes_list)}
    elif isinstance(classes_list, dict):
        names_dict = classes_list
    else:
        names_dict = {0: "Asset"}

    keypoints_names = payload.get("keypointNames", [f"kpt_{i}" for i in range(num_keypoints)])

    yaml_content = {
        "path": str(ds_dir),
        "train": "train/images",
        "val": "val/images",
        "kpt_shape": [num_keypoints, 3],
        "names": names_dict,
        "keypoints": keypoints_names,
    }
    if yaml is not None:
        with open(ds_dir / "data.yaml", "w", encoding="utf-8") as f:
            yaml.safe_dump(yaml_content, f, sort_keys=False, allow_unicode=True)

    n_train = int(payload.get("numTrain", 0) or 0)
    n_val = int(payload.get("numVal", 0) or 0)
    generate_samples = int(payload.get("generateSamples", 0) or 0)
    if n_train > 0 or n_val > 0:
        _ensure_sample_dataset(ds_dir, num_train=max(1, n_train), num_val=max(1, n_val))
    elif generate_samples > 0:
        n_tr = max(1, int(generate_samples * 0.8))
        n_vl = max(1, generate_samples - n_tr)
        _ensure_sample_dataset(ds_dir, num_train=n_tr, num_val=n_vl)

    return {
        "status": "created",
        "dataset": safe_name,
        "path": str(ds_dir.relative_to(PROJECT_ROOT)),
        "yaml": yaml_content,
    }


@router.post("/generate-samples")
async def generate_synthetic_pose_samples(payload: Dict[str, Any] = Body(...)):
    """Generate N synthetic pose images + YOLO labels inside the target dataset."""
    dataset_name = payload.get("dataset", "dataset")
    count = min(500, max(1, int(payload.get("count", 20))))
    train_ratio = float(payload.get("trainRatio", 0.8))
    ds_dir = _resolve_dataset_dir(dataset_name)

    # Clear or append
    if payload.get("overwrite", False):
        for sub in ("train/images", "train/labels", "val/images", "val/labels"):
            shutil.rmtree(ds_dir / sub, ignore_errors=True)

    for sub in ("train/images", "train/labels", "val/images", "val/labels"):
        (ds_dir / sub).mkdir(parents=True, exist_ok=True)

    # Temporarily clear existing check by generating additional files
    n_train = max(1, int(count * train_ratio))
    n_val = max(1, count - n_train)
    existing_t = len(list((ds_dir / "train" / "images").glob("*.png")))
    existing_v = len(list((ds_dir / "val" / "images").glob("*.png")))

    # Reuse generator logic via a temporary folder if existing files present
    tmp_dir = ds_dir / "_tmp_gen"
    _ensure_sample_dataset(tmp_dir, num_train=n_train, num_val=n_val)
    for i, p in enumerate(sorted((tmp_dir / "train" / "images").glob("*.png"))):
        idx = existing_t + i
        shutil.move(str(p), str(ds_dir / "train" / "images" / f"pose_{idx:04d}.png"))
        lbl = tmp_dir / "train" / "labels" / (p.stem + ".txt")
        if lbl.exists():
            shutil.move(str(lbl), str(ds_dir / "train" / "labels" / f"pose_{idx:04d}.txt"))
    for i, p in enumerate(sorted((tmp_dir / "val" / "images").glob("*.png"))):
        idx = existing_v + i
        shutil.move(str(p), str(ds_dir / "val" / "images" / f"pose_val_{idx:04d}.png"))
        lbl = tmp_dir / "val" / "labels" / (p.stem + ".txt")
        if lbl.exists():
            shutil.move(str(lbl), str(ds_dir / "val" / "labels" / f"pose_val_{idx:04d}.txt"))
    shutil.rmtree(tmp_dir, ignore_errors=True)

    return {"status": "ok", "generated": count, "dataset": ds_dir.name}


@router.post("/split")
async def split_dataset_endpoint(payload: Dict[str, Any] = Body(...)):
    """Re-balance or split a dataset according to train_ratio."""
    dataset_name = payload.get("dataset", "dataset")
    train_ratio = min(0.95, max(0.1, float(payload.get("trainRatio", 0.8))))
    ds_dir = _resolve_dataset_dir(dataset_name)

    all_pairs = []
    for sub in ("train", "val", "test"):
        img_sub = ds_dir / sub / "images"
        lbl_sub = ds_dir / sub / "labels"
        if img_sub.exists():
            for img_p in img_sub.glob("*.*"):
                if img_p.suffix.lower() in (".png", ".jpg", ".jpeg"):
                    lbl_p = lbl_sub / (img_p.stem + ".txt")
                    all_pairs.append((img_p, lbl_p if lbl_p.exists() else None))

    if not all_pairs:
        raise HTTPException(status_code=400, detail="No images found in dataset to split")

    random.shuffle(all_pairs)
    split_idx = int(len(all_pairs) * train_ratio)
    train_set = all_pairs[:split_idx]
    val_set = all_pairs[split_idx:]

    tmp_stage = ds_dir / "_split_stage"
    for s in ("train/images", "train/labels", "val/images", "val/labels"):
        (tmp_stage / s).mkdir(parents=True, exist_ok=True)

    for img_p, lbl_p in train_set:
        shutil.move(str(img_p), str(tmp_stage / "train" / "images" / img_p.name))
        if lbl_p and lbl_p.exists():
            shutil.move(str(lbl_p), str(tmp_stage / "train" / "labels" / lbl_p.name))

    for img_p, lbl_p in val_set:
        shutil.move(str(img_p), str(tmp_stage / "val" / "images" / img_p.name))
        if lbl_p and lbl_p.exists():
            shutil.move(str(lbl_p), str(tmp_stage / "val" / "labels" / lbl_p.name))

    for s in ("train", "val"):
        shutil.rmtree(ds_dir / s, ignore_errors=True)
        shutil.move(str(tmp_stage / s), str(ds_dir / s))
    shutil.rmtree(tmp_stage, ignore_errors=True)

    return {
        "status": "ok",
        "dataset": ds_dir.name,
        "train_count": len(train_set),
        "val_count": len(val_set),
        "total_count": len(all_pairs),
    }


@router.get("/configs")
async def get_pipeline_configs():
    """Return blender.yaml, annotation.yaml, and randomization.yaml configurations."""
    result = {}
    if yaml is not None:
        for name in ("blender", "annotation", "randomization", "main"):
            p = SRC_CONFIG_DIR / f"{name}.yaml"
            if p.exists():
                try:
                    result[name] = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
                except Exception:
                    result[name] = {}
    return result


@router.put("/configs/{config_name}")
async def update_pipeline_config(config_name: str, payload: Dict[str, Any] = Body(...)):
    if config_name not in ("blender", "annotation", "randomization", "main"):
        raise HTTPException(status_code=400, detail="Invalid config name")
    if yaml is None:
        raise HTTPException(status_code=500, detail="PyYAML not available")
    p = SRC_CONFIG_DIR / f"{config_name}.yaml"
    with open(p, "w", encoding="utf-8") as f:
        yaml.safe_dump(payload, f, sort_keys=False, allow_unicode=True)
    return {"status": "ok", "config": payload}


@router.get("/stats", response_model=DatasetStats)
async def get_dataset_stats(dataset: Optional[str] = Query(default=None)):
    ds_dir = _resolve_dataset_dir(dataset)
    train_path = ds_dir / "train" / "images"
    val_path = ds_dir / "val" / "images"

    train_count = len(glob.glob(str(train_path / "*.png"))) + len(glob.glob(str(train_path / "*.jpg")))
    val_count = len(glob.glob(str(val_path / "*.png"))) + len(glob.glob(str(val_path / "*.jpg")))

    yaml_file = ds_dir / "data.yaml"
    yaml_data = {}
    if yaml_file.exists() and yaml is not None:
        try:
            yaml_data = yaml.safe_load(yaml_file.read_text(encoding="utf-8")) or {}
        except Exception:
            pass

    return DatasetStats(
        train_count=train_count,
        val_count=val_count,
        total_count=train_count + val_count,
        dataset_name=ds_dir.name,
        path=str(ds_dir.relative_to(PROJECT_ROOT)) if str(ds_dir).startswith(str(PROJECT_ROOT)) else str(ds_dir),
        classes=yaml_data.get("names", {0: "WindTurbine"}),
        kpt_shape=yaml_data.get("kpt_shape", [14, 3]),
    )


@router.get("/images/{subset}", response_model=List[str])
async def list_images(subset: str, dataset: Optional[str] = Query(default=None)):
    if subset not in ["train", "val"]:
        raise HTTPException(status_code=400, detail="Invalid subset. Use 'train' or 'val'")

    ds_dir = _resolve_dataset_dir(dataset)
    path = ds_dir / subset / "images"
    if not path.exists():
        return []

    files = sorted([f for f in os.listdir(path) if f.lower().endswith((".png", ".jpg", ".jpeg"))])
    return files


@router.get("/file/{subset}/images/{filename}")
async def get_image(subset: str, filename: str, dataset: Optional[str] = Query(default=None)):
    if subset not in ["train", "val"]:
        raise HTTPException(status_code=400, detail="Invalid subset")

    ds_dir = _resolve_dataset_dir(dataset)
    file_path = ds_dir / subset / "images" / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Image not found")

    return FileResponse(str(file_path))


@router.get("/file/{subset}/labels/{filename}")
async def get_label(subset: str, filename: str, dataset: Optional[str] = Query(default=None)):
    if subset not in ["train", "val"]:
        raise HTTPException(status_code=400, detail="Invalid subset")

    ds_dir = _resolve_dataset_dir(dataset)
    label_filename = os.path.splitext(filename)[0] + ".txt"
    file_path = ds_dir / subset / "labels" / label_filename

    if not file_path.exists():
        return {"content": "No label file found"}

    return {"content": file_path.read_text(encoding="utf-8")}


@router.put("/file/{subset}/labels/{filename}")
async def update_label(
    subset: str,
    filename: str,
    payload: Dict[str, Any] = Body(...),
    dataset: Optional[str] = Query(default=None),
):
    if subset not in ["train", "val"]:
        raise HTTPException(status_code=400, detail="Invalid subset")

    ds_dir = _resolve_dataset_dir(dataset)
    lbl_dir = ds_dir / subset / "labels"
    lbl_dir.mkdir(parents=True, exist_ok=True)
    label_filename = os.path.splitext(filename)[0] + ".txt"
    file_path = lbl_dir / label_filename
    content = str(payload.get("content", ""))
    file_path.write_text(content, encoding="utf-8")
    return {"status": "saved", "filename": label_filename}


@router.delete("/file/{subset}/{filename}")
async def delete_dataset_sample(
    subset: str,
    filename: str,
    dataset: Optional[str] = Query(default=None),
):
    if subset not in ["train", "val"]:
        raise HTTPException(status_code=400, detail="Invalid subset")

    ds_dir = _resolve_dataset_dir(dataset)
    img_path = ds_dir / subset / "images" / filename
    lbl_path = ds_dir / subset / "labels" / (os.path.splitext(filename)[0] + ".txt")
    if img_path.exists():
        img_path.unlink()
    if lbl_path.exists():
        lbl_path.unlink()
    return {"status": "deleted", "filename": filename}


@router.post("/upload/{subset}")
async def upload_dataset_files(
    subset: str,
    files: List[UploadFile] = File(...),
    dataset: Optional[str] = Query(default=None),
):
    if subset not in ["train", "val"]:
        raise HTTPException(status_code=400, detail="Invalid subset")

    ds_dir = _resolve_dataset_dir(dataset)
    img_dir = ds_dir / subset / "images"
    lbl_dir = ds_dir / subset / "labels"
    img_dir.mkdir(parents=True, exist_ok=True)
    lbl_dir.mkdir(parents=True, exist_ok=True)

    saved = []
    for f in files:
        safe_name = os.path.basename(f.filename or "upload")
        ext = os.path.splitext(safe_name)[1].lower()
        target_dir = lbl_dir if ext == ".txt" else img_dir
        dest = target_dir / safe_name
        with open(dest, "wb") as out:
            shutil.copyfileobj(f.file, out)
        saved.append(safe_name)

    return {"status": "uploaded", "files": saved, "count": len(saved)}
