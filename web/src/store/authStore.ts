import { create } from 'zustand';
import { API_BASE_URL } from '../config/api';

const API_BASE = `${API_BASE_URL}/api`;

export interface DigitalTwinProfile {
    twin_id: string;
    name: string;
    description: string;
    configuration: Record<string, unknown>;
    preferences: Record<string, unknown>;
    created_at: string;
    updated_at: string;
}

export interface User {
    id: string;
    username: string;
    email: string;
    full_name: string;
    phone: string;
    is_active: boolean;
    is_verified: boolean;
    twin_profile: DigitalTwinProfile;
    created_at: string;
    updated_at: string;
    last_login: string | null;
}

interface AuthStore {
    currentUser: User | null;
    isAuthenticated: boolean;
    error: string | null;
    isInitializing: boolean;
    token: string | null;
    register: (username: string, email: string, password: string, fullName?: string) => Promise<boolean>;
    login: (username: string, password: string) => Promise<boolean>;
    logout: () => void;
    clearError: () => void;
    loadSession: () => Promise<void>;
    getProfile: () => Promise<void>;
    updateProfile: (data: Partial<User>) => Promise<boolean>;
    requestPasswordReset: (email: string) => Promise<boolean>;
    resetPassword: (token: string, newPassword: string) => Promise<boolean>;
    changePassword: (currentPassword: string, newPassword: string) => Promise<boolean>;
}

const SESSION_KEY = 'oc4_dt_token';
const LOCAL_USER_KEY = 'oc4_dt_local_user';
const LOCAL_USERS_DB_KEY = 'oc4_dt_local_users';

interface LocalUserRecord {
    user: User;
    password: string;
}

function getLocalUsers(): LocalUserRecord[] {
    try {
        const raw = localStorage.getItem(LOCAL_USERS_DB_KEY);
        return raw ? (JSON.parse(raw) as LocalUserRecord[]) : [];
    } catch {
        return [];
    }
}

function saveLocalUsers(users: LocalUserRecord[]) {
    localStorage.setItem(LOCAL_USERS_DB_KEY, JSON.stringify(users));
}

function createLocalUser(username: string, email: string, fullName?: string): User {
    const now = new Date().toISOString();
    const id = `local-${Date.now()}`;
    return {
        id,
        username,
        email: email || `${username}@dupliot.com`,
        full_name: fullName || username,
        phone: '',
        is_active: true,
        is_verified: true,
        twin_profile: {
            twin_id: `twin-${id}`,
            name: `${username} Digital Twin`,
            description: 'Standalone Cloud Workspace',
            configuration: {},
            preferences: {},
            created_at: now,
            updated_at: now,
        },
        created_at: now,
        updated_at: now,
        last_login: now,
    };
}

