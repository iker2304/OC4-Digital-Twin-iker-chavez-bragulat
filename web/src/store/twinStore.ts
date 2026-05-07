import { create } from 'zustand';
import type { TwinConfigUpdate, TwinState } from '../types';
import { StructuralEngine, type StructuralAnalysisResult, type EnvironmentalConditions, type PlatformState } from '../physics/StructuralEngine';

// Initialize Physics Engine
const physicsEngine = new StructuralEngine();

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
      fetch(`http://localhost:8080/persist/stream-values/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {});
    });
  }, 1000);
}

// Default Environmental Conditions (can be updated from weather API)
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
  connect: () => void;
  disconnect: () => void;
  setTwinData: (data: Partial<TwinState>) => void;
  updateConfig: (config: TwinConfigUpdate) => void;
  cameraSource: number | string;
  setCameraSource: (source: number | string) => void;
  revertCameraSource: (source: number | string) => void;
  
  // Environmental State
  envConditions: EnvironmentalConditions;
  setEnvConditions: (env: Partial<EnvironmentalConditions>) => void;

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
  cameraSource: 0,
  
  envConditions: DEFAULT_ENV,
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

  connect: () => {
    if (socket) return;
    manualDisconnect = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    
    socket = new WebSocket('ws://localhost:8080/ws/realtime');

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
            sway: Number(data.navigation?.position?.y) || 0, // Note: standard coord mapping check needed
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

        // Push to backend stream values (debounced — at most once per second)
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
    // Primary path: POST directly to the MJPEG detection server.
    // This is the most reliable path — it works even if the backend
    // WebSocket or MQTT are not running.
    if (typeof source === 'number') {
      fetch('http://127.0.0.1:8001/switch_source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      }).catch(() => {
        // Server might not be running yet — ignore silently;
        // the URL ?source= param will still trigger it when the
        // browser loads the new MJPEG URL.
      });
    }
    // Secondary path: notify via WebSocket → MQTT so the backend
    // pipeline_runner also knows.
    get().updateConfig({ camera_source: source });
  },
  // Updates the local store only — used when the backend reports a failed switch
  // and has already reverted to a previous source. No POST is sent to avoid loops.
  revertCameraSource: (source) => {
    set({ cameraSource: source });
  },
}));
