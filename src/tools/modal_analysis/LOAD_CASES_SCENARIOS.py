# ============================================================================
# CONFIGURATION EXAMPLES FOR DIFFERENT SCENARIOS
# ============================================================================
# Copy the desired scenario's LOAD_CASES into generate_simulation_data.py

# ============================================================================
# SCENARIO 1: BASIC (6 cases - 3 wave + 3 wind)
# ============================================================================
# Use this for quick testing

LOAD_CASES_SCENARIO_1 = {
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
# SCENARIO 2: EXTENDED (10 cases - 5 wave + 5 wind)
# ============================================================================
# Use for comprehensive analysis

LOAD_CASES_SCENARIO_2 = {
    "wave": [
        {"id": "olas_hs03_tp7", "name": "Wave Hs=0.3m Tp=7s (small)", "Hs": 0.3, "Tp": 7.0},
        {"id": "olas_hs05_tp8", "name": "Wave Hs=0.5m Tp=8s", "Hs": 0.5, "Tp": 8.0},
        {"id": "olas_hs10_tp10", "name": "Wave Hs=1.0m Tp=10s", "Hs": 1.0, "Tp": 10.0},
        {"id": "olas_hs15_tp11", "name": "Wave Hs=1.5m Tp=11s", "Hs": 1.5, "Tp": 11.0},
        {"id": "olas_hs20_tp12", "name": "Wave Hs=2.0m Tp=12s (large)", "Hs": 2.0, "Tp": 12.0},
    ],
    "wind": [
        {"id": "viento_2ms", "name": "Wind U=2m/s (calm)", "U": 2.0},
        {"id": "viento_3ms", "name": "Wind U=3m/s", "U": 3.0},
        {"id": "viento_5ms", "name": "Wind U=5m/s", "U": 5.0},
        {"id": "viento_8ms", "name": "Wind U=8m/s", "U": 8.0},
        {"id": "viento_10ms", "name": "Wind U=10m/s (strong)", "U": 10.0},
    ]
}

# ============================================================================
# SCENARIO 3: DETAILED WAVE ANALYSIS (8 cases - wave focus)
# ============================================================================
# Use for wave-specific studies

LOAD_CASES_SCENARIO_3 = {
    "wave": [
        {"id": "olas_hs02_tp6", "name": "Wave Hs=0.2m Tp=6s", "Hs": 0.2, "Tp": 6.0},
        {"id": "olas_hs03_tp7", "name": "Wave Hs=0.3m Tp=7s", "Hs": 0.3, "Tp": 7.0},
        {"id": "olas_hs05_tp8", "name": "Wave Hs=0.5m Tp=8s", "Hs": 0.5, "Tp": 8.0},
        {"id": "olas_hs07_tp9", "name": "Wave Hs=0.7m Tp=9s", "Hs": 0.7, "Tp": 9.0},
        {"id": "olas_hs10_tp10", "name": "Wave Hs=1.0m Tp=10s", "Hs": 1.0, "Tp": 10.0},
        {"id": "olas_hs15_tp11", "name": "Wave Hs=1.5m Tp=11s", "Hs": 1.5, "Tp": 11.0},
        {"id": "olas_hs20_tp12", "name": "Wave Hs=2.0m Tp=12s", "Hs": 2.0, "Tp": 12.0},
        {"id": "olas_hs25_tp13", "name": "Wave Hs=2.5m Tp=13s", "Hs": 2.5, "Tp": 13.0},
    ],
    "wind": [
        {"id": "viento_5ms", "name": "Wind U=5m/s (constant)", "U": 5.0},
    ]
}

# ============================================================================
# SCENARIO 4: DETAILED WIND ANALYSIS (8 cases - wind focus)
# ============================================================================
# Use for wind-specific studies

LOAD_CASES_SCENARIO_4 = {
    "wave": [
        {"id": "olas_hs10_tp10", "name": "Wave Hs=1.0m Tp=10s (constant)", "Hs": 1.0, "Tp": 10.0},
    ],
    "wind": [
        {"id": "viento_1ms", "name": "Wind U=1m/s (very calm)", "U": 1.0},
        {"id": "viento_2ms", "name": "Wind U=2m/s", "U": 2.0},
        {"id": "viento_3ms", "name": "Wind U=3m/s", "U": 3.0},
        {"id": "viento_5ms", "name": "Wind U=5m/s", "U": 5.0},
        {"id": "viento_8ms", "name": "Wind U=8m/s", "U": 8.0},
        {"id": "viento_10ms", "name": "Wind U=10m/s", "U": 10.0},
        {"id": "viento_12ms", "name": "Wind U=12m/s", "U": 12.0},
        {"id": "viento_15ms", "name": "Wind U=15m/s (strong)", "U": 15.0},
    ]
}

# ============================================================================
# SCENARIO 5: OPERATIONAL (12 cases - realistic combinations)
# ============================================================================
# Use for realistic operational scenarios

LOAD_CASES_SCENARIO_5 = {
    "wave": [
        {"id": "sea_state_1", "name": "Sea State 1: Hs=0.5m Tp=8s", "Hs": 0.5, "Tp": 8.0},
        {"id": "sea_state_2", "name": "Sea State 2: Hs=1.0m Tp=10s", "Hs": 1.0, "Tp": 10.0},
        {"id": "sea_state_3", "name": "Sea State 3: Hs=1.5m Tp=11s", "Hs": 1.5, "Tp": 11.0},
        {"id": "sea_state_4", "name": "Sea State 4: Hs=2.0m Tp=12s", "Hs": 2.0, "Tp": 12.0},
        {"id": "sea_state_5", "name": "Sea State 5: Hs=2.5m Tp=13s", "Hs": 2.5, "Tp": 13.0},
        {"id": "sea_state_6", "name": "Sea State 6: Hs=3.0m Tp=14s", "Hs": 3.0, "Tp": 14.0},
    ],
    "wind": [
        {"id": "wind_low", "name": "Wind: Low (3 m/s)", "U": 3.0},
        {"id": "wind_moderate", "name": "Wind: Moderate (7 m/s)", "U": 7.0},
        {"id": "wind_strong", "name": "Wind: Strong (12 m/s)", "U": 12.0},
        {"id": "wind_extreme", "name": "Wind: Extreme (18 m/s)", "U": 18.0},
        {"id": "wind_survival", "name": "Wind: Survival (25 m/s)", "U": 25.0},
        {"id": "wind_extreme_50yr", "name": "Wind: 50-year (35 m/s)", "U": 35.0},
    ]
}

# ============================================================================
# SCENARIO 6: RESONANCE STUDY (fine frequency sweep)
# ============================================================================
# Use to study modal resonance behavior

LOAD_CASES_SCENARIO_6 = {
    "wave": [
        # Fine sweep around mode 13 resonance (0.51 Hz)
        {"id": "olas_sweep_045", "name": "Wave sweep: Hs=1.0m Tp=22.2s (f≈0.45Hz)", "Hs": 1.0, "Tp": 22.2},
        {"id": "olas_sweep_048", "name": "Wave sweep: Hs=1.0m Tp=20.8s (f≈0.48Hz)", "Hs": 1.0, "Tp": 20.8},
        {"id": "olas_sweep_051", "name": "Wave sweep: Hs=1.0m Tp=19.6s (f≈0.51Hz) [RESONANCE]", "Hs": 1.0, "Tp": 19.6},
        {"id": "olas_sweep_054", "name": "Wave sweep: Hs=1.0m Tp=18.5s (f≈0.54Hz)", "Hs": 1.0, "Tp": 18.5},
        {"id": "olas_sweep_057", "name": "Wave sweep: Hs=1.0m Tp=17.5s (f≈0.57Hz)", "Hs": 1.0, "Tp": 17.5},
    ],
    "wind": [
        {"id": "viento_5ms", "name": "Wind constant: 5 m/s", "U": 5.0},
    ]
}

# ============================================================================
# SCENARIO 7: MINIMAL (3 cases - quick test)
# ============================================================================
# Use for quick testing/debugging

LOAD_CASES_SCENARIO_7 = {
    "wave": [
        {"id": "olas_hs10_tp10", "name": "Wave Hs=1.0m Tp=10s", "Hs": 1.0, "Tp": 10.0},
    ],
    "wind": [
        {"id": "viento_5ms", "name": "Wind U=5m/s", "U": 5.0},
        {"id": "viento_10ms", "name": "Wind U=10m/s", "U": 10.0},
    ]
}

# ============================================================================
# HOW TO USE
# ============================================================================
"""
1. Choose a scenario (1-7) above
2. Copy the entire LOAD_CASES dictionary
3. Open generate_simulation_data.py
4. Find the line: LOAD_CASES = { ... }
5. Replace it with your chosen scenario
6. Save and run: python generate_simulation_data.py

Example:
    In generate_simulation_data.py, change:
    
    LOAD_CASES = {
        "wave": [...],
        "wind": [...]
    }
    
    To:
    
    LOAD_CASES = LOAD_CASES_SCENARIO_2  # Extended 10 cases
"""

# ============================================================================
# CUSTOM SCENARIO TEMPLATE
# ============================================================================
"""
Create your own scenario:

LOAD_CASES_CUSTOM = {
    "wave": [
        {"id": "case_id_1", "name": "Display name", "Hs": 0.5, "Tp": 8.0},
        {"id": "case_id_2", "name": "Display name", "Hs": 1.0, "Tp": 10.0},
        # Add more wave cases...
    ],
    "wind": [
        {"id": "case_id_w1", "name": "Display name", "U": 3.0},
        {"id": "case_id_w2", "name": "Display name", "U": 5.0},
        # Add more wind cases...
    ]
}

Important:
- case_id: Must be unique, lowercase, no spaces (used for filenames)
- name: Display name shown in UI
- Hs: Significant wave height [m]
- Tp: Peak period [s]
- U: Wind speed [m/s]
"""

print(__doc__)
