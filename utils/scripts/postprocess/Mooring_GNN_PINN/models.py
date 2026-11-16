"""Neural network architectures for the OC4 Mooring Digital Twin.

Contains two complementary physics-informed models:
1. MooringPIGNN: Physics-Informed Graph Neural Network (Encode-Process-Decode)
   operating on the 3-line + platform graph G=(V, E). Predicts 3D nodal
   positions, velocities, accelerations, seabed touchdown probability,
   segment axial tensions, and per-line SHM diagnostics.
2. ContinuousMooringPINN: Coordinate-based continuous PINN N_theta(s, t, q_p, env)
   with Fourier features and exact analytical Dirichlet boundary ansatz,
   supporting autograd PDE evaluation along the continuous arc length s in [0, L0].
"""

from __future__ import annotations

import math
from typing import Dict, Tuple

import torch
import torch.nn as nn
import torch.nn.functional as F

from .graph_builder import MooringGraphBatch, MooringGraphBuilder
from .physics_catenary import OC4MooringConfig, SHM_CLASSES


def _build_mlp(
    in_dim: int,
    hidden_dim: int,
    out_dim: int,
    num_layers: int = 2,
    dropout: float = 0.0,
    final_activation: bool = False,
) -> nn.Sequential:
    layers = []
    curr_dim = in_dim
    for _ in range(max(1, num_layers - 1)):
        layers.append(nn.Linear(curr_dim, hidden_dim))
        layers.append(nn.SiLU())
        if dropout > 0.0:
            layers.append(nn.Dropout(dropout))
        curr_dim = hidden_dim
    layers.append(nn.Linear(curr_dim, out_dim))
    if final_activation:
        layers.append(nn.SiLU())
    return nn.Sequential(*layers)


class PhysicsMessagePassingLayer(nn.Module):
    """Residual Edge-Node Message Passing block conditioned on global state."""

    def __init__(self, hidden_dim: int, dropout: float = 0.0) -> None:
        super().__init__()
        # Edge update takes [h_src, h_dst, e_ij, g_ctx]
        self.edge_mlp = _build_mlp(hidden_dim * 4, hidden_dim, hidden_dim, num_layers=3, dropout=dropout)
        self.edge_norm = nn.LayerNorm(hidden_dim)

        # Node update takes [h_dst, aggregated_edge_msg, g_ctx]
        self.node_mlp = _build_mlp(hidden_dim * 3, hidden_dim, hidden_dim, num_layers=3, dropout=dropout)
        self.node_norm = nn.LayerNorm(hidden_dim)

    def forward(
        self,
        h_nodes: torch.Tensor,      # (B, V, D)
        h_edges: torch.Tensor,      # (B, E, D)
        edge_index: torch.Tensor,   # (2, E)
        g_ctx: torch.Tensor,        # (B, D)
    ) -> Tuple[torch.Tensor, torch.Tensor]:
        B, V, D = h_nodes.shape
        E = edge_index.shape[1]
        src, dst = edge_index[0], edge_index[1]

        h_src = h_nodes[:, src, :]  # (B, E, D)
        h_dst = h_nodes[:, dst, :]  # (B, E, D)
        g_edge = g_ctx.unsqueeze(1).expand(B, E, D)

        edge_in = torch.cat([h_src, h_dst, h_edges, g_edge], dim=-1)
        h_edges_next = self.edge_norm(h_edges + self.edge_mlp(edge_in))

        # Aggregate incoming edge messages to destination nodes (sum approximates force balance)
        agg = torch.zeros(B, V, D, device=h_nodes.device, dtype=h_nodes.dtype)
        dst_expand = dst.view(1, E, 1).expand(B, E, D)
        agg.scatter_add_(1, dst_expand, h_edges_next)

        g_node = g_ctx.unsqueeze(1).expand(B, V, D)
        node_in = torch.cat([h_nodes, agg, g_node], dim=-1)
        h_nodes_next = self.node_norm(h_nodes + self.node_mlp(node_in))

        return h_nodes_next, h_edges_next


