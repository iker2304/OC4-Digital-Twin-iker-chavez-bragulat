/**
 * OC4 Structural Physics Engine
 * 
 * This module implements simplified physics models for offshore structural analysis
 * in the context of a Digital Twin. It provides estimations for:
 * 1. Mooring Line Tension (Catenary/Spring-Damper approximation)
 * 2. Tower Stress Analysis (Cantilever Beam FEA approximation)
 * 3. Structural Health Monitoring (SHM) Simulation (Fatigue, OMA, Damage Detection)
 * 
 * NOTE: These are simplified engineering models for visualization and monitoring purposes.
 * Real-time high-fidelity FEA requires dedicated solver backends.
 */

// --- Constants & Properties (Based on OC4-DeepCwind Semi-submersible) ---

// Environmental Constants
const GRAVITY = 9.81; // m/s^2
// const WATER_DENSITY = 1025; // kg/m^3 (Unused)

// Tower Properties (NREL 5MW - Scaled Model 1:100)
// Based on Froude Scaling (lambda = 100)
// Real Height ~90m -> Model 0.9m
// Real Base Dia ~6m -> Model 0.06m
const TOWER_HEIGHT = 0.9; // m
const TOWER_BASE_DIAMETER = 0.06; // m
const TOWER_WALL_THICKNESS = 0.002; // m (Practical thickness for model stability, theoretically 0.00027m)
// const TOWER_TOP_DIAMETER = 0.0387; // m (Unused)

// Mooring Properties
const NUM_LINES = 3;
// Scaled Pretension (Froude Scale lambda=100, F_m = F_p / lambda^3)
// Full Scale ~1.2 MN -> Model ~1.2e6 / 1,000,000 = 1.2 N
const LINE_PRETENSION = 1.2; // N (Model Scale)
// const ANCHOR_RADIUS = 837.6; // m (Unused)
// const FAIRLEAD_RADIUS = 40.87; // m (Unused)
// const WATER_DEPTH = 200; // m (Unused)

// --- Interfaces ---

export interface EnvironmentalConditions {
    windSpeed: number; // m/s
    waveHeight: number; // m
    currentSpeed: number; // m/s
}

export interface PlatformState {
    surge: number; // x (m)
    sway: number; // y (m)
    heave: number; // z (m)
    roll: number; // rx (rad)
    pitch: number; // ry (rad)
    yaw: number; // rz (rad)
}

export interface StructuralAnalysisResult {
    mooring: {
        lines: { id: number; tension: number; safetyFactor: number }[];
        totalHorizontalForce: number;
        totalVerticalForce: number;
    };
    tower: {
        baseMoment: number; // Nm
        baseShear: number; // N
        maxStress: number; // MPa
        utilization: number; // % of Yield Strength
    };
    shm: {
        fatigueLifeUsed: number; // %
        damageIndex: number; // 0-1 (OMA Curvature Index)
        rulYears: number; // Remaining Useful Life
        alerts: string[];
        accumulatedCycles: number;
    };
}

// --- Physics Engine Class ---

export class StructuralEngine {
    private accumulatedDamage: number = 0;
    private cycleCount: number = 0;
    // private lastStress: number = 0; // Unused
    
    // Paris Law Parameters for Crack Propagation
    private crackLength: number = 0.001; // Current crack length (m), initial flaw 1mm
    private readonly crackCritical: number = 0.050; // Critical crack length 50mm
    private readonly C_paris: number = 1.5e-11; // Paris constant for steel in seawater
    private readonly m_paris: number = 3.1; // Paris exponent

    constructor() {
        // Initialize with some base damage if needed (e.g. from persistent storage)
        this.accumulatedDamage = 0.001; // 0.1% initial damage
        this.cycleCount = 10000; // Assume 10k cycles already occurred to normalize RUL
    }

