import numpy as np
from datetime import datetime
import math
from typing import Dict, List, Any

class KalmanFilter:
    def __init__(self, process_variance, measurement_variance, estimated_measurement_variance):
        self.process_variance = process_variance
        self.measurement_variance = measurement_variance
        self.estimated_measurement_variance = estimated_measurement_variance
        self.posteri_estimate = 0.0
        self.posteri_error_estimate = 1.0

    def update(self, measurement):
        # Time Update
        priori_estimate = self.posteri_estimate
        priori_error_estimate = self.posteri_error_estimate + self.process_variance

        # Measurement Update
        blending_factor = priori_error_estimate / (priori_error_estimate + self.estimated_measurement_variance)
        self.posteri_estimate = priori_estimate + blending_factor * (measurement - priori_estimate)
        self.posteri_error_estimate = (1 - blending_factor) * priori_error_estimate

        return self.posteri_estimate

class SHMAnalyzer:
    def __init__(self):
        # Material Properties (Steel S355)
        self.youngs_modulus = 210e9  # Pa
        self.yield_strength = 355e6  # Pa
        
        # S-N Curve Parameters (DNVGL-RP-C203)
        # log N = log a - m * log S
        self.m_slope = 3.0  # Slope of S-N curve
        self.log_a = 12.18  # Intercept for seawater with cathodic protection
        
        # Weibull Parameters for RUL
        self.weibull_shape = 2.5  # k (Shape factor, increasing failure rate)
        self.weibull_scale = 25.0 # lambda (Scale factor, characteristic life in years)
        
        # State
        # Initial damage set to 0.3 as requested
        self.initial_damage = 0.3 
        self.accumulated_damage = self.initial_damage 
        self.cycle_count = 1000 # Assume some cycles from transport
        self.start_time = datetime.now()
        self.stress_history = []
        self.last_update = datetime.now()
        
        # Kalman Filter for Stress Smoothing
        self.kalman_filter = KalmanFilter(process_variance=1e-5, measurement_variance=0.1, estimated_measurement_variance=0.1)

    def process_sensor_data(self, telemetry: Dict[str, Any]) -> Dict[str, Any]:
        """
        Process incoming telemetry data to update SHM state.
        telemetry: Dict containing 'navigation' (position/orientation) and 'metrics'
        """
        current_time = datetime.now()
        
        # 1. Extract Loads / Estimate Stress
        # Simplified stress estimation from motion (Tower Base Bending Moment)
        # Stress = (Moment * y) / I
        # Moment ~ Force * Height + Mass * Accel * Height
        
        pitch_rad = abs(telemetry.get('navigation', {}).get('pitch', 0))
        roll_rad = abs(telemetry.get('navigation', {}).get('roll', 0))
        tilt_angle = math.sqrt(pitch_rad**2 + roll_rad**2)
        
        # Mock stress calculation (MPa) based on tilt for 1:100 Scale Model
        # Scale Factor: lambda = 100
        # Stress scales as 1/lambda: sigma_m = sigma_p / 100
        # Target Real Stress: 20-200 MPa -> Model Stress: 0.2-2.0 MPa
        
        SCALE_FACTOR = 100.0

        # Convert degrees to radians if necessary
        # Assuming input pitch/roll might be in degrees if values are large > 1.0
        if abs(pitch_rad) > 1.0 or abs(roll_rad) > 1.0:
             # Likely degrees, convert to radians for calculation consistency
             pitch_rad = pitch_rad * (math.pi / 180.0)
             roll_rad = roll_rad * (math.pi / 180.0)
             
        tilt_angle_deg = math.sqrt(pitch_rad**2 + roll_rad**2) * (180.0 / math.pi)
        
        # New Formula for 1:100:
        # Base Stress (Dead load): 0.2 MPa (Model) -> 20 MPa (Real)
        # Tilt Stress: 0.1 MPa per degree -> 10 MPa/deg (Real)
        # Max expected tilt ~10 deg -> 1.2 MPa (Model) -> 120 MPa (Real)
        
        base_stress_model = 0.2 + (tilt_angle_deg * 0.1) # MPa (Model Scale)
        dynamic_stress_model = np.random.normal(0, 0.05) # Vibration noise +/- 5 MPa Real
        
        raw_stress_model = base_stress_model + dynamic_stress_model
        
        # Convert to Real Scale for RUL calculation and Display
        # The Digital Twin should reflect the Real Asset's physics
        raw_stress_real = raw_stress_model * SCALE_FACTOR
        
        # Validate and Filter Data
        if np.isnan(raw_stress_real) or np.isinf(raw_stress_real):
            raw_stress_real = 50.0 # Default fallback
            
        # Apply Kalman Filter (on Real Stress)
        current_stress_mpa = self.kalman_filter.update(raw_stress_real)
        
        self.stress_history.append(current_stress_mpa)
        if len(self.stress_history) > 1000:
            self.stress_history.pop(0)

        # 2. Update Fatigue Damage (Simplified Rainflow/Cycle Counting)
        # We assume every sample is a peak for this real-time approximation
        # In production, use proper Rainflow Counting on buffered windows
        if len(self.stress_history) >= 2:
            stress_range = abs(self.stress_history[-1] - self.stress_history[-2])
            if stress_range > 5: # Filter small noise
                self.cycle_count += 1
                damage_increment = self._calculate_miner_damage(stress_range)
                
                # Check for unrealistic sudden jumps (early warning)
                if damage_increment > 0.05: # > 5% life lost in one cycle is anomalous
                    damage_increment = 0.05
                    print(f"WARNING: Clipped anomalous damage increment: {damage_increment}")
                    
                self.accumulated_damage += damage_increment
                
                # Cap accumulated damage at 1.0 (100% life used)
                if self.accumulated_damage > 1.0:
                    self.accumulated_damage = 1.0

        # 3. Calculate Indicators
        damage_index = self._calculate_damage_index()
        rul_years = self._calculate_rul_probabilistic(current_stress_mpa)
        health_status = self._determine_health_status(damage_index)
        
        # 4. Anomaly Detection (Vibration Analysis)
        # Check for high frequency vibrations or excessive stress
        anomalies = self._detect_anomalies(current_stress_mpa)
        
        # Add early warning if fatigue life is critically high or jumped suddenly
        if self.accumulated_damage > 0.9:
            anomalies.append("CRITICAL: Fatigue Life Used > 90%")

        return {
            "timestamp": current_time.isoformat(),
            "sensor_id": "SHM-OC4-001",
            "metrics": {
                "current_stress_mpa": round(current_stress_mpa, 2),
                "damage_index": round(damage_index, 6),
                "fatigue_life_used_percent": round(damage_index * 100, 4),
                "remaining_life_years": round(rul_years, 2),
                "accumulated_cycles": self.cycle_count
            },
            "status": health_status,
            "anomalies": anomalies
        }

    def _calculate_miner_damage(self, stress_range_mpa: float) -> float:
        """
        Calculate fatigue damage for a single stress cycle using Palmgren-Miner rule
        and DNVGL S-N curves.
        """
        # Safety clipping to prevent math domain errors or extreme values
        if stress_range_mpa <= 0 or math.isnan(stress_range_mpa) or math.isinf(stress_range_mpa):
            return 0.0
            
        # N = 10^(log_a - m * log S)
        # Damage = 1 / N
        try:
            log_N = self.log_a - self.m_slope * math.log10(max(1.0, stress_range_mpa))
            N = 10 ** log_N
            
            # Avoid division by zero and cap minimum cycles to prevent infinite damage jumps
            if N < 1.0: 
                N = 1.0
                
            damage = 1.0 / N
            
            # Additional safety limit (no single cycle should cause > 0.01 damage)
            return min(damage, 0.01)
        except Exception as e:
            print(f"Fatigue Calculation Error: {e}")
            return 0.0

    def _calculate_damage_index(self) -> float:
        """
        Returns accumulated damage index (0.0 to 1.0)
        """
        val = min(1.0, self.accumulated_damage)
        if math.isnan(val) or math.isinf(val):
            return 0.0
        return val

    def set_damage_index(self, damage_index: float):
        """Manually override the damage index and reset the reference point."""
        val = max(0.0, min(1.0, damage_index))
        self.initial_damage = val
        self.accumulated_damage = val
        self.start_time = datetime.now()
        self.cycle_count = max(1000, self.cycle_count) # Keep cycles but allow new starting point

    def _calculate_rul_probabilistic(self, current_stress_mean: float) -> float:
        """
        Calculate Remaining Useful Life (RUL) using Weibull distribution and Monte Carlo projection.
        """
        try:
            remaining_damage_capacity = 1.0 - self.accumulated_damage
            
            if remaining_damage_capacity <= 0:
                return 0.0

            # 1. Deterministic RUL based on current damage rate
            elapsed_time_hours = (datetime.now() - self.start_time).total_seconds() / 3600
            
            # Use only INCREMENTAL damage for rate calculation
            damage_increment = max(0.0, self.accumulated_damage - self.initial_damage)
            
            # If no new damage, assume a standard default rate (e.g. 25 years base life)
            if damage_increment <= 1e-12 or elapsed_time_hours <= 1e-4:
                return 25.0 * remaining_damage_capacity
                
            damage_rate_per_hour = damage_increment / elapsed_time_hours
            
            if damage_rate_per_hour <= 0:
                return 25.0 * remaining_damage_capacity
                
            base_rul_hours = remaining_damage_capacity / damage_rate_per_hour
            base_rul = base_rul_hours / (24 * 365)
            
            if math.isinf(base_rul) or math.isnan(base_rul):
                return 25.0

            # 2. Monte Carlo Simulation for Load Uncertainty
            # Simulate 1000 scenarios of future stress factors
            num_simulations = 1000
            # Load factor variation (Weibull distributed load multipliers)
            load_factors = np.random.weibull(self.weibull_shape, num_simulations)
            
            # Adjust RUL based on load factors (higher load -> lower RUL)
            # Simplified relationship: Life ~ 1 / (Load^m)
            # Add small epsilon to avoid division by zero
            adjusted_ruls = base_rul / (np.power(load_factors, self.m_slope) + 1e-6)
            
            # Take the 10th percentile (conservative estimate, 90% confidence)
            conservative_rul = np.percentile(adjusted_ruls, 10)
            
            # Cap at realistic design limit
            final_rul = min(25.0, max(0.0, conservative_rul))
            
            if math.isnan(final_rul) or math.isinf(final_rul):
                return 25.0
                
            return float(final_rul)
            
        except Exception as e:
            print(f"RUL Calculation Error: {e}")
            return 25.0

    def _determine_health_status(self, damage_index: float) -> str:
        display_index = round(damage_index, 4)
        
        if display_index <= 0.3:
            return "HEALTHY"
        elif display_index <= 0.7:
            return "WARNING"
        elif display_index <= 0.9:
            return "CRITICAL"
        else:
            return "FAILURE_IMMINENT"

    def _detect_anomalies(self, current_stress: float) -> List[str]:
        anomalies = []
        
        # Threshold Check
        if current_stress > (self.yield_strength / 1e6) * 0.8: # > 80% Yield
            anomalies.append("Stress Exceedance: >80% Yield Strength")
            
        # Vibration Analysis (Simplified FFT check on recent history)
        if len(self.stress_history) > 50:
            recent = np.array(self.stress_history[-50:])
            std_dev = np.std(recent)
            if std_dev > 20: # High variance indicating instability/flutter
                anomalies.append("High Amplitude Vibration Detected")
                
        return anomalies
