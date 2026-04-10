import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';

export interface TwinProfile {
    id: string;
    userId: string;
    name: string;
    description: string;
    icon: string; // emoji
    color: string;
    createdAt: number;
    updatedAt: number;
    config: {
        mqttBroker: string;
        mqttPort: number;
        mqttTopic: string;
        websocketUrl: string;
        blenderScene: string;
        cameraSource: number | string;
        environmentalDefaults: {
            windSpeed: number;
            waveHeight: number;
            currentSpeed: number;
        };
    };
    pipelineIds: string[]; // associated pipelines
    defaultDashboardId?: string; // pinned dashboard for the overview tab
}

interface ProfileStore {
    profiles: TwinProfile[];
    activeProfileId: string | null;

    loadProfiles: (userId: string) => void;
    createProfile: (userId: string, name: string, description: string, icon: string, color: string) => TwinProfile;
    updateProfile: (profileId: string, updates: Partial<TwinProfile>) => void;
    deleteProfile: (profileId: string) => void;
    setActiveProfile: (profileId: string | null) => void;
    duplicateProfile: (profileId: string) => TwinProfile | null;
    getActiveProfile: () => TwinProfile | undefined;
}

const PROFILES_KEY = 'oc4_dt_profiles';

const DEFAULT_CONFIG: TwinProfile['config'] = {
    mqttBroker: 'localhost',
    mqttPort: 1883,
    mqttTopic: 'oc4/telemetry',
    websocketUrl: 'ws://localhost:8080/ws/realtime',
    blenderScene: 'OC4_Semi.blend',
    cameraSource: 0,
    environmentalDefaults: {
        windSpeed: 12,
        waveHeight: 2.5,
        currentSpeed: 0.5,
    },
};

const PROFILE_COLORS = [
    '#3b82f6', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b',
    '#ef4444', '#ec4899', '#6366f1', '#14b8a6', '#f97316'
];

const PROFILE_ICONS = ['🌊', '⚡', '🔧', '🏗️', '📡', '🌬️', '🔬', '⚙️'];

function getAllProfiles(): TwinProfile[] {
    try {
        const raw = localStorage.getItem(PROFILES_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

function saveAllProfiles(profiles: TwinProfile[]) {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
    fetch('http://localhost:8080/persist/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profiles)
    }).catch(() => { });
}

export { PROFILE_COLORS, PROFILE_ICONS, DEFAULT_CONFIG };

export const useProfileStore = create<ProfileStore>((set, get) => ({
    profiles: [],
    activeProfileId: null,

    loadProfiles: async (userId: string) => {
        try {
            const res = await fetch('http://localhost:8080/persist/profiles');
            if (res.ok) {
                const backendProfiles = await res.json();
                if (backendProfiles && Array.isArray(backendProfiles) && backendProfiles.length > 0) {
                    localStorage.setItem(PROFILES_KEY, JSON.stringify(backendProfiles));
                }
            }
        } catch (e) {
            // Fallback to local
        }

        const all = getAllProfiles();
        const userProfiles = all.filter(p => p.userId === userId);
        const activeId = localStorage.getItem(`oc4_dt_active_profile_${userId}`);
        set({
            profiles: userProfiles,
            activeProfileId: userProfiles.find(p => p.id === activeId) ? activeId : null
        });
    },

    createProfile: (userId, name, description, icon, color) => {
        const newProfile: TwinProfile = {
            id: uuidv4(),
            userId,
            name,
            description,
            icon: icon || PROFILE_ICONS[Math.floor(Math.random() * PROFILE_ICONS.length)],
            color: color || PROFILE_COLORS[Math.floor(Math.random() * PROFILE_COLORS.length)],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            config: { ...DEFAULT_CONFIG },
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

        all[idx] = { ...all[idx], ...updates, updatedAt: Date.now() };
        saveAllProfiles(all);

        set(state => ({
            profiles: state.profiles.map(p => p.id === profileId ? { ...p, ...updates, updatedAt: Date.now() } : p)
        }));
    },

    deleteProfile: (profileId) => {
        const all = getAllProfiles().filter(p => p.id !== profileId);
        saveAllProfiles(all);

        set(state => ({
            profiles: state.profiles.filter(p => p.id !== profileId),
            activeProfileId: state.activeProfileId === profileId ? null : state.activeProfileId,
        }));
    },

    setActiveProfile: (profileId) => {
        const profiles = get().profiles;
        if (profileId && profiles.length > 0) {
            const userId = profiles[0].userId;
            localStorage.setItem(`oc4_dt_active_profile_${userId}`, profileId);
        }
        set({ activeProfileId: profileId });
    },

    duplicateProfile: (profileId) => {
        const profile = get().profiles.find(p => p.id === profileId);
        if (!profile) return null;

        const dup: TwinProfile = {
            ...profile,
            id: uuidv4(),
            name: `${profile.name} (Copy)`,
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
        return state.profiles.find(p => p.id === state.activeProfileId);
    },
}));
