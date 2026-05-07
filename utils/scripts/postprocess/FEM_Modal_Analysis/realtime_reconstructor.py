"""Real-time modal reconstruction: FFT result → deformed mesh + colours.

Usage
-----
    from realtime_reconstructor import RealtimeReconstructor, on_fft_result_realtime

    reconstructor = RealtimeReconstructor(
        modal_shapes_json_path='utils/OC4-modal_res.json',
        mesh_json_path='utils/OC4-modal_mesh.json',
        sample_rate_hz=60.0,
    )

    # Inside MQTT / FFT callback:
    result_dict = reconstructor.process(fft_result)
    await websocket.send_json(result_dict)
"""

import json
import logging
import re
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

import numpy as np

from spectrum_to_mesh import N_DOF, N_nodes, SpectrumToMesh

logger = logging.getLogger(__name__)


class RealtimeReconstructor:
    """Loads modal shapes and mesh once; reconstructs deformed mesh per FFT cycle.

    Parameters
    ----------
    modal_shapes_json_path:
        Path to OC4-modal_res.json  → {"modes": {"Mode_N_(Freq.:_F)": {"Modes": {"1": [ux,uy,uz,mag], ...}}}}
    mesh_json_path:
        Path to OC4-modal_mesh.json → {"nodes": {"1": [x,y,z], ...}}
    sample_rate_hz:
        Camera / sensor FPS — sets Nyquist limit for mode filtering.
    """

    def __init__(
        self,
        modal_shapes_json_path: str,
        mesh_json_path: str,
        sample_rate_hz: float = 60.0,
    ) -> None:
        t0 = time.perf_counter()
        logger.info("[Reconstructor] Loading modal shapes from %s …", modal_shapes_json_path)
        self._mode_shapes: Dict[int, np.ndarray] = self._load_modal_shapes(modal_shapes_json_path)

        logger.info("[Reconstructor] Loading node coordinates from %s …", mesh_json_path)
        self._node_coords: np.ndarray = self._load_node_coordinates(mesh_json_path)

        self._spectrum = SpectrumToMesh(sample_rate_hz=sample_rate_hz)
        self._valid_modes: Dict[int, float] = self._spectrum.valid_modes

        dt = time.perf_counter() - t0
        logger.info(
            "[Reconstructor] Ready — %d modes loaded, %d nodes, %.2f s init time",
            len(self._mode_shapes),
            len(self._node_coords),
            dt,
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def process(
        self,
        fft_result: dict,
        deformation_scale: float = 100.0,
        colormap: str = "jet",
    ) -> dict:
        """Reconstruct the deformed mesh from one FFT result.

        Parameters
        ----------
        fft_result:
            Output of the MQTT vibration analyser:
            ``{'matched_modes': [(mode_id, amplitude), ...], ...}``
        deformation_scale:
            Visual amplification of displacements (100 = ×100 magnification).
        colormap:
            Colour map name — 'jet', 'viridis', 'hot', or 'coolwarm'.

        Returns
        -------
        dict:
            JSON-ready payload with deformed_coords, colors, displacement,
            active_modes, modal_amplitudes, and stats.
        """
        t0 = time.perf_counter()

        modal_amplitudes = self._extract_modal_amplitudes(fft_result)

        if not modal_amplitudes:
            logger.debug("[Reconstructor] No matched modes — returning zero field.")
            modal_amplitudes = {}

        deformed, colors, displacement = self._spectrum.process_full(
            modal_amplitudes=modal_amplitudes,
            mode_shapes=self._mode_shapes,
            node_coords=self._node_coords,
            deformation_scale=deformation_scale,
            colormap=colormap,
        )

        magnitude = np.linalg.norm(displacement, axis=1)
        dt_ms = (time.perf_counter() - t0) * 1000.0
        logger.debug("[Reconstructor] process() completed in %.1f ms", dt_ms)

        return {
            "type": "modal_update",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "deformed_coords": deformed.astype(np.float32).tolist(),
            "colors": colors.tolist(),
            "displacement": displacement.astype(np.float32).tolist(),
            "active_modes": list(modal_amplitudes.keys()),
            "modal_amplitudes": {str(k): float(v) for k, v in modal_amplitudes.items()},
            "stats": {
                "n_nodes": int(N_nodes),
                "max_displacement_m": float(magnitude.max()),
                "max_displacement_um": float(magnitude.max() * 1e6),
                "mean_displacement_m": float(magnitude.mean()),
                "sample_rate_hz": float(self._spectrum.sample_rate_hz),
                "nyquist_hz": float(self._spectrum.nyquist),
                "n_active_modes": len(modal_amplitudes),
                "process_ms": round(dt_ms, 2),
            },
        }

    # ------------------------------------------------------------------
    # Private loaders
    # ------------------------------------------------------------------

    _MODE_NAME_RE = re.compile(r"Mode_(\d+)_")

    def _load_modal_shapes(self, path: str) -> Dict[int, np.ndarray]:
        """Parse OC4-modal_res.json → {mode_id: float32 array of shape (N_nodes*3,)}."""
        with open(path, "r") as fh:
            raw = json.load(fh)

        modes_raw: dict = raw["modes"]
        result: Dict[int, np.ndarray] = {}

        for mode_name, mode_data in modes_raw.items():
            m = self._MODE_NAME_RE.search(mode_name)
            if m is None:
                logger.warning("[Reconstructor] Cannot parse mode id from '%s' — skipped.", mode_name)
                continue
            mode_id = int(m.group(1))

            nodes_dict: dict = mode_data["Modes"]
            n = len(nodes_dict)
            arr = np.empty(n * N_DOF, dtype=np.float32)

            for node_str, values in nodes_dict.items():
                idx = (int(node_str) - 1) * N_DOF  # 1-indexed → 0-indexed
                arr[idx]     = values[0]  # ux
                arr[idx + 1] = values[1]  # uy
                arr[idx + 2] = values[2]  # uz  (4th value is magnitude — ignored)

            result[mode_id] = arr
            logger.debug("[Reconstructor] Mode %d loaded (%d nodes)", mode_id, n)

        logger.info("[Reconstructor] %d mode shapes loaded.", len(result))
        return result

    def _load_node_coordinates(self, path: str) -> np.ndarray:
        """Parse OC4-modal_mesh.json → float32 array of shape (N_nodes, 3)."""
        with open(path, "r") as fh:
            raw = json.load(fh)

        nodes_dict: dict = raw["nodes"]
        n = len(nodes_dict)
        coords = np.empty((n, N_DOF), dtype=np.float32)

        for node_str, xyz in nodes_dict.items():
            idx = int(node_str) - 1  # 1-indexed → 0-indexed
            coords[idx, 0] = xyz[0]
            coords[idx, 1] = xyz[1]
            coords[idx, 2] = xyz[2]

        logger.info("[Reconstructor] %d node coordinates loaded.", n)
        return coords

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _extract_modal_amplitudes(fft_result: dict) -> Dict[int, float]:
        """Convert the FFT result's matched_modes list to a {mode_id: amplitude} dict.

        Accepts two formats produced by different pipeline stages:
        - tuple list: [(mode_id, amplitude), ...]          (signal_processing.py)
        - dict list:  [{"mode_id": int, "amplitude": float, ...}]  (backend fem.py)
        """
        result: Dict[int, float] = {}
        for item in fft_result.get("matched_modes", []):
            if isinstance(item, dict):
                result[int(item["mode_id"])] = float(item["amplitude"])
            else:
                mode_id, amp = item
                result[int(mode_id)] = float(amp)
        return result


# ---------------------------------------------------------------------------
# Integration helper
# ---------------------------------------------------------------------------

async def on_fft_result_realtime(
    fft_result: dict,
    reconstructor: RealtimeReconstructor,
    websocket,  # FastAPI WebSocket or any object with async send_json()
    deformation_scale: float = 100.0,
    colormap: str = "jet",
) -> None:
    """Reconstruct mesh from *fft_result* and push the payload over *websocket*.

    Catches all exceptions so a bad FFT frame never kills the MQTT loop.
    """
    try:
        payload = reconstructor.process(
            fft_result,
            deformation_scale=deformation_scale,
            colormap=colormap,
        )
        await websocket.send_json(payload)
    except Exception:
        logger.exception("[Reconstructor] Error during real-time reconstruction — skipping frame.")
