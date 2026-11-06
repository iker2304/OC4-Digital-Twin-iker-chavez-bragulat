#!/usr/bin/env node
/**
 * Copies the heavy binary assets that this standalone client needs from the
 * main repository into `mobile/public/`, so they are never duplicated in git.
 *
 *   - 3D models  : ../web/public/models/*.{glb,fbx}
 *   - ONNX models: ../web/public/models/*.onnx  (and ./models/ if present)
 *
 * Safe to run repeatedly: files are skipped when the destination is already
 * newer than the source.
 */
import { mkdir, readdir, stat, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(here, '..');
const publicModels = path.join(mobileRoot, 'public', 'models');

const SOURCES = [
    path.resolve(mobileRoot, '..', 'web', 'public', 'models'),
    path.join(mobileRoot, 'models'),
    // Repo root: where a freshly exported `best.onnx` usually lands.
    path.resolve(mobileRoot, '..'),
];
const EXTENSIONS = new Set(['.glb', '.gltf', '.fbx', '.onnx']);

async function isUpToDate(src, dest) {
    try {
        const [a, b] = await Promise.all([stat(src), stat(dest)]);
        return b.mtimeMs >= a.mtimeMs && b.size === a.size;
    } catch {
        return false;
    }
}

async function main() {
    await mkdir(publicModels, { recursive: true });
    let copied = 0;
    let skipped = 0;

    for (const dir of SOURCES) {
        if (!existsSync(dir)) continue;
        for (const entry of await readdir(dir)) {
            if (!EXTENSIONS.has(path.extname(entry).toLowerCase())) continue;
            const src = path.join(dir, entry);
            const dest = path.join(publicModels, entry);
            if (await isUpToDate(src, dest)) {
                skipped += 1;
                continue;
            }
            await copyFile(src, dest);
            copied += 1;
            console.log(`[sync-models] ${entry} -> public/models/${entry}`);
        }
    }

    if (copied === 0) {
        console.log(
            `[sync-models] up to date (${skipped} asset(s)). ` +
            'The 3D scene falls back to a procedural platform when no .glb is available.'
        );
    }
}

main().catch((err) => {
    console.error('[sync-models] failed:', err);
    process.exitCode = 1;
});
