import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { BenchPage } from './bench/BenchPage';
import { PublicBenchPage } from './bench/PublicBenchPage';
import { ModelInfoPage } from './modelinfo/ModelInfoPage';
import { useAppStore } from './store/appStore';
import './index.css';

// Dev-only handle on the store, so the pose pipeline can be driven by hand from
// the console (inject a pose, check where the twin lands) without needing a
// camera pointed at the real platform. `?debug=1` enables it on a built bundle
// too, which is the only way to inspect the state on the phone that is failing.
if (import.meta.env.DEV || new URLSearchParams(window.location.search).has('debug')) {
    (window as Window & { __oc4?: typeof useAppStore }).__oc4 = useAppStore;
}

/**
 * The benchmark lives at `/bench` (and `?bench=1`), not on a separate build: it
 * has to run the very same engine, model and pose solve the app uses, or it
 * would be measuring something else.
 */
const bench =
    new URLSearchParams(window.location.search).has('bench') ||
    /\/bench\/?$/.test(window.location.pathname);

/**
 * The public wizard lives at `/benchmark-public/` (and `?public=1`).
 *
 * Separate from `/bench` because the audience is different: this one is opened by
 * a stranger from a QR code and must not assume they know which device or model
 * they want.
 */
const publicBench =
    new URLSearchParams(window.location.search).has('public') ||
    /\/benchmark-public\/?$/.test(window.location.pathname);

// The bench is the one screen that scrolls with the document instead of inside a
// panel (see `index.css`).
if (bench || publicBench) document.documentElement.classList.add('oc4-scroll');

/**
 * Resumen por clase de cada modelo entrenado, en `/model-info/` (y `?modelinfo=1`).
 *
 * Existe porque la mAP global ocultaba que el rotor estaba en 0,00: aquí se ven
 * turbina y rotor separados y la evolución época a época.
 */
const modelInfo =
    new URLSearchParams(window.location.search).has('modelinfo') ||
    /\/model-info\/?$/.test(window.location.pathname);

if (modelInfo) document.documentElement.classList.add('oc4-scroll');

const container = document.getElementById('root');
if (!container) throw new Error('Falta el elemento #root en index.html');

createRoot(container).render(
    <StrictMode>
        {modelInfo ? (
            <ModelInfoPage />
        ) : publicBench ? (
            <PublicBenchPage />
        ) : bench ? (
            <BenchPage />
        ) : (
            <App />
        )}
    </StrictMode>
);
