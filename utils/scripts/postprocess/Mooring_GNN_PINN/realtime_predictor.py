"""Real-time Mooring Digital Twin predictor using MooringPIGNN.

Bridges 6-DOF vision pose telemetry (from orientation.py / keypoints.csv / MQTT oc4/pose)
to real-time 3D mooring line geometry, segment tension profiles, Touchdown Zone (TDZ)
tracking, API RP 2SK safety factors, T-N fatigue damage, and SHM fault classification.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

if __package__ is None or __package__ == "":
    _pkg_parent = str(Path(__file__).resolve().parent.parent)
    if _pkg_parent not in sys.path:
        sys.path.insert(0, _pkg_parent)
    __package__ = "Mooring_GNN_PINN"

import numpy as np
import torch
import yaml

from .graph_builder import MooringGraphBuilder
from .models import MooringPIGNN
from .physics_catenary import OC4MooringConfig, SHM_CLASSES


_DEFAULT_CONFIG_PATH = Path(__file__).parent / "config" / "mooring_gnn_pinn.yaml"


class MooringRealtimePredictor:
    """Real-time inference engine wrapping MooringPIGNN + ElasticCatenarySolver."""

    def __init__(
        self,
        config_path: Union[str, Path] = _DEFAULT_CONFIG_PATH,
        checkpoint_path: Optional[Union[str, Path]] = None,
        device: str = "cpu",
    ) -> None:
        self.config_path = Path(config_path)
        with open(self.config_path, "r", encoding="utf-8") as fh:
            self.raw_cfg = yaml.safe_load(fh) or {}

        self.cfg = OC4MooringConfig.from_yaml(self.config_path)
        self.device = torch.device(device)
        self.builder = MooringGraphBuilder(self.cfg)

        model_cfg = self.raw_cfg.get("model", {})
        self.model = MooringPIGNN(
            cfg=self.cfg,
            hidden_dim=int(model_cfg.get("hidden_dim", 128)),
            num_mp_layers=int(model_cfg.get("num_mp_layers", 6)),
            dropout=float(model_cfg.get("dropout", 0.05)),
        ).to(self.device)

        self.checkpoint_loaded = False
        if checkpoint_path is not None and Path(checkpoint_path).exists():
            state = torch.load(checkpoint_path, map_location=self.device, weights_only=False)
            model_state = state["model_state_dict"] if "model_state_dict" in state else state
            self.model.load_state_dict(model_state)
            self.checkpoint_loaded = True
        else:
            default_ckpt = Path(
                self.raw_cfg.get("training", {}).get(
                    "checkpoint_dir",
                    "utils/scripts/postprocess/Mooring_GNN_PINN/checkpoints",
                )
            ) / "mooring_pignn_best.pt"
            if default_ckpt.exists():
                state = torch.load(default_ckpt, map_location=self.device, weights_only=False)
                model_state = state["model_state_dict"] if "model_state_dict" in state else state
                self.model.load_state_dict(model_state)
                self.checkpoint_loaded = True

        self.model.eval()
        self._prev_pose: Optional[np.ndarray] = None
        self._accumulated_fatigue_damage = np.zeros(self.cfg.num_lines, dtype=np.float64)
        self._prev_fairlead_tensions = np.zeros(self.cfg.num_lines, dtype=np.float64)

    def reset_state(self) -> None:
        """Reset temporal velocity & fatigue accumulation state."""
        self._prev_pose = None
        self._accumulated_fatigue_damage.fill(0.0)
        self._prev_fairlead_tensions.fill(0.0)

    def _update_fatigue_tn(self, fairlead_tensions_N: np.ndarray) -> np.ndarray:
        """Estimate per-step T-N fatigue increment (DNV-OS-E301 / API RP 2SK)."""
        increments = np.zeros(self.cfg.num_lines, dtype=np.float64)
        mbl = self.cfg.minimum_breaking_load_N
        k_tn = self.cfg.tn_curve_K
        m_tn = self.cfg.tn_curve_m

        if np.any(self._prev_fairlead_tensions > 0.0):
            delta_t = np.abs(fairlead_tensions_N - self._prev_fairlead_tensions)
            stress_ratio = np.clip(delta_t / mbl, 1e-6, 1.0)
            # Only accumulate meaningful cyclic variations (> 0.5% MBL)
            active = stress_ratio > 0.005
            n_cycles = k_tn * np.power(stress_ratio, -m_tn)
            increments[active] = 1.0 / np.maximum(n_cycles[active], 1.0)
            self._accumulated_fatigue_damage += increments

        self._prev_fairlead_tensions = fairlead_tensions_N.copy()
        return increments

    @torch.no_grad()
    def predict_from_pose(
        self,
        pose_6dof: Union[List[float], np.ndarray],
        env_4: Optional[Union[List[float], np.ndarray]] = None,
        vel_6dof: Optional[Union[List[float], np.ndarray]] = None,
        dt: float = 0.08,
        from_model_scale: Optional[bool] = None,
    ) -> Dict[str, Any]:
        """Run single-frame GNN+PINN inference from 6-DOF platform pose.

        Args:
            pose_6dof: [surge, sway, heave, roll_rad, pitch_rad, yaw_rad]
            env_4: [Hs_m, Tp_s, U_wind_ms, U_curr_ms]
            vel_6dof: optional [vx, vy, vz, wx, wy, wz]; estimated via finite diff if None.
            dt: timestep in seconds (in input scale) used if vel_6dof is None.
            from_model_scale: overrides cfg.input_is_model_scale when provided.
        """
        t0 = time.perf_counter()
        pose_arr = np.asarray(pose_6dof, dtype=np.float64)

        if vel_6dof is None:
            if self._prev_pose is not None and dt > 1e-4:
                vel_arr = (pose_arr - self._prev_pose) / dt
            else:
                vel_arr = np.zeros(6, dtype=np.float64)
        else:
            vel_arr = np.asarray(vel_6dof, dtype=np.float64)

        self._prev_pose = pose_arr.copy()

        env_arr = (
            np.array([1.5, 10.0, 8.0, 0.5], dtype=np.float64)
            if env_4 is None
            else np.asarray(env_4, dtype=np.float64)
        )

        sample = self.builder.build_sample_dict_from_pose(
            pose_arr,
            vel_arr,
            env_arr,
            from_model_scale=from_model_scale,
        )
        batch = self.builder.collate_samples([sample]).to(self.device)
        preds = self.model(batch)

        pos_pred = preds["pos_pred"][0].cpu().numpy()               # (K, N, 3) [m]
        vel_pred = preds["vel_pred"][0].cpu().numpy()               # (K, N, 3) [m/s]
        td_prob = preds["touchdown_prob"][0].cpu().numpy()          # (K, N)
        tensions_N = preds["tension_pred"][0].cpu().numpy()         # (K, S) [N]
        shm_probs = preds["shm_probs"][0].cpu().numpy()             # (K, 5)
        health_factors = preds["health_factors"][0].cpu().numpy()   # (K, 2)

        # Also extract analytical catenary baseline for transparency & fallback comparison
        cat_sols = self.builder.solver.solve_all_lines(
            self.builder.kinematics, sample["pose_6dof"]
        )

        fairlead_tensions_N = tensions_N[:, -1] if self.checkpoint_loaded else np.array(
            [c["T_fairlead"] for c in cat_sols], dtype=np.float64
        )
        anchor_tensions_N = tensions_N[:, 0] if self.checkpoint_loaded else np.array(
            [c["T_anchor"] for c in cat_sols], dtype=np.float64
        )
        segment_tensions_N = tensions_N if self.checkpoint_loaded else np.stack(
            [c["tensions"] for c in cat_sols], axis=0
        )

        fatigue_inc = self._update_fatigue_tn(fairlead_tensions_N)

        # Compute resultant mooring restoring force at platform fairleads
        total_fx = 0.0
        total_fy = 0.0
        total_fz = 0.0
        lines_summary = []

        seg_len = self.cfg.segment_length_m
        for k in range(self.cfg.num_lines):
            # Fairlead tangent direction pointing from last interior node to fairlead
            tangent = pos_pred[k, -1] - pos_pred[k, -2]
            t_norm = float(np.linalg.norm(tangent))
            if t_norm > 1e-6:
                dir_vec = tangent / t_norm
                # Force on platform pulls along -dir_vec
                t_fair = float(fairlead_tensions_N[k])
                total_fx -= t_fair * float(dir_vec[0])
                total_fy -= t_fair * float(dir_vec[1])
                total_fz -= t_fair * float(dir_vec[2])
            else:
                t_fair = float(fairlead_tensions_N[k])

            t_anch = float(anchor_tensions_N[k])
            sf = float(self.cfg.minimum_breaking_load_N / max(t_fair, 1.0))

            # Touchdown index: highest node index still in seabed contact (p_td >= 0.5)
            contact_nodes = np.where(td_prob[k] >= 0.5)[0]
            tdp_idx = int(contact_nodes.max()) if len(contact_nodes) > 0 else 0
            laid_len = float(tdp_idx * seg_len) if self.checkpoint_loaded else float(cat_sols[k]["laid_length_m"])

            cls_idx = int(np.argmax(shm_probs[k])) if self.checkpoint_loaded else 0
            lines_summary.append(
                {
                    "id": k + 1,
                    "azimuth_deg": self.cfg.line_angles_deg[k],
                    "tension_fairlead_kN": round(t_fair / 1000.0, 2),
                    "tension_anchor_kN": round(t_anch / 1000.0, 2),
                    "safety_factor": round(sf, 3),
                    "laid_length_m": round(laid_len, 2),
                    "touchdown_node_idx": tdp_idx,
                    "shm_status": SHM_CLASSES[cls_idx],
                    "shm_probabilities": {
                        SHM_CLASSES[c]: round(float(shm_probs[k, c]), 4)
                        for c in range(len(SHM_CLASSES))
                    },
                    "ea_health_ratio": round(float(health_factors[k, 0]), 4),
                    "weight_ratio": round(float(health_factors[k, 1]), 4),
                    "fatigue_damage_accumulated": round(float(self._accumulated_fatigue_damage[k]), 8),
                    "fatigue_damage_step": round(float(fatigue_inc[k]), 8),
                }
            )

        elapsed_ms = (time.perf_counter() - t0) * 1000.0

        return {
            "mode": "pignn+catenary" if self.checkpoint_loaded else "catenary_prior_untrained_pignn",
            "inference_ms": round(elapsed_ms, 2),
            "platform_pose_prototype": {
                "surge_m": round(float(sample["pose_6dof"][0]), 3),
                "sway_m": round(float(sample["pose_6dof"][1]), 3),
                "heave_m": round(float(sample["pose_6dof"][2]), 3),
                "roll_deg": round(math.degrees(float(sample["pose_6dof"][3])), 3),
                "pitch_deg": round(math.degrees(float(sample["pose_6dof"][4])), 3),
                "yaw_deg": round(math.degrees(float(sample["pose_6dof"][5])), 3),
            },
            "mooring": {
                "lines": lines_summary,
                "total_horizontal_force_kN": round(math.hypot(total_fx, total_fy) / 1000.0, 2),
                "total_vertical_force_kN": round(total_fz / 1000.0, 2),
                "nodes_3d_m": np.round(pos_pred, 3).tolist(),
                "velocities_3d_ms": np.round(vel_pred, 4).tolist(),
                "segment_tensions_kN": np.round(segment_tensions_N / 1000.0, 2).tolist(),
                "touchdown_probabilities": np.round(td_prob, 3).tolist(),
            },
        }

    def predict_from_mqtt_payload(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Parse an MQTT oc4/pose JSON payload and predict mooring state."""
        nav = payload.get("navigation", payload)
        pos = nav.get("position", {})
        pose = np.array(
            [
                float(pos.get("x", nav.get("surge", 0.0))),
                float(pos.get("y", nav.get("sway", 0.0))),
                float(pos.get("z", nav.get("heave", 0.0))),
                math.radians(float(nav.get("roll", 0.0))),
                math.radians(float(nav.get("pitch", 0.0))),
                math.radians(float(nav.get("yaw", 0.0))),
            ],
            dtype=np.float64,
        )
        env = payload.get("environment", {})
        env_4 = np.array(
            [
                float(env.get("waveHeight", 1.5)),
                float(env.get("wavePeriod", 10.0)),
                float(env.get("windSpeed", 8.0)),
                float(env.get("currentSpeed", 0.5)),
            ],
            dtype=np.float64,
        )
        return self.predict_from_pose(pose, env_4=env_4)


