#!/usr/bin/env node
/**
 * Cross-platform launcher for the two "special" dev modes.
 *
 * `HTTPS=1 npm run dev` only works in bash-like shells; PowerShell/cmd need a
 * different syntax and getting it wrong silently starts a plain HTTP server,
 * which then means "the camera does not work" with no obvious cause.
 *
 *   npm run dev:https    → dev server over HTTPS with a self-signed cert
 *                          (valid for localhost only)
 *   npm run dev:tunnel   → dev server ready to be published by the tunnel
 *                          (HMR over wss:443, any Host accepted)
 *
 * The second one is only needed if you want to expose the **dev server**
 * (port 5273). The recommended tunnel setup publishes the built app served by
 * `server/index.mjs` (`npm start`, port 8787), which needs none of this.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(here, '..');
const viteBin = path.join(mobileRoot, 'node_modules', 'vite', 'bin', 'vite.js');

const flags = process.argv.slice(2);
const passThrough = flags.filter((flag) => !flag.startsWith('--https') && !flag.startsWith('--tunnel'));

const env = { ...process.env };
if (flags.includes('--https')) env.HTTPS = '1';
if (flags.includes('--tunnel')) env.TUNNEL = '1';

if (!env.HTTPS && !env.TUNNEL) {
    console.warn(
        '[dev-variant] sin --https ni --tunnel: esto es un `npm run dev` normal. ' +
        'Usa `npm run dev:https` o `npm run dev:tunnel`.'
    );
}

const child = spawn(process.execPath, [viteBin, '--host', ...passThrough], {
    cwd: mobileRoot,
    stdio: 'inherit',
    env,
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
}

child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
});
