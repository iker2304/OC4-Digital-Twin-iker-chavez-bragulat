import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import { DEFAULT_PHYSICS_CONFIG, type PhysicsConfig } from '../physics/StructuralEngine';
import { useTwinStore } from './twinStore';
import { API_BASE_URL, WS_BASE_URL } from '../config/api';

export type TwinAssetType =
  | 'offshore_wind'
  | 'onshore_wind'
  | 'civil_structure'
  | 'robotics'
  | 'aerospace_uav'
  | 'custom';

export interface TwinKeypointDef {
  id: number;
  name: string;
  x: number;
  y: number;
  z: number;
}

export interface TwinAIConfig {
  yoloModelPath: string;
  datasetName: string;
  confidenceThreshold: number;
  keypointThreshold: number;
  numKeypoints: number;
  classNames: string[];
  keypoints: TwinKeypointDef[];
}

export interface TwinProfile {
  id: string;
  userId: string;
  name: string;
  description: string;
  assetType: TwinAssetType;
  icon: string; // emoji
  color: string;
  createdAt: number;
  updatedAt: number;
  config: {
    mqttBroker: string;
    mqttPort: number;
    mqttTopic: string;
    mqttConfigTopic: string;
    websocketUrl: string;
    blenderScene: string;
    cameraSource: number | string;
    model3dUrl: string;
    modelScale: number;
    enableBladeRotation: boolean;
    animatedNodeName: string;
    locationName: string;
    coordinates: [number, number]; // [lat, lng]
    environmentalDefaults: {
      windSpeed: number;
      waveHeight: number;
      currentSpeed: number;
    };
    physicsConfig: PhysicsConfig;
    aiConfig: TwinAIConfig;
  };
  pipelineIds: string[]; // associated pipelines
  defaultDashboardId?: string; // pinned dashboard for the overview tab
}

export interface TwinTemplate {
  id: string;
  name: string;
  assetType: TwinAssetType;
  icon: string;
  color: string;
  description: string;
  config: TwinProfile['config'];
}

const DEFAULT_KEYPOINTS: TwinKeypointDef[] = [
  { id: 1, name: 'Col1_Top', x: 14.43, y: 25.0, z: 12.0 },
  { id: 2, name: 'Col2_Top', x: 14.43, y: -25.0, z: 12.0 },
  { id: 3, name: 'Col3_Top', x: -28.87, y: 0.0, z: 12.0 },
  { id: 4, name: 'Tower_Top', x: 0.0, y: 0.0, z: 87.6 },
  { id: 5, name: 'Col1_Bottom', x: 14.43, y: 25.0, z: -20.0 },
  { id: 6, name: 'Col2_Bottom', x: 14.43, y: -25.0, z: -20.0 },
  { id: 7, name: 'Col3_Bottom', x: -28.87, y: 0.0, z: -20.0 },
  { id: 8, name: 'Center_Column', x: 0.0, y: 0.0, z: 10.0 },
  { id: 9, name: 'Fairlead_1', x: 20.43, y: 35.39, z: -14.0 },
  { id: 10, name: 'Fairlead_2', x: 20.43, y: -35.39, z: -14.0 },
  { id: 11, name: 'Fairlead_3', x: -40.87, y: 0.0, z: -14.0 },
];

export const DEFAULT_CONFIG: TwinProfile['config'] = {
  mqttBroker: 'localhost',
  mqttPort: 1883,
  mqttTopic: 'oc4/telemetry',
  mqttConfigTopic: 'oc4/config',
  websocketUrl: `${WS_BASE_URL}/ws/realtime`,
  blenderScene: 'OC4_Semi.blend',
  cameraSource: 0,
  model3dUrl: '/models/OC4.glb',
  modelScale: 0.05,
  enableBladeRotation: true,
  animatedNodeName: 'Low.002',
  locationName: 'North Sea — Block 14/19 (OC4 Test Site)',
  coordinates: [55.0, 2.0],
  environmentalDefaults: {
    windSpeed: 12,
    waveHeight: 2.5,
    currentSpeed: 0.5,
  },
  physicsConfig: { ...DEFAULT_PHYSICS_CONFIG },
  aiConfig: {
    yoloModelPath: 'data/models/CV/pose/yolo11m-pose-v1/weights/best.pt',
    datasetName: 'Floating platform.v1i.yolov11',
    confidenceThreshold: 0.5,
    keypointThreshold: 0.5,
    numKeypoints: 11,
    classNames: ['floating_platform'],
    keypoints: DEFAULT_KEYPOINTS,
  },
};

