#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FEM Modal Response Simulation Data Generator
Generates displacement fields for wind and wave loads using modal superposition
"""

import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

import json
import numpy as np
from pathlib import Path
from typing import Dict, List, Tuple
import warnings
warnings.filterwarnings('ignore')

# ============================================================================
# CONFIGURATION
# ============================================================================

# Input files — resolved relative to the repo root
_REPO_ROOT = Path(__file__).resolve().parents[3]
MODAL_SHAPES_FILE = _REPO_ROOT / "web" / "public" / "OC4-modal" / "OC4-modal_res.json"
MODAL_PROPERTIES_FILE = Path(__file__).parent / "modal_properties.txt"

# Output directory
OUTPUT_DIR = Path(__file__).parent / "simulation_results"
OUTPUT_DIR.mkdir(exist_ok=True)

# Structure parameters
STRUCTURE_MASS_KG = 7.0
DAMPING_RATIO = 0.02  # 2% - for structure in air (no water)

# Modes to use (the most energetic ones)
MODES_TO_USE = [13, 14, 15, 20]

# Frequency analysis range
FREQ_MIN = 0.01
FREQ_MAX = 3.0
FREQ_RESOLUTION = 0.01
FREQUENCIES = np.arange(FREQ_MIN, FREQ_MAX + FREQ_RESOLUTION, FREQ_RESOLUTION)

# Load cases to simulate
LOAD_CASES = {
    "wave": [
        {"id": "olas_hs05_tp8", "name": "Wave Hs=0.5m Tp=8s", "Hs": 0.5, "Tp": 8.0},
        {"id": "olas_hs10_tp10", "name": "Wave Hs=1.0m Tp=10s", "Hs": 1.0, "Tp": 10.0},
        {"id": "olas_hs20_tp12", "name": "Wave Hs=2.0m Tp=12s", "Hs": 2.0, "Tp": 12.0},
    ],
    "wind": [
        {"id": "viento_3ms", "name": "Wind U=3m/s", "U": 3.0},
        {"id": "viento_5ms", "name": "Wind U=5m/s", "U": 5.0},
        {"id": "viento_8ms", "name": "Wind U=8m/s", "U": 8.0},
    ]
}

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

def load_modal_shapes(filepath: str) -> Dict[int, Dict[int, List[float]]]:
    """
    Load modal shape data from RAMSeries JSON export
    Returns: {mode_number: {node_id: [ux, uy, uz]}}
    """
    print(f"Loading modal shapes from {filepath}...")
    with open(filepath, 'r') as f:
        data = json.load(f)
    
    modal_shapes = {}
    modes_in_file = data.get('modes', {})
    
    for mode_key, mode_data in modes_in_file.items():
        # Parse mode number from key (e.g., "Mode_13_(Freq.:_0.51)" -> 13)
        try:
            mode_num = int(mode_key.split('_')[1])
            shapes = mode_data.get('Modes', {})
            
            modal_shapes[mode_num] = {}
            for node_str, coords in shapes.items():
                node_id = int(node_str)
                modal_shapes[mode_num][node_id] = coords
        except (ValueError, IndexError, KeyError):
            continue
    
    print(f"  ✓ Loaded {len(modal_shapes)} modes")
    return modal_shapes


def load_modal_properties(filepath: str) -> Tuple[Dict, Dict]:
    """
    Load modal properties (frequencies and masses)
    """
    print(f"Loading modal properties from {filepath}...")
    frequencies = {}
    masses = {}
    
    # Parse the table format provided by user
    with open(filepath, 'r') as f:
        lines = f.readlines()
    
    for line in lines[1:]:  # Skip header
        parts = line.split()
        if len(parts) < 8:
            continue
        try:
            mode_num = int(parts[0])
            freq_hz = float(parts[1])
            mass_x = float(parts[2])
            mass_y = float(parts[4])
            mass_z = float(parts[6])
            
            frequencies[mode_num] = freq_hz
            masses[mode_num] = {
                'mass_x': mass_x,
                'mass_y': mass_y,
                'mass_z': mass_z
            }
        except (ValueError, IndexError):
            continue
    
    print(f"  ✓ Loaded properties for {len(frequencies)} modes")
    return frequencies, masses


def calculate_mrao(freq_excitation: float, freq_natural: float, 
                   mass_modal: float, damping: float) -> float:
    """
    Calculate Modal Response Amplitude Operator (MRAO)
    
    MRAO_m(f) = 1 / (M_m × √[(ωn² - ωe²)² + (2ζωnωe)²])
    
    Args:
        freq_excitation: Excitation frequency [Hz]
        freq_natural: Natural frequency of mode [Hz]
        mass_modal: Generalized mass of mode [kg]
        damping: Damping ratio [0-1]
    
    Returns:
        MRAO value (amplification factor)
    """
    omega_n = 2 * np.pi * freq_natural
    omega_e = 2 * np.pi * freq_excitation
    
    numerator = 1.0
    term1 = (omega_n**2 - omega_e**2)**2
    term2 = (2 * damping * omega_n * omega_e)**2
    denominator = mass_modal * np.sqrt(term1 + term2)
    
    if denominator == 0:
        return np.inf
    
    return numerator / denominator


def jonswap_spectrum(frequencies: np.ndarray, Hs: float, Tp: float) -> np.ndarray:
    """
    Generate JONSWAP spectrum (for wave excitation)
    
    Args:
        frequencies: Array of frequencies [Hz]
        Hs: Significant wave height [m]
        Tp: Peak period [s]
    
    Returns:
        S(f): Spectral density [m²/Hz]
    """
    fp = 1.0 / Tp  # Peak frequency
    gamma = 3.3    # Peakedness factor
    sigma_a = 0.07  # Spectral width (left side)
    sigma_b = 0.09  # Spectral width (right side)
    
    sigma = np.where(frequencies <= fp, sigma_a, sigma_b)
    
    # Peakedness enhancement
    r = np.exp(-(frequencies - fp)**2 / (2 * sigma**2 * fp**2))
    
    # JONSWAP formula
    alpha = 0.0081
    g = 9.81
    
    S = (alpha * g**2 / (2*np.pi)**4) * np.power(frequencies, -5) * \
        np.exp(-1.25 * np.power(fp / frequencies, 4)) * np.power(gamma, r)
    
    # Normalize to Hs
    m0 = np.trapezoid(S, frequencies)
    if m0 > 0:
        S = S * (Hs**2 / (4 * np.sqrt(m0)))
    
    return S


def kaimal_wind_spectrum(frequencies: np.ndarray, U: float, z: float = 10.0) -> np.ndarray:
    """
    Generate Kaimal wind spectrum (for wind excitation)
    
    Args:
        frequencies: Array of frequencies [Hz]
        U: Mean wind speed [m/s]
        z: Height [m]
    
    Returns:
        S(f): Power spectral density
    """
    Lz = 0.3 * z  # Length scale
    fu = frequencies * Lz / U
    sigma_u = 0.2 * U  # Turbulence standard deviation
    
    # Kaimal spectrum
    S = (4 * sigma_u**2 * Lz / U) / np.power(1 + 10.6 * fu, 5/3)
    
    return S


def spectrum_to_amplitudes(S: np.ndarray, frequencies: np.ndarray) -> np.ndarray:
    """
    Convert spectral density to wave/wind amplitudes
    
    H(f) = 2 × √(S(f) × Δf)
    """
    if len(frequencies) < 2:
        delta_f = 0.01
    else:
        delta_f = frequencies[1] - frequencies[0]
    
    amplitudes = 2.0 * np.sqrt(np.maximum(S, 0) * delta_f)
    return amplitudes


def calculate_modal_amplitudes(mrao_data: Dict[int, np.ndarray],
                               spectrum_amplitudes: np.ndarray,
                               frequencies: np.ndarray) -> Dict[int, float]:
    """
    Calculate RMS amplitude for each mode
    
    q_m_RMS = √(mean(q_m(f)²)) where q_m(f) = MRAO_m(f) × H(f)
    """
    modal_amps = {}
    
    for mode_id, mrao_values in mrao_data.items():
        # Apply MRAO to spectrum
        q_values = np.array(mrao_values) * spectrum_amplitudes
        
        # Calculate RMS
        q_rms = np.sqrt(np.mean(q_values**2))
        modal_amps[mode_id] = q_rms
    
    return modal_amps


def reconstruct_displacements(modal_amps: Dict[int, float],
                             modal_shapes: Dict[int, Dict[int, List[float]]],
                             n_nodes: int) -> np.ndarray:
    """
    Reconstruct displacement field by superposition of modes
    
    For each node i:
        u_i = Σ_m q_m × Φ_m(i)
    """
    displacements = np.zeros((n_nodes, 3))  # [ux, uy, uz] for each node
    
    for mode_id, q_rms in modal_amps.items():
        if mode_id not in modal_shapes:
            continue
        
        mode_shapes = modal_shapes[mode_id]
        
        for node_id, phi in mode_shapes.items():
            if node_id < n_nodes:
                displacements[node_id] += q_rms * np.array(phi[:3])
    
    return displacements


def calculate_magnitude_and_colors(displacements: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """
    Calculate displacement magnitude and normalized colors for colormap
    
    Returns:
        magnitude: |u| for each node
        normalized_colors: (|u| - min) / (max - min) ∈ [0, 1]
    """
    # Calculate magnitude
    magnitude = np.linalg.norm(displacements, axis=1)
    
    # Normalize for colormap
    mag_min = np.min(magnitude)
    mag_max = np.max(magnitude)
    
    if mag_max > mag_min:
        normalized_colors = (magnitude - mag_min) / (mag_max - mag_min)
    else:
        normalized_colors = np.zeros_like(magnitude)
    
    return magnitude, normalized_colors


def save_case_result(case_id: str, case_name: str, case_params: Dict,
                    modal_amps: Dict[int, float],
                    displacements: np.ndarray,
                    magnitude: np.ndarray,
                    normalized_colors: np.ndarray) -> None:
    """
    Save case results to JSON file
    """
    result = {
        "case_id": case_id,
        "case_name": case_name,
        "case_type": case_params.get("type", "unknown"),
        "parameters": {k: v for k, v in case_params.items() if k != "type"},
        "modal_responses": {
            f"mode_{m}": float(amp) for m, amp in modal_amps.items()
        },
        "displacements": {
            str(i): displacements[i].tolist() 
            for i in range(len(displacements))
        },
        "magnitude_m": magnitude.tolist(),
        "min_displacement_m": float(np.min(magnitude)),
        "max_displacement_m": float(np.max(magnitude)),
        "normalized_colors": normalized_colors.tolist()
    }
    
    output_file = OUTPUT_DIR / f"result_{case_id}.json"
    with open(output_file, 'w') as f:
        json.dump(result, f, indent=2)
    
    print(f"  ✓ Saved {case_id}: max_disp={float(np.max(magnitude)):.6f}m")


def save_mrao_data(mrao_dict: Dict[int, Dict]) -> None:
    """
    Save pre-calculated MRAO data for use in React
    """
    output_file = OUTPUT_DIR / "mrao_precalculated.json"
    with open(output_file, 'w') as f:
        json.dump(mrao_dict, f, indent=2)
    
    print(f"✓ Saved MRAO data: {output_file}")


def save_cases_index(cases_data: List[Dict]) -> None:
    """
    Save index of all available cases
    """
    index = {
        "structure": {
            "name": "OC4 1:100",
            "total_mass_kg": STRUCTURE_MASS_KG,
            "damping_ratio": DAMPING_RATIO,
            "n_modes_used": len(MODES_TO_USE),
            "modes_used": MODES_TO_USE
        },
        "analysis": {
            "frequency_range_hz": [FREQ_MIN, FREQ_MAX],
            "frequency_resolution_hz": FREQ_RESOLUTION,
            "amplitude_scale_visual": 100,
            "colormap": "jet"
        },
        "cases": cases_data
    }
    
    output_file = OUTPUT_DIR / "cases_index.json"
    with open(output_file, 'w') as f:
        json.dump(index, f, indent=2)
    
    print(f"✓ Saved cases index: {output_file}")


# ============================================================================
# MAIN EXECUTION
# ============================================================================

def main():
    print("\n" + "="*70)
    print("FEM MODAL RESPONSE SIMULATION DATA GENERATOR")
    print("="*70 + "\n")
    
    # ========================================================================
    # STEP 1: Load modal data
    # ========================================================================
    print("STEP 1: Loading modal data...")
    modal_shapes = load_modal_shapes(MODAL_SHAPES_FILE)
    frequencies_natural, masses = load_modal_properties(MODAL_PROPERTIES_FILE)
    
    # Get number of nodes
    n_nodes = len(modal_shapes[MODES_TO_USE[0]])
    print(f"  ✓ Structure has {n_nodes} nodes\n")
    
    # ========================================================================
    # STEP 2: Pre-calculate MRAOs
    # ========================================================================
    print("STEP 2: Pre-calculating MRAOs (function of transfer)...")
    mrao_dict = {}
    
    for mode_id in MODES_TO_USE:
        f_nat = frequencies_natural[mode_id]
        # Use mass_x as default (can be changed based on excitation direction)
        mass = masses[mode_id]['mass_x']
        
        mrao_values = [
            calculate_mrao(f_exc, f_nat, mass, DAMPING_RATIO)
            for f_exc in FREQUENCIES
        ]
        
        mrao_dict[mode_id] = {
            "frequency_hz": float(f_nat),
            "mass_kg": float(mass),
            "mrao_values": mrao_values,
            "frequencies_hz": FREQUENCIES.tolist()
        }
        
        print(f"  ✓ Mode {mode_id}: f={f_nat:.3f}Hz, m={mass:.4f}kg")
    
    save_mrao_data(mrao_dict)
    print()
    
    # ========================================================================
    # STEP 3: Process each load case
    # ========================================================================
    print("STEP 3: Generating load cases...\n")
    cases_list = []
    
    # Process wave cases
    print("  Wave cases:")
    for case in LOAD_CASES["wave"]:
        print(f"    {case['name']}...", end=" ")
        
        # Generate spectrum
        S = jonswap_spectrum(FREQUENCIES, case['Hs'], case['Tp'])
        H = spectrum_to_amplitudes(S, FREQUENCIES)
        
        # Calculate modal amplitudes
        mrao_wave = {
            m: np.array(mrao_dict[m]["mrao_values"]) 
            for m in MODES_TO_USE
        }
        q_amps = calculate_modal_amplitudes(mrao_wave, H, FREQUENCIES)
        
        # Reconstruct displacements
        displacements = reconstruct_displacements(q_amps, modal_shapes, n_nodes)
        magnitude, colors = calculate_magnitude_and_colors(displacements)
        
        # Save
        case["type"] = "wave"
        save_case_result(case['id'], case['name'], case, q_amps, 
                        displacements, magnitude, colors)
        
        cases_list.append({
            "id": case['id'],
            "name": case['name'],
            "type": "wave",
            "parameters": {"Hs_m": case['Hs'], "Tp_s": case['Tp']},
            "file": f"result_{case['id']}.json"
        })
    
    print()
    
    # Process wind cases
    print("  Wind cases:")
    for case in LOAD_CASES["wind"]:
        print(f"    {case['name']}...", end=" ")
        
        # Generate spectrum
        S = kaimal_wind_spectrum(FREQUENCIES, case['U'])
        H = spectrum_to_amplitudes(S, FREQUENCIES)
        
        # Calculate modal amplitudes
        mrao_wind = {
            m: np.array(mrao_dict[m]["mrao_values"]) 
            for m in MODES_TO_USE
        }
        q_amps = calculate_modal_amplitudes(mrao_wind, H, FREQUENCIES)
        
        # Reconstruct displacements
        displacements = reconstruct_displacements(q_amps, modal_shapes, n_nodes)
        magnitude, colors = calculate_magnitude_and_colors(displacements)
        
        # Save
        case["type"] = "wind"
        save_case_result(case['id'], case['name'], case, q_amps, 
                        displacements, magnitude, colors)
        
        cases_list.append({
            "id": case['id'],
            "name": case['name'],
            "type": "wind",
            "parameters": {"U_ms": case['U']},
            "file": f"result_{case['id']}.json"
        })
    
    print()
    
    # ========================================================================
    # STEP 4: Save cases index
    # ========================================================================
    print("STEP 4: Creating cases index...")
    save_cases_index(cases_list)
    print()
    
    # ========================================================================
    # Summary
    # ========================================================================
    print("="*70)
    print("✓ SIMULATION DATA GENERATION COMPLETE")
    print("="*70)
    print(f"\nGenerated files in: {OUTPUT_DIR}/")
    print(f"  - mrao_precalculated.json (MRAO functions)")
    print(f"  - cases_index.json (index of all cases)")
    for case in cases_list:
        print(f"  - result_{case['id']}.json (displacement data)")
    print(f"\nTotal cases generated: {len(cases_list)}")
    print("\nReady for React visualization!\n")


if __name__ == "__main__":
    main()
