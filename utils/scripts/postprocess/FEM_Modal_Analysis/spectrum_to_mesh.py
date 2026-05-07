import numpy as np
import json
import os
from datetime import datetime
from typing import Dict, List, Optional, Tuple
import logging

# Colormap LUT size (number of discrete colours)
_LUT_SIZE = 256

try:
    from signal_processing import SAMPLE_RATE_HZ as _DEFAULT_SAMPLE_RATE_HZ
except ImportError:
    _DEFAULT_SAMPLE_RATE_HZ = 10.0  # fallback when imported outside the local scripts dir

# Constants
N_nodes = 56428
N_DOF = 3  # ux, uy, uz

MODES_TO_USE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
                19, 20, 21, 22, 23, 24, 25, 26, 27]

MODAL_FREQUENCIES: Dict[int, float] = {
    1: 0.7196,
    2: 0.7197,
    3: 4.224,
    4: 4.224,
    5: 6.527,
    6: 10.62,
    7: 10.84,
    8: 10.84,
    9: 18.57,
    10: 18.57,
    11: 18.79,
    12: 18.80,
    13: 19.03,
    14: 19.11,
    15: 19.48,
    16: 19.48,
    17: 19.57,
    18: 20.04,
    19: 20.88,
    20: 20.95,
    21: 21.51,
    22: 21.79,
    23: 22.91,
    24: 23.49,
    25: 23.51,
    26: 27.16,
    27: 27.17,
}


def compute_nyquist(sample_rate_hz: float) -> float:
    """Return the Nyquist frequency for the given sample rate."""
    return sample_rate_hz / 2.0


def validate_modes(sample_rate_hz: float) -> Dict[int, float]:
    """Return the subset of MODAL_FREQUENCIES reachable below Nyquist.

    Any mode whose frequency exceeds the Nyquist limit cannot be resolved with
    the current camera FPS and is excluded from reconstruction.
    """
    nyquist = compute_nyquist(sample_rate_hz)
    valid = {}
    skipped = []

    for mode_id, freq in MODAL_FREQUENCIES.items():
        if mode_id not in MODES_TO_USE:
            continue
        if freq <= nyquist:
            valid[mode_id] = freq
        else:
            skipped.append((mode_id, freq))

    if skipped:
        logging.warning(
            f"[spectrum_to_mesh] Nyquist={nyquist:.3f} Hz (SR={sample_rate_hz:.2f} Hz). "
            f"Excluding {len(skipped)} mode(s) above Nyquist: "
            + ", ".join(f"Mode {m} ({f:.3f} Hz)" for m, f in skipped)
        )

    return valid


