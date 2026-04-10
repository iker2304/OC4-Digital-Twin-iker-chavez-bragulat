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
