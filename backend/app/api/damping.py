"""Half-Power Bandwidth damping ratio estimation.

Computes the damping ratio ζ for each spectral peak using the
Half-Power Bandwidth (−3 dB) method on a **linear amplitude** spectrum.

Cut level:  A_max / √2   →   rel_height = 1 − 1/√2  ≈ 0.2929

Formula:    ζ = (f₂ − f₁) / (2 · fₙ)

References
----------
    Ewins, D.J. "Modal Testing: Theory, Practice and Application", 2nd ed.
    Brincker, R. & Ventura, C. "Introduction to Operational Modal Analysis".
"""

from __future__ import annotations

import numpy as np
from scipy.signal import peak_widths
from typing import List, Dict


def calcular_amortiguamiento(
    freqs: np.ndarray,
    amplitudes: np.ndarray,
    peak_indices: np.ndarray,
) -> List[Dict[str, float]]:
    """Estimate the damping ratio ζ for each detected peak via Half-Power Bandwidth.

    Parameters
    ----------
    freqs : np.ndarray
        1-D array of frequency values (Hz) — output of ``np.fft.rfftfreq``.
    amplitudes : np.ndarray
        1-D array of **linear** amplitude values (|FFT|) — same length as *freqs*.
    peak_indices : np.ndarray
        Integer indices into *freqs* / *amplitudes* identifying each detected peak
        (e.g. output of ``scipy.signal.find_peaks``).

    Returns
    -------
    List[Dict[str, float]]
        One dict per peak with keys:
            - ``fn_hz``   : natural frequency of the peak (Hz)
            - ``f1_hz``   : lower half-power frequency (Hz)
            - ``f2_hz``   : upper half-power frequency (Hz)
            - ``zeta``    : damping ratio  ζ = (f₂ − f₁) / (2·fₙ)
            - ``bw_hz``   : bandwidth f₂ − f₁ (Hz)
            - ``peak_idx``: original index in the spectrum array

    Notes
    -----
    ``scipy.signal.peak_widths`` measures width at the level::

        evaluation_height = peak_height - rel_height * (peak_height - base)

    With ``rel_height = 1 - 1/√2 ≈ 0.2929`` and base ≈ 0 the evaluation
    height becomes ``A_peak · (1/√2)`` — exactly the −3 dB half-power point
    for a linear amplitude spectrum.
    """
    if len(peak_indices) == 0:
        return []

    peak_indices = np.asarray(peak_indices, dtype=int)

    # rel_height for the linear-amplitude half-power point
    REL_HEIGHT = 1.0 - 1.0 / np.sqrt(2.0)  # ≈ 0.29289

    # Frequency spacing (uniform grid assumed)
    if len(freqs) > 1:
        df = float(freqs[1] - freqs[0])
    else:
        return []

    # peak_widths returns: widths (in samples), height at which width was measured,
    # left_ips and right_ips (interpolated positions in fractional sample indices)
    try:
        widths, width_heights, left_ips, right_ips = peak_widths(
            amplitudes, peak_indices, rel_height=REL_HEIGHT
        )
    except Exception:
        # Fallback: return empty if peak_widths fails (e.g. peaks at spectrum edges)
        return [
            {
                "fn_hz": float(freqs[idx]),
                "f1_hz": None,
                "f2_hz": None,
                "zeta": None,
                "bw_hz": None,
                "peak_idx": int(idx),
            }
            for idx in peak_indices
        ]

    results: List[Dict[str, float]] = []

    for i, idx in enumerate(peak_indices):
        fn = float(freqs[idx])

        # Convert fractional sample indices → Hz
        f1 = float(freqs[0]) + float(left_ips[i]) * df
        f2 = float(freqs[0]) + float(right_ips[i]) * df

        bw = f2 - f1
        zeta = bw / (2.0 * fn) if fn > 0 else None

        results.append({
            "fn_hz": fn,
            "f1_hz": round(f1, 6),
            "f2_hz": round(f2, 6),
            "zeta": round(zeta, 6) if zeta is not None else None,
            "bw_hz": round(bw, 6),
            "peak_idx": int(idx),
        })

    return results