class SpectrumToMesh:
    """Projects modal participation factors onto the FEM mesh in real time.

    The Nyquist limit is recomputed whenever the camera FPS changes so that
    modes above the observable frequency range are automatically excluded.
    """

    def __init__(self, sample_rate_hz: float = _DEFAULT_SAMPLE_RATE_HZ):
        self._sample_rate_hz = sample_rate_hz
        self._nyquist = compute_nyquist(sample_rate_hz)
        self._valid_modes = validate_modes(sample_rate_hz)

        logging.info(
            f"[SpectrumToMesh] Initialized — SR={self._sample_rate_hz:.2f} Hz, "
            f"Nyquist={self._nyquist:.3f} Hz, "
            f"active modes: {list(self._valid_modes.keys())}"
        )

    def update_sample_rate(self, sample_rate_hz: float) -> None:
        """Update Nyquist and revalidate modes when the camera FPS changes."""
        if sample_rate_hz <= 0 or abs(sample_rate_hz - self._sample_rate_hz) < 0.1:
            return
        self._sample_rate_hz = sample_rate_hz
        self._nyquist = compute_nyquist(sample_rate_hz)
        self._valid_modes = validate_modes(sample_rate_hz)
        logging.info(
            f"[SpectrumToMesh] Sample rate updated → {sample_rate_hz:.2f} Hz | "
            f"Nyquist={self._nyquist:.3f} Hz | "
            f"active modes: {list(self._valid_modes.keys())}"
        )

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def sample_rate_hz(self) -> float:
        return self._sample_rate_hz

    @property
    def nyquist(self) -> float:
        return self._nyquist

    @property
    def valid_modes(self) -> Dict[int, float]:
        return self._valid_modes

    # ------------------------------------------------------------------
    # Core reconstruction
    # ------------------------------------------------------------------

    def project(
        self,
        modal_amplitudes: Dict[int, float],
        mode_shapes: Dict[int, np.ndarray],
    ) -> np.ndarray:
        """Superpose modal contributions onto the mesh displacement field.

        Parameters
        ----------
        modal_amplitudes:
            {mode_id: participation_factor} from the FFT result.
        mode_shapes:
            {mode_id: array of shape (N_nodes * N_DOF,)} preloaded eigenvectors.

        Returns
        -------
        displacement: np.ndarray of shape (N_nodes, N_DOF)
        """
        displacement = np.zeros(N_nodes * N_DOF)

        for mode_id, amplitude in modal_amplitudes.items():
            if mode_id not in self._valid_modes:
                continue  # above Nyquist or not in MODES_TO_USE
            if mode_id not in mode_shapes:
                logging.warning(f"[SpectrumToMesh] Mode shape for mode {mode_id} not loaded.")
                continue
            displacement += amplitude * mode_shapes[mode_id]

        return displacement.reshape(N_nodes, N_DOF)

    def result_to_dict(
        self,
        displacement: np.ndarray,
        modal_amplitudes: Dict[int, float],
    ) -> dict:
        """Serialize a displacement field to a JSON-serializable dict."""
        return {
            "timestamp": datetime.now().isoformat(),
            "sample_rate_hz": self._sample_rate_hz,
            "nyquist_hz": self._nyquist,
            "active_modes": list(self._valid_modes.keys()),
            "modal_amplitudes": {str(k): v for k, v in modal_amplitudes.items()},
            "displacement_norm": float(np.linalg.norm(displacement)),
            "max_displacement": float(np.max(np.abs(displacement))),
        }

    # ------------------------------------------------------------------
    # 1. Colormap LUT
    # ------------------------------------------------------------------

    def _generate_colormap_lut(self, colormap: str = "jet") -> np.ndarray:
        """Build an (N, 3) uint8 RGB look-up table for the given colormap.

        Supported colormaps: 'jet', 'viridis', 'hot', 'coolwarm'.
        Falls back to 'jet' for unknown names.

        Returns
        -------
        lut: np.ndarray of shape (_LUT_SIZE, 3), dtype uint8
        """
        t = np.linspace(0.0, 1.0, _LUT_SIZE)

        if colormap == "viridis":
            r = np.clip(0.267 + 0.704 * t + 0.029 * t**2, 0, 1)
            g = np.clip(0.005 + 1.085 * t - 0.085 * t**2, 0, 1)
            b = np.clip(0.329 + 0.325 * t - 0.654 * t**2, 0, 1)
        elif colormap == "hot":
            r = np.clip(t * 3.0, 0, 1)
            g = np.clip(t * 3.0 - 1.0, 0, 1)
            b = np.clip(t * 3.0 - 2.0, 0, 1)
        elif colormap == "coolwarm":
            r = np.clip(0.230 + 1.540 * t - 0.770 * t**2, 0, 1)
            g = np.clip(0.300 + 0.800 * t - 1.100 * t**2, 0, 1)
            b = np.clip(0.900 - 0.800 * t + 0.000 * t**2, 0, 1)
        else:  # jet (default)
            r = np.clip(1.5 - np.abs(4.0 * t - 3.0), 0, 1)
            g = np.clip(1.5 - np.abs(4.0 * t - 2.0), 0, 1)
            b = np.clip(1.5 - np.abs(4.0 * t - 1.0), 0, 1)

        lut = (np.stack([r, g, b], axis=1) * 255).astype(np.uint8)
        self._lut = lut
        return lut

    # ------------------------------------------------------------------
    # 2. Magnitud nodal
    # ------------------------------------------------------------------

    @staticmethod
    def compute_magnitude(displacement: np.ndarray) -> np.ndarray:
        """Return the Euclidean displacement magnitude for every node.

        Parameters
        ----------
        displacement: (N_nodes, N_DOF) array

        Returns
        -------
        magnitude: (N_nodes,) array of non-negative floats
        """
        return np.linalg.norm(displacement, axis=1)

    # ------------------------------------------------------------------
    # 3. Normalización
    # ------------------------------------------------------------------

    @staticmethod
    def normalize_magnitude(
        magnitude: np.ndarray,
        vmin: Optional[float] = None,
        vmax: Optional[float] = None,
    ) -> np.ndarray:
        """Map magnitude values to [0, 1].

        Parameters
        ----------
        magnitude: (N_nodes,) array
        vmin, vmax: clip range; if None, use data min/max.

        Returns
        -------
        normalized: (N_nodes,) float64 in [0, 1]
        """
        lo = vmin if vmin is not None else float(magnitude.min())
        hi = vmax if vmax is not None else float(magnitude.max())
        if hi - lo < 1e-12:
            return np.zeros_like(magnitude, dtype=np.float64)
        return np.clip((magnitude - lo) / (hi - lo), 0.0, 1.0)

    # ------------------------------------------------------------------
    # 4. Aplicar colormap
    # ------------------------------------------------------------------

    def apply_colormap(
        self,
        normalized: np.ndarray,
        colormap: str = "jet",
    ) -> np.ndarray:
        """Map a normalized [0,1] array to RGB colours via the LUT.

        Parameters
        ----------
        normalized: (N_nodes,) float array in [0, 1]
        colormap: name passed to _generate_colormap_lut if LUT not cached.

        Returns
        -------
        colors: (N_nodes, 3) uint8 RGB array
        """
        if not hasattr(self, "_lut"):
            self._generate_colormap_lut(colormap)

        indices = np.clip(
            (normalized * (_LUT_SIZE - 1)).astype(np.int32), 0, _LUT_SIZE - 1
        )
        return self._lut[indices]

    # ------------------------------------------------------------------
    # 5. Escala visual de deformación
    # ------------------------------------------------------------------

    @staticmethod
    def apply_deformation_scale(
        displacement: np.ndarray,
        node_coords: np.ndarray,
        scale: float = 1.0,
    ) -> np.ndarray:
        """Add scaled displacements to the reference node coordinates.

        Parameters
        ----------
        displacement: (N_nodes, N_DOF) deformation field
        node_coords: (N_nodes, N_DOF) reference node positions
        scale: visual amplification factor (1.0 = true scale)

        Returns
        -------
        deformed_coords: (N_nodes, N_DOF) array
        """
        return node_coords + scale * displacement

    # ------------------------------------------------------------------
    # 6. Pipeline completo (PRINCIPAL)
    # ------------------------------------------------------------------

    def process_full(
        self,
        modal_amplitudes: Dict[int, float],
        mode_shapes: Dict[int, np.ndarray],
        node_coords: np.ndarray,
        deformation_scale: float = 1.0,
        colormap: str = "jet",
        vmin: Optional[float] = None,
        vmax: Optional[float] = None,
    ) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Full real-time reconstruction pipeline.

        Steps
        -----
        1. project()              → displacement field
        2. compute_magnitude()    → nodal magnitudes
        3. normalize_magnitude()  → [0, 1] range
        4. apply_colormap()       → RGB colours
        5. apply_deformation_scale() → visual deformed mesh

        Parameters
        ----------
        modal_amplitudes: {mode_id: participation_factor}
        mode_shapes: preloaded eigenvectors per mode
        node_coords: (N_nodes, N_DOF) reference positions
        deformation_scale: visual amplification factor
        colormap: LUT name
        vmin, vmax: magnitude clipping range for colour mapping

        Returns
        -------
        deformed_coords : (N_nodes, N_DOF) deformed node positions
        colors          : (N_nodes, 3) uint8 RGB per node
        displacement    : (N_nodes, N_DOF) raw displacement field
        """
        displacement = self.project(modal_amplitudes, mode_shapes)
        magnitude    = self.compute_magnitude(displacement)
        normalized   = self.normalize_magnitude(magnitude, vmin=vmin, vmax=vmax)
        colors       = self.apply_colormap(normalized, colormap=colormap)
        deformed     = self.apply_deformation_scale(displacement, node_coords, deformation_scale)
        return deformed, colors, displacement

    # ------------------------------------------------------------------
    # 7. Serialización JSON
    # ------------------------------------------------------------------

    def to_json_dict(
        self,
        displacement: np.ndarray,
        modal_amplitudes: Dict[int, float],
        colors: Optional[np.ndarray] = None,
        deformed_coords: Optional[np.ndarray] = None,
    ) -> dict:
        """Build a complete JSON-serializable result dict.

        Parameters
        ----------
        displacement: (N_nodes, N_DOF) raw field
        modal_amplitudes: participation factors used
        colors: (N_nodes, 3) uint8 RGB (optional)
        deformed_coords: (N_nodes, N_DOF) deformed positions (optional)

        Returns
        -------
        dict ready for json.dumps()
        """
        magnitude = self.compute_magnitude(displacement)
        payload: dict = {
            "timestamp": datetime.now().isoformat(),
            "sample_rate_hz": self._sample_rate_hz,
            "nyquist_hz": self._nyquist,
            "active_modes": list(self._valid_modes.keys()),
            "modal_amplitudes": {str(k): float(v) for k, v in modal_amplitudes.items()},
            "displacement_norm": float(np.linalg.norm(displacement)),
            "max_displacement": float(magnitude.max()),
            "mean_displacement": float(magnitude.mean()),
        }
        if colors is not None:
            payload["colors_rgb"] = colors.tolist()
        if deformed_coords is not None:
            payload["deformed_coords"] = deformed_coords.tolist()
        return payload


# ----------------------------------------------------------------------
# 8. Función auxiliar de carga de formas modales
# ----------------------------------------------------------------------

def load_modal_shapes(
    shapes_dir: str,
    modes: List[int],
    n_nodes: int = N_nodes,
    n_dof: int = N_DOF,
    file_pattern: str = "mode_{mode_id:03d}.npy",
) -> Dict[int, np.ndarray]:
    """Load pre-computed eigenvectors from disk.

    Expects one .npy file per mode with shape (n_nodes * n_dof,).

    Parameters
    ----------
    shapes_dir: directory containing the .npy files
    modes: list of mode IDs to load
    n_nodes: number of mesh nodes (default N_nodes)
    n_dof: degrees of freedom per node (default N_DOF)
    file_pattern: filename template; receives ``mode_id`` as keyword argument.

    Returns
    -------
    mode_shapes: {mode_id: ndarray of shape (n_nodes * n_dof,)}
    """
    mode_shapes: Dict[int, np.ndarray] = {}
    expected_len = n_nodes * n_dof

    for mode_id in modes:
        filename = file_pattern.format(mode_id=mode_id)
        filepath = os.path.join(shapes_dir, filename)

        if not os.path.isfile(filepath):
            logging.warning(f"[load_modal_shapes] File not found: {filepath}")
            continue

        data = np.load(filepath)

        if data.size != expected_len:
            logging.error(
                f"[load_modal_shapes] Mode {mode_id}: expected {expected_len} values, "
                f"got {data.size}. Skipping."
            )
            continue

        mode_shapes[mode_id] = data.ravel().astype(np.float64)
        logging.info(f"[load_modal_shapes] Loaded mode {mode_id} from {filepath}")

    return mode_shapes
