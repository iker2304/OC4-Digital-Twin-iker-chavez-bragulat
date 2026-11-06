import { networkInterfaces } from 'node:os';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

/**
 * Version of the installed onnxruntime-web.
 *
 * The JS glue and the WASM binary must come from the *same* release: a mismatch
 * makes `initWasm()` fail with "no available backend found", which is a very
 * confusing symptom. Hardcoding it here (or in `env.ts`) is exactly how that
 * bug happens, so it is read from node_modules and injected at build time.
 */
function ortVersion(): string {
  try {
    const pkg = path.resolve('node_modules', 'onnxruntime-web', 'package.json');
    return JSON.parse(readFileSync(pkg, 'utf8')).version ?? 'latest';
  } catch {
    return 'latest';
  }
}

/** IPv4 addresses of this machine, so the terminal can print the LAN URL. */
function lanAddresses(): string[] {
  const found: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) found.push(iface.address);
    }
  }
  return found;
}

/**
 * Cross-origin isolation unlocks multi-threaded WASM inside onnxruntime-web,
 * which is roughly 2-3x faster than the single-threaded fallback.
 *
 * `credentialless` (instead of `require-corp`) keeps third-party fetches — the
 * ORT CDN fallback — working without requiring CORP headers on every asset.
 */
const crossOriginIsolation: Plugin = {
  name: 'oc4-cross-origin-isolation',
  configureServer(server) {
    server.middlewares.use((_request, response, next) => {
      response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      // `require-corp` (not `credentialless`): Safari only understands this one,
      // and cross-origin isolation is what enables multi-threaded WASM on iOS.
      response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      next();
    });
  },
  configurePreviewServer(server) {
    server.middlewares.use((_request, response, next) => {
      response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      // `require-corp` (not `credentialless`): Safari only understands this one,
      // and cross-origin isolation is what enables multi-threaded WASM on iOS.
      response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      next();
    });
  },
};

/**
 * Replaces Vite's URL list with something actionable.
 *
 * The single most common support question is "the camera does not work on my
 * phone", and the cause is almost always the origin being neither HTTPS nor
 * localhost — which is invisible unless you know the rule.
 */
