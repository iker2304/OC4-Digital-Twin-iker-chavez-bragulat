"""Mooring GNN + PINN Digital Twin API Router.

REST:
  GET  /api/mooring/architecture        - Combined GNN + PINN architecture metadata
  POST /api/mooring/predict             - Predict 3D mooring lines from 6-DOF pose + env
  GET  /api/mooring/recordings          - List available keypoints.csv recordings
  GET  /api/mooring/recordings/{rec_id} - Evaluate frames from a real recording
WS:
  WS   /api/mooring/ws/live             - Real-time mooring predictions from latest_twin_data
"""

from __future__ import annotations

import asyncio
import csv
import math
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import yaml
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

try:
    from app.api.twin import latest_twin_data
except Exception:
    latest_twin_data = {"navigation": {"roll": 0, "pitch": 0, "yaw": 0, "position": {"x": 0, "y": 0, "z": 0}}}

router = APIRouter()

_REPO_ROOT = Path(__file__).resolve().parents[3]
_MOORING_PKG_PARENT = _REPO_ROOT / "utils" / "scripts" / "postprocess"
_MOORING_CFG_PATH = _MOORING_PKG_PARENT / "Mooring_GNN_PINN" / "config" / "mooring_gnn_pinn.yaml"
_RECORDINGS_DIR = _REPO_ROOT / "results" / "recordings"

if str(_MOORING_PKG_PARENT) not in sys.path:
    sys.path.insert(0, str(_MOORING_PKG_PARENT))

_PREDICTOR = None
_TORCH_ENGINE_AVAILABLE = False
_IMPORT_ERROR: Optional[str] = None

try:
    from Mooring_GNN_PINN.realtime_predictor import MooringRealtimePredictor, load_poses_from_csv
    _TORCH_ENGINE_AVAILABLE = True
except Exception as exc:
    _IMPORT_ERROR = str(exc)


def _get_predictor():
    global _PREDICTOR
    if not _TORCH_ENGINE_AVAILABLE:
        return None
    if _PREDICTOR is None:
        _PREDICTOR = MooringRealtimePredictor(config_path=_MOORING_CFG_PATH, device="cpu")
    return _PREDICTOR


def _load_yaml_cfg() -> Dict[str, Any]:
    if _MOORING_CFG_PATH.exists():
        with open(_MOORING_CFG_PATH, "r", encoding="utf-8") as fh:
            return yaml.safe_load(fh) or {}
    return {}


# ── Pure-NumPy fallback elastic catenary (used when torch/scipy not in backend venv) ──
def _numpy_rotation_zyx(roll: float, pitch: float, yaw: float) -> np.ndarray:
    cr, sr = math.cos(roll), math.sin(roll)
    cp, sp = math.cos(pitch), math.sin(pitch)
    cy, sy = math.cos(yaw), math.sin(yaw)
    rx = np.array([[1.0, 0.0, 0.0], [0.0, cr, -sr], [0.0, sr, cr]])
    ry = np.array([[cp, 0.0, sp], [0.0, 1.0, 0.0], [-sp, 0.0, cp]])
    rz = np.array([[cy, -sy, 0.0], [sy, cy, 0.0], [0.0, 0.0, 1.0]])
    return rz @ ry @ rx


