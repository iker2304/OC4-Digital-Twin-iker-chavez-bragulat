export interface TwinState {
  navigation: {
    roll: number;
    pitch: number;
    yaw: number;
    position: { x: number; y: number; z: number };
  };
  pose?: {
    rvec: number[];
    tvec: number[];
  };
  metrics: {
    velocity: { x: number; y: number; z: number };
    forces: { fx: number; fy: number; fz: number };
    distances: { d1: number; d2: number; d3: number };
  };
  video: {
    keypoints: Array<{ x: number; y: number; id: string }>;
    overlayData: Record<string, unknown>;
  };
  system?: {
    localIp: string;
  };
}

export type TwinConfigUpdate = Record<string, unknown>;

export interface WeatherData {
  temp: number;
  windSpeed: number;
  windDir: number;
  visibility: number;
  waveHeight: number;
  wavePeriod: number;
  waveDir: number;
}

export interface POI {
  id: string;
  position: [number, number];
  title: string;
  description: string;
  isRemovable?: boolean;
}

export interface SHMResponse {
  timestamp: string;
  sensor_id: string;
  metrics: {
      current_stress_mpa: number;
      damage_index: number;
      fatigue_life_used_percent: number;
      remaining_life_years: number;
      accumulated_cycles: number;
  };
  status: string;
  anomalies: string[];
}

// ── Operational Modal Analysis (OMA) types ────────────────────────────────────

/** Visualization mode for the 3D structural viewer. */
export type ViewMode = 'time' | 'frequency';

/**
 * FEM mode shape data loaded from OC4-modal_res.json.
 * Each mode maps node IDs to [ux, uy, uz] displacement vectors.
 * Φ_FEM,i — the i-th mode shape column vector.
 */
export interface FemModeShapeData {
  /** FEM natural frequency for this mode (Hz) */
  frequency: number;
  /**
   * Node displacements: Record<nodeId (1-indexed), [ux, uy, uz]>
   * These are the components of Φ_FEM,i for modal superposition.
   */
  nodes: Record<string, [number, number, number]>;
}

/** FFT spectrum payload from the backend modal-filtered-ws. */
export interface FftSpectrum {
  freqs: number[];
  magnitudes: number[];
}

/**
 * WebSocket message from /api/fem/modal-filtered-ws.
 * Contains band-isolated modal coordinates q_i(t) computed via IFFT.
 */
export interface ModalFilteredMessage {
  type: 'modal_filtered';
  /**
   * Modal coordinates in metres: { modeId: q_i(t) }
   * Computed as: q_i(t) = IFFT( FFT(x(t)) · H_i(f) )[-1]
   * where H_i is the bandpass mask centred at the i-th FEM frequency.
   */
  q_modal: Record<string, number>;
  fft_spectrum: FftSpectrum;
  sample_rate_hz: number;
  n_samples: number;
  timestamp: string;
}

