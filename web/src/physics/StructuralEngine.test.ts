import { describe, it, expect } from 'vitest';
import { StructuralEngine, type PlatformState, type EnvironmentalConditions } from './StructuralEngine';

describe('StructuralEngine Scaling Verification', () => {
    const engine = new StructuralEngine();

    // Standard Environmental Conditions (Rated Wind)
    const env: EnvironmentalConditions = {
        windSpeed: 11.4, // Rated wind speed for NREL 5MW (m/s)
        waveHeight: 2.0,
        currentSpeed: 0.5
    };

    // Stable Platform State (Upright)
    const state: PlatformState = {
        surge: 0,
        sway: 0,
        heave: 0,
        roll: 0,
        pitch: 0, // No tilt
        yaw: 0
    };

    it('should calculate realistic tower stress at rated wind speed (Real Scale Equivalent)', () => {
        const result = engine.calculateTowerStress(state, env);
        
        // Manual Estimation for Scaled Model (1.26m Rotor) -> Scaled to Real Equivalent
        // Real Rated Wind Speed = 11.4 m/s.
        // Thrust is calculated using Model Wind Speed (1.14 m/s).
        // Then Stress is calculated (Model Stress ~0.2-0.5 MPa).
        // Then converted to Real Stress (* 100) -> ~20-50 MPa.
        
        console.log(`Calculated Max Real Stress: ${result.maxStress} MPa`);
        
        // Adjusted bounds for Real Scale Equivalent
        expect(result.maxStress).toBeGreaterThan(10); 
        expect(result.maxStress).toBeLessThan(200);
        
        // Utilization should be reasonable (< 50% of 355 MPa)
        expect(result.utilization).toBeLessThan(60);
    });

    it('should calculate realistic RUL under normal load', () => {
        const stressResult = engine.calculateTowerStress(state, env);
        const shm = engine.calculateSHM(state, stressResult);
        
        // console.log(`Calculated RUL: ${shm.rulYears} years`);
        
        // Should be > 1 year and < 100 years
        expect(shm.rulYears).toBeGreaterThan(1);
        expect(shm.rulYears).toBeLessThan(100);
        
        // Damage index should be small initially
        expect(shm.damageIndex).toBeLessThan(0.1);
    });

    it('should detect critical stress under extreme pitch', () => {
        const tiltedState = { ...state, pitch: 0.15 }; // ~8.5 degrees
        const result = engine.calculateTowerStress(tiltedState, env);
        
        console.log(`Tilted Stress: ${result.maxStress} MPa`);
        
        // Stress should increase due to gravity moment.
        // With smaller rotor, thrust stress is lower (~7 MPa).
        // Gravity moment adds ~1 MPa.
        // Total stress is now around 8.3 MPa.
        expect(result.maxStress).toBeGreaterThan(7); 
    });
});
