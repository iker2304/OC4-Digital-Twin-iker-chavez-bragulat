/**
 * Generalist Structural & Physics Engine for Digital Twins
 * 
 * Implements configurable physics models for structural analysis across multiple
 * Digital Twin types (Offshore Wind OC4, Onshore Wind, Civil Structures/Bridges,
 * Industrial Robotics, Aerospace/UAV, or Custom Assets).
 * Provides real-time estimations for:
 * 1. Restraint / Mooring / Support Tension (Catenary/Spring-Damper approximation)
 * 2. Structural Stress Analysis (Cantilever Beam / Member FEA approximation)
 * 3. Structural Health Monitoring (SHM) Simulation (Fatigue, OMA, Crack Propagation, RUL)
 */

const GRAVITY = 9.81; // m/s^2

export interface PhysicsConfig {
    scaleFactor: number;          // Froude scale lambda (e.g. 100 for 1:100 model, 1 for full scale)
    structureHeight: number;      // m (Model scale height, e.g. 0.9m)
    baseDiameter: number;         // m (Model scale diameter, e.g. 0.06m)
    wallThickness: number;        // m (Model scale thickness, e.g. 0.002m)
    topMass: number;              // kg (RNA or top payload mass at model scale, e.g. 0.35kg)
    structureMass: number;        // kg (Tower/main body mass at model scale, e.g. 0.35kg)
    rotorDiameter: number;        // m (Aerodynamic area diameter, e.g. 1.26m)
    thrustCoefficient: number;    // Aerodynamic drag/thrust coefficient Ct (e.g. 0.7)
    yieldStrength: number;        // MPa (Material yield strength, e.g. 355 for S355 steel)
    youngsModulus: number;        // GPa (e.g. 210 GPa)
    numMooringLines: number;      // Number of mooring/support lines (e.g. 3)
    linePretension: number;       // N (Pretension at model scale, e.g. 1.2 N)
    horizontalStiffness: number;  // N/m (Horizontal stiffness K_h, e.g. 75000)
    verticalStiffness: number;    // N/m (Vertical stiffness K_v, e.g. 15000)
    breakingStrength: number;     // N (Minimum Breaking Load MBL, e.g. 10,000,000 N)
    initialDamage: number;        // 0-1 (e.g. 0.001)
    criticalCrackLength: number;  // m (e.g. 0.050m)
    parisConstantC: number;       // Paris law C (e.g. 1.5e-11)
    parisExponentM: number;       // Paris law m (e.g. 3.1)
    designLifeYears: number;      // Years (e.g. 25)
}

export const DEFAULT_PHYSICS_CONFIG: PhysicsConfig = {
    scaleFactor: 100,
    structureHeight: 0.9,
    baseDiameter: 0.06,
    wallThickness: 0.002,
    topMass: 0.35,
    structureMass: 0.35,
    rotorDiameter: 1.26,
    thrustCoefficient: 0.7,
    yieldStrength: 355,
    youngsModulus: 210,
    numMooringLines: 3,
    linePretension: 1.2,
    horizontalStiffness: 75000,
    verticalStiffness: 15000,
    breakingStrength: 10000000,
    initialDamage: 0.001,
    criticalCrackLength: 0.050,
    parisConstantC: 1.5e-11,
    parisExponentM: 3.1,
    designLifeYears: 25,
};

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

export class StructuralEngine {
    private config: PhysicsConfig;
    private accumulatedDamage: number = 0;
    private cycleCount: number = 0;
    private crackLength: number = 0.001;

    constructor(customConfig?: Partial<PhysicsConfig>) {
        this.config = { ...DEFAULT_PHYSICS_CONFIG, ...(customConfig || {}) };
        this.accumulatedDamage = this.config.initialDamage;
        this.cycleCount = 10000;
        this.crackLength = Math.max(0.0005, this.config.criticalCrackLength * 0.02);
    }

    public setConfig(updates: Partial<PhysicsConfig>): void {
        this.config = { ...this.config, ...updates };
        if (updates.initialDamage !== undefined) {
            this.accumulatedDamage = updates.initialDamage;
        }
    }

    public getConfig(): PhysicsConfig {
        return { ...this.config };
    }

    public resetDamage(): void {
        this.accumulatedDamage = this.config.initialDamage;
        this.cycleCount = 100;
        this.crackLength = Math.max(0.0005, this.config.criticalCrackLength * 0.02);
    }

    /**
     * Calculates Support / Mooring Line Tensions using a configurable quasi-static stiffness model
     */
    public calculateMooringForces(state: PlatformState, env: EnvironmentalConditions): StructuralAnalysisResult['mooring'] {
        const lines = [];
        let totalFx = 0;
        let totalFy = 0;
        let totalFz = 0;

        const numLines = Math.max(1, Math.round(this.config.numMooringLines));
        const K_h = this.config.horizontalStiffness;
        const K_v = this.config.verticalStiffness;
        const pretension = this.config.linePretension;
        const MBL = Math.max(1000, this.config.breakingStrength);
        const angleStep = 360 / numLines;

        for (let i = 0; i < numLines; i++) {
            const lineAngle = (180 + i * angleStep) * (Math.PI / 180);
            const radialDisp = state.surge * Math.cos(lineAngle) + state.sway * Math.sin(lineAngle);
            const waveLoad = 50000 * env.waveHeight * Math.cos(lineAngle);

            let tension = pretension + (K_h * radialDisp) + (K_v * Math.abs(state.heave));

            if (radialDisp > 5) tension *= 1.1;
            if (radialDisp > 10) tension *= 1.25;

            tension += Math.abs(waveLoad);
            tension = Math.max(pretension, tension);

            const safetyFactor = MBL / Math.max(1e-6, tension);

            lines.push({
                id: i + 1,
                tension: tension / 1000, // kN
                safetyFactor
            });

            totalFx += tension * Math.cos(lineAngle);
            totalFy += tension * Math.sin(lineAngle);
            totalFz += pretension + (K_v * state.heave);
        }

        return {
            lines,
            totalHorizontalForce: Math.sqrt(totalFx ** 2 + totalFy ** 2),
            totalVerticalForce: totalFz
        };
    }

