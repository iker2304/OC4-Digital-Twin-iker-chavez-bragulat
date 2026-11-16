"""Physics-Informed Loss functions for the OC4 Mooring Digital Twin.

Combines supervised observation terms with multi-physics PDE residuals:
1. MooringPINNLoss: Discrete graph-based physics loss over G=(V, E):
   - L_data: Position, velocity, tension, and touchdown supervision
   - L_const: Axial constitutive law (Hooke + tension-only + internal damping)
   - L_momentum: 3D lumped-mass momentum balance (axial + gravity/buoyancy +
     Morison hydrodynamic drag & added mass + seabed contact reaction)
   - L_bc: Kinematic Dirichlet boundaries at anchors and camera-driven fairleads
   - L_seabed: Non-penetration constraint z >= -water_depth
   - L_shm: Cross-entropy fault classification + health factor regression
2. ContinuousPINNLoss: Autograd PDE residual loss for ContinuousMooringPINN.
"""

from __future__ import annotations

import math
from typing import Dict, Optional, Tuple

import torch
import torch.nn as nn
import torch.nn.functional as F

from .graph_builder import MooringGraphBatch
from .physics_catenary import OC4MooringConfig


class MooringPINNLoss(nn.Module):
    """Multi-task physics-informed loss for MooringPIGNN."""

    def __init__(
        self,
        cfg: OC4MooringConfig,
        weights: Optional[Dict[str, float]] = None,
    ) -> None:
        super().__init__()
        self.cfg = cfg
        default_weights = {
            "data_pos": 10.0,
            "data_tension": 5.0,
            "constitutive": 2.0,
            "momentum_pde": 1.0,
            "boundary_bc": 10.0,
            "seabed_contact": 5.0,
            "shm_class": 1.5,
            "shm_health": 2.0,
        }
        if weights:
            default_weights.update(weights)
        self.weights = default_weights

    def forward(
        self,
        preds: Dict[str, torch.Tensor],
        batch: MooringGraphBatch,
    ) -> Tuple[torch.Tensor, Dict[str, float]]:
        pos_pred = preds["pos_pred"]                 # (B, K, N, 3)
        vel_pred = preds["vel_pred"]                 # (B, K, N, 3)
        acc_pred = preds["acc_pred"]                 # (B, K, N, 3)
        tension_pred = preds["tension_pred"]         # (B, K, S)
        td_logits = preds["touchdown_logits"]        # (B, K, N)
        shm_logits = preds["shm_logits"]             # (B, K, 5)
        health_pred = preds["health_factors"]        # (B, K, 2)

        l0 = self.cfg.segment_length_m
        L0 = self.cfg.unstretched_length_m
        eps = 1e-6

        # Effective line parameters (use target health ratios during training if present)
        if batch.health_factors is not None:
            ea_ratio = batch.health_factors[..., 0]  # (B, K)
            w_ratio = batch.health_factors[..., 1]   # (B, K)
        else:
            ea_ratio = health_pred[..., 0].detach()
            w_ratio = health_pred[..., 1].detach()

        ea_eff = self.cfg.axial_stiffness_N * ea_ratio.unsqueeze(-1)              # (B, K, 1)
        w_eff = self.cfg.submerged_weight_N_m * w_ratio.unsqueeze(-1)             # (B, K, 1)

        # --- 1. Constitutive Law Residual (Hooke axial tension-only + damping) ---
        dr_seg = pos_pred[:, :, 1:, :] - pos_pred[:, :, :-1, :]                   # (B, K, S, 3)
        seg_len = torch.linalg.norm(dr_seg, dim=-1).clamp_min(eps)                # (B, K, S)
        tau_seg = dr_seg / seg_len.unsqueeze(-1)                                  # (B, K, S, 3)

        strain = (seg_len - l0) / l0                                              # (B, K, S)
        dv_seg = vel_pred[:, :, 1:, :] - vel_pred[:, :, :-1, :]                   # (B, K, S, 3)
        strain_rate = (dv_seg * tau_seg).sum(dim=-1) / l0                         # (B, K, S)

        t_const = F.relu(ea_eff * F.relu(strain) + self.cfg.internal_damping_Ns * strain_rate)
        loss_const = F.mse_loss(tension_pred / 1.0e6, t_const / 1.0e6)

        # --- 2. 3D Lumped-Mass Momentum Balance PDE Residual (interior nodes j = 1..N-2) ---
        # Axial force divergence: T_{j} * tau_{j} - T_{j-1} * tau_{j-1}
        f_seg = tension_pred.unsqueeze(-1) * tau_seg                              # (B, K, S, 3)
        f_axial_int = f_seg[:, :, 1:, :] - f_seg[:, :, :-1, :]                    # (B, K, N-2, 3)

        # Nodal tangent at interior nodes
        tau_node = tau_seg[:, :, :-1, :] + tau_seg[:, :, 1:, :]
        tau_node = tau_node / torch.linalg.norm(tau_node, dim=-1, keepdim=True).clamp_min(eps)

        # Submerged gravity + buoyancy force
        f_grav = torch.zeros_like(f_axial_int)
        f_grav[..., 2] = -w_eff * l0                                              # (B, K, N-2)

        # Morison hydrodynamic drag (using relative fluid velocity u_rel = -v_node)
        v_int = vel_pred[:, :, 1:-1, :]
        a_int = acc_pred[:, :, 1:-1, :]
        p_int = pos_pred[:, :, 1:-1, :]

        u_rel = -v_int
        u_t = (u_rel * tau_node).sum(dim=-1, keepdim=True) * tau_node
        u_n = u_rel - u_t
        u_n_norm = torch.linalg.norm(u_n, dim=-1, keepdim=True)
        u_t_norm = torch.linalg.norm(u_t, dim=-1, keepdim=True)

        rho_w = self.cfg.water_density_kg_m3
        d_eff = self.cfg.diameter_m
        f_drag = 0.5 * rho_w * d_eff * l0 * (
            self.cfg.cd_normal * u_n_norm * u_n
            + math.pi * self.cfg.cd_tangential * u_t_norm * u_t
        )

        # Seabed reaction force (support weight on contact + elastic penalty + vertical damping)
        seabed_z = self.cfg.seabed_z_m
        z_int = p_int[..., 2]
        penetration = F.relu(seabed_z - z_int)
        contact_smooth = torch.sigmoid((seabed_z + 0.1 - z_int) / self.cfg.penetration_smoothing_m)

        f_bed = torch.zeros_like(f_axial_int)
        f_bed[..., 2] = (
            self.cfg.seabed_stiffness_N_m2 * l0 * penetration
            + w_eff * l0 * contact_smooth
            - self.cfg.seabed_damping_Ns_m2 * l0 * v_int[..., 2] * contact_smooth
        )

        # Effective inertia with directional added mass
        m_struct = self.cfg.mass_per_unit_length_kg_m * l0
        vol_seg = 0.25 * math.pi * (d_eff ** 2) * l0
        m_add_n = rho_w * vol_seg * self.cfg.ca_normal
        m_add_t = rho_w * vol_seg * self.cfg.ca_tangential

        a_t = (a_int * tau_node).sum(dim=-1, keepdim=True) * tau_node
        a_n = a_int - a_t
        ma_inertia = (m_struct + m_add_n) * a_n + (m_struct + m_add_t) * a_t

        f_ref = max(self.cfg.submerged_weight_N_m * l0, 1.0)
        pde_residual = (ma_inertia - (f_axial_int + f_grav + f_drag + f_bed)) / f_ref
        loss_momentum = (pde_residual ** 2).mean()

        # --- 3. Dirichlet Boundary Conditions (Anchor & Fairlead) ---
        err_anch_pos = ((pos_pred[:, :, 0, :] - batch.r_anchor) / L0) ** 2
        err_fair_pos = ((pos_pred[:, :, -1, :] - batch.r_fairlead) / L0) ** 2
        err_anch_vel = (vel_pred[:, :, 0, :] / 5.0) ** 2
        err_fair_vel = ((vel_pred[:, :, -1, :] - batch.v_fairlead) / 5.0) ** 2
        loss_bc = (err_anch_pos + err_fair_pos + err_anch_vel + err_fair_vel).mean()

        # --- 4. Seabed Non-Penetration Penalty ---
        loss_seabed = (F.relu(seabed_z - pos_pred[..., 2]) ** 2).mean()

        # --- 5. Data & SHM Supervision Terms (when targets are provided) ---
        loss_data_pos = torch.zeros((), device=pos_pred.device, dtype=pos_pred.dtype)
        loss_data_ten = torch.zeros((), device=pos_pred.device, dtype=pos_pred.dtype)
        loss_shm_cls = torch.zeros((), device=pos_pred.device, dtype=pos_pred.dtype)
        loss_shm_hlth = torch.zeros((), device=pos_pred.device, dtype=pos_pred.dtype)

        if batch.pos_target is not None:
            loss_data_pos = F.mse_loss(pos_pred / 10.0, batch.pos_target / 10.0)
            if batch.vel_target is not None:
                loss_data_pos = loss_data_pos + 0.5 * F.mse_loss(vel_pred / 5.0, batch.vel_target / 5.0)
            if batch.touchdown_target is not None:
                loss_data_pos = loss_data_pos + 0.25 * F.binary_cross_entropy_with_logits(
                    td_logits, batch.touchdown_target
                )

        if batch.tension_target is not None:
            loss_data_ten = F.mse_loss(tension_pred / 1.0e6, batch.tension_target / 1.0e6)

        if batch.shm_labels is not None:
            loss_shm_cls = F.cross_entropy(shm_logits.reshape(-1, shm_logits.shape[-1]), batch.shm_labels.reshape(-1))

        if batch.health_factors is not None:
            loss_shm_hlth = F.mse_loss(health_pred, batch.health_factors)

        w = self.weights
        total_loss = (
            w["data_pos"] * loss_data_pos
            + w["data_tension"] * loss_data_ten
            + w["constitutive"] * loss_const
            + w["momentum_pde"] * loss_momentum
            + w["boundary_bc"] * loss_bc
            + w["seabed_contact"] * loss_seabed
            + w["shm_class"] * loss_shm_cls
            + w["shm_health"] * loss_shm_hlth
        )

        metrics = {
            "total": float(total_loss.detach().item()),
            "data_pos": float(loss_data_pos.detach().item()),
            "data_tension": float(loss_data_ten.detach().item()),
            "constitutive": float(loss_const.detach().item()),
            "momentum_pde": float(loss_momentum.detach().item()),
            "boundary_bc": float(loss_bc.detach().item()),
            "seabed_contact": float(loss_seabed.detach().item()),
            "shm_class": float(loss_shm_cls.detach().item()),
            "shm_health": float(loss_shm_hlth.detach().item()),
        }
        return total_loss, metrics