function devBanner(options: { https: boolean; port: number; lan: string[] }): Plugin {
  return {
    name: 'oc4-dev-banner',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        const scheme = options.https ? 'https' : 'http';
        const lines = [
          '',
          '  OC4 mobile · cliente standalone',
          `   este equipo : ${scheme}://localhost:${options.port}`,
        ];
        for (const ip of options.lan) {
          lines.push(`   LAN         : ${scheme}://${ip}:${options.port}`);
        }
        if (!options.https) {
          lines.push(
            '',
            '  Con http://<IP-de-LAN> la camara NO funcionara: el navegador',
            '  solo concede getUserMedia en https:// o en http://localhost.',
            '    · Tunel HTTPS con dominio real   -> recomendado en movil',
            '    · npm run dev:https              -> https://localhost (este equipo)',
            '    · Android: chrome://flags/#unsafely-treat-insecure-origin-as-secure'
          );
        } else {
          lines.push(
            '',
            '  Aviso: el certificado autofirmado solo es valido para localhost.',
            '  Para el movil usa un tunel HTTPS con dominio real (README).'
          );
        }
        lines.push('');
        console.log(lines.join('\n'));
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Empty prefix: plain (non-VITE_) variables in .env / .env.local are read too,
  // so `HTTPS=1` can live in a file instead of depending on the shell syntax.
  const fileEnv = loadEnv(mode, process.cwd(), '');
  const env: Record<string, string | undefined> = { ...fileEnv, ...process.env };

  const API_TARGET = env.API_URL ?? 'http://127.0.0.1:8787';
  const WEB_PORT = Number(env.WEB_PORT ?? 5273);
  const USE_HTTPS = String(env.HTTPS ?? '0') === '1';
  /**
   * Deployment base. `/` in development; the production image is served from a
   * subpath (`/oc4-dt-mobile/`), and every asset URL Vite emits has to carry it.
   * Must end with a slash, or relative resolution breaks.
   */
  const BASE_PATH = (() => {
    const raw = (env.PUBLIC_BASE ?? '/').trim();
    if (raw === '' || raw === '/') return '/';
    return `/${raw.replace(/^\/+|\/+$/g, '')}/`;
  })();
  /** Dev server published by the tunnel: HMR must dial the public 443 over wss. */
  const TUNNEL_MODE = String(env.TUNNEL ?? '0') === '1';
  const HMR_CLIENT_PORT = env.HMR_CLIENT_PORT
    ? Number(env.HMR_CLIENT_PORT)
    : TUNNEL_MODE
      ? 443
      : undefined;
  const lan = lanAddresses();

  // Extra hostnames that must be accepted (tunnel domain, reverse proxy...).
  const extraHosts = (env.DEV_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);

  return {
    base: BASE_PATH,
    define: {
      // Consumed by src/lib/env.ts for the CDN fallback path.
      __OC4_ORT_VERSION__: JSON.stringify(ortVersion()),
    },
    /**
     * onnxruntime-web must NOT be pre-bundled: its internal
     * `new URL('....wasm', import.meta.url)` does not survive the optimizer, and
     * the resulting bogus request gets answered by the SPA fallback with HTML —
     * which fails as "expected magic word 00 61 73 6d, found 3c 21 64 6f".
     */
    optimizeDeps: {
      exclude: ['onnxruntime-web'],
    },
    plugins: [
      react(),
      ...(USE_HTTPS ? [basicSsl() as Plugin] : []),
      crossOriginIsolation,
      devBanner({ https: USE_HTTPS, port: WEB_PORT, lan }),
    ],
    server: {
      // `host: true` binds 0.0.0.0. Without it, Vite can stay on [::1] on Windows
      // and phones on the LAN get "connection refused".
      host: true,
      port: WEB_PORT,
      strictPort: true,
      /**
       * Vite rejects unknown `Host` headers with 403 "This host is not allowed".
       * That silently breaks every tunnel / reverse proxy, so by default every
       * host is accepted: this is a dev-only client whose whole purpose is to be
       * reached from other devices. Restrict it with DEV_ALLOWED_HOSTS if the
       * machine is on an untrusted network.
       */
      allowedHosts: extraHosts.length > 0 ? ['localhost', ...lan, ...extraHosts] : true,
      hmr: HMR_CLIENT_PORT
        ? { clientPort: HMR_CLIENT_PORT, protocol: TUNNEL_MODE ? 'wss' : undefined }
        : undefined,
      /**
       * The heavy static assets (multi-GB model dirs, a 28 MB .wasm) must stay
       * out of the watcher: on Windows, chokidar hits EBUSY when one of them is
       * rewritten while the dev server is running, and the whole server dies.
       * They are served fine — they are just never watched for changes.
       */
      watch: {
        ignored: [
          '**/node_modules/**',
          '**/.git/**',
          '**/dist/**',
          '**/public/ort/**',
          '**/public/models/**',
        ],
      },
      proxy: {
        // Optional telemetry backend. The client is fully functional offline:
        // if this proxy is unreachable the app only reports "telemetría no disponible".
        '/api': {
          target: API_TARGET,
          // Keep the real Host and add X-Forwarded-* so the app behind a tunnel
          // can build correct absolute URLs.
          changeOrigin: false,
          xfwd: true,
        },
      },
    },
    build: {
      target: 'es2022',
      chunkSizeWarningLimit: 1500,
      rollupOptions: {
        output: {
          manualChunks: {
            'react-vendor': ['react', 'react-dom'],
            'three-vendor': ['three', '@react-three/fiber', '@react-three/drei'],
            'ort-vendor': ['onnxruntime-web'],
          },
        },
      },
    },
  };
});