    /**
     * Calculates Mooring Line Tensions using a quasi-static stiffness model
     * Validated against concepts from API RP 2SK
     */
    public calculateMooringForces(state: PlatformState, env: EnvironmentalConditions): StructuralAnalysisResult['mooring'] {
        const lines = [];
        let totalFx = 0;
        let totalFy = 0;
        let totalFz = 0;

        // Simplified stiffness matrix approach for catenary lines
        // K_horizontal approx 50-100 kN/m per line for small displacements
        const K_h = 75000; // N/m
        const K_v = 15000; // N/m (Vertical stiffness is lower in catenary regime until taut)

        for (let i = 0; i < NUM_LINES; i++) {
            // Angle of line i (120 degrees separation: 0, 120, 240)
            // const angle = (i * 120) * (Math.PI / 180); // Unused
            
            // Project platform displacement onto line direction
            // Surge (x) aligns with line 1 (0 deg)? No, typically Line 1 is upstream or specific orientation.
            // Let's assume Line 1 is at 180 deg (surging forward pulls it taut). 
            // Standard OC4: Line 1 at 180, Line 2 at 60, Line 3 at 300.
            // Simplified: Just use radial displacement from fairlead.
            
            const lineAngle = (180 + i * 120) * (Math.PI / 180); // 180, 300, 60
            
            // Displacement projected onto line axis
            const radialDisp = state.surge * Math.cos(lineAngle) + state.sway * Math.sin(lineAngle);
            
            // Dynamic tension component due to wave/current (simplified)
            // T_dyn = C_d * v^2 + Stiffness * displacement
            const waveLoad = 50000 * env.waveHeight * Math.cos(lineAngle); // Random directional factor
            
            // Calculate Tension
            // T = PreTension + K * delta_L + DynamicLoads
            let tension = LINE_PRETENSION + (K_h * radialDisp) + (K_v * Math.abs(state.heave));
            
            // Add non-linear effect for large offsets (hardening spring)
            if (radialDisp > 5) tension *= 1.1; 
            if (radialDisp > 10) tension *= 1.25;

            // Add wave dynamics
            tension += Math.abs(waveLoad);

            // Safety Factor (API RP 2SK requires > 1.67 for operating)
            // Breaking strength approx 10,000 kN for studless chain
            const MBL = 10000000; // 10 MN
            const safetyFactor = MBL / tension;

            lines.push({
                id: i + 1,
                tension: tension / 1000, // Convert to kN
                safetyFactor
            });

            totalFx += tension * Math.cos(lineAngle);
            totalFy += tension * Math.sin(lineAngle);
            totalFz += LINE_PRETENSION + (K_v * state.heave); // Simplified vertical
        }

        return {
            lines,
            totalHorizontalForce: Math.sqrt(totalFx**2 + totalFy**2),
            totalVerticalForce: totalFz
        };
    }

    /**
     * Calculates Tower Base Stresses using simplified FEA (Beam Theory)
     * Verifies against ISO 19901-3 limits
     */
    public calculateTowerStress(state: PlatformState, env: EnvironmentalConditions): StructuralAnalysisResult['tower'] {
        // Scale Factor
        const LAMBDA = 100;

        // 1. Aerodynamic Thrust (simplified actuator disk theory)
        // F_thrust = 0.5 * rho * A * Ct * V^2
        const rho_air = 1.225;
        // Rotor diameter specified by user: 1.26 m (Real 126m)
        const rotor_diam = 1.26; // m
        const area = Math.PI * (rotor_diam / 2) ** 2;
        const Ct = 0.7; // Thrust coefficient (operating)
        
        // Convert Real Wind Speed to Model Wind Speed for Force Calculation
        // V_m = V_p / sqrt(lambda) = V_p / 10
        const windSpeedModel = env.windSpeed / Math.sqrt(LAMBDA);
        const thrust = 0.5 * rho_air * area * Ct * (windSpeedModel ** 2);

        // 2. Gravitational Moment due to Pitch (P-Delta effect)
        // RNA Mass approx 350,000 kg -> Scaled Mass ~ M_p / lambda^3
        // lambda = 100 -> 350000 / 1,000,000 = 0.35 kg
        const rna_mass = 0.35; // kg
        const tower_mass = 0.35; // kg
        const rna_weight = rna_mass * GRAVITY;
        const tower_weight = tower_mass * GRAVITY;
        
        // Moment arm due to pitch angle
        const moment_gravity = (rna_weight * TOWER_HEIGHT + tower_weight * (TOWER_HEIGHT/2)) * Math.sin(Math.abs(state.pitch));

        // 3. Inertial Moment due to acceleration (simplified: proportional to pitch magnitude for now, assuming harmonic motion)
        const moment_inertia = 0.2 * moment_gravity; // Mock dynamic factor

        // Total Bending Moment at Base
        const totalMoment = (thrust * TOWER_HEIGHT) + moment_gravity + moment_inertia;

        // Calculate Stress (Sigma = M*y/I)
        // Annulus Moment of Inertia I = (pi/64) * (D_out^4 - D_in^4)
        const D_out = TOWER_BASE_DIAMETER;
        const D_in = D_out - (2 * TOWER_WALL_THICKNESS);
        const I = (Math.PI / 64) * (Math.pow(D_out, 4) - Math.pow(D_in, 4));
        const y = D_out / 2;

        const bendingStress = (totalMoment * y) / I; // Pascals
        
        // Axial Stress (F/A)
        const Area = (Math.PI / 4) * (Math.pow(D_out, 2) - Math.pow(D_in, 2));
        const axialForce = rna_weight + tower_weight; // Simplified
        const axialStress = axialForce / Area;

        // Combined Stress (Von Mises approx for beam)
        const totalStress = Math.abs(bendingStress) + Math.abs(axialStress);
        const stressMPa_Model = totalStress / 1e6;
        
        // Convert to Real Equivalent Stress for Visualization/Utilization
        // Sigma_p = Sigma_m * lambda
        const stressMPa_Real = stressMPa_Model * LAMBDA;

        // Yield Strength of Steel (S355 -> 355 MPa)
        const yieldStrength = 355; 
        const utilization = (stressMPa_Real / yieldStrength) * 100;

        return {
            baseMoment: totalMoment,
            baseShear: thrust,
            maxStress: stressMPa_Real, // Return Real Scale Stress
            utilization
        };
    }

