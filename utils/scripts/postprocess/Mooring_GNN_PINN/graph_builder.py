"""Graph construction for the OC4 3-line mooring system.

Builds a homogeneous-topology PyTorch graph G = (V, E) representing:
- 3 mooring lines discretized into N segments (N + 1 nodes per line)
- 1 global floating platform super-node coupled to the 3 fairleads
- Bidirectional structural line edges + platform-fairlead coupling edges
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional
import math

import numpy as np
import torch

from .physics_catenary import (
    OC4MooringConfig,
    PlatformToFairleadKinematics,
    ElasticCatenarySolver,
)


@dataclass
class MooringGraphBatch:
    """Batched tensor container for the OC4 mooring graph (fixed topology across batch)."""

    # Static topology tensors
    edge_index: torch.Tensor            # (2, E)
    fwd_edge_idx: torch.Tensor          # (num_lines * S,)
    bwd_edge_idx: torch.Tensor          # (num_lines * S,)
    line_node_indices: torch.Tensor     # (num_lines, N)
    anchor_node_indices: torch.Tensor   # (num_lines,)
    fairlead_node_indices: torch.Tensor # (num_lines,)
    platform_node_idx: int

    # Per-sample input tensors
    node_features: torch.Tensor         # (B, V, 16)
    edge_features: torch.Tensor         # (B, E, 10)
    global_cond: torch.Tensor           # (B, 16)

    # Physical reference tensors (prototype SI units)
    pos_cat_nom: torch.Tensor           # (B, num_lines, N, 3) [m]
    r_anchor: torch.Tensor              # (B, num_lines, 3) [m]
    r_fairlead: torch.Tensor            # (B, num_lines, 3) [m]
    v_fairlead: torch.Tensor            # (B, num_lines, 3) [m/s]
    env_4: torch.Tensor                 # (B, 4) [Hs, Tp, U_wind, U_curr]

    # Optional ground-truth / training supervision targets
    pos_target: Optional[torch.Tensor] = None       # (B, num_lines, N, 3) [m]
    vel_target: Optional[torch.Tensor] = None       # (B, num_lines, N, 3) [m/s]
    acc_target: Optional[torch.Tensor] = None       # (B, num_lines, N, 3) [m/s^2]
    tension_target: Optional[torch.Tensor] = None   # (B, num_lines, S) [N]
    touchdown_target: Optional[torch.Tensor] = None # (B, num_lines, N) {0, 1}
    shm_labels: Optional[torch.Tensor] = None       # (B, num_lines) int64
    health_factors: Optional[torch.Tensor] = None   # (B, num_lines, 2) [EA_ratio, w_ratio]

    def to(self, device: torch.device | str) -> "MooringGraphBatch":
        """Move all tensors in the batch to the target device."""
        return MooringGraphBatch(
            edge_index=self.edge_index.to(device),
            fwd_edge_idx=self.fwd_edge_idx.to(device),
            bwd_edge_idx=self.bwd_edge_idx.to(device),
            line_node_indices=self.line_node_indices.to(device),
            anchor_node_indices=self.anchor_node_indices.to(device),
            fairlead_node_indices=self.fairlead_node_indices.to(device),
            platform_node_idx=self.platform_node_idx,
            node_features=self.node_features.to(device),
            edge_features=self.edge_features.to(device),
            global_cond=self.global_cond.to(device),
            pos_cat_nom=self.pos_cat_nom.to(device),
            r_anchor=self.r_anchor.to(device),
            r_fairlead=self.r_fairlead.to(device),
            v_fairlead=self.v_fairlead.to(device),
            env_4=self.env_4.to(device),
            pos_target=self.pos_target.to(device) if self.pos_target is not None else None,
            vel_target=self.vel_target.to(device) if self.vel_target is not None else None,
            acc_target=self.acc_target.to(device) if self.acc_target is not None else None,
            tension_target=self.tension_target.to(device) if self.tension_target is not None else None,
            touchdown_target=self.touchdown_target.to(device) if self.touchdown_target is not None else None,
            shm_labels=self.shm_labels.to(device) if self.shm_labels is not None else None,
            health_factors=self.health_factors.to(device) if self.health_factors is not None else None,
        )


class MooringGraphBuilder:
    """Builds fixed-topology PyTorch graph batches from OC4 mooring physics states."""

    NODE_FEAT_DIM = 16
    EDGE_FEAT_DIM = 10
    GLOBAL_COND_DIM = 16

    def __init__(self, cfg: OC4MooringConfig) -> None:
        self.cfg = cfg
        self.kinematics = PlatformToFairleadKinematics(cfg)
        self.solver = ElasticCatenarySolver(cfg)
        self.equilibrium_catenary = self.solver.solve_all_lines(
            self.kinematics, np.zeros(6, dtype=np.float64)
        )
        self.pos_eq_default = np.stack([c["positions"] for c in self.equilibrium_catenary], axis=0)

        self._init_topology()

    def _init_topology(self) -> None:
        K = self.cfg.num_lines
        N = self.cfg.nodes_per_line
        S = self.cfg.segments_per_line

        self.num_line_nodes = K * N
        self.platform_node_idx = K * N
        self.total_nodes = K * N + 1

        line_nodes = np.arange(K * N, dtype=np.int64).reshape(K, N)
        self.line_node_indices = torch.from_numpy(line_nodes)
        self.anchor_node_indices = torch.from_numpy(line_nodes[:, 0].copy())
        self.fairlead_node_indices = torch.from_numpy(line_nodes[:, -1].copy())

        src_list: List[int] = []
        dst_list: List[int] = []
        fwd_idx: List[int] = []
        bwd_idx: List[int] = []
        edge_types: List[float] = []
        edge_ref_len: List[float] = []

        seg_len = self.cfg.segment_length_m

        # 1. Intra-line bidirectional edges
        for k in range(K):
            for j in range(S):
                u = int(line_nodes[k, j])
                v = int(line_nodes[k, j + 1])

                fwd_idx.append(len(src_list))
                src_list.append(u)
                dst_list.append(v)
                edge_types.append(0.0)
                edge_ref_len.append(seg_len)

                bwd_idx.append(len(src_list))
                src_list.append(v)
                dst_list.append(u)
                edge_types.append(0.0)
                edge_ref_len.append(seg_len)

        # 2. Platform super-node <-> Fairlead bidirectional coupling edges
        r_couple = math.hypot(self.cfg.fairlead_radius_m, self.cfg.fairlead_depth_m)
        for k in range(K):
            f_node = int(line_nodes[k, -1])
            src_list.append(self.platform_node_idx)
            dst_list.append(f_node)
            edge_types.append(1.0)
            edge_ref_len.append(r_couple)

            src_list.append(f_node)
            dst_list.append(self.platform_node_idx)
            edge_types.append(1.0)
            edge_ref_len.append(r_couple)

        self.edge_index = torch.tensor([src_list, dst_list], dtype=torch.long)
        self.fwd_edge_idx = torch.tensor(fwd_idx, dtype=torch.long)
        self.bwd_edge_idx = torch.tensor(bwd_idx, dtype=torch.long)
        self.edge_types_np = np.array(edge_types, dtype=np.float32)
        self.edge_ref_len_np = np.array(edge_ref_len, dtype=np.float32)

    def build_sample_dict_from_pose(
        self,
        pose_6dof: np.ndarray,
        vel_6dof: Optional[np.ndarray] = None,
        env_4: Optional[np.ndarray] = None,
        from_model_scale: Optional[bool] = None,
    ) -> Dict[str, np.ndarray]:
        """Compute physical priors and assemble a sample dict ready for graph batching."""
        pose_proto, vel_proto = self.kinematics.scale_pose_to_prototype(
            pose_6dof, vel_6dof, from_model_scale=from_model_scale
        )
        env = (
            np.array([1.5, 10.0, 8.0, 0.5], dtype=np.float64)
            if env_4 is None
            else np.asarray(env_4, dtype=np.float64)
        )

        r_fair, v_fair = self.kinematics.compute_fairleads(pose_proto, vel_proto)
        cat_nom = self.solver.solve_all_lines(self.kinematics, pose_proto)
        pos_cat_nom = np.stack([c["positions"] for c in cat_nom], axis=0)

        return {
            "pose_6dof": pose_proto,
            "vel_6dof": vel_proto,
            "env_4": env,
            "r_anchor": self.kinematics.anchor_positions.copy(),
            "r_fairlead": r_fair,
            "v_fairlead": v_fair,
            "pos_eq": self.pos_eq_default.copy(),
            "pos_cat_nom": pos_cat_nom,
        }

    def build_single_tensors(self, sample: Dict[str, np.ndarray]) -> Dict[str, np.ndarray]:
        """Construct normalized node_features, edge_features, and global_cond for one sample."""
        K = self.cfg.num_lines
        N = self.cfg.nodes_per_line
        S = self.cfg.segments_per_line
        L0 = self.cfg.unstretched_length_m
        h = self.cfg.water_depth_m
        v_ref = 5.0

        pose_6dof = sample["pose_6dof"]
        vel_6dof = sample["vel_6dof"]
        env_4 = sample["env_4"]
        pos_cat_nom = sample["pos_cat_nom"]  # (K, N, 3)
        pos_eq = sample["pos_eq"]            # (K, N, 3)
        v_fair = sample["v_fairlead"]        # (K, 3)

        s_norm = np.linspace(0.0, 1.0, N, dtype=np.float32)

        # Prior nodal velocity: linear ramp from 0 at anchor to v_fair at fairlead
        vel_prior_lines = (s_norm[None, :, None] ** 1.5) * v_fair[:, None, :]

        node_feats = np.zeros((self.total_nodes, self.NODE_FEAT_DIM), dtype=np.float32)
        node_pos_all = np.zeros((self.total_nodes, 3), dtype=np.float32)
        node_vel_all = np.zeros((self.total_nodes, 3), dtype=np.float32)

        for k in range(K):
            offset = k * N
            node_pos_all[offset : offset + N] = pos_cat_nom[k].astype(np.float32)
            node_vel_all[offset : offset + N] = vel_prior_lines[k].astype(np.float32)

            node_feats[offset : offset + N, 0:3] = (pos_cat_nom[k] / L0).astype(np.float32)
            node_feats[offset : offset + N, 3:6] = (pos_eq[k] / L0).astype(np.float32)
            node_feats[offset : offset + N, 6:9] = (vel_prior_lines[k] / v_ref).astype(np.float32)
            node_feats[offset : offset + N, 9] = s_norm
            node_feats[offset, 10] = 1.0            # is_anchor
            node_feats[offset + S, 11] = 1.0        # is_fairlead
            node_feats[offset : offset + N, 12] = 0.0
            node_feats[offset : offset + N, 13] = 1.0  # nominal EA / EA_0
            node_feats[offset : offset + N, 14] = 1.0  # nominal w / w_0
            node_feats[offset : offset + N, 15] = ((pos_cat_nom[k, :, 2] + h) / h).astype(np.float32)

        # Super-node platform features
        p_idx = self.platform_node_idx
        node_pos_all[p_idx] = pose_6dof[:3].astype(np.float32)
        node_vel_all[p_idx] = vel_6dof[:3].astype(np.float32)
        node_feats[p_idx, 0:3] = (pose_6dof[:3] / L0).astype(np.float32)
        node_feats[p_idx, 6:9] = (vel_6dof[:3] / v_ref).astype(np.float32)
        node_feats[p_idx, 12] = 1.0
        node_feats[p_idx, 13:16] = pose_6dof[3:6].astype(np.float32)

        # Edge features
        src_np = self.edge_index[0].numpy()
        dst_np = self.edge_index[1].numpy()
        dr = node_pos_all[dst_np] - node_pos_all[src_np]
        dv = node_vel_all[dst_np] - node_vel_all[src_np]
        dist = np.linalg.norm(dr, axis=-1, keepdims=True)
        l_ref = self.edge_ref_len_np[:, None]
        strain = np.where(self.edge_types_np[:, None] < 0.5, (dist - l_ref) / (l_ref + 1e-6), 0.0)

        edge_feats = np.concatenate(
            [
                dr / (l_ref + 1e-6),
                dist / (l_ref + 1e-6),
                strain,
                dv / v_ref,
                l_ref / L0,
                self.edge_types_np[:, None],
            ],
            axis=-1,
        ).astype(np.float32)

        # Global context vector (16 dims)
        global_cond = np.array(
            [
                pose_6dof[0] / 10.0,
                pose_6dof[1] / 10.0,
                pose_6dof[2] / 5.0,
                pose_6dof[3],
                pose_6dof[4],
                pose_6dof[5],
                vel_6dof[0] / 2.0,
                vel_6dof[1] / 2.0,
                vel_6dof[2] / 2.0,
                vel_6dof[3],
                vel_6dof[4],
                vel_6dof[5],
                env_4[0] / 5.0,
                env_4[1] / 15.0,
                env_4[2] / 25.0,
                env_4[3] / 2.0,
            ],
            dtype=np.float32,
        )

        return {
            "node_features": node_feats,
            "edge_features": edge_feats,
            "global_cond": global_cond,
        }

    def collate_samples(self, samples: List[Dict[str, np.ndarray]]) -> MooringGraphBatch:
        """Collate a list of sample dicts into a batched MooringGraphBatch."""
        node_feats_list, edge_feats_list, gcond_list = [], [], []
        for smp in samples:
            tensors = self.build_single_tensors(smp)
            node_feats_list.append(tensors["node_features"])
            edge_feats_list.append(tensors["edge_features"])
            gcond_list.append(tensors["global_cond"])

        def stack_f32(key: str) -> Optional[torch.Tensor]:
            if key not in samples[0] or samples[0][key] is None:
                return None
            return torch.from_numpy(np.stack([s[key] for s in samples], axis=0).astype(np.float32))

        shm_labels = None
        if "shm_labels" in samples[0] and samples[0]["shm_labels"] is not None:
            shm_labels = torch.from_numpy(np.stack([s["shm_labels"] for s in samples], axis=0).astype(np.int64))

        return MooringGraphBatch(
            edge_index=self.edge_index.clone(),
            fwd_edge_idx=self.fwd_edge_idx.clone(),
            bwd_edge_idx=self.bwd_edge_idx.clone(),
            line_node_indices=self.line_node_indices.clone(),
            anchor_node_indices=self.anchor_node_indices.clone(),
            fairlead_node_indices=self.fairlead_node_indices.clone(),
            platform_node_idx=self.platform_node_idx,
            node_features=torch.from_numpy(np.stack(node_feats_list, axis=0)),
            edge_features=torch.from_numpy(np.stack(edge_feats_list, axis=0)),
            global_cond=torch.from_numpy(np.stack(gcond_list, axis=0)),
            pos_cat_nom=stack_f32("pos_cat_nom"),
            r_anchor=stack_f32("r_anchor"),
            r_fairlead=stack_f32("r_fairlead"),
            v_fairlead=stack_f32("v_fairlead"),
            env_4=stack_f32("env_4"),
            pos_target=stack_f32("pos_target"),
            vel_target=stack_f32("vel_target"),
            acc_target=stack_f32("acc_target"),
            tension_target=stack_f32("tension_target"),
            touchdown_target=stack_f32("touchdown_target"),
            shm_labels=shm_labels,
            health_factors=stack_f32("health_factors"),
        )