def _numpy_catenary_predict(
    pose_6dof: np.ndarray,
    env_4: np.ndarray,
    from_model_scale: bool = False,
) -> Dict[str, Any]:
    t0 = time.perf_counter()
    cfg = _load_yaml_cfg()
    plat = cfg.get("platform", {})
    line_cfg = cfg.get("line_properties", {})
    scale_cfg = cfg.get("scale", {})
    graph_cfg = cfg.get("graph", {})

    angles_deg = [float(a) for a in plat.get("line_angles_deg", [180.0, 60.0, 300.0])]
    water_depth = float(plat.get("water_depth_m", 200.0))
    r_fair = float(plat.get("fairlead_radius_m", 40.868))
    z_fair0 = -float(plat.get("fairlead_depth_m", 14.0))
    r_anch = float(plat.get("anchor_radius_m", 837.6))
    z_anch = -float(plat.get("anchor_depth_m", 200.0))
    L0 = float(line_cfg.get("unstretched_length_m", 835.5))
    EA = float(line_cfg.get("axial_stiffness_N", 753.6e6))
    w = float(line_cfg.get("submerged_mass_per_unit_length_kg_m", 108.63)) * 9.81
    mbl = float(line_cfg.get("minimum_breaking_load_N", 10.0e6))
    n_seg = int(graph_cfg.get("segments_per_line", 20))
    n_nodes = n_seg + 1
    lam = float(scale_cfg.get("froude_lambda", 100.0))

    pose = pose_6dof.astype(np.float64).copy()
    if from_model_scale:
        pose[:3] *= lam

    R = _numpy_rotation_zyx(pose[3], pose[4], pose[5])
    lines_out = []
    nodes_3d_all = []
    seg_tensions_all = []
    td_probs_all = []
    total_fx = total_fy = total_fz = 0.0

    for idx, ang_deg in enumerate(angles_deg):
        rad = math.radians(ang_deg)
        ca, sa = math.cos(rad), math.sin(rad)
        anchor = np.array([r_anch * ca, r_anch * sa, z_anch])
        fair_loc = np.array([r_fair * ca, r_fair * sa, z_fair0])
        fair = pose[:3] + R @ fair_loc

        delta = fair - anchor
        X_F = float(math.hypot(delta[0], delta[1]))
        Z_F = float(delta[2])
        er_x, er_y = (delta[0] / X_F, delta[1] / X_F) if X_F > 1e-6 else (1.0, 0.0)

        def eval_res(log_h: float, v_val: float):
            H = math.exp(max(math.log(10.0), min(math.log(5e8), log_h)))
            if v_val <= w * L0:
                l_b = L0 - v_val / w
                x_c = l_b + (H / w) * math.asinh(v_val / H) + (H * L0) / EA
                z_c = (H / w) * (math.sqrt(1.0 + (v_val / H) ** 2) - 1.0) + (v_val ** 2) / (2.0 * w * EA)
            else:
                v_a = v_val - w * L0
                x_c = (H / w) * (math.asinh((v_a + w * L0) / H) - math.asinh(v_a / H)) + (H * L0) / EA
                z_c = (H / w) * (
                    math.sqrt(1.0 + ((v_a + w * L0) / H) ** 2) - math.sqrt(1.0 + (v_a / H) ** 2)
                ) + (v_a * L0 + 0.5 * w * L0 ** 2) / EA
            return (x_c - X_F) / L0, (z_c - Z_F) / L0

        best_lh, best_v, best_err = math.log(7e5), 0.7 * w * L0, float("inf")
        for g_lh, g_v in [(math.log(7e5), 0.7 * w * L0), (math.log(2e6), 0.8 * w * L0)]:
            lh, v_val = g_lh, g_v
            for _ in range(30):
                f1, f2 = eval_res(lh, v_val)
                err = math.hypot(f1, f2)
                if err < best_err:
                    best_err, best_lh, best_v = err, lh, v_val
                if err < 1e-9:
                    break
                eps_h = 1e-4
                eps_v = max(10.0, abs(v_val) * 1e-5)
                f1h, f2h = eval_res(lh + eps_h, v_val)
                f1v, f2v = eval_res(lh, v_val + eps_v)
                j11, j21 = (f1h - f1) / eps_h, (f2h - f2) / eps_h
                j12, j22 = (f1v - f1) / eps_v, (f2v - f2) / eps_v
                det = j11 * j22 - j12 * j21
                if abs(det) < 1e-16:
                    break
                dlh = max(-1.0, min(1.0, (-f1 * j22 + f2 * j12) / det))
                dv = max(-0.25 * w * L0, min(0.25 * w * L0, (-j11 * f2 + j21 * f1) / det))
                lh += dlh
                v_val = max(100.0, v_val + dv)
            if best_err < 1e-7:
                break

        H = math.exp(max(math.log(10.0), min(math.log(5e8), best_lh)))
        V = best_v
        L_B = max(0.0, L0 - V / w) if V <= w * L0 else 0.0
        V_A = 0.0 if V <= w * L0 else V - w * L0

        nodes = np.zeros((n_nodes, 3))
        t_node = np.zeros(n_nodes)
        td_prob = np.zeros(n_nodes)
        for j in range(n_nodes):
            s = (j * L0) / n_seg
            if L_B > 0.0:
                if s <= L_B:
                    xl, zl, tn = s * (1.0 + H / EA), 0.0, H
                else:
                    ss = s - L_B
                    vs = w * ss
                    xl = L_B * (1.0 + H / EA) + (H / w) * math.asinh(vs / H) + (H * ss) / EA
                    zl = (H / w) * (math.sqrt(1.0 + (vs / H) ** 2) - 1.0) + (vs ** 2) / (2.0 * w * EA)
                    tn = math.hypot(H, vs)
            else:
                vs = V_A + w * s
                xl = (H / w) * (math.asinh(vs / H) - math.asinh(V_A / H)) + (H * s) / EA
                zl = (H / w) * (math.sqrt(1.0 + (vs / H) ** 2) - math.sqrt(1.0 + (V_A / H) ** 2)) + (
                    V_A * s + 0.5 * w * s ** 2
                ) / EA
                tn = math.hypot(H, vs)

            if j == 0:
                xl, zl = 0.0, 0.0
            elif j == n_nodes - 1:
                xl, zl = X_F, Z_F

            nodes[j] = [anchor[0] + xl * er_x, anchor[1] + xl * er_y, max(-water_depth, anchor[2] + zl)]
            t_node[j] = tn
            td_prob[j] = 1.0 if nodes[j, 2] <= (-water_depth + 0.25) else 0.0

        seg_t = 0.5 * (t_node[:-1] + t_node[1:]) / 1000.0
        t_fair_kn = float(t_node[-1] / 1000.0)
        t_anch_kn = float(t_node[0] / 1000.0)
        tang = nodes[-1] - nodes[-2]
        tnorm = float(np.linalg.norm(tang))
        if tnorm > 1e-6:
            dvec = tang / tnorm
            total_fx -= t_node[-1] * float(dvec[0])
            total_fy -= t_node[-1] * float(dvec[1])
            total_fz -= t_node[-1] * float(dvec[2])

        tdp_nodes = np.where(td_prob >= 0.5)[0]
        tdp_idx = int(tdp_nodes.max()) if len(tdp_nodes) > 0 else 0

        lines_out.append(
            {
                "id": idx + 1,
                "azimuth_deg": ang_deg,
                "tension_fairlead_kN": round(t_fair_kn, 2),
                "tension_anchor_kN": round(t_anch_kn, 2),
                "safety_factor": round((mbl / 1000.0) / max(t_fair_kn, 0.1), 3),
                "laid_length_m": round(L_B, 2),
                "touchdown_node_idx": tdp_idx,
                "shm_status": "HEALTHY",
                "shm_probabilities": {
                    "HEALTHY": 1.0,
                    "PRETENSION_LOSS": 0.0,
                    "STIFFNESS_DEGRADATION": 0.0,
                    "BIOFOULING": 0.0,
                    "LINE_BREAKAGE": 0.0,
                },
                "ea_health_ratio": 1.0,
                "weight_ratio": 1.0,
                "fatigue_damage_accumulated": 0.0,
                "fatigue_damage_step": 0.0,
            }
        )
        nodes_3d_all.append(np.round(nodes, 3).tolist())
        seg_tensions_all.append(np.round(seg_t, 2).tolist())
        td_probs_all.append(np.round(td_prob, 3).tolist())

    elapsed_ms = (time.perf_counter() - t0) * 1000.0
    return {
        "mode": "numpy_elastic_catenary_fallback",
        "inference_ms": round(elapsed_ms, 2),
        "platform_pose_prototype": {
            "surge_m": round(float(pose[0]), 3),
            "sway_m": round(float(pose[1]), 3),
            "heave_m": round(float(pose[2]), 3),
            "roll_deg": round(math.degrees(float(pose[3])), 3),
            "pitch_deg": round(math.degrees(float(pose[4])), 3),
            "yaw_deg": round(math.degrees(float(pose[5])), 3),
        },
        "mooring": {
            "lines": lines_out,
            "total_horizontal_force_kN": round(math.hypot(total_fx, total_fy) / 1000.0, 2),
            "total_vertical_force_kN": round(total_fz / 1000.0, 2),
            "nodes_3d_m": nodes_3d_all,
            "segment_tensions_kN": seg_tensions_all,
            "touchdown_probabilities": td_probs_all,
        },
    }


