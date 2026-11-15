const rawApiUrl = import.meta.env.VITE_API_URL as string | undefined;
export const API_BASE_URL = (rawApiUrl || 'http://localhost:8080').replace(/\/+$/, '');

const rawWsUrl = import.meta.env.VITE_WS_URL as string | undefined;
export const WS_BASE_URL = (
  rawWsUrl ||
  API_BASE_URL.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://')
).replace(/\/+$/, '');
