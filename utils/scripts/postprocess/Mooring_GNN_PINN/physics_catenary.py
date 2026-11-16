"""Physical models for the OC4-DeepCwind Semi-Submersible Mooring System.

Implements:
1. OC4MooringConfig: Geometry, material, hydrodynamic, and seabed parameters
   based on Robertson et al. (2014), NREL/TP-5000-60601, with Froude scaling.
2. PlatformToFairleadKinematics: Exact 6-DOF rigid-body transformation from
   platform pose/velocity (camera PnP / MQTT) to 3D fairlead boundaries.
3. ElasticCatenarySolver: Unified quasi-static elastic catenary solver
   (seabed-contact + fully suspended regimes) for node positions and tensions.
4. generate_synthetic_mooring_sample: Physics-consistent synthetic generator
   covering nominal operation and structural health degradation scenarios.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Union
import math

import numpy as np
from scipy.optimize import root
import torch
import yaml


SHM_CLASSES: List[str] = [
    "HEALTHY",
    "PRETENSION_LOSS",
    "STIFFNESS_DEGRADATION",
    "BIOFOULING",
    "LINE_BREAKAGE",
]
SHM_CLASS_TO_IDX: Dict[str, int] = {name: idx for idx, name in enumerate(SHM_CLASSES)}


@dataclass
class OC4MooringConfig:
    """Physical and numerical parameters for the OC4-DeepCwind 3-line mooring."""

    # Platform & mooring layout (prototype scale)
    num_lines: int = 3
    line_angles_deg: List[float] = field(default_factory=lambda: [180.0, 60.0, 300.0])
    water_depth_m: float = 200.0
    fairlead_radius_m: float = 40.868
    fairlead_depth_m: float = 14.0
    anchor_radius_m: float = 837.6
    anchor_depth_m: float = 200.0

    # Line mechanical properties (prototype scale)
    unstretched_length_m: float = 835.5
    diameter_m: float = 0.0766
    mass_per_unit_length_kg_m: float = 113.35
    submerged_mass_per_unit_length_kg_m: float = 108.63
    axial_stiffness_N: float = 753.6e6
    minimum_breaking_load_N: float = 10.0e6
    internal_damping_Ns: float = 5.0e4
    tn_curve_K: float = 6.0e3
    tn_curve_m: float = 3.0

    # Hydrodynamics
    gravity_m_s2: float = 9.81
    water_density_kg_m3: float = 1025.0
    cd_normal: float = 1.6
    cd_tangential: float = 0.1
    ca_normal: float = 1.0
    ca_tangential: float = 0.0

    # Seabed contact
    seabed_stiffness_N_m2: float = 3.0e6
    seabed_damping_Ns_m2: float = 1.0e4
    seabed_friction_coeff: float = 0.3
    penetration_smoothing_m: float = 0.25

    # Froude scale handling
    froude_lambda: float = 100.0
    input_is_model_scale: bool = True

    # Discretization & model
    segments_per_line: int = 20
    hard_bc: bool = True

    @property
    def nodes_per_line(self) -> int:
        return self.segments_per_line + 1

    @property
    def segment_length_m(self) -> float:
        return self.unstretched_length_m / float(self.segments_per_line)

    @property
    def submerged_weight_N_m(self) -> float:
        return self.submerged_mass_per_unit_length_kg_m * self.gravity_m_s2

    @property
    def seabed_z_m(self) -> float:
        return -self.water_depth_m

    @classmethod
    def from_yaml(cls, yaml_path: Union[str, Path]) -> "OC4MooringConfig":
        """Load OC4 mooring configuration from a YAML file."""
        with open(yaml_path, "r", encoding="utf-8") as fh:
            raw = yaml.safe_load(fh) or {}

        plat = raw.get("platform", {})
        line = raw.get("line_properties", {})
        hydro = raw.get("hydrodynamics", {})
        bed = raw.get("seabed", {})
        scale = raw.get("scale", {})
        graph = raw.get("graph", {})

        return cls(
            num_lines=int(plat.get("num_lines", 3)),
            line_angles_deg=[float(a) for a in plat.get("line_angles_deg", [180.0, 60.0, 300.0])],
            water_depth_m=float(plat.get("water_depth_m", 200.0)),
            fairlead_radius_m=float(plat.get("fairlead_radius_m", 40.868)),
            fairlead_depth_m=float(plat.get("fairlead_depth_m", 14.0)),
            anchor_radius_m=float(plat.get("anchor_radius_m", 837.6)),
            anchor_depth_m=float(plat.get("anchor_depth_m", 200.0)),
            unstretched_length_m=float(line.get("unstretched_length_m", 835.5)),
            diameter_m=float(line.get("diameter_m", 0.0766)),
            mass_per_unit_length_kg_m=float(line.get("mass_per_unit_length_kg_m", 113.35)),
            submerged_mass_per_unit_length_kg_m=float(
                line.get("submerged_mass_per_unit_length_kg_m", 108.63)
            ),
            axial_stiffness_N=float(line.get("axial_stiffness_N", 753.6e6)),
            minimum_breaking_load_N=float(line.get("minimum_breaking_load_N", 10.0e6)),
            internal_damping_Ns=float(line.get("internal_damping_Ns", 5.0e4)),
            tn_curve_K=float(line.get("tn_curve_K", 6.0e3)),
            tn_curve_m=float(line.get("tn_curve_m", 3.0)),
            gravity_m_s2=float(hydro.get("gravity_m_s2", 9.81)),
            water_density_kg_m3=float(hydro.get("water_density_kg_m3", 1025.0)),
            cd_normal=float(hydro.get("cd_normal", 1.6)),
            cd_tangential=float(hydro.get("cd_tangential", 0.1)),
            ca_normal=float(hydro.get("ca_normal", 1.0)),
            ca_tangential=float(hydro.get("ca_tangential", 0.0)),
            seabed_stiffness_N_m2=float(bed.get("vertical_stiffness_N_m2", 3.0e6)),
            seabed_damping_Ns_m2=float(bed.get("vertical_damping_Ns_m2", 1.0e4)),
            seabed_friction_coeff=float(bed.get("friction_coeff", 0.3)),
            penetration_smoothing_m=float(bed.get("penetration_smoothing_m", 0.25)),
            froude_lambda=float(scale.get("froude_lambda", 100.0)),
            input_is_model_scale=bool(scale.get("input_is_model_scale", True)),
            segments_per_line=int(graph.get("segments_per_line", 20)),
            hard_bc=bool(graph.get("hard_bc", True)),
        )


def rotation_matrix_zyx(roll: float, pitch: float, yaw: float) -> np.ndarray:
    """Construct ZYX Euler rotation matrix matching utils/scripts/postprocess/geometry/orientation.py.

    Angles are in radians: roll (X), pitch (Y), yaw (Z).
    """
    cr, sr = math.cos(roll), math.sin(roll)
    cp, sp = math.cos(pitch), math.sin(pitch)
    cy, sy = math.cos(yaw), math.sin(yaw)

    rx = np.array([[1.0, 0.0, 0.0], [0.0, cr, -sr], [0.0, sr, cr]], dtype=np.float64)
    ry = np.array([[cp, 0.0, sp], [0.0, 1.0, 0.0], [-sp, 0.0, cp]], dtype=np.float64)
    rz = np.array([[cy, -sy, 0.0], [sy, cy, 0.0], [0.0, 0.0, 1.0]], dtype=np.float64)
    return rz @ ry @ rx


def rotation_matrix_zyx_torch(euler: torch.Tensor) -> torch.Tensor:
    """Batched ZYX Euler rotation matrix in PyTorch.

    Args:
        euler: Tensor of shape (..., 3) containing [roll, pitch, yaw] in radians.

    Returns:
        Rotation matrices of shape (..., 3, 3).
    """
    roll, pitch, yaw = euler[..., 0], euler[..., 1], euler[..., 2]
    cr, sr = torch.cos(roll), torch.sin(roll)
    cp, sp = torch.cos(pitch), torch.sin(pitch)
    cy, sy = torch.cos(yaw), torch.sin(yaw)

    r00 = cy * cp
    r01 = cy * sp * sr - sy * cr
    r02 = cy * sp * cr + sy * sr

    r10 = sy * cp
    r11 = sy * sp * sr + cy * cr
    r12 = sy * sp * cr - cy * sr

    r20 = -sp
    r21 = cp * sr
    r22 = cp * cr

    row0 = torch.stack([r00, r01, r02], dim=-1)
    row1 = torch.stack([r10, r11, r12], dim=-1)
    row2 = torch.stack([r20, r21, r22], dim=-1)
    return torch.stack([row0, row1, row2], dim=-2)


class PlatformToFairleadKinematics:
    """Transforms platform 6-DOF pose and velocity to exact 3D anchor and fairlead boundary states."""

    def __init__(self, cfg: OC4MooringConfig) -> None:
        self.cfg = cfg
        angles_rad = np.radians(cfg.line_angles_deg)

        self.anchor_positions = np.stack(
            [
                cfg.anchor_radius_m * np.cos(angles_rad),
                cfg.anchor_radius_m * np.sin(angles_rad),
                np.full_like(angles_rad, -cfg.anchor_depth_m),
            ],
            axis=-1,
        ).astype(np.float64)

        self.fairlead_local = np.stack(
            [
                cfg.fairlead_radius_m * np.cos(angles_rad),
                cfg.fairlead_radius_m * np.sin(angles_rad),
                np.full_like(angles_rad, -cfg.fairlead_depth_m),
            ],
            axis=-1,
        ).astype(np.float64)

    def scale_pose_to_prototype(
        self,
        pose_6dof: np.ndarray,
        vel_6dof: Optional[np.ndarray] = None,
        from_model_scale: Optional[bool] = None,
    ) -> Tuple[np.ndarray, np.ndarray]:
        """Convert 6-DOF pose/velocity from model scale (1:100) to prototype scale if configured."""
        pose = np.asarray(pose_6dof, dtype=np.float64).copy()
        vel = np.zeros(6, dtype=np.float64) if vel_6dof is None else np.asarray(vel_6dof, dtype=np.float64).copy()

        use_scale = self.cfg.input_is_model_scale if from_model_scale is None else from_model_scale
        if use_scale:
            lam = self.cfg.froude_lambda
            sqrt_lam = math.sqrt(lam)
            pose[:3] *= lam
            vel[:3] *= sqrt_lam
            vel[3:] /= sqrt_lam  # rad/s scales by 1 / sqrt(lambda)
        return pose, vel

    def compute_fairleads(
        self,
        pose_6dof: np.ndarray,
        vel_6dof: Optional[np.ndarray] = None,
    ) -> Tuple[np.ndarray, np.ndarray]:
        """Compute global 3D fairlead positions (3, 3) and velocities (3, 3) in prototype coordinates.

        Args:
            pose_6dof: [surge, sway, heave, roll_rad, pitch_rad, yaw_rad] in prototype scale.
            vel_6dof:  [vx, vy, vz, wx, wy, wz] in prototype scale.
        """
        pose = np.asarray(pose_6dof, dtype=np.float64)
        vel = np.zeros(6, dtype=np.float64) if vel_6dof is None else np.asarray(vel_6dof, dtype=np.float64)

        p_plat = pose[:3]
        R = rotation_matrix_zyx(pose[3], pose[4], pose[5])
        rotated_offsets = (R @ self.fairlead_local.T).T  # (3, 3)
        r_fair = p_plat[None, :] + rotated_offsets

        v_plat = vel[:3]
        omega = vel[3:]
        v_fair = v_plat[None, :] + np.cross(omega[None, :], rotated_offsets)
        return r_fair, v_fair


class ElasticCatenarySolver:
    """Quasi-static 3D elastic catenary solver for each mooring line.

    Supports both partial seabed contact (L_B > 0) and fully suspended (L_B = 0)
    configurations in a single C1-continuous nonlinear formulation.
    """

    def __init__(self, cfg: OC4MooringConfig) -> None:
        self.cfg = cfg

    def solve_line(
        self,
        anchor_pos: np.ndarray,
        fairlead_pos: np.ndarray,
        num_nodes: Optional[int] = None,
        unstretched_length_m: Optional[float] = None,
        axial_stiffness_N: Optional[float] = None,
        submerged_weight_N_m: Optional[float] = None,
    ) -> Dict[str, np.ndarray | float]:
        """Solve elastic catenary profile and tension distribution for one line."""
        n_nodes = num_nodes or self.cfg.nodes_per_line
        L0 = self.cfg.unstretched_length_m if unstretched_length_m is None else float(unstretched_length_m)
        EA = self.cfg.axial_stiffness_N if axial_stiffness_N is None else float(axial_stiffness_N)
        w = self.cfg.submerged_weight_N_m if submerged_weight_N_m is None else float(submerged_weight_N_m)

        delta = fairlead_pos - anchor_pos
        horiz_vec = delta[:2]
        X_F = float(np.linalg.norm(horiz_vec))
        Z_F = float(delta[2])

        if X_F < 1e-6:
            e_r = np.array([1.0, 0.0], dtype=np.float64)
        else:
            e_r = horiz_vec / X_F

        s_grid = np.linspace(0.0, L0, n_nodes, dtype=np.float64)

        # Degenerate / line-breakage guard if stiffness is zeroed out
        if EA <= 1.0:
            r_nodes = np.zeros((n_nodes, 3), dtype=np.float64)
            r_nodes[:, :2] = anchor_pos[:2]
            r_nodes[:, 2] = anchor_pos[2]
            r_nodes[-1] = fairlead_pos
            return {
                "positions": r_nodes,
                "tensions": np.zeros(n_nodes - 1, dtype=np.float64),
                "node_tensions": np.zeros(n_nodes, dtype=np.float64),
                "H": 0.0,
                "V": 0.0,
                "T_fairlead": 0.0,
                "T_anchor": 0.0,
                "laid_length_m": L0,
                "touchdown_mask": np.ones(n_nodes, dtype=np.float64),
            }

        def residuals(vars_uv: np.ndarray) -> np.ndarray:
            H = math.exp(float(np.clip(vars_uv[0], math.log(10.0), math.log(5.0e8))))
            V = float(vars_uv[1])

            if V <= w * L0:
                L_B = L0 - V / w
                V_A = 0.0
                L_s = V / w
            else:
                L_B = 0.0
                V_A = V - w * L0
                L_s = L0

            if L_B > 0.0:
                x_calc = L_B + (H / w) * math.asinh(V / H) + (H * L0) / EA
                z_calc = (H / w) * (math.sqrt(1.0 + (V / H) ** 2) - 1.0) + (V ** 2) / (2.0 * w * EA)
            else:
                x_calc = (H / w) * (math.asinh((V_A + w * L0) / H) - math.asinh(V_A / H)) + (H * L0) / EA
                z_calc = (H / w) * (
                    math.sqrt(1.0 + ((V_A + w * L0) / H) ** 2) - math.sqrt(1.0 + (V_A / H) ** 2)
                ) + (V_A * L_s + 0.5 * w * L_s ** 2) / EA

            return np.array([(x_calc - X_F) / L0, (z_calc - Z_F) / L0], dtype=np.float64)

        # Smart multi-start initial guesses in (log(H), V)
        D_straight = math.hypot(X_F, Z_F)
        H_guess = 1.0e6 if D_straight >= 0.995 * L0 else 6.0e5
        V_guess = min(0.95 * w * L0, w * math.sqrt(max(1.0, Z_F * (2.0 * H_guess / w + Z_F))))
        guesses = [
            np.array([math.log(H_guess), V_guess], dtype=np.float64),
            np.array([math.log(2.0e6), 0.7 * w * L0], dtype=np.float64),
            np.array([math.log(2.5e5), 0.5 * w * L0], dtype=np.float64),
            np.array([math.log(5.0e6), 1.15 * w * L0], dtype=np.float64),
        ]

        best_sol = None
        best_norm = float("inf")
        for g0 in guesses:
            sol = root(residuals, g0, method="hybr", tol=1e-11)
            err = float(np.linalg.norm(sol.fun))
            if err < best_norm:
                best_norm = err
                best_sol = sol
            if err < 1e-8:
                break

        H = math.exp(float(np.clip(best_sol.x[0], math.log(10.0), math.log(5.0e8))))
        V = float(best_sol.x[1])

        if V <= w * L0:
            L_B = max(0.0, L0 - V / w)
            V_A = 0.0
        else:
            L_B = 0.0
            V_A = V - w * L0

        x_local = np.zeros(n_nodes, dtype=np.float64)
        z_local = np.zeros(n_nodes, dtype=np.float64)
        t_node = np.zeros(n_nodes, dtype=np.float64)

        for idx, s in enumerate(s_grid):
            if L_B > 0.0:
                if s <= L_B:
                    x_local[idx] = s * (1.0 + H / EA)
                    z_local[idx] = 0.0
                    t_node[idx] = H
                else:
                    s_susp = s - L_B
                    v_s = w * s_susp
                    x_local[idx] = L_B * (1.0 + H / EA) + (H / w) * math.asinh(v_s / H) + (H * s_susp) / EA
                    z_local[idx] = (H / w) * (math.sqrt(1.0 + (v_s / H) ** 2) - 1.0) + (v_s ** 2) / (2.0 * w * EA)
                    t_node[idx] = math.hypot(H, v_s)
            else:
                v_s = V_A + w * s
                x_local[idx] = (H / w) * (math.asinh(v_s / H) - math.asinh(V_A / H)) + (H * s) / EA
                z_local[idx] = (H / w) * (math.sqrt(1.0 + (v_s / H) ** 2) - math.sqrt(1.0 + (V_A / H) ** 2)) + (
                    V_A * s + 0.5 * w * (s ** 2)
                ) / EA
                t_node[idx] = math.hypot(H, v_s)

        # Enforce exact endpoints in case of minor solver tolerance
        x_local[0] = 0.0
        z_local[0] = 0.0
        x_local[-1] = X_F
        z_local[-1] = Z_F

        r_nodes = np.zeros((n_nodes, 3), dtype=np.float64)
        r_nodes[:, 0] = anchor_pos[0] + x_local * e_r[0]
        r_nodes[:, 1] = anchor_pos[1] + x_local * e_r[1]
        r_nodes[:, 2] = anchor_pos[2] + z_local

        seg_tensions = 0.5 * (t_node[:-1] + t_node[1:])
        touchdown_mask = (r_nodes[:, 2] <= (-self.cfg.water_depth_m + 0.15)).astype(np.float64)

        return {
            "positions": r_nodes,
            "tensions": seg_tensions,
            "node_tensions": t_node,
            "H": H,
            "V": V,
            "T_fairlead": float(t_node[-1]),
            "T_anchor": float(t_node[0]),
            "laid_length_m": float(L_B),
            "touchdown_mask": touchdown_mask,
        }

    def solve_all_lines(
        self,
        kinematics: PlatformToFairleadKinematics,
        pose_6dof: np.ndarray,
        line_overrides: Optional[List[Dict[str, float]]] = None,
    ) -> List[Dict[str, np.ndarray | float]]:
        """Solve quasi-static catenary for all mooring lines given platform 6-DOF pose."""
        r_fair, _ = kinematics.compute_fairleads(pose_6dof)
        results = []
        for k in range(self.cfg.num_lines):
            ov = (line_overrides[k] if line_overrides and k < len(line_overrides) else {}) or {}
            anchor_pos = kinematics.anchor_positions[k].copy()
            if "anchor_shift_m" in ov:
                radial = anchor_pos[:2] / (np.linalg.norm(anchor_pos[:2]) + 1e-8)
                anchor_pos[:2] -= radial * ov["anchor_shift_m"]

            res = self.solve_line(
                anchor_pos=anchor_pos,
                fairlead_pos=r_fair[k],
                unstretched_length_m=ov.get("unstretched_length_m"),
                axial_stiffness_N=ov.get("axial_stiffness_N"),
                submerged_weight_N_m=ov.get("submerged_weight_N_m"),
            )
            results.append(res)
        return results


def generate_synthetic_mooring_sample(
    cfg: OC4MooringConfig,
    kinematics: PlatformToFairleadKinematics,
    solver: ElasticCatenarySolver,
    rng: np.random.Generator,
    equilibrium_catenary: Optional[List[Dict[str, np.ndarray | float]]] = None,
) -> Dict[str, np.ndarray]:
    """Generate one physics-consistent dynamic mooring state sample for training/validation.

    Combines exact quasi-static elastic catenary solutions with physically motivated
    hydrodynamic drag bowing, inertia-compatible kinematics, and optional structural
    degradation modes (SHM anomalies) on a randomly selected line.
    """
    # Sample realistic 6-DOF platform states (prototype scale)
    surge = rng.uniform(-12.0, 12.0)
    sway = rng.uniform(-12.0, 12.0)
    heave = rng.uniform(-2.5, 2.5)
    roll = math.radians(rng.uniform(-6.0, 6.0))
    pitch = math.radians(rng.uniform(-7.0, 7.0))
    yaw = math.radians(rng.uniform(-8.0, 8.0))
    pose_6dof = np.array([surge, sway, heave, roll, pitch, yaw], dtype=np.float64)

    vel_6dof = np.array(
        [
            rng.uniform(-1.5, 1.5),
            rng.uniform(-1.5, 1.5),
            rng.uniform(-0.8, 0.8),
            math.radians(rng.uniform(-2.0, 2.0)),
            math.radians(rng.uniform(-2.0, 2.0)),
            math.radians(rng.uniform(-1.5, 1.5)),
        ],
        dtype=np.float64,
    )

    hs = rng.uniform(0.5, 6.0)
    tp = rng.uniform(6.0, 15.0)
    u_wind = rng.uniform(2.0, 25.0)
    u_curr = rng.uniform(0.0, 1.8)
    curr_dir = rng.uniform(0.0, 2.0 * math.pi)
    env_4 = np.array([hs, tp, u_wind, u_curr], dtype=np.float64)

    # Sample SHM scenario: 55% all healthy, 45% anomaly on one line
    shm_labels = np.zeros(cfg.num_lines, dtype=np.int64)
    health_factors = np.ones((cfg.num_lines, 2), dtype=np.float64)  # [EA_ratio, w_ratio]
    line_overrides: List[Dict[str, float]] = [{} for _ in range(cfg.num_lines)]

    if rng.random() < 0.45:
        affected_line = int(rng.integers(0, cfg.num_lines))
        fault_cls = int(rng.integers(1, len(SHM_CLASSES)))
        shm_labels[affected_line] = fault_cls

        if fault_cls == SHM_CLASS_TO_IDX["PRETENSION_LOSS"]:
            # Anchor drag or elongation (+4m to +12m slack)
            slack = float(rng.uniform(4.0, 12.0))
            line_overrides[affected_line]["unstretched_length_m"] = cfg.unstretched_length_m + slack
            health_factors[affected_line] = [0.85, 1.0]
        elif fault_cls == SHM_CLASS_TO_IDX["STIFFNESS_DEGRADATION"]:
            ea_ratio = float(rng.uniform(0.45, 0.75))
            line_overrides[affected_line]["axial_stiffness_N"] = cfg.axial_stiffness_N * ea_ratio
            health_factors[affected_line] = [ea_ratio, 1.0]
        elif fault_cls == SHM_CLASS_TO_IDX["BIOFOULING"]:
            w_ratio = float(rng.uniform(1.15, 1.45))
            line_overrides[affected_line]["submerged_weight_N_m"] = cfg.submerged_weight_N_m * w_ratio
            health_factors[affected_line] = [1.0, w_ratio]
        elif fault_cls == SHM_CLASS_TO_IDX["LINE_BREAKAGE"]:
            line_overrides[affected_line]["axial_stiffness_N"] = 0.0
            health_factors[affected_line] = [0.0, 1.0]

    # Prior nominal catenary (assuming healthy properties, as input to digital twin)
    r_fair, v_fair = kinematics.compute_fairleads(pose_6dof, vel_6dof)
    cat_nominal = solver.solve_all_lines(kinematics, pose_6dof, line_overrides=None)
    cat_actual = solver.solve_all_lines(kinematics, pose_6dof, line_overrides=line_overrides)

    if equilibrium_catenary is None:
        equilibrium_catenary = solver.solve_all_lines(kinematics, np.zeros(6, dtype=np.float64))

    n_nodes = cfg.nodes_per_line
    s_norm = np.linspace(0.0, 1.0, n_nodes, dtype=np.float64)

    pos_eq = np.stack([c["positions"] for c in equilibrium_catenary], axis=0)
    pos_cat_nom = np.stack([c["positions"] for c in cat_nominal], axis=0)
    pos_target = np.stack([c["positions"] for c in cat_actual], axis=0)
    tension_target = np.stack([c["tensions"] for c in cat_actual], axis=0)
    touchdown_target = np.stack([c["touchdown_mask"] for c in cat_actual], axis=0)

    vel_target = np.zeros((cfg.num_lines, n_nodes, 3), dtype=np.float64)
    acc_target = np.zeros((cfg.num_lines, n_nodes, 3), dtype=np.float64)

    # Add hydrodynamic current bowing + dynamic profile consistent with boundary velocities
    u_curr_vec = np.array([u_curr * math.cos(curr_dir), u_curr * math.sin(curr_dir), 0.0], dtype=np.float64)
    drag_scale = 0.5 * cfg.water_density_kg_m3 * cfg.cd_normal * cfg.diameter_m

    for k in range(cfg.num_lines):
        # Smooth suspended weight shape function vanishing at anchor (s=0) and fairlead (s=1)
        suspended = 1.0 - touchdown_target[k]
        bow_shape = suspended * np.sin(math.pi * s_norm)

        if shm_labels[k] != SHM_CLASS_TO_IDX["LINE_BREAKAGE"]:
            h_eff = max(float(cat_actual[k]["H"]), 1.0e4)
            # Transverse Morison bow proportional to u_curr*|u_curr|*L^2 / (8*H)
            bow_amp = (drag_scale * np.linalg.norm(u_curr_vec) * (cfg.unstretched_length_m ** 2)) / (8.0 * h_eff)
            bow_amp = min(bow_amp, 6.0)
            pos_target[k] += bow_shape[:, None] * (u_curr_vec[None, :] / (u_curr + 1e-6)) * bow_amp
            pos_target[k, :, 2] = np.maximum(pos_target[k, :, 2], cfg.seabed_z_m)

            # Velocity interpolation along suspended span
            vel_shape = np.power(s_norm, 1.5) * suspended
            vel_target[k] = vel_shape[:, None] * v_fair[k][None, :]
            # Small hydrodynamic dynamic tension modulation
            dyn_factor = 1.0 + 0.03 * (hs / 6.0) * np.sign(np.dot(v_fair[k], r_fair[k] - kinematics.anchor_positions[k]))
            tension_target[k] = np.maximum(0.0, tension_target[k] * dyn_factor)
        else:
            vel_target[k] = 0.0
            tension_target[k] = 0.0

        # Ensure exact boundary points
        pos_target[k, 0] = kinematics.anchor_positions[k]
        if shm_labels[k] != SHM_CLASS_TO_IDX["LINE_BREAKAGE"]:
            pos_target[k, -1] = r_fair[k]
            vel_target[k, -1] = v_fair[k]

        # Moderate acceleration consistent with wave frequency omega = 2*pi/Tp
        omega_wave = 2.0 * math.pi / max(tp, 1.0)
        acc_target[k] = -0.25 * omega_wave * vel_target[k]

    return {
        "pose_6dof": pose_6dof,
        "vel_6dof": vel_6dof,
        "env_4": env_4,
        "r_anchor": kinematics.anchor_positions.copy(),
        "r_fairlead": r_fair,
        "v_fairlead": v_fair,
        "pos_eq": pos_eq,
        "pos_cat_nom": pos_cat_nom,
        "pos_target": pos_target,
        "vel_target": vel_target,
        "acc_target": acc_target,
        "tension_target": tension_target,
        "touchdown_target": touchdown_target,
        "shm_labels": shm_labels,
        "health_factors": health_factors,
    }
