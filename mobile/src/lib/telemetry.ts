import { useEffect } from 'react';
import { API_BASE } from './env';
import { useAppStore } from '../store/appStore';
import type { TelemetryFrame } from '../types';

const POST_INTERVAL_MS = 500;
const HEALTH_TIMEOUT_MS = 2500;

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Optional bridge to the standalone Node server.
 *
 * Everything the app does works without it; this only mirrors what the phone is
 * seeing so a laptop can display the same detections (see
 * `server/index.mjs` → `GET /api/detections/stream`).
 */
export function useTelemetry() {
    const enabled = useAppStore((state) => state.telemetryEnabled);

    useEffect(() => {
        if (!enabled) {
            useAppStore.setState({ telemetryStatus: 'off' });
            return;
        }

        let cancelled = false;
        let lastSentAt = 0;

        const checkHealth = async () => {
            useAppStore.setState({ telemetryStatus: 'connecting' });
            try {
                const response = await fetchWithTimeout(`${API_BASE}/health`);
                if (cancelled) return;
                useAppStore.setState({ telemetryStatus: response.ok ? 'online' : 'error' });
            } catch {
                if (!cancelled) useAppStore.setState({ telemetryStatus: 'offline' });
            }
        };

        const flush = async () => {
            const state = useAppStore.getState();
            if (state.telemetryStatus === 'off' || state.telemetryStatus === 'error') return;
            // Nothing worth sending yet.
            if (state.detections.length === 0 && state.metrics.inferenceMs === 0) return;

            const frame: TelemetryFrame = {
                ts: Date.now(),
                fps: state.metrics.fps,
                inferenceMs: state.metrics.inferenceMs,
                provider: state.provider,
                model: state.modelName,
                detections: state.detections.map((detection) => ({
                    label: detection.label,
                    score: Math.round(detection.score * 1000) / 1000,
                    bbox: detection.bbox.map((value) => Math.round(value)) as [number, number, number, number],
                    keypoints: detection.keypoints?.map((keypoint) => ({
                        x: Math.round(keypoint.x),
                        y: Math.round(keypoint.y),
                        score: Math.round(keypoint.score * 100) / 100,
                    })),
                })),
            };

            try {
                const response = await fetchWithTimeout(`${API_BASE}/detections`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(frame),
                });
                if (cancelled) return;
                if (response.ok && useAppStore.getState().telemetryStatus !== 'online') {
                    useAppStore.setState({ telemetryStatus: 'online' });
                }
            } catch {
                if (!cancelled) useAppStore.setState({ telemetryStatus: 'offline' });
            }
        };

        void checkHealth();
        const interval = setInterval(() => {
            const now = Date.now();
            if (now - lastSentAt < POST_INTERVAL_MS) return;
            lastSentAt = now;
            void flush();
        }, POST_INTERVAL_MS);

        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [enabled]);
}
