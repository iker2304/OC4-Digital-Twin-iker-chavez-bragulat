"""FRF-based modal amplitude correction.

When enabled via detection.yaml (fem.frf_correction.enabled: true), this module
corrects the raw FFT amplitudes by removing the resonance amplification effect of
each mode's Frequency Response Function (FRF).

Theory
------
The FFT of the measured displacement gives Q(omega) = H(omega) * F(omega).
The raw spectral amplitude |Q| already represents the physical displacement in
metres (after pixel-to-metre calibration).  Dividing by |H| recovers the modal
force contribution |F|, which is independent of how close the excitation frequency
is to the natural frequency.

    |H_i(omega)| = (1/M_i) / sqrt( (omega_i^2 - omega^2)^2 + (2*zeta_i*omega_i*omega)^2 )

    amp_corrected = amp_raw / |H_i(omega)|

Use case
--------
This correction is useful when you want to compare the *forcing* between modes
rather than the *response*.  For pure deformation visualisation the raw amplitude
is sufficient — enable this only if you need physically meaningful modal force
estimates (e.g. fatigue load estimation).

Usage
-----
    from frf_correction import FRFCorrector

    corrector = FRFCorrector(zeta=0.01)          # 1 % damping for all modes
    matched   = corrector.correct(matched_modes)  # list of mode dicts
"""

import logging
import math
from typing import Dict, List

logger = logging.getLogger(__name__)

# Modal frequencies (Hz) — must match spectrum_to_mesh.py
_MODAL_FREQUENCIES: Dict[int, float] = {
    1: 0.7196,  2: 0.7197,  3: 4.224,  4: 4.224,  5: 6.527,
    6: 10.62,   7: 10.84,   8: 10.84,  9: 18.57,  10: 18.57,
    11: 18.79,  12: 18.80,  13: 19.03, 14: 19.11,  15: 19.48,
    16: 19.48,  17: 19.57,  18: 20.04, 19: 20.88,  20: 20.95,
    21: 21.51,  22: 21.79,  23: 22.91, 24: 23.49,  25: 23.51,
    26: 27.16,  27: 27.17,
}


class FRFCorrector:
    """Removes resonance amplification from raw FFT modal amplitudes.

    Parameters
    ----------
    zeta:
        Modal damping ratio applied uniformly to all modes.
        Typical values for offshore steel structures: 0.01 - 0.02 (1-2 %).
    modal_mass:
        Modal mass Mᵢ.  If the FEM eigenvectors are mass-normalised
        (phi_i^T * M * phi_i = 1) this equals 1.0 for every mode.
    """

    def __init__(self, zeta: float = 0.01, modal_mass: float = 1.0) -> None:
        if not (0.0 < zeta < 1.0):
            raise ValueError(f"zeta must be in (0, 1), got {zeta}")
        self.zeta = zeta
        self.modal_mass = modal_mass
        logger.info(
            "[FRFCorrector] Initialised — zeta=%.4f, modal_mass=%.3f",
            zeta, modal_mass,
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def frf_magnitude(self, omega: float, omega_i: float) -> float:
        """Return |Hᵢ(ω)| for a single (excitation, natural) frequency pair.

        Parameters
        ----------
        omega:
            Excitation frequency in rad/s.
        omega_i:
            Natural frequency of the mode in rad/s.

        Returns
        -------
        float — always positive; very small near resonance with low damping.
        """
        B = omega_i ** 2 - omega ** 2           # real part of denominator
        C = 2.0 * self.zeta * omega_i * omega   # imaginary part of denominator
        return (1.0 / self.modal_mass) / math.sqrt(B ** 2 + C ** 2)

    def correct(self, matched_modes: List[Dict]) -> List[Dict]:
        """Apply FRF correction to a list of matched mode dicts.

        Each dict must contain at least:
            "mode_id"   : int
            "freq_hz"   : float  — excitation frequency bin (Hz)
            "amplitude" : float  — raw FFT magnitude (metres)

        Returns a new list of dicts with two additional fields:
            "amplitude_raw" : original uncorrected amplitude
            "amplitude"     : FRF-corrected amplitude (overwrites original)
            "H_mag"         : |Hᵢ(ω)| used for correction
        """
        corrected: List[Dict] = []

        for mode in matched_modes:
            mode_id = int(mode["mode_id"])
            f_exc   = float(mode["freq_hz"])
            amp_raw = float(mode["amplitude"])

            omega_i = 2.0 * math.pi * _MODAL_FREQUENCIES.get(mode_id, f_exc)
            omega   = 2.0 * math.pi * f_exc

            H_mag = self.frf_magnitude(omega, omega_i)

            # Guard: avoid division by near-zero for extremely low damping
            if H_mag < 1e-12:
                logger.warning(
                    "[FRFCorrector] |H| ≈ 0 for mode %d at %.4f Hz — skipping correction.",
                    mode_id, f_exc,
                )
                corrected.append({**mode})
                continue

            amp_corrected = amp_raw / H_mag

            corrected.append({
                **mode,
                "amplitude_raw": amp_raw,
                "amplitude":     amp_corrected,
                "H_mag":         H_mag,
            })

            logger.debug(
                "[FRFCorrector] Mode %d: amp_raw=%.6f  |H|=%.4f  amp_corr=%.6f",
                mode_id, amp_raw, H_mag, amp_corrected,
            )

        return corrected

    # ------------------------------------------------------------------
    # Convenience: build from YAML config dict
    # ------------------------------------------------------------------

    @classmethod
    def from_config(cls, cfg: dict) -> "FRFCorrector":
        """Instantiate from the frf_correction section of FEM_modal.yaml.

        Expected structure:
            frf_correction:
              enabled: true
              zeta: 0.01
              modal_mass: 1.0
        """
        frf_cfg = cfg.get("frf_correction", {})
        return cls(
            zeta=float(frf_cfg.get("zeta", 0.01)),
            modal_mass=float(frf_cfg.get("modal_mass", 1.0)),
        )