    /**
     * Simulates SHM Data Processing (Fatigue, OMA, Damage Detection)
     */
    public calculateSHM(state: PlatformState, stressResult: StructuralAnalysisResult['tower']): StructuralAnalysisResult['shm'] {
        const alerts: string[] = [];

        // 1. Fatigue Accumulation (Mock Rainflow Counting)
        // We accumulate damage proportional to stress^m (Basquin's law, m=3 for steel)
        // Note: stressResult.maxStress is now REAL SCALE Equivalent Stress (MPa)
        // FIX: Use a dynamic fraction (e.g. 20%) of max stress as the cyclic range, 
        // because maxStress includes static loads (gravity/thrust) which don't cause fatigue directly.
        const stressRange = stressResult.maxStress * 0.2; 
        const m = 3;
        const damageIncrement = Math.pow(stressRange / 1000, m) * 0.00001; // Mock factor
        
        this.accumulatedDamage += damageIncrement;
        this.cycleCount++;

        // 2. OMA / Damage Detection (Mock Modal Curvature Index)
        // Simulate a "damaged" state if stress exceeds threshold repeatedly
        // Use accumulated damage as baseline index instead of hardcoded 0.02
        let damageIndex = this.accumulatedDamage; 
        if (stressResult.utilization > 80) {
            damageIndex = Math.max(damageIndex, 0.45); // High likelihood of damage
            alerts.push("CRITICAL: Modal Curvature Deviation detected > 0.4");
        }
        
        // Use state to detect extreme tilt (simplified sensor fusion)
        const maxTilt = Math.max(Math.abs(state.pitch), Math.abs(state.roll));
        if (maxTilt > 0.15) { // ~8.5 degrees
            alerts.push("WARNING: Extreme Tilt Detected > 8.5°");
        }

        if (this.accumulatedDamage > 0.8) {
            alerts.push("WARNING: Fatigue life usage > 80%");
        }

        if (stressResult.utilization > 90) {
            alerts.push("DANGER: Tower Base Stress exceeds 90% Yield");
        }

        // 3. RUL Prediction (Paris Law Crack Propagation)
        // da/dN = C * (dK)^m
        // dK = Y * dSigma * sqrt(pi * a)
        const Y = 1.12; // Geometry factor
        // FIX: Use cyclic stress range (20% of max) instead of total max stress
        const dSigma = stressResult.maxStress * 0.2; // MPa
        const dK = Y * dSigma * Math.sqrt(Math.PI * this.crackLength);
        
        // Calculate crack growth for this cycle
        const da = this.C_paris * Math.pow(dK, this.m_paris);
        this.crackLength += da; // Update state

        // Estimate remaining cycles: N = integral da / (C * dK^m)
        // Simplified instantaneous projection:
        const cyclesRemaining = (this.crackCritical - this.crackLength) / Math.max(1e-20, da);
        
        // Convert to years (assuming average wave period ~5s -> ~6.3M cycles/year)
        const cyclesPerYear = 365 * 24 * 3600 / 5;
        const yearsRemaining = cyclesRemaining / cyclesPerYear;

        return {
            fatigueLifeUsed: (this.crackLength / this.crackCritical) * 100, // Use crack length % as fatigue metric
            damageIndex,
            rulYears: Math.min(50, Math.max(0, yearsRemaining)), // Cap at 50 years
            alerts,
            accumulatedCycles: this.cycleCount
        };
    }
}
