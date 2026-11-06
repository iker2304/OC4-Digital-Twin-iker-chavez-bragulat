#!/usr/bin/env node
/**
 * Copies the onnxruntime-web WASM/mjs runtime from node_modules into
 * `mobile/public/ort/` so inference works completely offline (and without
 * depending on a CDN being reachable from the phone).
 *
 * `src/lib/inference/ortAssets.ts` probes `/ort/` at runtime and only falls
 * back to the CDN when this script has not been run.
 */
import { mkdir, readdir, copyFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(here, '..');
const distDir = path.join(mobileRoot, 'node_modules', 'onnxruntime-web', 'dist');
const outDir = path.join(mobileRoot, 'public', 'ort');

/**
 * Only the two variants we can actually ask for: the plain threaded build and
 * the JSEP (WebGPU) one. `asyncify` and `jspi` add ~43 MB of dead weight.
 */
const WANTED = /^ort-wasm-simd-threaded(\.jsep)?\.(wasm|mjs)$/;

/**
 * The ORT API itself (not just the wasm glue), needed by the thread benchmark:
 * `numThreads` is read when the WASM module is instantiated, so comparing 1/2/4/8
 * threads requires *separate module instances*, which means loading a second copy
 * of the API from our own origin by URL. ~580 kB, worth it.
 */
const EXTRA_API = 'ort.wasm.min.mjs';

async function isUpToDate(source, destination) {
    try {
        const [a, b] = await Promise.all([stat(source), stat(destination)]);
        return b.size === a.size && b.mtimeMs >= a.mtimeMs;
    } catch {
        return false;
    }
}

async function main() {
    if (!existsSync(distDir)) {
        console.warn('[sync-ort] onnxruntime-web is not installed yet — run `npm install` first.');
        return;
    }
    await mkdir(outDir, { recursive: true });

    let copied = 0;
    let skipped = 0;
    const entries = [...(await readdir(distDir)).filter((entry) => WANTED.test(entry)), EXTRA_API];
    for (const entry of entries) {
        const source = path.join(distDir, entry);
        const destination = path.join(outDir, entry);
        if (await isUpToDate(source, destination)) {
            skipped += 1;
            continue;
        }
        await copyFile(source, destination);
        copied += 1;
        console.log(`[sync-ort] ${entry}`);
    }

    if (copied === 0) {
        console.log(`[sync-ort] up to date (${skipped} runtime file(s)) — inference works offline.`);
    }
}

main().catch((err) => {
    console.error('[sync-ort] failed:', err);
    process.exitCode = 1;
});