export const TWIN_TEMPLATES: TwinTemplate[] = [
  {
    id: 'tpl_oc4_offshore',
    name: 'OC4 DeepCwind Floating Turbine',
    assetType: 'offshore_wind',
    icon: '🌊',
    color: '#3b82f6',
    description: 'Turbina eólica flotante semi-sumergible NREL 5MW (escala 1:100) con seguimiento óptico de 11 keypoints y análisis hidrodinámico/estructural.',
    config: { ...DEFAULT_CONFIG },
  },
  {
    id: 'tpl_onshore_wind',
    name: 'Aerogenerador Terrestre 3.5MW',
    assetType: 'onshore_wind',
    icon: '🌬️',
    color: '#10b981',
    description: 'Turbina eólica terrestre de cimentación fija con monitorización modal de torre tubular y análisis de fatiga por cargas de viento.',
    config: {
      ...DEFAULT_CONFIG,
      mqttTopic: 'wind/onshore01/telemetry',
      mqttConfigTopic: 'wind/onshore01/config',
      blenderScene: 'Onshore_Turbine.blend',
      model3dUrl: '/models/OC4.glb',
      modelScale: 0.05,
      enableBladeRotation: true,
      locationName: 'Parque Eólico Zaragoza, España',
      coordinates: [41.65, -0.88],
      environmentalDefaults: { windSpeed: 9.5, waveHeight: 0, currentSpeed: 0 },
      physicsConfig: {
        ...DEFAULT_PHYSICS_CONFIG,
        scaleFactor: 100,
        structureHeight: 1.1,
        baseDiameter: 0.05,
        wallThickness: 0.0025,
        numMooringLines: 4,
        linePretension: 5.0,
        horizontalStiffness: 180000,
        verticalStiffness: 120000,
        yieldStrength: 355,
      },
      aiConfig: {
        ...DEFAULT_CONFIG.aiConfig,
        classNames: ['wind_turbine'],
        numKeypoints: 8,
      },
    },
  },
  {
    id: 'tpl_civil_bridge',
    name: 'Viaducto / Puente Colgante SHM',
    assetType: 'civil_structure',
    icon: '🏗️',
    color: '#f59e0b',
    description: 'Infraestructura civil monitorizada mediante visión artificial y sensores vibracionales para detección de daño estructural (OMA) y tensión en tirantes.',
    config: {
      ...DEFAULT_CONFIG,
      mqttTopic: 'civil/bridge01/telemetry',
      mqttConfigTopic: 'civil/bridge01/config',
      blenderScene: 'Suspension_Bridge.blend',
      model3dUrl: 'procedural:bridge',
      modelScale: 1.0,
      enableBladeRotation: false,
      animatedNodeName: '',
      locationName: 'Estuario de Bilbao, España',
      coordinates: [43.323, -3.017],
      environmentalDefaults: { windSpeed: 8.0, waveHeight: 0.5, currentSpeed: 0.2 },
      physicsConfig: {
        ...DEFAULT_PHYSICS_CONFIG,
        scaleFactor: 50,
        structureHeight: 1.4,
        baseDiameter: 0.12,
        wallThickness: 0.006,
        topMass: 1.2,
        structureMass: 2.5,
        rotorDiameter: 0.4,
        thrustCoefficient: 0.4,
        numMooringLines: 6,
        linePretension: 15.0,
        horizontalStiffness: 150000,
        verticalStiffness: 90000,
        yieldStrength: 460,
        designLifeYears: 50,
      },
      aiConfig: {
        ...DEFAULT_CONFIG.aiConfig,
        classNames: ['bridge_deck', 'pylon'],
        numKeypoints: 10,
      },
    },
  },
  {
    id: 'tpl_robotics_arm',
    name: 'Brazo Robótico Industrial 6-DOF',
    assetType: 'robotics',
    icon: '🤖',
    color: '#8b5cf6',
    description: 'Manipulador robótico articulado con estimación de pose 6-DOF por cámara, control de par en articulaciones y predicción de vida útil (RUL) de reductores.',
    config: {
      ...DEFAULT_CONFIG,
      mqttTopic: 'robotics/arm01/telemetry',
      mqttConfigTopic: 'robotics/arm01/config',
      blenderScene: 'RobotArm_6DOF.blend',
      model3dUrl: 'procedural:robot_arm',
      modelScale: 1.0,
      enableBladeRotation: false,
      animatedNodeName: '',
      locationName: 'Planta Industrial Barcelona — Celda 4',
      coordinates: [41.385, 2.173],
      environmentalDefaults: { windSpeed: 0, waveHeight: 0, currentSpeed: 0 },
      physicsConfig: {
        ...DEFAULT_PHYSICS_CONFIG,
        scaleFactor: 1,
        structureHeight: 1.2,
        baseDiameter: 0.18,
        wallThickness: 0.012,
        topMass: 15.0,
        structureMass: 45.0,
        rotorDiameter: 0.2,
        thrustCoefficient: 0.1,
        numMooringLines: 3,
        linePretension: 50.0,
        horizontalStiffness: 250000,
        verticalStiffness: 250000,
        yieldStrength: 500,
        designLifeYears: 15,
      },
      aiConfig: {
        ...DEFAULT_CONFIG.aiConfig,
        classNames: ['robot_arm'],
        numKeypoints: 7,
      },
    },
  },
  {
    id: 'tpl_aerospace_uav',
    name: 'UAV / Dron de Inspección Naval',
    assetType: 'aerospace_uav',
    icon: '🛸',
    color: '#06b6d4',
    description: 'Plataforma aérea no tripulada con seguimiento óptico de actitud (Roll/Pitch/Yaw), telemetría inercial y análisis de vibraciones en chasis.',
    config: {
      ...DEFAULT_CONFIG,
      mqttTopic: 'uav/drone01/telemetry',
      mqttConfigTopic: 'uav/drone01/config',
      blenderScene: 'Quadrotor_UAV.blend',
      model3dUrl: 'procedural:uav',
      modelScale: 1.0,
      enableBladeRotation: true,
      animatedNodeName: '',
      locationName: 'Plataforma Experimental Gran Canaria',
      coordinates: [28.0, -15.4],
      environmentalDefaults: { windSpeed: 6.5, waveHeight: 1.0, currentSpeed: 0.2 },
      physicsConfig: {
        ...DEFAULT_PHYSICS_CONFIG,
        scaleFactor: 1,
        structureHeight: 0.35,
        baseDiameter: 0.04,
        wallThickness: 0.003,
        topMass: 2.5,
        structureMass: 4.0,
        rotorDiameter: 0.6,
        thrustCoefficient: 0.8,
        numMooringLines: 4,
        linePretension: 10.0,
        horizontalStiffness: 15000,
        verticalStiffness: 15000,
        yieldStrength: 280,
        designLifeYears: 10,
      },
      aiConfig: {
        ...DEFAULT_CONFIG.aiConfig,
        classNames: ['uav_frame'],
        numKeypoints: 6,
      },
    },
  },
];