def load_poses_from_csv(
    csv_path: Union[str, Path],
    max_frames: Optional[int] = None,
    max_tilt_deg: float = 20.0,
) -> Tuple[np.ndarray, np.ndarray, int]:
    """Load 6-DOF trajectory from a pose_detection.py keypoints.csv recording.

    Filters severe single-frame PnP outliers and converts camera-relative offsets
    to platform relative displacements [surge, sway, heave, roll_rad, pitch_rad, yaw_rad].

    Returns:
        poses (T, 6), timestamps_s (T,), num_outliers_filtered
    """
    rows: List[Dict[str, float]] = []
    with open(csv_path, "r", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
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

    if not rows:
        raise ValueError(f"No rows found in CSV: {csv_path}")

    # Filter PnP outliers (frames where orientation jumps unrealistically)
    valid_rows: List[Dict[str, float]] = []
    outliers = 0
    for r in rows:
        if abs(r["pitch"]) > max_tilt_deg or abs(r["roll"]) > max_tilt_deg or abs(r["yaw"]) > max_tilt_deg:
            outliers += 1
            continue
        valid_rows.append(r)

    if not valid_rows:
        valid_rows = rows

    if max_frames is not None:
        valid_rows = valid_rows[:max_frames]

    ref = valid_rows[0]
    poses = []
    times = []
    for r in valid_rows:
        # Map camera axes (z: depth->surge, x: lateral->sway, -y: up->heave)
        surge = float(np.clip(r["dz"] - ref["dz"], -0.25, 0.25))
        sway = float(np.clip(r["dx"] - ref["dx"], -0.25, 0.25))
        heave = float(np.clip(-(r["dy"] - ref["dy"]), -0.10, 0.10))
        roll_rad = math.radians(r["roll"])
        pitch_rad = math.radians(r["pitch"])
        yaw_rad = math.radians(r["yaw"])
        poses.append([surge, sway, heave, roll_rad, pitch_rad, yaw_rad])
        times.append(r["time_s"])

    return np.asarray(poses, dtype=np.float64), np.asarray(times, dtype=np.float64), outliers


def main() -> None:
    parser = argparse.ArgumentParser(description="Real-time OC4 Mooring GNN+PINN Predictor")
    parser.add_argument("--config", type=str, default=str(_DEFAULT_CONFIG_PATH))
    parser.add_argument("--checkpoint", type=str, default=None)
    parser.add_argument("--csv", type=str, default=None, help="Path to keypoints.csv recording")
    parser.add_argument("--max-frames", type=int, default=5)
    parser.add_argument("--device", type=str, default="cpu")
    args = parser.parse_args()

    predictor = MooringRealtimePredictor(
        config_path=args.config,
        checkpoint_path=args.checkpoint,
        device=args.device,
    )

    if args.csv:
        poses, times, outliers = load_poses_from_csv(args.csv, max_frames=args.max_frames)
        print(
            f"[MooringPredictor] Loaded {len(poses)} valid frames from {args.csv} "
            f"(filtered {outliers} PnP outliers)."
        )
        for idx, pose in enumerate(poses):
            dt = float(times[idx] - times[idx - 1]) if idx > 0 else 0.08
            res = predictor.predict_from_pose(pose, dt=max(dt, 1e-3))
            lines_str = " | ".join(
                f"L{ln['id']}: {ln['tension_fairlead_kN']:.1f} kN (SF={ln['safety_factor']:.2f}, "
                f"TD={ln['laid_length_m']:.0f}m, {ln['shm_status']})"
                for ln in res["mooring"]["lines"]
            )
            print(
                f"  Frame {idx:02d} | {res['inference_ms']:.1f} ms | "
                f"Surge={res['platform_pose_prototype']['surge_m']:+.2f}m | {lines_str}"
            )
    else:
        demo_pose = np.array([0.05, 0.01, -0.005, 0.02, 0.03, 0.01], dtype=np.float64)
        res = predictor.predict_from_pose(demo_pose)
        print(json.dumps({k: v for k, v in res.items() if k != "mooring"}, indent=2))
        print("Lines:", json.dumps(res["mooring"]["lines"], indent=2))


if __name__ == "__main__":
    main()