    /**
     * Calculates Base Stresses using configurable Beam Theory
     */
    public calculateTowerStress(state: PlatformState, env: EnvironmentalConditions): StructuralAnalysisResult['tower'] {
        const LAMBDA = Math.max(1, this.config.scaleFactor);
        const height = Math.max(0.05, this.config.structureHeight);

        // 1. Aerodynamic / External Thrust
        const rho_air = 1.225;
        const rotor_diam = Math.max(0.05, this.config.rotorDiameter);
        const area = Math.PI * (rotor_diam / 2) ** 2;
        const Ct = this.config.thrustCoefficient;

        const windSpeedModel = env.windSpeed / Math.sqrt(LAMBDA);
        const thrust = 0.5 * rho_air * area * Ct * (windSpeedModel ** 2);

        // 2. Gravitational Moment due to Pitch/Roll (P-Delta effect)
        const rna_weight = this.config.topMass * GRAVITY;
        const tower_weight = this.config.structureMass * GRAVITY;

        const tiltAngle = Math.sqrt(state.pitch ** 2 + state.roll ** 2);
        const moment_gravity = (rna_weight * height + tower_weight * (height / 2)) * Math.sin(Math.abs(tiltAngle));

        // 3. Inertial Moment
        const moment_inertia = 0.2 * moment_gravity;

        // Total Bending Moment at Base
        const totalMoment = (thrust * height) + moment_gravity + moment_inertia;

        // Calculate Stress (Sigma = M*y/I)
        const D_out = Math.max(0.01, this.config.baseDiameter);
        const wall = Math.min(D_out * 0.45, Math.max(0.0005, this.config.wallThickness));
        const D_in = D_out - (2 * wall);
        const I = Math.max(1e-12, (Math.PI / 64) * (Math.pow(D_out, 4) - Math.pow(D_in, 4)));
        const y = D_out / 2;

        const bendingStress = (totalMoment * y) / I; // Pascals

        // Axial Stress (F/A)
        const Area = Math.max(1e-8, (Math.PI / 4) * (Math.pow(D_out, 2) - Math.pow(D_in, 2)));
        const axialForce = rna_weight + tower_weight;
        const axialStress = axialForce / Area;

        const totalStress = Math.abs(bendingStress) + Math.abs(axialStress);
        const stressMPa_Model = totalStress / 1e6;
        const stressMPa_Real = stressMPa_Model * LAMBDA;

        const yieldStrength = Math.max(10, this.config.yieldStrength);
        const utilization = (stressMPa_Real / yieldStrength) * 100;

        return {
            baseMoment: totalMoment,
            baseShear: thrust,
            maxStress: stressMPa_Real,
            utilization
        };
    }

    /**
     * Simulates SHM Data Processing (Fatigue, OMA, Damage Detection, RUL)
     */
    public calculateSHM(state: PlatformState, stressResult: StructuralAnalysisResult['tower']): StructuralAnalysisResult['shm'] {
        const alerts: string[] = [];

        const stressRange = stressResult.maxStress * 0.2;
        const m = this.config.parisExponentM || 3;
        const damageIncrement = Math.pow(stressRange / 1000, m) * 0.00001;

        this.accumulatedDamage += damageIncrement;
        this.cycleCount++;

        let damageIndex = this.accumulatedDamage;
        if (stressResult.utilization > 80) {
            damageIndex = Math.max(damageIndex, 0.45);
            alerts.push("CRITICAL: Modal Curvature Deviation detected > 0.4");
        }

        const maxTilt = Math.max(Math.abs(state.pitch), Math.abs(state.roll));
        if (maxTilt > 0.15) {
            alerts.push("WARNING: Extreme Tilt Detected > 8.5°");
        }

        if (this.accumulatedDamage > 0.8) {
            alerts.push("WARNING: Fatigue life usage > 80%");
        }

        if (stressResult.utilization > 90) {
            alerts.push("DANGER: Base Stress exceeds 90% Yield");
        }

        const Y = 1.12;
        const dSigma = Math.max(0.1, stressResult.maxStress * 0.2);
        const dK = Y * dSigma * Math.sqrt(Math.PI * this.crackLength);

        const da = this.config.parisConstantC * Math.pow(dK, this.config.parisExponentM);
        this.crackLength = Math.min(this.config.criticalCrackLength, this.crackLength + da);

        const cyclesRemaining = Math.max(0, (this.config.criticalCrackLength - this.crackLength) / Math.max(1e-20, da));
        const cyclesPerYear = 365 * 24 * 3600 / 5;
        const yearsRemaining = cyclesRemaining / cyclesPerYear;

        return {
            fatigueLifeUsed: Math.min(100, (this.crackLength / this.config.criticalCrackLength) * 100),
            damageIndex,
            rulYears: Math.min(this.config.designLifeYears * 2, Math.max(0, yearsRemaining)),
            alerts,
            accumulatedCycles: this.cycleCount
        };
    }
}