interface ProfileStore {
  profiles: TwinProfile[];
  activeProfileId: string | null;

  loadProfiles: (userId: string) => void;
  createProfile: (
    userId: string,
    name: string,
    description: string,
    icon: string,
    color: string,
    templateId?: string,
    customConfig?: Partial<TwinProfile['config']>,
    assetType?: TwinAssetType
  ) => TwinProfile;
  updateProfile: (profileId: string, updates: Partial<TwinProfile>) => void;
  deleteProfile: (profileId: string) => void;
  setActiveProfile: (profileId: string | null) => void;
  duplicateProfile: (profileId: string) => TwinProfile | null;
  getActiveProfile: () => TwinProfile | undefined;
}

const PROFILES_KEY = 'oc4_dt_profiles';

const PROFILE_COLORS = [
  '#3b82f6', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b',
  '#ef4444', '#ec4899', '#6366f1', '#14b8a6', '#f97316'
];

const PROFILE_ICONS = ['🌊', '⚡', '🔧', '🏗️', '📡', '🌬️', '🔬', '⚙️', '🤖', '🛸'];

function normalizeProfile(p: any): TwinProfile {
  const cfg = p.config || {};
  return {
    ...p,
    assetType: p.assetType || 'offshore_wind',
    config: {
      ...DEFAULT_CONFIG,
      ...cfg,
      environmentalDefaults: {
        ...DEFAULT_CONFIG.environmentalDefaults,
        ...(cfg.environmentalDefaults || {}),
      },
      physicsConfig: {
        ...DEFAULT_PHYSICS_CONFIG,
        ...(cfg.physicsConfig || {}),
      },
      aiConfig: {
        ...DEFAULT_CONFIG.aiConfig,
        ...(cfg.aiConfig || {}),
      },
    },
  };
}