class MooringPIGNN(nn.Module):
    """Physics-Informed Graph Neural Network for OC4 3-line mooring state and SHM prediction."""

    def __init__(
        self,
        cfg: OC4MooringConfig,
        hidden_dim: int = 128,
        num_mp_layers: int = 6,
        dropout: float = 0.05,
        node_in_dim: int = MooringGraphBuilder.NODE_FEAT_DIM,
        edge_in_dim: int = MooringGraphBuilder.EDGE_FEAT_DIM,
        global_in_dim: int = MooringGraphBuilder.GLOBAL_COND_DIM,
    ) -> None:
        super().__init__()
        self.cfg = cfg
        self.hidden_dim = hidden_dim
        self.num_mp_layers = num_mp_layers

        # Physical output scaling factors
        self.disp_scale_m = 25.0
        self.vel_scale_ms = 5.0
        self.acc_scale_ms2 = 5.0
        self.tension_scale_N = 1.0e6  # 1 MN reference scale

        # Encoders
        self.node_encoder = nn.Sequential(
            _build_mlp(node_in_dim, hidden_dim, hidden_dim, num_layers=2, dropout=dropout),
            nn.LayerNorm(hidden_dim),
        )
        self.edge_encoder = nn.Sequential(
            _build_mlp(edge_in_dim, hidden_dim, hidden_dim, num_layers=2, dropout=dropout),
            nn.LayerNorm(hidden_dim),
        )
        self.global_encoder = nn.Sequential(
            _build_mlp(global_in_dim, hidden_dim, hidden_dim, num_layers=2, dropout=dropout),
            nn.LayerNorm(hidden_dim),
        )

        # Processor: stacked physics message-passing layers
        self.mp_layers = nn.ModuleList(
            [PhysicsMessagePassingLayer(hidden_dim, dropout=dropout) for _ in range(num_mp_layers)]
        )

        # Multi-task Decoder Heads
        # 1) Node kinematics: delta_pos (3), vel (3), acc (3), touchdown_logit (1)
        self.node_kinematics_head = _build_mlp(hidden_dim, hidden_dim, 10, num_layers=3, dropout=0.0)

        # 2) Segment axial tension head (from bidirectional symmetric edge features)
        self.edge_tension_head = _build_mlp(hidden_dim * 2, hidden_dim, 1, num_layers=3, dropout=0.0)

        # 3) Per-line SHM head: [node_mean, node_max, edge_mean, platform_h] -> classes + [EA_ratio, w_ratio]
        shm_in_dim = hidden_dim * 4
        self.line_shm_backbone = _build_mlp(shm_in_dim, hidden_dim, hidden_dim, num_layers=2, dropout=dropout)
        self.line_shm_classifier = nn.Linear(hidden_dim, len(SHM_CLASSES))
        self.line_health_regressor = nn.Linear(hidden_dim, 2)

    def forward(self, batch: MooringGraphBatch) -> Dict[str, torch.Tensor]:
        B = batch.node_features.shape[0]
        K = self.cfg.num_lines
        N = self.cfg.nodes_per_line
        S = self.cfg.segments_per_line

        h_nodes = self.node_encoder(batch.node_features)
        h_edges = self.edge_encoder(batch.edge_features)
        g_ctx = self.global_encoder(batch.global_cond)

        for layer in self.mp_layers:
            h_nodes, h_edges = layer(h_nodes, h_edges, batch.edge_index, g_ctx)

        # --- 1. Decode Line Node Kinematics ---
        # Extract mooring line nodes only: shape (B, K, N, D)
        line_node_flat = batch.line_node_indices.view(-1)
        h_line_nodes = h_nodes[:, line_node_flat, :].view(B, K, N, self.hidden_dim)

        kin_raw = self.node_kinematics_head(h_line_nodes)
        delta_pos = kin_raw[..., 0:3] * self.disp_scale_m
        vel_pred = kin_raw[..., 3:6] * self.vel_scale_ms
        acc_pred = kin_raw[..., 6:9] * self.acc_scale_ms2
        touchdown_logits = kin_raw[..., 9]

        # Enforce Dirichlet BC exactly if hard_bc is enabled
        if self.cfg.hard_bc:
            bc_mask = torch.ones((1, 1, N, 1), device=delta_pos.device, dtype=delta_pos.dtype)
            bc_mask[:, :, 0, :] = 0.0   # anchor fixed
            bc_mask[:, :, -1, :] = 0.0  # fairlead driven by platform pose
            delta_pos = delta_pos * bc_mask
            vel_pred = vel_pred * bc_mask
            vel_pred[:, :, -1, :] = batch.v_fairlead
            acc_pred = acc_pred * bc_mask

        pos_pred = batch.pos_cat_nom + delta_pos

        # --- 2. Decode Segment Tensions ---
        e_fwd = h_edges[:, batch.fwd_edge_idx, :].view(B, K, S, self.hidden_dim)
        e_bwd = h_edges[:, batch.bwd_edge_idx, :].view(B, K, S, self.hidden_dim)
        e_sym = 0.5 * (e_fwd + e_bwd)
        e_diff = torch.abs(e_fwd - e_bwd)
        e_seg = torch.cat([e_sym, e_diff], dim=-1)  # (B, K, S, 2*D)

        tension_raw = self.edge_tension_head(e_seg).squeeze(-1)
        tension_pred = F.softplus(tension_raw) * self.tension_scale_N  # strictly positive [N]

        # --- 3. Decode Per-Line SHM Diagnostics ---
        h_plat = h_nodes[:, batch.platform_node_idx, :].unsqueeze(1).expand(B, K, self.hidden_dim)
        node_mean = h_line_nodes.mean(dim=2)
        node_max = h_line_nodes.max(dim=2).values
        edge_mean = e_sym.mean(dim=2)

        shm_feat = torch.cat([node_mean, node_max, edge_mean, h_plat], dim=-1)
        shm_hidden = F.silu(self.line_shm_backbone(shm_feat))
        shm_logits = self.line_shm_classifier(shm_hidden)  # (B, K, 5)
        health_raw = self.line_health_regressor(shm_hidden)
        # EA_ratio in (0, 1.5], w_ratio in (0.5, 2.0]
        ea_ratio = 1.5 * torch.sigmoid(health_raw[..., 0])
        w_ratio = 0.5 + 1.5 * torch.sigmoid(health_raw[..., 1])
        health_factors = torch.stack([ea_ratio, w_ratio], dim=-1)

        return {
            "pos_pred": pos_pred,                   # (B, K, N, 3) [m]
            "delta_pos": delta_pos,                 # (B, K, N, 3) [m]
            "vel_pred": vel_pred,                   # (B, K, N, 3) [m/s]
            "acc_pred": acc_pred,                   # (B, K, N, 3) [m/s^2]
            "touchdown_logits": touchdown_logits,   # (B, K, N)
            "touchdown_prob": torch.sigmoid(touchdown_logits),
            "tension_pred": tension_pred,           # (B, K, S) [N]
            "shm_logits": shm_logits,               # (B, K, 5)
            "shm_probs": F.softmax(shm_logits, dim=-1),
            "health_factors": health_factors,       # (B, K, 2)
        }