def _fallback_load_csv(csv_path: Path, max_frames: int = 30) -> tuple[np.ndarray, np.ndarray, int]:
    rows = []
    with open(csv_path, "r", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            rows.append(
                {
                    "time_s": float(row["time_s"]),
                    "pitch": float(row["pitch"]),
                    "roll": float(row["roll"]),
                    "yaw": float(row["yaw"]),
                    "dx": float(row["distance_x"]),
                    "dy": float(row["distance_y"]),
                    "dz": float(row["distance_z"]),
                }
            )
    valid = [r for r in rows if abs(r["pitch"]) <= 20 and abs(r["roll"]) <= 20 and abs(r["yaw"]) <= 20]
    outliers = len(rows) - len(valid)
    if not valid:
        valid = rows
    valid = valid[:max_frames]
    ref = valid[0]
    poses = np.array(
        [
            [
                float(np.clip(r["dz"] - ref["dz"], -0.25, 0.25)),
                float(np.clip(r["dx"] - ref["dx"], -0.25, 0.25)),
                float(np.clip(-(r["dy"] - ref["dy"]), -0.10, 0.10)),
                math.radians(r["roll"]),
                math.radians(r["pitch"]),
                math.radians(r["yaw"]),
            ]
            for r in valid
        ],
        dtype=np.float64,
    )
    times = np.array([r["time_s"] for r in valid], dtype=np.float64)
    return poses, times, outliers


# ── Pydantic Models ────────────────────────────────────────────────────────────
class MooringPredictRequest(BaseModel):
    surge: float = 0.0
    sway: float = 0.0
    heave: float = 0.0
    roll_deg: float = 0.0
    pitch_deg: float = 0.0
    yaw_deg: float = 0.0
    wave_height: float = 1.5
    wave_period: float = 10.0
    wind_speed: float = 8.0
    current_speed: float = 0.5
    from_model_scale: bool = False


# ── REST Endpoints ─────────────────────────────────────────────────────────────
@router.get("/architecture")
async def get_mooring_architecture():
    """Return metadata describing the combined GNN + PINN neural architecture."""
    raw_cfg = _load_yaml_cfg()
    predictor = _get_predictor()
    ckpt_exists = bool(predictor and predictor.checkpoint_loaded)
    param_count = (
        sum(p.numel() for p in predictor.model.parameters())
        if predictor is not None
        else 1312018
    )

    return {
        "torch_engine_available": _TORCH_ENGINE_AVAILABLE,
        "checkpoint_loaded": ckpt_exists,
        "import_note": _IMPORT_ERROR,
        "parameters_count": param_count,
        "config": raw_cfg,
        "graph": {
            "total_nodes": 64,
            "line_nodes": 63,
            "platform_nodes": 1,
            "total_directed_edges": 126,
            "intra_line_edges": 120,
            "coupling_edges": 6,
            "node_feat_dim": 16,
            "edge_feat_dim": 10,
            "global_cond_dim": 16,
        },
        "shm_classes": [
            "HEALTHY",
            "PRETENSION_LOSS",
            "STIFFNESS_DEGRADATION",
            "BIOFOULING",
            "LINE_BREAKAGE",
        ],
    }


@router.post("/predict")
async def predict_mooring(req: MooringPredictRequest):
    """Run GNN+PINN (or analytical catenary fallback) mooring inference for a 6-DOF pose."""
    pose = np.array(
        [
            req.surge,
            req.sway,
            req.heave,
            math.radians(req.roll_deg),
            math.radians(req.pitch_deg),
            math.radians(req.yaw_deg),
        ],
        dtype=np.float64,
    )
    env = np.array([req.wave_height, req.wave_period, req.wind_speed, req.current_speed], dtype=np.float64)

    predictor = _get_predictor()
    if predictor is not None:
        return predictor.predict_from_pose(pose, env_4=env, from_model_scale=req.from_model_scale)
    return _numpy_catenary_predict(pose, env, from_model_scale=req.from_model_scale)


@router.get("/recordings")
async def list_mooring_recordings():
    """List available recordings containing keypoints.csv."""
    if not _RECORDINGS_DIR.exists():
        return {"recordings": []}
    recs = []
    for p in sorted(_RECORDINGS_DIR.iterdir(), reverse=True):
        csv_file = p / "keypoints.csv"
        if p.is_dir() and csv_file.exists():
            recs.append({"id": p.name, "path": str(csv_file)})
    return {"recordings": recs}


@router.get("/recordings/{rec_id}")
async def evaluate_recording(rec_id: str, max_frames: int = 25):
    """Evaluate frames of a recorded keypoints.csv trajectory."""
    csv_path = (_RECORDINGS_DIR / rec_id / "keypoints.csv").resolve()
    if not csv_path.exists() or csv_path.parent.parent != _RECORDINGS_DIR.resolve():
        raise HTTPException(status_code=404, detail="Recording not found")

    if _TORCH_ENGINE_AVAILABLE:
        poses, times, outliers = load_poses_from_csv(csv_path, max_frames=max_frames)
    else:
        poses, times, outliers = _fallback_load_csv(csv_path, max_frames=max_frames)

    predictor = _get_predictor()
    if predictor is not None:
        predictor.reset_state()

    frames = []
    for i, pose in enumerate(poses):
        dt = float(times[i] - times[i - 1]) if i > 0 else 0.08
        if predictor is not None:
            pred = predictor.predict_from_pose(pose, dt=max(dt, 1e-3), from_model_scale=True)
        else:
            pred = _numpy_catenary_predict(pose, np.array([1.5, 10.0, 8.0, 0.5]), from_model_scale=True)
        frames.append({"frame_idx": i, "time_s": round(float(times[i]), 3), **pred})

    return {
        "recording_id": rec_id,
        "valid_frames": len(frames),
        "outliers_filtered": outliers,
        "frames": frames,
    }


@router.websocket("/ws/live")
async def mooring_live_ws(websocket: WebSocket):
    """Stream live mooring predictions derived from latest_twin_data (MQTT oc4/pose)."""
    await websocket.accept()
    predictor = _get_predictor()
    try:
        while True:
            nav = latest_twin_data.get("navigation", {})
            pos = nav.get("position", {})
            pose = np.array(
                [
                    float(pos.get("x", 0.0)),
                    float(pos.get("y", 0.0)),
                    float(pos.get("z", 0.0)),
                    math.radians(float(nav.get("roll", 0.0))),
                    math.radians(float(nav.get("pitch", 0.0))),
                    math.radians(float(nav.get("yaw", 0.0))),
                ],
                dtype=np.float64,
            )
            env = np.array([1.5, 10.0, 8.0, 0.5], dtype=np.float64)
            if predictor is not None:
                res = predictor.predict_from_pose(pose, env_4=env, from_model_scale=True)
            else:
                res = _numpy_catenary_predict(pose, env, from_model_scale=True)
            await websocket.send_json(res)
            await asyncio.sleep(0.1)
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print(f"[Mooring WS] Error: {exc}")
        try:
            await websocket.close()
        except Exception:
            pass
