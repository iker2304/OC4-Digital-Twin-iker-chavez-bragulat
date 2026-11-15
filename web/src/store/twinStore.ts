import { create } from 'zustand';
import type { TwinConfigUpdate, TwinState } from '../types';
import { API_BASE_URL, WS_BASE_URL } from '../config/api';
import {
  StructuralEngine,
  DEFAULT_PHYSICS_CONFIG,
  type PhysicsConfig,
  type StructuralAnalysisResult,
  type EnvironmentalConditions,
  type PlatformState
} from '../physics/StructuralEngine';

// Initialize Physics Engine
export const physicsEngine = new StructuralEngine();

// Debounce helper for stream value pushes (avoid flooding backend on every WS message)
let _streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingStreamValues: Record<string, { lastValue: unknown; updatedAt: string }> = {};

function scheduleStreamFlush() {
  if (_streamFlushTimer) return;
  _streamFlushTimer = setTimeout(() => {
    _streamFlushTimer = null;
    const batch = _pendingStreamValues;
    _pendingStreamValues = {};
    Object.entries(batch).forEach(([id, payload]) => {
      fetch(`${API_BASE_URL}/persist/stream-values/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {});
    });
  }, 1000);
}

// Default Environmental Conditions (can be updated from weather API or active profile)
const DEFAULT_ENV: EnvironmentalConditions = {
  windSpeed: 12, // m/s (Rated wind speed for NREL 5MW)
  waveHeight: 2.5, // m
  currentSpeed: 0.5 // m/s
};

interface StructuralHistory {
  timestamp: number;
  mooringTension: number; // Total horizontal force or max line tension
  towerStress: number; // Max stress MPa
  fatigueLife: number; // % used
}

interface TwinStore extends TwinState {
  isConnected: boolean;
  isSimulating: boolean;
  connect: () => void;
  disconnect: () => void;
  toggleSimulation: (enable?: boolean) => Promise<void>;
  setTwinData: (data: Partial<TwinState>) => void;
  updateConfig: (config: TwinConfigUpdate) => void;
  cameraSource: number | string;
  setCameraSource: (source: number | string) => void;
  revertCameraSource: (source: number | string) => void;

  // Environmental State
  envConditions: EnvironmentalConditions;
  setEnvConditions: (env: Partial<EnvironmentalConditions>) => void;

  // Physics Config State
  physicsConfig: PhysicsConfig;
  updatePhysicsConfig: (updates: Partial<PhysicsConfig>) => void;
  resetStructuralDamage: () => void;

  // Structural Analysis State
  structural: StructuralAnalysisResult | null;
  structuralHistory: StructuralHistory[];

  history: {
    roll: { timestamp: number; value: number }[];
    pitch: { timestamp: number; value: number }[];
    yaw: { timestamp: number; value: number }[];
    x: { timestamp: number; value: number }[];
    y: { timestamp: number; value: number }[];
    z: { timestamp: number; value: number }[];
  };
}

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let manualDisconnect = false;

export const useTwinStore = create<TwinStore>((set, get) => ({
  navigation: {
    roll: 0,
    pitch: 0,
    yaw: 0,
    position: { x: 0, y: 0, z: 0 },
  },
  pose: {
    rvec: [0, 0, 0],
    tvec: [0, 0, 0]
  },
  metrics: {
    velocity: { x: 0, y: 0, z: 0 },
    forces: { fx: 0, fy: 0, fz: 0 },
    distances: { d1: 0, d2: 0, d3: 0 },
  },
  video: {
    keypoints: [],
    overlayData: {},
  },
  isConnected: false,
  isSimulating: false,
  cameraSource: 0,

  envConditions: DEFAULT_ENV,
  physicsConfig: DEFAULT_PHYSICS_CONFIG,
  structural: null,
  structuralHistory: [],

  history: {
    roll: [],
    pitch: [],
    yaw: [],
    x: [],
    y: [],
    z: [],
  },

  setEnvConditions: (env) => set((state) => ({
    envConditions: { ...state.envConditions, ...env }
  })),

  updatePhysicsConfig: (updates) => {
    physicsEngine.setConfig(updates);
    const updated = physicsEngine.getConfig();
    set({ physicsConfig: updated });
    // Also sync to backend SHM analyzer
    fetch(`${API_BASE_URL}/shm/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        youngsModulus: updated.youngsModulus * 1e9,
        yieldStrength: updated.yieldStrength * 1e6,
        scaleFactor: updated.scaleFactor,
        mSlope: updated.parisExponentM,
        designLifeYears: updated.designLifeYears,
        initialDamage: updated.initialDamage,
      }),
    }).catch(() => {});
  },

  resetStructuralDamage: () => {
    physicsEngine.resetDamage();
    set({ structuralHistory: [] });
  },

  toggleSimulation: async (enable) => {
    const nextState = enable !== undefined ? enable : !get().isSimulating;
    try {
      const res = await fetch(`${API_BASE_URL}/api/twins/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: nextState, frequencyHz: 10.0 }),
      });
      if (res.ok) {
        const data = await res.json();
        set({ isSimulating: Boolean(data.simulating) });
        if (data.simulating && !get().isConnected) {
          get().connect();
        }
      }
    } catch {
      set({ isSimulating: nextState });
    }
  },

  connect: () => {
    if (socket) return;
    manualDisconnect = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    // Check backend simulation status on connect
    fetch(`${API_BASE_URL}/api/twins/active`)
      .then((r) => r.json())
      .then((d) => {
        if (d && typeof d.simulating === 'boolean') {
          set({ isSimulating: d.simulating });
        }
      })
      .catch(() => {});

    socket = new WebSocket(`${WS_BASE_URL}/ws/realtime`);

    socket.onopen = () => {
      set({ isConnected: true });
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const now = Date.now();

        // Prepare State for Physics Engine
        const currentEnv = get().envConditions;
        const platformState: PlatformState = {
          surge: Number(data.navigation?.position?.x) || 0,
          sway: Number(data.navigation?.position?.y) || 0,
          heave: Number(data.navigation?.position?.z) || 0,
          roll: Number(data.navigation?.roll) || 0,
          pitch: Number(data.navigation?.pitch) || 0,
          yaw: Number(data.navigation?.yaw) || 0
        };

        // Run Structural Analysis
        const mooring = physicsEngine.calculateMooringForces(platformState, currentEnv);
        const tower = physicsEngine.calculateTowerStress(platformState, currentEnv);
        const shm = physicsEngine.calculateSHM(platformState, tower);

        const analysisResult: StructuralAnalysisResult = { mooring, tower, shm };

        set((state) => ({
          navigation: data.navigation || state.navigation,
          metrics: data.metrics || state.metrics,
          video: data.video || state.video,
          pose: data.pose || state.pose,
          system: data.system || state.system,

          structural: analysisResult,
          structuralHistory: [...state.structuralHistory, {
            timestamp: now,
            mooringTension: mooring.totalHorizontalForce / 1000, // kN
            towerStress: tower.maxStress,
            fatigueLife: shm.fatigueLifeUsed
          }].slice(-500),

          history: {
            roll: [...(state.history?.roll || []), { timestamp: now, value: Number(data.navigation?.roll) || 0 }].slice(-100),
            pitch: [...(state.history?.pitch || []), { timestamp: now, value: Number(data.navigation?.pitch) || 0 }].slice(-100),
            yaw: [...(state.history?.yaw || []), { timestamp: now, value: Number(data.navigation?.yaw) || 0 }].slice(-100),
            x: [...(state.history?.x || []), { timestamp: now, value: Number(data.navigation?.position?.x) || 0 }].slice(-100),
            y: [...(state.history?.y || []), { timestamp: now, value: Number(data.navigation?.position?.y) || 0 }].slice(-100),
            z: [...(state.history?.z || []), { timestamp: now, value: Number(data.navigation?.position?.z) || 0 }].slice(-100),
          }
        }));

        // Sync structural analysis to backend for dashboard widgets
        const streamData = {
          surge: platformState.surge,
          sway: platformState.sway,
          heave: platformState.heave,
          roll: platformState.roll,
          pitch: platformState.pitch,
          yaw: platformState.yaw,
          mooringTension: mooring.totalHorizontalForce / 1000,
          towerStress: tower.maxStress,
          fatigueLife: shm.fatigueLifeUsed,
          updatedAt: new Date().toISOString()
        };

        const updatedAt = streamData.updatedAt;
        Object.entries({
          'twin.surge': streamData.surge,
          'twin.sway': streamData.sway,
          'twin.heave': streamData.heave,
          'twin.roll': streamData.roll,
          'twin.pitch': streamData.pitch,
          'twin.yaw': streamData.yaw,
          'twin.mooring': streamData.mooringTension,
          'twin.tower': streamData.towerStress,
          'twin.fatigue': streamData.fatigueLife
        }).forEach(([id, value]) => {
          _pendingStreamValues[id] = { lastValue: value, updatedAt };
        });
        scheduleStreamFlush();
      } catch (e) {
        console.error('Error parsing WebSocket message', e);
      }
    };

    socket.onclose = () => {
      set({ isConnected: false });
      socket = null;
      if (!manualDisconnect) {
        reconnectTimer = setTimeout(() => {
          get().connect();
        }, 1500);
      }
    };
  },
  disconnect: () => {
    manualDisconnect = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (socket) {
      socket.close();
      socket = null;
    }
  },
  setTwinData: (data) => set((state) => ({ ...state, ...data })),
  updateConfig: (config) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(config));
    } else {
      console.warn('Cannot update config: WebSocket not connected');
    }
  },
  setCameraSource: (source) => {
    set({ cameraSource: source });
    if (typeof source === 'number') {
      fetch('http://127.0.0.1:8001/switch_source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      }).catch(() => {});
    }
    get().updateConfig({ camera_source: source });
  },
  revertCameraSource: (source) => {
    set({ cameraSource: source });
  },
}));