function getAllProfiles(): TwinProfile[] {
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map(normalizeProfile) : [];
  } catch {
    return [];
  }
}

function saveAllProfiles(profiles: TwinProfile[]) {
  localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
  fetch(`${API_BASE_URL}/persist/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profiles)
  }).catch(() => {});
}

function syncActiveProfileWithSystem(profile: TwinProfile | undefined) {
  if (!profile) return;
  const twinStore = useTwinStore.getState();
  if (profile.config.environmentalDefaults) {
    twinStore.setEnvConditions(profile.config.environmentalDefaults);
  }
  if (profile.config.physicsConfig) {
    twinStore.updatePhysicsConfig(profile.config.physicsConfig);
  }
  // Sync with backend active twin manager
  fetch(`${API_BASE_URL}/api/twins/active`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: profile.id,
      name: profile.name,
      assetType: profile.assetType,
      mqttBroker: profile.config.mqttBroker,
      mqttPort: profile.config.mqttPort,
      mqttTopic: profile.config.mqttTopic,
      mqttConfigTopic: profile.config.mqttConfigTopic,
      model3dUrl: profile.config.model3dUrl,
      yoloModelPath: profile.config.aiConfig?.yoloModelPath,
      keypointsCount: profile.config.aiConfig?.numKeypoints || 11,
      physicsConfig: profile.config.physicsConfig,
    }),
  }).catch(() => {});
}

export { PROFILE_COLORS, PROFILE_ICONS };

export const useProfileStore = create<ProfileStore>((set, get) => ({
  profiles: [],
  activeProfileId: null,

  loadProfiles: async (userId: string) => {
    try {
      const res = await fetch(`${API_BASE_URL}/persist/profiles`);
      if (res.ok) {
        const backendProfiles = await res.json();
        if (backendProfiles && Array.isArray(backendProfiles) && backendProfiles.length > 0) {
          localStorage.setItem(PROFILES_KEY, JSON.stringify(backendProfiles.map(normalizeProfile)));
        }
      }
    } catch {
      // Fallback to localStorage
    }

    const all = getAllProfiles();
    let userProfiles = all.filter(p => p.userId === userId);

    // Seed default multi-twin profiles if this user has none yet
    if (userProfiles.length === 0) {
      const defaultOc4: TwinProfile = {
        id: uuidv4(),
        userId,
        name: 'OC4 DeepCwind Floating Turbine',
        description: 'Plataforma eólica flotante semi-sumergible NREL 5MW (escala 1:100) con seguimiento óptico YOLO Pose y análisis estructural.',
        assetType: 'offshore_wind',
        icon: '🌊',
        color: '#3b82f6',
        createdAt: Date.now() - 86400000,
        updatedAt: Date.now(),
        config: JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
        pipelineIds: [],
      };
      const secondaryBridge: TwinProfile = {
        id: uuidv4(),
        userId,
        name: 'Viaducto Colgante SHM-02',
        description: 'Gemelo digital de puente atirantado para monitorización modal (OMA), control de tensión en tirantes y fatiga estructural.',
        assetType: 'civil_structure',
        icon: '🏗️',
        color: '#f59e0b',
        createdAt: Date.now() - 43200000,
        updatedAt: Date.now(),
        config: JSON.parse(JSON.stringify(TWIN_TEMPLATES[2].config)),
        pipelineIds: [],
      };
      const roboticsTwin: TwinProfile = {
        id: uuidv4(),
        userId,
        name: 'Celda Robótica 6-DOF',
        description: 'Manipulador industrial articulado con seguimiento visual de keypoints y estimación de fatiga mecánica en tiempo real.',
        assetType: 'robotics',
        icon: '🤖',
        color: '#8b5cf6',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        config: JSON.parse(JSON.stringify(TWIN_TEMPLATES[3].config)),
        pipelineIds: [],
      };

      userProfiles = [defaultOc4, secondaryBridge, roboticsTwin];
      const merged = [...all, ...userProfiles];
      saveAllProfiles(merged);
    }

    const savedActiveId = localStorage.getItem(`oc4_dt_active_profile_${userId}`);
    const resolvedActiveId =
      userProfiles.find(p => p.id === savedActiveId)?.id ||
      userProfiles[0]?.id ||
      null;

    if (resolvedActiveId) {
      localStorage.setItem(`oc4_dt_active_profile_${userId}`, resolvedActiveId);
    }

    set({
      profiles: userProfiles,
      activeProfileId: resolvedActiveId,
    });

    const activeProfile = userProfiles.find(p => p.id === resolvedActiveId);
    syncActiveProfileWithSystem(activeProfile);
  },

  createProfile: (userId, name, description, icon, color, templateId, customConfig, assetType) => {
    const template = TWIN_TEMPLATES.find(t => t.id === templateId);
    const baseConfig: TwinProfile['config'] = template
      ? JSON.parse(JSON.stringify(template.config))
      : JSON.parse(JSON.stringify(DEFAULT_CONFIG));

    const mergedConfig: TwinProfile['config'] = {
      ...baseConfig,
      ...(customConfig || {}),
      environmentalDefaults: {
        ...baseConfig.environmentalDefaults,
        ...(customConfig?.environmentalDefaults || {}),
      },
      physicsConfig: {
        ...baseConfig.physicsConfig,
        ...(customConfig?.physicsConfig || {}),
      },
      aiConfig: {
        ...baseConfig.aiConfig,
        ...(customConfig?.aiConfig || {}),
      },
    };

    const newProfile: TwinProfile = {
      id: uuidv4(),
      userId,
      name,
      description,
      assetType: assetType || template?.assetType || 'custom',
      icon: icon || template?.icon || PROFILE_ICONS[Math.floor(Math.random() * PROFILE_ICONS.length)],
      color: color || template?.color || PROFILE_COLORS[Math.floor(Math.random() * PROFILE_COLORS.length)],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      config: mergedConfig,
      pipelineIds: [],
    };

    const all = getAllProfiles();
    all.push(newProfile);
    saveAllProfiles(all);

    set(state => ({ profiles: [...state.profiles, newProfile] }));
    return newProfile;
  },

  updateProfile: (profileId, updates) => {
    const all = getAllProfiles();
    const idx = all.findIndex(p => p.id === profileId);
    if (idx === -1) return;

    const existing = all[idx];
    const updatedProfile: TwinProfile = normalizeProfile({
      ...existing,
      ...updates,
      config: updates.config
        ? {
            ...existing.config,
            ...updates.config,
            environmentalDefaults: {
              ...existing.config.environmentalDefaults,
              ...(updates.config.environmentalDefaults || {}),
            },
            physicsConfig: {
              ...existing.config.physicsConfig,
              ...(updates.config.physicsConfig || {}),
            },
            aiConfig: {
              ...existing.config.aiConfig,
              ...(updates.config.aiConfig || {}),
            },
          }
        : existing.config,
      updatedAt: Date.now(),
    });

    all[idx] = updatedProfile;
    saveAllProfiles(all);

    set(state => ({
      profiles: state.profiles.map(p => (p.id === profileId ? updatedProfile : p)),
    }));

    if (get().activeProfileId === profileId) {
      syncActiveProfileWithSystem(updatedProfile);
    }
  },

  deleteProfile: (profileId) => {
    const all = getAllProfiles().filter(p => p.id !== profileId);
    saveAllProfiles(all);

    set(state => {
      const remaining = state.profiles.filter(p => p.id !== profileId);
      const nextActive =
        state.activeProfileId === profileId
          ? remaining[0]?.id || null
          : state.activeProfileId;
      return {
        profiles: remaining,
        activeProfileId: nextActive,
      };
    });
  },

  setActiveProfile: (profileId) => {
    const profiles = get().profiles;
    if (profileId && profiles.length > 0) {
      const userId = profiles[0].userId;
      localStorage.setItem(`oc4_dt_active_profile_${userId}`, profileId);
    }
    set({ activeProfileId: profileId });
    const found = profiles.find(p => p.id === profileId);
    syncActiveProfileWithSystem(found);
  },

  duplicateProfile: (profileId) => {
    const profile = get().profiles.find(p => p.id === profileId);
    if (!profile) return null;

    const dup: TwinProfile = {
      ...JSON.parse(JSON.stringify(profile)),
      id: uuidv4(),
      name: `${profile.name} (Copia)`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pipelineIds: [],
    };

    const all = getAllProfiles();
    all.push(dup);
    saveAllProfiles(all);

    set(state => ({ profiles: [...state.profiles, dup] }));
    return dup;
  },

  getActiveProfile: () => {
    const state = get();
    return state.profiles.find(p => p.id === state.activeProfileId) || state.profiles[0];
  },
}));
