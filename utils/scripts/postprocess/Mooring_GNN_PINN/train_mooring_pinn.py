"""Training and verification script for the OC4 Mooring GNN + PINN Digital Twin.

Supports:
1. Training MooringPIGNN on physics-consistent elastic catenary + Morison + SHM samples.
2. Optional physics-only self-supervised fine-tuning using real 6-DOF camera
   trajectories from results/recordings/*/keypoints.csv (--recordings-glob).
3. Verification of ContinuousMooringPINN autograd PDE residuals.
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import sys
from pathlib import Path
from typing import Dict, List, Optional

if __package__ is None or __package__ == "":
    _pkg_parent = str(Path(__file__).resolve().parent.parent)
    if _pkg_parent not in sys.path:
        sys.path.insert(0, _pkg_parent)
    __package__ = "Mooring_GNN_PINN"

import numpy as np
import torch
import yaml

from .graph_builder import MooringGraphBuilder
from .models import ContinuousMooringPINN, MooringPIGNN
from .physics_catenary import (
    ElasticCatenarySolver,
    OC4MooringConfig,
    PlatformToFairleadKinematics,
    generate_synthetic_mooring_sample,
)
from .pinn_loss import ContinuousPINNLoss, MooringPINNLoss
from .realtime_predictor import load_poses_from_csv


_DEFAULT_CONFIG_PATH = Path(__file__).parent / "config" / "mooring_gnn_pinn.yaml"


def build_synthetic_dataset(
    cfg: OC4MooringConfig,
    num_samples: int,
    seed: int = 42,
) -> List[Dict[str, np.ndarray]]:
    """Generate physics-based mooring samples covering healthy and faulty states."""
    rng = np.random.default_rng(seed)
    kinematics = PlatformToFairleadKinematics(cfg)
    solver = ElasticCatenarySolver(cfg)
    eq_cat = solver.solve_all_lines(kinematics, np.zeros(6, dtype=np.float64))

    samples = []
    for _ in range(num_samples):
        samples.append(generate_synthetic_mooring_sample(cfg, kinematics, solver, rng, eq_cat))
    return samples


def build_unsupervised_real_samples(
    cfg: OC4MooringConfig,
    builder: MooringGraphBuilder,
    recordings_glob: str,
    max_per_file: int = 40,
) -> List[Dict[str, np.ndarray]]:
    """Load real 6-DOF camera trajectories for physics-only PINN regularization."""
    samples: List[Dict[str, np.ndarray]] = []
    for csv_file in sorted(glob.glob(recordings_glob)):
        try:
            poses, times, _ = load_poses_from_csv(csv_file, max_frames=max_per_file)
        except Exception:
            continue
        for i, pose in enumerate(poses):
            if i > 0:
                dt = max(float(times[i] - times[i - 1]), 1e-3)
                vel = (pose - poses[i - 1]) / dt
            else:
                vel = np.zeros(6, dtype=np.float64)
            samples.append(builder.build_sample_dict_from_pose(pose, vel))
    return samples


def evaluate_pignn(
    model: MooringPIGNN,
    loss_fn: MooringPINNLoss,
    builder: MooringGraphBuilder,
    samples: List[Dict[str, np.ndarray]],
    batch_size: int,
    device: torch.device,
) -> Dict[str, float]:
    """Evaluate MooringPIGNN on a list of samples."""
    model.eval()
    agg: Dict[str, float] = {}
    correct_shm = 0
    total_shm = 0
    num_batches = 0

    with torch.no_grad():
        for start in range(0, len(samples), batch_size):
            chunk = samples[start : start + batch_size]
            batch = builder.collate_samples(chunk).to(device)
            preds = model(batch)
            _, metrics = loss_fn(preds, batch)

            for k, v in metrics.items():
                agg[k] = agg.get(k, 0.0) + v
            num_batches += 1

            if batch.shm_labels is not None:
                pred_cls = preds["shm_logits"].argmax(dim=-1)
                correct_shm += int((pred_cls == batch.shm_labels).sum().item())
                total_shm += int(batch.shm_labels.numel())

    if num_batches > 0:
        for k in agg:
            agg[k] /= num_batches
    agg["shm_acc"] = (correct_shm / total_shm) if total_shm > 0 else 0.0
    return agg


def verify_continuous_pinn_autograd(
    cfg: OC4MooringConfig,
    raw_cfg: dict,
    builder: MooringGraphBuilder,
    sample: Dict[str, np.ndarray],
    device: torch.device,
) -> Dict[str, float]:
    """Run one forward + autograd PDE backward check for ContinuousMooringPINN."""
    m_cfg = raw_cfg.get("model", {})
    cont_model = ContinuousMooringPINN(
        cfg=cfg,
        hidden_dim=int(m_cfg.get("continuous_pinn_hidden_dim", 128)),
        num_layers=int(m_cfg.get("continuous_pinn_layers", 4)),
        num_fourier_freqs=int(m_cfg.get("continuous_pinn_fourier_freqs", 8)),
    ).to(device)
    cont_loss_fn = ContinuousPINNLoss(cfg).to(device)

    batch = builder.collate_samples([sample]).to(device)
    # Create 24 collocation points across the 3 lines
    M = 24
    s_norm = torch.rand(M, 1, device=device, requires_grad=True)
    t_norm = torch.rand(M, 1, device=device, requires_grad=True)
    line_ids = torch.arange(M, device=device) % cfg.num_lines
    line_onehot = torch.nn.functional.one_hot(line_ids, num_classes=cfg.num_lines).float()
    global_cond = batch.global_cond.expand(M, -1)
    r_anchor = batch.r_anchor[0, line_ids, :]
    r_fairlead = batch.r_fairlead[0, line_ids, :]

    derivs = cont_model.forward_with_derivatives(
        s_norm, t_norm, line_onehot, global_cond, r_anchor, r_fairlead
    )
    loss, metrics = cont_loss_fn(derivs)
    loss.backward()

    # Check gradient finiteness
    has_valid_grads = all(
        p.grad is not None and torch.isfinite(p.grad).all()
        for p in cont_model.parameters()
    )
    if not has_valid_grads:
        raise RuntimeError("ContinuousMooringPINN produced non-finite or missing gradients!")
    return metrics


def train(args: argparse.Namespace) -> None:
    config_path = Path(args.config)
    with open(config_path, "r", encoding="utf-8") as fh:
        raw_cfg = yaml.safe_load(fh) or {}

    cfg = OC4MooringConfig.from_yaml(config_path)
    train_cfg = raw_cfg.get("training", {})
    model_cfg = raw_cfg.get("model", {})
    loss_weights = raw_cfg.get("loss_weights", {})

    epochs = int(args.epochs if args.epochs is not None else train_cfg.get("epochs", 40))
    num_samples = int(args.samples if args.samples is not None else train_cfg.get("num_synthetic_samples", 512))
    batch_size = int(args.batch_size if args.batch_size is not None else train_cfg.get("batch_size", 16))
    lr = float(args.lr if args.lr is not None else train_cfg.get("learning_rate", 1.0e-3))
    seed = int(train_cfg.get("seed", 42))
    val_split = float(train_cfg.get("val_split", 0.15))

    torch.manual_seed(seed)
    np.random.seed(seed)
    device = torch.device(args.device)

    print(f"[Train] Building {num_samples} physics-consistent OC4 mooring samples...")
    all_samples = build_synthetic_dataset(cfg, num_samples=num_samples, seed=seed)
    n_val = max(1, int(round(num_samples * val_split)))
    train_samples = all_samples[:-n_val]
    val_samples = all_samples[-n_val:]

    builder = MooringGraphBuilder(cfg)
    real_unsupervised: List[Dict[str, np.ndarray]] = []
    if args.recordings_glob:
        real_unsupervised = build_unsupervised_real_samples(cfg, builder, args.recordings_glob)
        print(f"[Train] Loaded {len(real_unsupervised)} real 6-DOF samples for physics-only regularization.")

    model = MooringPIGNN(
        cfg=cfg,
        hidden_dim=int(model_cfg.get("hidden_dim", 128)),
        num_mp_layers=int(model_cfg.get("num_mp_layers", 6)),
        dropout=float(model_cfg.get("dropout", 0.05)),
    ).to(device)
    loss_fn = MooringPINNLoss(cfg=cfg, weights=loss_weights).to(device)

    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=lr,
        weight_decay=float(train_cfg.get("weight_decay", 1.0e-5)),
    )
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=max(1, epochs))

    rng = np.random.default_rng(seed)
    best_val_loss = float("inf")
    history: List[Dict[str, float]] = []

    print(
        f"[Train] MooringPIGNN params={sum(p.numel() for p in model.parameters()):,} | "
        f"device={device} | epochs={epochs} | train={len(train_samples)} | val={len(val_samples)}"
    )

    for epoch in range(1, epochs + 1):
        model.train()
        perm = rng.permutation(len(train_samples))
        epoch_metrics: Dict[str, float] = {}
        n_steps = 0

        for start in range(0, len(train_samples), batch_size):
            idxs = perm[start : start + batch_size]
            chunk = [train_samples[int(i)] for i in idxs]
            batch = builder.collate_samples(chunk).to(device)

            optimizer.zero_grad(set_to_none=True)
            preds = model(batch)
            loss, metrics = loss_fn(preds, batch)

            # Optional physics-only regularization on real camera poses
            if real_unsupervised:
                real_idxs = rng.integers(0, len(real_unsupervised), size=min(4, len(real_unsupervised)))
                real_chunk = [real_unsupervised[int(i)] for i in real_idxs]
                real_batch = builder.collate_samples(real_chunk).to(device)
                real_preds = model(real_batch)
                real_loss, _ = loss_fn(real_preds, real_batch)
                loss = loss + 0.25 * real_loss

            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=2.0)
            optimizer.step()

            for k, v in metrics.items():
                epoch_metrics[k] = epoch_metrics.get(k, 0.0) + v
            n_steps += 1

        scheduler.step()
        for k in epoch_metrics:
            epoch_metrics[k] /= max(1, n_steps)

        val_metrics = evaluate_pignn(model, loss_fn, builder, val_samples, batch_size, device)
        history.append({"epoch": epoch, "train": epoch_metrics, "val": val_metrics})

        print(
            f"Epoch {epoch:03d}/{epochs:03d} | "
            f"Train={epoch_metrics['total']:.4f} (PDE={epoch_metrics['momentum_pde']:.4f}, "
            f"Const={epoch_metrics['constitutive']:.4f}) | "
            f"Val={val_metrics['total']:.4f} | SHM_Acc={val_metrics['shm_acc']*100:.1f}%"
        )

        if not args.verify_only and val_metrics["total"] < best_val_loss:
            best_val_loss = val_metrics["total"]
            ckpt_dir = Path(args.output_dir or train_cfg.get("checkpoint_dir", "checkpoints"))
            ckpt_dir.mkdir(parents=True, exist_ok=True)
            torch.save(
                {
                    "epoch": epoch,
                    "model_state_dict": model.state_dict(),
                    "val_metrics": val_metrics,
                    "config_path": str(config_path),
                },
                ckpt_dir / "mooring_pignn_best.pt",
            )

    if args.verify_only:
        cont_metrics = verify_continuous_pinn_autograd(cfg, raw_cfg, builder, val_samples[0], device)
        print(
            "[Verify] ContinuousMooringPINN autograd PDE check OK: "
            + ", ".join(f"{k}={v:.4f}" for k, v in cont_metrics.items())
        )
    else:
        ckpt_dir = Path(args.output_dir or train_cfg.get("checkpoint_dir", "checkpoints"))
        ckpt_dir.mkdir(parents=True, exist_ok=True)
        with open(ckpt_dir / "training_history.json", "w", encoding="utf-8") as fh:
            json.dump(history, fh, indent=2)
        print(f"[Train] Checkpoints & history saved to {ckpt_dir}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Train OC4 Mooring GNN+PINN Digital Twin")
    parser.add_argument("--config", type=str, default=str(_DEFAULT_CONFIG_PATH))
    parser.add_argument("--epochs", type=int, default=None)
    parser.add_argument("--samples", type=int, default=None)
    parser.add_argument("--batch-size", type=int, default=None)
    parser.add_argument("--lr", type=float, default=None)
    parser.add_argument("--device", type=str, default="cpu")
    parser.add_argument("--output-dir", type=str, default=None)
    parser.add_argument("--recordings-glob", type=str, default=None)
    parser.add_argument("--verify-only", action="store_true", help="Run fast training + autograd check without saving checkpoints")
    args = parser.parse_args()
    train(args)


if __name__ == "__main__":
    main()