class ContinuousPINNLoss(nn.Module):
    """Autograd PDE residual loss for ContinuousMooringPINN evaluated at collocation points."""

    def __init__(self, cfg: OC4MooringConfig) -> None:
        super().__init__()
        self.cfg = cfg

    def forward(
        self,
        derivs: Dict[str, torch.Tensor],
        ea_eff: Optional[torch.Tensor] = None,
    ) -> Tuple[torch.Tensor, Dict[str, float]]:
        r_pred = derivs["r_pred"]
        tension = derivs["tension_pred"]
        r_s = derivs["r_s"]
        r_ss = derivs["r_ss"]
        v = derivs["v"]
        a = derivs["a"]
        T_s = derivs["T_s"]

        eps = 1e-6
        r_s_norm = torch.linalg.norm(r_s, dim=-1).clamp_min(eps)
        tau = r_s / r_s_norm.unsqueeze(-1)

        # Orthogonal derivative d(tau)/ds = (r_ss - (r_ss . tau) * tau) / ||r_s||
        r_ss_proj = (r_ss * tau).sum(dim=-1, keepdim=True) * tau
        dtau_ds = (r_ss - r_ss_proj) / r_s_norm.unsqueeze(-1)

        # Constitutive equation: T = EA * max(0, ||r_s|| - 1)
        ea = self.cfg.axial_stiffness_N if ea_eff is None else ea_eff
        strain = r_s_norm - 1.0
        t_const = ea * F.relu(strain)
        loss_const = F.mse_loss(tension / 1.0e6, t_const / 1.0e6)

        # Continuous cable PDE: M_a * a - d(T * tau)/ds - f_ext = 0
        f_axial_s = T_s.unsqueeze(-1) * tau + tension.unsqueeze(-1) * dtau_ds

        f_grav = torch.zeros_like(f_axial_s)
        f_grav[..., 2] = -self.cfg.submerged_weight_N_m

        u_rel = -v
        u_t = (u_rel * tau).sum(dim=-1, keepdim=True) * tau
        u_n = u_rel - u_t
        f_drag = 0.5 * self.cfg.water_density_kg_m3 * self.cfg.diameter_m * (
            self.cfg.cd_normal * torch.linalg.norm(u_n, dim=-1, keepdim=True) * u_n
            + math.pi * self.cfg.cd_tangential * torch.linalg.norm(u_t, dim=-1, keepdim=True) * u_t
        )

        seabed_z = self.cfg.seabed_z_m
        penetration = F.relu(seabed_z - r_pred[..., 2])
        contact_smooth = torch.sigmoid((seabed_z + 0.1 - r_pred[..., 2]) / self.cfg.penetration_smoothing_m)
        f_bed = torch.zeros_like(f_axial_s)
        f_bed[..., 2] = (
            self.cfg.seabed_stiffness_N_m2 * penetration
            + self.cfg.submerged_weight_N_m * contact_smooth
            - self.cfg.seabed_damping_Ns_m2 * v[..., 2] * contact_smooth
        )

        vol = 0.25 * math.pi * (self.cfg.diameter_m ** 2)
        m_add_n = self.cfg.water_density_kg_m3 * vol * self.cfg.ca_normal
        a_t = (a * tau).sum(dim=-1, keepdim=True) * tau
        a_n = a - a_t
        ma = (self.cfg.mass_per_unit_length_kg_m + m_add_n) * a_n + self.cfg.mass_per_unit_length_kg_m * a_t

        f_ref = max(self.cfg.submerged_weight_N_m, 1.0)
        pde_res = (ma - (f_axial_s + f_grav + f_drag + f_bed)) / f_ref
        loss_pde = (pde_res ** 2).mean()
        loss_seabed = (penetration ** 2).mean()

        total = loss_const + 0.5 * loss_pde + 5.0 * loss_seabed
        return total, {
            "total": float(total.detach().item()),
            "constitutive": float(loss_const.detach().item()),
            "pde": float(loss_pde.detach().item()),
            "seabed": float(loss_seabed.detach().item()),
        }