export const useAuthStore = create<AuthStore>((set, get) => ({
    currentUser: null,
    isAuthenticated: false,
    error: null,
    isInitializing: true,
    token: null,

    register: async (username, email, password, fullName) => {
        set({ error: null });
        try {
            const res = await fetch(`${API_BASE}/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, email, password, full_name: fullName || '' }),
            });
            const data = await res.json();
            if (!res.ok) {
                let errorMessage = 'Registration failed';
                if (data.detail) {
                    if (Array.isArray(data.detail)) {
                        errorMessage = data.detail.map((err: any) => `${err.loc.join('.')} - ${err.msg}`).join(', ');
                    } else {
                        errorMessage = data.detail;
                    }
                }
                set({ error: errorMessage });
                return false;
            }
            localStorage.setItem(SESSION_KEY, data.access_token);
            set({
                currentUser: data.user,
                isAuthenticated: true,
                token: data.access_token,
                error: null,
            });
            return true;
        } catch {
            // Standalone / offline cloud fallback when no backend server is connected
            const users = getLocalUsers();
            const exists = users.find(
                (u) =>
                    u.user.username.toLowerCase() === username.toLowerCase() ||
                    (email && u.user.email.toLowerCase() === email.toLowerCase())
            );
            if (exists) {
                set({ error: 'El usuario o correo ya existe en este navegador' });
                return false;
            }
            const user = createLocalUser(username, email, fullName);
            const token = `local_${user.id}`;
            users.push({ user, password });
            saveLocalUsers(users);
            localStorage.setItem(SESSION_KEY, token);
            localStorage.setItem(LOCAL_USER_KEY, JSON.stringify(user));
            set({
                currentUser: user,
                isAuthenticated: true,
                token,
                error: null,
            });
            return true;
        }
    },

    login: async (username, password) => {
        set({ error: null });
        try {
            const formData = new FormData();
            formData.append('username', username);
            formData.append('password', password);
            const res = await fetch(`${API_BASE}/auth/login`, {
                method: 'POST',
                body: formData,
            });
            const data = await res.json();
            if (!res.ok) {
                let errorMessage = 'Login failed';
                if (data.detail) {
                    if (Array.isArray(data.detail)) {
                        errorMessage = data.detail.map((err: any) => `${err.loc.join('.')} - ${err.msg}`).join(', ');
                    } else {
                        errorMessage = data.detail;
                    }
                }
                set({ error: errorMessage });
                return false;
            }
            localStorage.setItem(SESSION_KEY, data.access_token);
            set({
                currentUser: data.user,
                isAuthenticated: true,
                token: data.access_token,
                error: null,
            });
            return true;
        } catch {
            // Standalone / offline cloud fallback when no backend server is connected
            const users = getLocalUsers();
            const found = users.find(
                (u) =>
                    u.user.username.toLowerCase() === username.toLowerCase() ||
                    u.user.email.toLowerCase() === username.toLowerCase()
            );
            if (found) {
                if (found.password !== password) {
                    set({ error: 'Contraseña incorrecta' });
                    return false;
                }
                const token = `local_${found.user.id}`;
                localStorage.setItem(SESSION_KEY, token);
                localStorage.setItem(LOCAL_USER_KEY, JSON.stringify(found.user));
                set({
                    currentUser: found.user,
                    isAuthenticated: true,
                    token,
                    error: null,
                });
                return true;
            }
            // If no local account exists yet for this username, create a local session seamlessly
            const user = createLocalUser(username, username.includes('@') ? username : `${username}@dupliot.com`);
            const token = `local_${user.id}`;
            users.push({ user, password });
            saveLocalUsers(users);
            localStorage.setItem(SESSION_KEY, token);
            localStorage.setItem(LOCAL_USER_KEY, JSON.stringify(user));
            set({
                currentUser: user,
                isAuthenticated: true,
                token,
                error: null,
            });
            return true;
        }
    },

    logout: () => {
        localStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(LOCAL_USER_KEY);
        set({ currentUser: null, isAuthenticated: false, token: null, error: null });
    },

    clearError: () => set({ error: null }),

    loadSession: async () => {
        set({ isInitializing: true });
        const token = localStorage.getItem(SESSION_KEY);
        if (token) {
            if (token.startsWith('local_')) {
                try {
                    const rawUser = localStorage.getItem(LOCAL_USER_KEY);
                    if (rawUser) {
                        set({
                            currentUser: JSON.parse(rawUser) as User,
                            isAuthenticated: true,
                            token,
                            isInitializing: false,
                        });
                        return;
                    }
                } catch {
                    // ignore and clear below
                }
            }
            try {
                const res = await fetch(`${API_BASE}/auth/profile`, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                if (res.ok) {
                    const data = await res.json();
                    set({
                        currentUser: data,
                        isAuthenticated: true,
                        token,
                        isInitializing: false,
                    });
                    return;
                }
            } catch {
                // Silently fail and fallback to clearing session
            }
            localStorage.removeItem(SESSION_KEY);
            localStorage.removeItem(LOCAL_USER_KEY);
        }
        set({ isInitializing: false, token: null });
    },

    getProfile: async () => {
        const { token } = get();
        if (!token) return;
        try {
            const res = await fetch(`${API_BASE}/auth/profile`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (res.ok) {
                const data = await res.json();
                set({ currentUser: data });
            }
        } catch {
            // Silently fail - profile will remain as-is
        }
    },

    updateProfile: async (data) => {
        const { token } = get();
        if (!token) return false;
        try {
            const res = await fetch(`${API_BASE}/auth/profile`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify(data),
            });
            if (res.ok) {
                const updated = await res.json();
                set({ currentUser: updated });
                return true;
            }
            const errorData = await res.json();
            set({ error: errorData.detail || 'Update failed' });
            return false;
        } catch {
            set({ error: 'Unable to connect to server' });
            return false;
        }
    },

    requestPasswordReset: async (email) => {
        set({ error: null });
        try {
            const res = await fetch(`${API_BASE}/auth/password-reset`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email }),
            });
            if (res.ok) {
                return true;
            }
            const data = await res.json();
            set({ error: data.detail || 'Request failed' });
            return false;
        } catch {
            set({ error: 'Unable to connect to server' });
            return false;
        }
    },

    resetPassword: async (token, newPassword) => {
        set({ error: null });
        try {
            const res = await fetch(`${API_BASE}/auth/password-reset/confirm`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, new_password: newPassword }),
            });
            if (res.ok) {
                return true;
            }
            const data = await res.json();
            set({ error: data.detail || 'Reset failed' });
            return false;
        } catch {
            set({ error: 'Unable to connect to server' });
            return false;
        }
    },

    changePassword: async (currentPassword, newPassword) => {
        const { token } = get();
        if (!token) return false;
        set({ error: null });
        try {
            const res = await fetch(`${API_BASE}/auth/change-password`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
            });
            if (res.ok) {
                return true;
            }
            const data = await res.json();
            set({ error: data.detail || 'Password change failed' });
            return false;
        } catch {
            set({ error: 'Unable to connect to server' });
            return false;
        }
    },
}));