class FourierFeatureEncoding(nn.Module):
    """Multi-scale Fourier encoding for continuous arc-length and time coordinates (s, t)."""

    def __init__(self, in_dim: int = 2, num_freqs: int = 8) -> None:
        super().__init__()
        freqs = (2.0 ** torch.arange(num_freqs, dtype=torch.float32)) * math.pi
        self.register_buffer("freqs", freqs)
        self.out_dim = in_dim * (1 + 2 * num_freqs)

    def forward(self, coords: torch.Tensor) -> torch.Tensor:
        # coords: (..., in_dim)
        scaled = coords.unsqueeze(-1) * self.freqs  # (..., in_dim, F)
        sin_feat = torch.sin(scaled).flatten(start_dim=-2)
        cos_feat = torch.cos(scaled).flatten(start_dim=-2)
        return torch.cat([coords, sin_feat, cos_feat], dim=-1)


class ContinuousMooringPINN(nn.Module):
    """Coordinate-based Continuous PINN evaluating r_k(s, t) and T_k(s, t) via autograd.

    Enforces exact Dirichlet boundary conditions at anchor (s=0) and fairlead (s=L0)
    through the analytical ansatz:
        r_hat(s, t) = (1 - s_hat) * r_anchor + s_hat * r_fairlead(t)
                      + s_hat * (1 - s_hat) * L0 * MLP_r(...)
    """

    def __init__(
        self,
        cfg: OC4MooringConfig,
        hidden_dim: int = 128,
        num_layers: int = 4,
        num_fourier_freqs: int = 8,
        global_in_dim: int = MooringGraphBuilder.GLOBAL_COND_DIM,
    ) -> None:
        super().__init__()
        self.cfg = cfg
        self.fourier = FourierFeatureEncoding(in_dim=2, num_freqs=num_fourier_freqs)
        in_dim = self.fourier.out_dim + cfg.num_lines + global_in_dim

        self.backbone = _build_mlp(
            in_dim=in_dim,
            hidden_dim=hidden_dim,
            out_dim=hidden_dim,
            num_layers=num_layers,
            dropout=0.0,
            final_activation=True,
        )
        self.pos_head = nn.Linear(hidden_dim, 3)
        self.tension_head = nn.Linear(hidden_dim, 1)

    def forward(
        self,
        s_norm: torch.Tensor,       # (M, 1) in [0, 1]
        t_norm: torch.Tensor,       # (M, 1) normalized time
        line_onehot: torch.Tensor,  # (M, 3)
        global_cond: torch.Tensor,  # (M, 16)
        r_anchor: torch.Tensor,     # (M, 3) [m]
        r_fairlead: torch.Tensor,   # (M, 3) [m]
    ) -> Tuple[torch.Tensor, torch.Tensor]:
        st = torch.cat([s_norm, t_norm], dim=-1)
        st_enc = self.fourier(st)
        feat = torch.cat([st_enc, line_onehot, global_cond], dim=-1)
        h = self.backbone(feat)

        # Analytical ansatz guaranteeing exact BC at s_norm=0 and s_norm=1
        bubble = s_norm * (1.0 - s_norm)
        r_linear = (1.0 - s_norm) * r_anchor + s_norm * r_fairlead
        r_pred = r_linear + bubble * self.cfg.unstretched_length_m * 0.25 * self.pos_head(h)

        t_pred = F.softplus(self.tension_head(h)).squeeze(-1) * 1.0e6  # [N]
        return r_pred, t_pred

    def forward_with_derivatives(
        self,
        s_norm: torch.Tensor,
        t_norm: torch.Tensor,
        line_onehot: torch.Tensor,
        global_cond: torch.Tensor,
        r_anchor: torch.Tensor,
        r_fairlead: torch.Tensor,
        time_scale_s: float = 10.0,
    ) -> Dict[str, torch.Tensor]:
        """Evaluate r(s, t), T(s, t), and exact 1st/2nd-order spatial/temporal derivatives."""
        if not s_norm.requires_grad:
            s_norm = s_norm.clone().detach().requires_grad_(True)
        if not t_norm.requires_grad:
            t_norm = t_norm.clone().detach().requires_grad_(True)

        r_pred, t_pred = self.forward(s_norm, t_norm, line_onehot, global_cond, r_anchor, r_fairlead)
        L0 = self.cfg.unstretched_length_m
        ones = torch.ones_like(r_pred[:, 0])

        dr_ds_list, d2r_ds2_list = [], []
        dr_dt_list, d2r_dt2_list = [], []

        for dim in range(3):
            dr_ds_norm = torch.autograd.grad(
                r_pred[:, dim], s_norm, grad_outputs=ones, create_graph=True, retain_graph=True
            )[0]
            d2r_ds_norm2 = torch.autograd.grad(
                dr_ds_norm.squeeze(-1), s_norm, grad_outputs=ones, create_graph=True, retain_graph=True
            )[0]
            dr_dt_norm = torch.autograd.grad(
                r_pred[:, dim], t_norm, grad_outputs=ones, create_graph=True, retain_graph=True
            )[0]
            d2r_dt_norm2 = torch.autograd.grad(
                dr_dt_norm.squeeze(-1), t_norm, grad_outputs=ones, create_graph=True, retain_graph=True
            )[0]

            dr_ds_list.append(dr_ds_norm.squeeze(-1) / L0)
            d2r_ds2_list.append(d2r_ds_norm2.squeeze(-1) / (L0 ** 2))
            dr_dt_list.append(dr_dt_norm.squeeze(-1) / time_scale_s)
            d2r_dt2_list.append(d2r_dt_norm2.squeeze(-1) / (time_scale_s ** 2))

        dT_ds_norm = torch.autograd.grad(
            t_pred, s_norm, grad_outputs=ones, create_graph=True, retain_graph=True
        )[0]

        return {
            "r_pred": r_pred,
            "tension_pred": t_pred,
            "r_s": torch.stack(dr_ds_list, dim=-1),
            "r_ss": torch.stack(d2r_ds2_list, dim=-1),
            "v": torch.stack(dr_dt_list, dim=-1),
            "a": torch.stack(d2r_dt2_list, dim=-1),
            "T_s": dT_ds_norm.squeeze(-1) / L0,
        }
