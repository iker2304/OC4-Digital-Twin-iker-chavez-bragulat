#!/usr/bin/env node
/**
 * OC4 Digital Twin — standalone mobile server.
 *
 * Deliberately tiny. The mobile client runs ALL inference on the device, so
 * this server has exactly two jobs:
 *
 *   1. Serve the built SPA (`dist/`) so a phone can open the app from the LAN.
 *   2. Optionally relay detections to other devices (SSE), e.g. to mirror what
 *      the phone sees on a laptop.
 *
 * If this process is not running, the mobile app still works: it only reports
 * "telemetry offline".
 *
 * Usage:
 *   node server/index.mjs                 # API only (use `npm run dev` for the SPA)
 *   node server/index.mjs --serve-dist    # API + built SPA (production-ish)
 *   PORT=8787 node server/index.mjs
 */
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import {
    appendFileSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const distDir = path.join(root, 'dist');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
    const withEquals = argv.find((a) => a.startsWith(`--${name}=`));
    if (withEquals) return withEquals.split('=').slice(1).join('=');
    const idx = argv.indexOf(`--${name}`);
    if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) return argv[idx + 1];
    return fallback;
};

const PORT = Number(value('port', process.env.PORT ?? 8787));
const HOST = value('host', process.env.HOST ?? '0.0.0.0');
const SERVE_DIST = flag('serve-dist') || process.env.SERVE_DIST === '1';
const MAX_HISTORY = 120;

/**
 * Where benchmark runs are kept.
 *
 * A JSON-lines file rather than a database: one append per run, no dependency,
 * and `grep`-able from the VPS. `DATA_DIR` points at a Docker volume in
 * production, because the container is recreated on every deploy and anything
 * written outside the volume dies with it.
 */
const DATA_DIR = value('data-dir', process.env.DATA_DIR ?? path.join(root, 'data'));
const BENCH_FILE = path.join(DATA_DIR, 'bench.jsonl');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.jsonl');

const app = express();

/**
 * Behind the tunnel, the request arrives from Caddy/frps. Trusting the proxy
 * makes `req.protocol` report `https` and `req.hostname` report the tunnel
 * domain, so nothing here ever has to build an absolute `http://localhost:...`
 * URL (which is what breaks pages served over https).
 */
app.set('trust proxy', true);

/**
 * Compresses the small stuff: HTML, JS and the JSON API. The 28 MB `.wasm` is
 * compressible in principle but `mime-db` marks `application/wasm` as
 * non-compressible, so the default filter skips it; that is why the tunnel mode
 * serves the runtime from a CDN instead (see `VITE_ORT_ASSET_BASE=cdn`).
 * A `.onnx` is dense float weights: compressing it costs CPU and saves almost
 * nothing, so it is excluded explicitly.
 */
app.use(
    compression({
        threshold: 1024,
        filter: (req, res) => {
            if (/\.onnx(\?|$)/.test(req.url)) return false;
            return compression.filter(req, res);
        },
    })
);

// The phone may upload detections as JSON; keep the body cap small and honest.
app.use(express.json({ limit: '256kb' }));

/**
 * Cross-origin isolation. Must match the dev server so behaviour is identical:
 * onnxruntime-web enables multi-threaded WASM only when `crossOriginIsolated`
 * is true. `credentialless` keeps third-party fetches (CDN) working.
 */
app.use((_req, res, next) => {
    // `require-corp` rather than `credentialless`: it is the value Safari has
    // understood since 15.2, and cross-origin isolation is what unlocks
    // multi-threaded WASM (SharedArrayBuffer) on iOS. Every asset this app loads
    // is same-origin, so the stricter policy costs nothing.
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
});

/* ------------------------------------------------------------------ state */

const startedAt = Date.now();
/** @type {Array<Record<string, unknown>>} */
const history = [];
/** @type {Set<import('express').Response>} */
const sseClients = new Set();

function pushDetection(payload) {
    const record = { receivedAt: new Date().toISOString(), ...payload };
    history.push(record);
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

    const frame = `event: detection\ndata: ${JSON.stringify(record)}\n\n`;
    for (const client of sseClients) client.write(frame);
    return record;
}

/* -------------------------------------------------------------------- api */

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        service: 'oc4-mobile-standalone',
        version: '0.1.0',
        uptimeMs: Date.now() - startedAt,
        sseClients: sseClients.size,
        servesDist: SERVE_DIST && existsSync(distDir),
        // Let the client show whether multi-threaded WASM will be available here.
        crossOriginIsolated: true,
        /**
         * Echoes what the server actually received. Open this endpoint from the
         * phone (https://<slug>/api/health): if `host` is the tunnel domain and
         * `forwardedProto` is `https`, the whole chain works end to end.
         */
        request: {
            host: req.get('host') ?? null,
            protocol: req.protocol,
            forwardedProto: req.get('x-forwarded-proto') ?? null,
            forwardedHost: req.get('x-forwarded-host') ?? null,
            forwardedFor: req.get('x-forwarded-for') ?? null,
        },
    });
});

/**
 * Runtime configuration. Lets you point a fleet of phones at a model or a twin
 * asset without rebuilding the bundle.
 */
app.get('/api/config', (_req, res) => {
    res.json({
        twinModelUrl: process.env.TWIN_MODEL_URL ?? '/models/OC4.glb',
        inference: {
            // Defaults applied by the client when the user has not chosen a model.
            modelUrl: process.env.ONNX_MODEL_URL ?? null,
            inputSize: Number(process.env.ONNX_INPUT_SIZE ?? 640),
            confidence: Number(process.env.ONNX_CONFIDENCE ?? 0.35),
            iou: Number(process.env.ONNX_IOU ?? 0.45),
        },
        telemetry: { enabled: true, postIntervalMs: 500 },
    });
});

app.post('/api/detections', (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object') {
        res.status(400).json({ error: 'Expected a JSON object body' });
        return;
    }
    const record = pushDetection(body);
    res.status(202).json({ ok: true, receivedAt: record.receivedAt });
});

app.get('/api/detections/latest', (_req, res) => {
    res.json({ latest: history.at(-1) ?? null, count: history.length });
});

/** Server-Sent Events: easiest reliable push channel for a browser consumer. */
app.get('/api/detections/stream', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    if (history.length > 0) {
        res.write(`event: history\ndata: ${JSON.stringify(history.slice(-20))}\n\n`);
    }
    sseClients.add(res);

    // Keep-alive comments stop proxies from closing an idle stream.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
    const cleanup = () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
});

/* ------------------------------------------------------------------ bench */

/**
 * A device is now something the tester names, not three hardcoded options.
 *
 * The old model (`device` ∈ torre|laptop|movil) mixed two ideas: *what kind of
 * machine* it is and *which machine*. Two laptops were the same column in the
 * comparison. Runs now point at a profile id, and the profile carries the
 * nickname, the category and whatever the browser would confess about the
 * hardware.
 */
const CATEGORIES = new Set(['sobremesa', 'portatil', 'movil']);
const LEGACY_NAMES = { torre: 'Torre', laptop: 'Portátil', movil: 'Móvil' };
/** Old runs only stored `device: 'torre' | 'laptop' | 'movil'`; map them to a category. */
const LEGACY_CATEGORY = { torre: 'sobremesa', laptop: 'portatil', movil: 'movil' };
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

const METRIC_KEYS = [
    'captureMs',
    'preprocessMs',
    'inferenceMs',
    'postprocessMs',
    'poseMs',
    'readyMs',
    'paintMs',
    /** Confianza media de las detecciones del frame (0..1). */
    'score',
];

const round1 = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : 0);

/** Whole file, tolerant to a truncated last line (a deploy mid-write). */
function readBench() {
    if (!existsSync(BENCH_FILE)) return [];
    const records = [];
    for (const line of readFileSync(BENCH_FILE, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            records.push(JSON.parse(trimmed));
        } catch {
            // One corrupt line is not worth losing the whole history over.
        }
    }
    return records;
}

/** Appends one run; creates the directory on first use. */
function appendBench(record) {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(BENCH_FILE, `${JSON.stringify(record)}\n`);
}

/** Device profiles, last write wins per id (append-only keeps this crash-safe). */
function readDeviceProfiles() {
    const profiles = new Map();
    if (!existsSync(DEVICES_FILE)) return profiles;
    for (const line of readFileSync(DEVICES_FILE, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const profile = JSON.parse(trimmed);
            if (profile?.id) profiles.set(profile.id, profile);
        } catch {
            // Same tolerance as the runs file.
        }
    }
    return profiles;
}

function appendDeviceProfile(profile) {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(DEVICES_FILE, `${JSON.stringify(profile)}\n`);
}

/**
 * Rewrites a JSON-lines file in one go.
 *
 * Write to a temporary file and rename: a crash midway leaves the old file
 * untouched. Before that, the previous contents are copied aside — the delete
 * endpoint is the only destructive path in this server and it has already been
 * pointed at the wrong id once.
 */
function writeJsonLines(file, rows) {
    mkdirSync(DATA_DIR, { recursive: true });
    try {
        if (existsSync(file) && statSync(file).size > 0) {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            copyFileSync(file, `${file}.${stamp}.bak`);
            // Keep the five most recent backups, no more.
            const prefix = `${path.basename(file)}.`;
            const backups = readdirSync(DATA_DIR)
                .filter((name) => name.startsWith(prefix) && name.endsWith('.bak'))
                .sort();
            for (const stale of backups.slice(0, Math.max(0, backups.length - 5))) {
                try {
                    unlinkSync(path.join(DATA_DIR, stale));
                } catch {
                    // A leftover backup is not a problem.
                }
            }
        }
    } catch {
        // A failed backup must not stop the operation the user asked for.
    }
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
    renameSync(temporary, file);
}

/**
 * Where the `.onnx` files live in this deployment.
 *
 * `dist/models` when the built SPA is being served, `public/models` otherwise:
 * both are the same files, and the fingerprint has to be computed from whichever
 * is actually on disk.
 */
function modelsDirectory() {
    return [path.join(distDir, 'models'), path.join(root, 'public', 'models')].find((candidate) =>
        existsSync(candidate)
    );
}

/**
 * Old file name → current one.
 *
 * Verified by checksum that the bytes are identical: the rename did not touch the
 * weights. Without this the 123 runs taken before the rename would stay in their
 * own bucket instead of joining the model they actually used.
 */
const LEGACY_ALIAS = new Map([
    ['best.int8.onnx', 'yolo-pose-s-640-int8.onnx'],
    ['best.onnx', 'yolo-pose-s-640.onnx'],
]);

let fingerprintCache = { at: 0, map: new Map() };

/**
 * Fingerprint of every model on disk, computed exactly like the browser does
 * (`engine.ts`): first and last 192 KB plus the size, SHA-256, first 12 hex.
 *
 * Identical on purpose — the id the page filters by has to be the id the server
 * derives from the bytes, or a run would land in a bucket nobody looks at.
 */
function fingerprints() {
    if (Date.now() - fingerprintCache.at < 5 * 60_000) return fingerprintCache.map;
    const map = new Map();
    const directory = modelsDirectory();
    if (directory) {
        for (const file of readdirSync(directory)) {
            if (!file.toLowerCase().endsWith('.onnx')) continue;
            try {
                const bytes = readFileSync(path.join(directory, file));
                const window = 192 * 1024;
                const head = bytes.subarray(0, Math.min(window, bytes.length));
                const tail = bytes.subarray(Math.max(0, bytes.length - window));
                const digest = createHash('sha256')
                    .update(head)
                    .update(tail)
                    .update(Buffer.from(String(bytes.length), 'utf8'))
                    .digest('hex');
                map.set(file, digest.slice(0, 12));
            } catch {
                // A file we cannot read simply has no fingerprint.
            }
        }
    }
    fingerprintCache = { at: Date.now(), map };
    return map;
}

/**
 * Which model a run belongs to.
 *
 * The same device gets faster or slower depending on the `.onnx` it is running,
 * so a benchmark row is really (device, model). Runs taken before the model id
 * existed only stored a file name; they are **migrated on read**: the old name is
 * mapped to the current one, whose fingerprint comes from the actual bytes. That
 * way the history joins the model it was produced with, without rewriting a
 * single line of the runs file.
 */
function modelOf(run) {
    /**
     * El modelo es **el fichero**, no la huella que tenía ese día.
     *
     * `modelId` se guarda con la firma de los bytes, así que reexportar o volver a
     * cuantizar el mismo `.onnx` le cambiaba el id y todas las ejecuciones
     * anteriores se quedaban en una columna aparte con el mismo nombre: el eje de
     * modelos salía duplicado y, si esas columnas viejas no se listaban, la línea
     * del equipo se cortaba sin motivo (parecía que faltaban medidas).
     *
     * Mientras el fichero siga en `models/`, manda su huella actual, así que todo
     * su histórico vuelve a ser un solo modelo. La huella guardada solo se usa ya
     * para lo que nunca estuvo aquí: ficheros borrados y ejecuciones antiguas.
     */
    const raw = run.model ?? run.modelName ?? 'desconocido';
    const file = LEGACY_ALIAS.get(raw) ?? raw;
    const fingerprint = fingerprints().get(file);
    if (fingerprint) {
        const base = slugify(file.replace(/\.onnx$/i, ''));
        return { modelId: `${base}-${fingerprint}`, name: file, legacy: !run.modelId };
    }
    if (run.modelId) {
        return {
            modelId: run.modelId,
            name: run.modelName ?? run.model ?? run.modelId,
            legacy: false,
        };
    }
    return { modelId: `legacy-${slugify(raw)}`, name: raw, legacy: true };
}

function slugify(value) {
    return String(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
}

/**
 * Sums one run into an accumulator: timings, confianza y calidad de pose.
 *
 * All the aggregations (device list, comparison, matrix) go through this so the
 * same run can never produce two different averages depending on which endpoint
 * you look at.
 */
function accumulate(target, samples) {
    target.runs += 1;
    target.samples += samples.length;
    for (const sample of samples) {
        for (const key of METRIC_KEYS) target[key] = (target[key] ?? 0) + (Number(sample[key]) || 0);
        /**
         * Only samples that *carry* a confidence count towards the average.
         *
         * Runs stored before this metric existed have no `score` key at all, and
         * averaging them as 0 % would draw a fake "this model is unsure" point for
         * every old run. A real sample with no detections does store 0, so the
         * distinction is presence of the field, not its value.
         */
        if (sample.score !== undefined && sample.score !== null) target.scored += 1;
        if (sample.solved) {
            target.solved += 1;
            if (Number.isFinite(Number(sample.rmsPx)) && Number(sample.rmsPx) > 0) {
                target.rmsPx += Number(sample.rmsPx);
                target.rmsCount += 1;
            }
        }
    }
}

/** Fresh accumulator for `accumulate`. */
function emptyTotals() {
    return {
        runs: 0,
        samples: 0,
        solved: 0,
        scored: 0,
        rmsPx: 0,
        rmsCount: 0,
        ...Object.fromEntries(METRIC_KEYS.map((key) => [key, 0])),
    };
}

/** The four quality numbers the plot puts on its Y axis. */
function qualityOf(totals) {
    const samples = Math.max(1, totals.samples);
    return {
        averageScore: totals.scored > 0 ? round1(totals.score / totals.scored) : null,
        averageRmsPx: totals.rmsCount > 0 ? round1(totals.rmsPx / totals.rmsCount) : null,
        solvedRate: totals.samples > 0 ? round1((totals.solved / samples) * 100) : null,
    };
}

/**
 * Public vs private.
 *
 * The public wizard exists so strangers can benchmark their own devices from a QR
 * code; those runs are marked `isPublic` when they arrive. Everything else — the
 * internal bench, the history from before this existed — is private. Keeping the
 * flag on the record (instead of inferring it from a profile field) means a run
 * answers for itself even after its profile is edited.
 */
let publicDevicesCache = { at: 0, ids: new Set() };

/**
 * Devices created by the public wizard.
 *
 * Cached for a minute because `scopeOf` runs once per stored run and reading the
 * profiles file each time would make the listing quadratic.
 */
function publicDeviceIds() {
    if (Date.now() - publicDevicesCache.at < 60_000) return publicDevicesCache.ids;
    const ids = new Set();
    for (const [id, profile] of readDeviceProfiles()) {
        if (profile?.isPublic || profile?.owner || profile?.calibration) ids.add(id);
    }
    publicDevicesCache = { at: Date.now(), ids };
    return ids;
}

function scopeOf(record) {
    // The flag on the record wins: it is what the posting client declared.
    if (record?.isPublic === true) return 'public';
    if (record?.isPublic === false) return 'private';
    /**
     * Runs stored before the flag existed belong to whoever owns the device.
     * A profile with an owner (or a calibration) came from the public wizard, so
     * its history is public — otherwise the first public campaign would be filed
     * as private just because it landed before this column did.
     */
    // `id` covers profiles (which have no `deviceId`): without it a public
    // profile would be listed under "private" while its own runs were public.
    const id = record?.deviceId ?? record?.device ?? record?.id;
    return id && publicDeviceIds().has(id) ? 'public' : 'private';
}

/** `?scope=all|public|private`, defaulting to everything. */
function requestedScope(req) {
    const raw = String(req.query.scope ?? 'all').toLowerCase();
    return raw === 'public' || raw === 'private' ? raw : 'all';
}

function inScope(record, scope) {
    return scope === 'all' || scopeOf(record) === scope;
}

/** Runs of one model, or all of them when `modelId` is null. */
function filterByModel(records, modelId) {
    if (!modelId) return records;
    return records.filter((record) => modelOf(record).modelId === modelId);
}

/**
 * Every device we know about: the saved profiles plus any id that only exists in
 * the runs file (a legacy `torre`/`movil`, or a run posted before the profile
 * was created). Nobody should have to re-register a machine to see its history.
 */
function listDevices(modelId = null, scope = 'all') {
    const profiles = new Map(
        [...readDeviceProfiles()].filter(([, profile]) => inScope(profile, scope))
    );
    const runs = filterByModel(readBench(), modelId).filter((run) => inScope(run, scope));
    /** Per device: run count, last run, and the sample-weighted timings. */
    const stats = new Map();
    for (const run of runs) {
        const id = run.deviceId ?? run.device;
        if (!id) continue;
        const entry = stats.get(id) ?? { ...emptyTotals(), lastRun: null };
        if (!entry.lastRun || run.receivedAt > entry.lastRun) entry.lastRun = run.receivedAt;
        accumulate(entry, Array.isArray(run.samples) ? run.samples : []);
        stats.set(id, entry);
    }
    /**
     * A device can have runs in both scopes: the profile was created by the public
     * wizard (public) but somebody also ran the internal bench on it (private). The
     * scope filter drops the profile from this listing, so the fallback must still
     * use its real name — otherwise the table shows a slug like `desktop-2026`
     * next to "Desktop Rafael".
     */
    const allProfiles = readDeviceProfiles();
    for (const [id, entry] of stats) {
        if (!profiles.has(id)) {
            const known = allProfiles.get(id);
            profiles.set(id, {
                id,
                name: known?.name ?? LEGACY_NAMES[id] ?? id,
                category: known?.category ?? LEGACY_CATEGORY[id] ?? 'sobremesa',
                hardware: known?.hardware ?? null,
                createdAt: known?.createdAt ?? null,
                legacy: !known,
            });
        }
    }
    return [...profiles.values()]
        .map((profile) => {
            const entry = stats.get(profile.id);
            const samples = entry?.samples ?? 0;
            return {
                ...profile,
                runs: entry?.runs ?? 0,
                lastRun: entry?.lastRun ?? null,
                samples,
                /**
                 * Average of every test this device has run.
                 *
                 * `readyMs` is the comparable number across machines (frame grab →
                 * pose solved), so it is what the list is sorted by and what the
                 * scatter plot puts on the Y axis. `null`, not `0`, when there is
                 * nothing measured: a device with no data must not look instant.
                 */
                averageReadyMs: samples > 0 ? round1(entry.readyMs / samples) : null,
                averagePaintMs: samples > 0 ? round1(entry.paintMs / samples) : null,
                averageInferenceMs: samples > 0 ? round1(entry.inferenceMs / samples) : null,
                // Calidad: confianza, error de reproyección y % de poses resueltas.
                ...(entry ? qualityOf(entry) : { averageScore: null, averageRmsPx: null, solvedRate: null }),
            };
        })
        // Fastest first, devices without data at the end.
        .sort((left, right) => {
            if (left.averageReadyMs === null && right.averageReadyMs === null) {
                return String(left.name).localeCompare(String(right.name));
            }
            if (left.averageReadyMs === null) return 1;
            if (right.averageReadyMs === null) return -1;
            return left.averageReadyMs - right.averageReadyMs;
        });
}

function normalizeSample(sample) {
    const out = {};
    for (const key of METRIC_KEYS) {
        const value = Number(sample?.[key]);
        out[key] = Number.isFinite(value) ? round1(value) : 0;
    }
    out.detected = Number(sample?.detected) || 0;
    out.solved = Boolean(sample?.solved);
    /**
     * Calidad de la pose, no del dispositivo.
     *
     * `rmsPx` es el error de reproyección que devuelve el solver: cuánto se
     * separan los keypoints detectados de los proyectados. Solo existe cuando la
     * pose se resolvió, así que se guarda como `null` — promediarlo con ceros
     * escondería justo los frames que fallan.
     */
    const rms = Number(sample?.rmsPx);
    out.rmsPx = Number.isFinite(rms) && rms > 0 ? round1(rms) : null;
    return out;
}

/**
 * Stores one benchmark run.
 *
 * The samples are kept, not just the averages: the average of a phone that
 * throttled halfway through is a lie, and only the raw samples let a later
 * analysis separate the first two seconds from the rest.
 */
app.post('/api/bench', (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object') {
        res.status(400).json({ error: 'Expected a JSON object body' });
        return;
    }
    // New runs carry a profile id; the old `device` field is still accepted so a
    // cached bundle keeps working.
    const deviceId = String(body.deviceId ?? body.device ?? '');
    if (!SLUG.test(deviceId)) {
        res.status(400).json({ error: 'deviceId debe ser un slug (a-z, 0-9, guiones)' });
        return;
    }
    const category = String(body.category ?? '');
    if (category && !CATEGORIES.has(category)) {
        res.status(400).json({ error: `category debe ser una de ${[...CATEGORIES].join(', ')}` });
        return;
    }
    const scenario = String(body.scenario ?? '').slice(0, 40);
    if (!scenario) {
        res.status(400).json({ error: 'Falta scenario' });
        return;
    }

    const samples = (Array.isArray(body.samples) ? body.samples : [])
        .slice(0, 200)
        .map(normalizeSample);

    /**
     * Model identity.
     *
     * `modelFile` is the visible name, `modelFingerprint` is what tells two
     * exports of the same name apart, and together they form the `modelId` the
     * page filters by. A run without them is grouped under a `legacy-…` id built
     * from whatever name the old client sent.
     */
    const modelFile = String(body.modelFile ?? body.modelName ?? '').trim().slice(0, 80) || null;
    const modelFingerprint = String(body.modelFingerprint ?? '').trim().slice(0, 24) || null;
    const modelId = modelFile
        ? `${slugify(modelFile.replace(/\.onnx$/i, ''))}${modelFingerprint ? `-${modelFingerprint}` : ''}`
        : null;

    const record = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        receivedAt: new Date().toISOString(),
        deviceId,
        deviceName: String(body.deviceName ?? LEGACY_NAMES[deviceId] ?? deviceId).slice(0, 60),
        category: category || null,
        // Kept for older readers of the file (and for the CSV of past runs).
        device: deviceId,
        scenario,
        deviceInfo: body.deviceInfo ?? body.hardware ?? null,
        runtime: body.runtime ?? null,
        // Legacy field: the file name, which is how the pre-model runs are grouped.
        model: modelFile ?? body.model ?? null,
        modelId,
        modelName: modelFile,
        modelFingerprint,
        modelBytes: Number(body.modelBytes) || null,
        modelInput: Number(body.modelInputSize) || null,
        modelTask: body.modelTask ?? null,
        modelKeypoints: Number(body.modelKeypoints) || null,
        samples,
        /**
         * `true` when the run came from the public wizard.
         *
         * Explicit, not derived: the public page posts `publicRun: true`, and a run
         * that arrived without it is internal no matter who the device belongs to.
         */
        isPublic: body.publicRun === true,
        request: {
            host: req.get('host') ?? null,
            protocol: req.protocol,
            forwardedFor: req.get('x-forwarded-for') ?? null,
        },
    };

    appendBench(record);
    res.status(201).json({ ok: true, id: record.id, saved: samples.length, modelId });
});

/**
 * Per-scenario averages of a set of runs.
 *
 * Weighted by sample count on purpose: three runs of 8 samples and one run of 2
 * must not count the same as four runs of 8.
 */
function aggregateScenarios(records) {
    /** @type {Map<string, {scenario: string, runs: number, samples: number, weight: number, solved: number, sums: Record<string, number>}>} */
    const grouped = new Map();
    for (const record of records) {
        const samples = Array.isArray(record.samples) ? record.samples : [];
        if (samples.length === 0) continue;
        const entry = grouped.get(record.scenario) ?? {
            scenario: record.scenario,
            runs: 0,
            samples: 0,
            weight: 0,
            solved: 0,
            sums: Object.fromEntries(METRIC_KEYS.map((key) => [key, 0])),
        };
        entry.runs += 1;
        entry.samples += samples.length;
        entry.weight += samples.length;
        for (const sample of samples) {
            for (const key of METRIC_KEYS) entry.sums[key] += Number(sample[key]) || 0;
            if (sample.solved) entry.solved += 1;
        }
        grouped.set(record.scenario, entry);
    }

    return [...grouped.values()]
        .map((entry) => {
            const row = {
                scenario: entry.scenario,
                runs: entry.runs,
                samples: entry.samples,
                solvedRate: round1((entry.solved / Math.max(1, entry.samples)) * 100),
            };
            for (const key of METRIC_KEYS) row[key] = round1(entry.sums[key] / entry.weight);
            return row;
        })
        .sort((left, right) => left.scenario.localeCompare(right.scenario));
}

/**
 * Device profiles: create or update one, and list them all.
 *
 * The id comes from the client (a slug built from the nickname), so adding a
 * device twice updates the same row instead of creating twins.
 */
app.post('/api/bench/devices', (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object') {
        res.status(400).json({ error: 'Expected a JSON object body' });
        return;
    }
    const id = String(body.id ?? '');
    if (!SLUG.test(id)) {
        res.status(400).json({ error: 'id debe ser un slug (a-z, 0-9, guiones)' });
        return;
    }
    const name = String(body.name ?? '').trim().slice(0, 60);
    if (!name) {
        res.status(400).json({ error: 'Falta el apodo del equipo' });
        return;
    }
    const category = String(body.category ?? '');
    if (!CATEGORIES.has(category)) {
        res.status(400).json({ error: `category debe ser una de ${[...CATEGORIES].join(', ')}` });
        return;
    }

    const profile = {
        id,
        name,
        category,
        hardware: body.hardware ?? null,
        note: String(body.note ?? '').slice(0, 200) || null,
        createdAt: new Date().toISOString(),
        /**
         * Who ran it and what the device measured about itself.
         *
         * Only the public wizard fills these in: `owner` is the person's name (the
         * point of a public campaign is knowing whose machine it is), and
         * `calibration` is the measured CPU/memory/GPU profile. Both are optional
         * so profiles created from the internal bench keep working unchanged.
         */
        owner: String(body.owner ?? '').slice(0, 120) || null,
        // A profile created by the public wizard is public by definition.
        isPublic: body.public === true || Boolean(body.owner),
        description: String(body.description ?? '').slice(0, 200) || null,
        calibration: body.calibration ?? null,
    };
    appendDeviceProfile(profile);
    res.status(201).json({ ok: true, device: profile });
});

app.get('/api/bench/devices', (req, res) => {
    const modelId = req.query.modelId ? String(req.query.modelId) : null;
    const scope = requestedScope(req);
    res.json({ devices: listDevices(modelId, scope), modelId: modelId ?? 'todos', scope });
});

/**
 * Deletes a device **and every run stored for it**.
 *
 * Both files are rewritten: the profile disappears from `devices.jsonl` and the
 * runs from `bench.jsonl`. Leaving the runs behind would resurrect the device on
 * the next listing (it is rebuilt from the runs), which is the worst of both
 * worlds: deleted in the UI, still in the averages.
 */
app.delete('/api/bench/devices/:id', (req, res) => {
    const id = String(req.params.id ?? '');
    if (!SLUG.test(id)) {
        res.status(400).json({ error: 'id no válido' });
        return;
    }

    const runs = readBench();
    const kept = runs.filter((record) => (record.deviceId ?? record.device) !== id);
    const removedRuns = runs.length - kept.length;

    const profiles = readDeviceProfiles();
    const removedProfile = profiles.delete(id);

    /**
     * Nothing to delete means nothing to rewrite.
     *
     * A delete aimed at an id that does not exist used to rewrite both files
     * anyway, which turns a typo into an opportunity to lose the whole history if
     * the read came back empty. Now it is a 404 and the files are untouched.
     */
    if (removedRuns === 0 && !removedProfile) {
        res.status(404).json({ error: `no existe ningún equipo con id ${id}` });
        return;
    }

    writeJsonLines(BENCH_FILE, kept);
    writeJsonLines(DEVICES_FILE, [...profiles.values()]);

    res.json({ ok: true, deviceId: id, removedRuns, removedProfile });
});

/**
 * Deletes every run and every profile inside a scope.
 *
 * The per-device ✕ already exists; this is the "clean up after a campaign" path,
 * which the page guards with two confirmations. It is destructive by definition,
 * so the query must carry `confirm=delete`: a mistyped URL cannot wipe the
 * history. `scope=all` trumps everything, `scope=public` leaves the internal
 * measurements untouched.
 */
app.delete('/api/bench/data', (req, res) => {
    const scope = requestedScope(req);
    const modelId = req.query.modelId ? String(req.query.modelId) : null;
    if (String(req.query.confirm ?? '') !== 'delete') {
        res.status(400).json({ error: 'falta confirm=delete' });
        return;
    }

    const runs = readBench();
    /**
     * Optional `modelId`.
     *
     * Every time a `.onnx` is replaced its fingerprint changes, so the runs taken
     * with the previous weights stay under an id whose file no longer exists. That
     * is correct (they *are* a different model) but it doubles the columns of the
     * plot with identical labels. This is the way to drop just those.
     */
    const kept = runs.filter(
        (record) => !inScope(record, scope) || (modelId !== null && modelOf(record).modelId !== modelId)
    );
    const profiles = readDeviceProfiles();
    /**
     * A model-scoped delete never touches profiles.
     *
     * Dropping runs of a model has nothing to do with who owns the machine. The
     * first version applied the scope filter to the profiles unconditionally and
     * `scope=all` wiped the whole devices file — a profile list is not a thing to
     * lose while tidying up two duplicate columns.
     */
    const keptProfiles =
        modelId === null
            ? [...profiles.values()].filter((profile) => !inScope(profile, scope))
            : [...profiles.values()];
    const removedRuns = runs.length - kept.length;
    const removedProfiles = profiles.size - keptProfiles.length;

    // Nothing to remove means nothing to rewrite: same rule as the per-device
    // delete, which is the one that once truncated both files.
    if (removedRuns === 0 && removedProfiles === 0) {
        res.status(404).json({ error: `no hay nada que borrar en el ámbito ${scope}` });
        return;
    }

    writeJsonLines(BENCH_FILE, kept);
    writeJsonLines(DEVICES_FILE, keptProfiles);
    res.json({ ok: true, scope, removedRuns, removedProfiles });
});

/**
 * Averages per scenario for one device, within one model.
 *
 * `?modelId=` is what makes two runs of the same laptop comparable: the same
 * machine is faster with one `.onnx` than with another, so a mixed average is
 * meaningless.
 */
app.get('/api/bench/summary', (req, res) => {
    const requested = req.query.deviceId ?? req.query.device ?? null;
    const modelId = req.query.modelId ? String(req.query.modelId) : null;
    const scope = requestedScope(req);
    const filtered = filterByModel(
        (requested
            ? readBench().filter((record) => (record.deviceId ?? record.device) === requested)
            : readBench()
        ).filter((record) => inScope(record, scope)),
        modelId
    );

    res.json({
        deviceId: requested ?? 'todos',
        modelId: modelId ?? 'todos',
        runs: filtered.length,
        devices: listDevices(modelId, scope).map((device) => ({
            deviceId: device.id,
            name: device.name,
            runs: device.runs,
        })),
        scenarios: aggregateScenarios(filtered),
    });
});

/**
 * Every model that has runs, with who ran it.
 *
 * This is the list the page puts *above* the machines: a benchmark row is really
 * (model, device), and the model decides the baseline.
 */
app.get('/api/bench/models', (req, res) => {
    const scope = requestedScope(req);
    const runs = readBench().filter((run) => inScope(run, scope));
    const grouped = new Map();
    for (const run of runs) {
        const { modelId, name, legacy } = modelOf(run);
        const entry = grouped.get(modelId) ?? {
            modelId,
            name,
            legacy,
            runs: 0,
            bytes: run.modelBytes ?? null,
            inputSize: run.modelInput ?? null,
            task: run.modelTask ?? null,
            keypoints: run.modelKeypoints ?? null,
            firstAt: run.receivedAt,
            lastAt: run.receivedAt,
            devices: new Map(),
        };
        entry.runs += 1;
        entry.bytes = entry.bytes ?? run.modelBytes ?? null;
        entry.inputSize = entry.inputSize ?? run.modelInput ?? null;
        entry.task = entry.task ?? run.modelTask ?? null;
        entry.keypoints = entry.keypoints ?? run.modelKeypoints ?? null;
        if (run.receivedAt < entry.firstAt) entry.firstAt = run.receivedAt;
        if (run.receivedAt > entry.lastAt) entry.lastAt = run.receivedAt;
        const deviceId = run.deviceId ?? run.device;
        if (deviceId) {
            const device = entry.devices.get(deviceId) ?? { deviceId, name: run.deviceName ?? deviceId, runs: 0 };
            device.runs += 1;
            entry.devices.set(deviceId, device);
        }
        grouped.set(modelId, entry);
    }

    const models = [...grouped.values()]
        .map((entry) => ({ ...entry, devices: [...entry.devices.values()] }))
        .sort((left, right) => String(right.lastAt).localeCompare(String(left.lastAt)));
    res.json({ models });
});

/**
 * Every (device, model) cell that has samples — the grid behind the model axis.
 *
 * A run is really (device, model): the same laptop is faster with one `.onnx`
 * than with another. Returning the whole grid lets the page draw one line per
 * machine across the models, which is the only way to see whether a smaller model
 * helps every device or just the slow ones. The maths is the same sample-weighted
 * average as `listDevices`, so a cell can never disagree with the device list.
 */
app.get('/api/bench/matrix', (req, res) => {
    const scope = requestedScope(req);
    const profiles = readDeviceProfiles();
    const byModel = new Map();
    const byDevice = new Map();

    const empty = (extra) => ({ ...emptyTotals(), ...extra });

    for (const run of readBench()) {
        if (!inScope(run, scope)) continue;
        const deviceId = run.deviceId ?? run.device;
        if (!deviceId) continue;
        const { modelId, name, legacy } = modelOf(run);

        const model = byModel.get(modelId) ?? empty({ modelId, name, legacy });
        const device = byDevice.get(deviceId) ?? empty({
            deviceId,
            points: new Map(),
            name: profiles.get(deviceId)?.name ?? LEGACY_NAMES[deviceId] ?? run.deviceName ?? deviceId,
            category: profiles.get(deviceId)?.category ?? LEGACY_CATEGORY[deviceId] ?? 'sobremesa',
        });
        const cell = device.points.get(modelId) ?? empty({ modelId });

        const samples = Array.isArray(run.samples) ? run.samples : [];
        for (const target of [model, device, cell]) accumulate(target, samples);

        byModel.set(modelId, model);
        device.points.set(modelId, cell);
        byDevice.set(deviceId, device);
    }

    /** Same numbers the device list reports, from the same sums. */
    const averages = (entry) => ({
        runs: entry.runs,
        samples: entry.samples,
        averageReadyMs: entry.samples > 0 ? round1(entry.readyMs / entry.samples) : null,
        averagePaintMs: entry.samples > 0 ? round1(entry.paintMs / entry.samples) : null,
        averageInferenceMs: entry.samples > 0 ? round1(entry.inferenceMs / entry.samples) : null,
        ...qualityOf(entry),
    });

    res.json({
        models: [...byModel.values()]
            .map((entry) => ({
                modelId: entry.modelId,
                name: entry.name,
                legacy: entry.legacy,
                ...averages(entry),
            }))
            // Slowest first: the axis then reads left → right as "less work".
            .sort((left, right) => (right.averageReadyMs ?? 0) - (left.averageReadyMs ?? 0)),
        devices: [...byDevice.values()]
            .map((entry) => ({
                deviceId: entry.deviceId,
                name: entry.name,
                category: entry.category,
                ...averages(entry),
                points: [...entry.points.values()].map((cell) => ({
                    modelId: cell.modelId,
                    ...averages(cell),
                })),
            }))
            .sort((left, right) => String(left.name).localeCompare(String(right.name))),
    });
});

/**
 * The `.onnx` files this deployment actually serves.
 *
 * The bench uses it to offer a model switch without a rebuild: drop a file in
 * `public/models`, run `npm run build`, and it shows up here.
 */app.get('/api/models', (_req, res) => {
    const directory = modelsDirectory();
    if (!directory) {
        res.json({ models: [] });
        return;
    }
    const models = readdirSync(directory)
        .filter((file) => file.toLowerCase().endsWith('.onnx'))
        .sort()
        .map((file) => ({
            file,
            url: `/models/${file}`,
            bytes: statSync(path.join(directory, file)).size,
            labels: existsSync(path.join(directory, file.replace(/\.onnx$/i, '.labels.txt'))),
        }));
    res.json({ models });
});

/**
 * The devices side by side — the whole point of storing everything.
 *
 * `?ids=a,b,c` picks the columns (the checkboxes on the page); without it every
 * device that has data is included. `?modelId=` restricts the whole comparison to
 * one model, which is the only way the numbers mean anything.
 */
app.get('/api/bench/compare', (req, res) => {
    const requested = String(req.query.ids ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
    const modelId = req.query.modelId ? String(req.query.modelId) : null;
    const scope = requestedScope(req);
    const profiles = listDevices(modelId, scope);
    const chosen = requested.length > 0 ? profiles.filter((entry) => requested.includes(entry.id)) : profiles;

    const all = filterByModel(readBench(), modelId).filter((record) => inScope(record, scope));
    const devices = chosen.map((profile) => {
        const records = all.filter((record) => (record.deviceId ?? record.device) === profile.id);
        const runtimes = new Set(
            records.map((record) => record.runtime?.note ?? record.runtime?.provider ?? '—')
        );
        return {
            deviceId: profile.id,
            name: profile.name,
            category: profile.category,
            hardware: profile.hardware ?? null,
            runs: records.length,
            // Same sample-weighted averages the list is sorted by, so the table,
            // the plot and the device list can never disagree.
            averageReadyMs: profile.averageReadyMs,
            averagePaintMs: profile.averagePaintMs,
            averageInferenceMs: profile.averageInferenceMs,
            averageScore: profile.averageScore ?? null,
            averageRmsPx: profile.averageRmsPx ?? null,
            solvedRate: profile.solvedRate ?? null,
            samples: profile.samples ?? 0,
            scenarios: aggregateScenarios(records),
            runtimes: [...runtimes].slice(0, 3),
        };
    });
    res.json({ devices });
});

/** Raw runs, newest first — the detail behind the averages. */
app.get('/api/bench/runs', (req, res) => {
    const requested = req.query.deviceId ?? req.query.device ?? null;
    const modelId = req.query.modelId ? String(req.query.modelId) : null;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 30));
    const scope = requestedScope(req);
    const records = filterByModel(
        readBench().filter(
            (record) => (!requested || (record.deviceId ?? record.device) === requested) && inScope(record, scope)
        ),
        modelId
    )
        .slice(-limit)
        .reverse();
    res.json({ count: records.length, runs: records });
});

/**
 * The whole history as CSV, one row per run.
 *
 * So a spreadsheet or `pandas.read_csv` can answer "¿cuánto ha mejorado el móvil
 * desde la primera medida?" without anyone writing a client.
 */
app.get('/api/bench/export.csv', (req, res) => {
    const requested = req.query.deviceId ?? req.query.device ?? null;
    const modelId = req.query.modelId ? String(req.query.modelId) : null;
    const scope = requestedScope(req);
    const records = filterByModel(
        readBench().filter(
            (record) => (!requested || (record.deviceId ?? record.device) === requested) && inScope(record, scope)
        ),
        modelId
    );

    const header = [
        'id',
        'fecha',
        'equipo_id',
        'equipo',
        'categoria',
        'modelo',
        'modelo_id',
        'scenario',
        'nucleos',
        'provider',
        'runtime',
        'muestras',
        'yolo_ms',
        'pre_ms',
        'pnp_ms',
        'hasta_predecir_ms',
        'hasta_pintar_ms',
        'pose_ok_pct',
    ].join(',');

    const meanOf = (samples, key) =>
        samples.length === 0
            ? 0
            : round1(samples.reduce((sum, sample) => sum + (Number(sample[key]) || 0), 0) / samples.length);

    const lines = records.map((record) => {
        const samples = Array.isArray(record.samples) ? record.samples : [];
        const solved = samples.filter((sample) => sample.solved).length;
        const cells = [
            record.id,
            record.receivedAt,
            record.deviceId ?? record.device,
            `"${String(record.deviceName ?? LEGACY_NAMES[record.device] ?? record.device).replace(/"/g, '""')}"`,
            record.category ?? '',
            `"${String(modelOf(record).name).replace(/"/g, '""')}"`,
            modelOf(record).modelId,
            record.scenario,
            record.deviceInfo?.cores ?? '',
            record.runtime?.provider ?? '',
            `"${String(record.runtime?.note ?? '').replace(/"/g, '""')}"`,
            samples.length,
            meanOf(samples, 'inferenceMs'),
            meanOf(samples, 'preprocessMs'),
            meanOf(samples, 'poseMs'),
            meanOf(samples, 'readyMs'),
            meanOf(samples, 'paintMs'),
            samples.length ? round1((solved / samples.length) * 100) : 0,
        ];
        return cells.join(',');
    });

    res.type('text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="oc4-bench.csv"');
    res.send([header, ...lines].join('\n'));
});

/* ----------------------------------------------------------- static (SPA) */

if (SERVE_DIST && existsSync(distDir)) {
    app.use(
        express.static(distDir, {
            setHeaders(res, filePath) {
                if (filePath.endsWith('.wasm')) {
                    res.setHeader('Content-Type', 'application/wasm');
                }
                // Hashed assets are immutable; index.html must never be cached.
                if (filePath.endsWith('index.html')) {
                    res.setHeader('Cache-Control', 'no-cache');
                } else if (/\.[0-9a-f]{8,}\./.test(path.basename(filePath))) {
                    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                } else if (/[\\/]models[\\/]/.test(filePath)) {
                    // The ONNX model and the glTF are tens of MB and change rarely: a day
                    // of freshness keeps them off the wire on repeat visits, and
                    // revalidation (ETag) covers a model swap.
                    res.setHeader('Cache-Control', 'public, max-age=86400');
                }
            },
        })
    );
    // SPA fallback: every non-/api route renders the app shell.
    app.get(/^(?!\/api\/).*/, (req, res, next) => {
        // …but a *file* that is not there must 404. Answering index.html to a
        // missing `/models/x.onnx` or `/models/x.labels.txt` turns an obvious
        // 404 into a parse error (or, worse, into HTML class names).
        if (/\.[a-z0-9]{2,5}$/i.test(req.path)) return next();
        res.sendFile(path.join(distDir, 'index.html'));
    });
} else {
    app.get('/', (_req, res) => {
        res
            .status(200)
            .type('text/plain')
            .send(
                [
                    'OC4 mobile standalone server is running (API only).',
                    '',
                    'The SPA is not served because `dist/` does not exist yet or',
                    '`--serve-dist` was not passed.',
                    '',
                    '  Development :  npm run dev      (Vite serves the app, /api is proxied here)',
                    '  Production  :  npm start        (builds, then serves dist/ from here)',
                ].join('\n')
            );
    });
}

app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route' }));

/* ------------------------------------------------------------- lifecycle */

function localAddresses() {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const iface of list ?? []) {
            if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
        }
    }
    return out;
}

const server = http.createServer(app);

server.listen(PORT, HOST, () => {
    const scheme = 'http';
    console.log('');
    console.log('  OC4 mobile standalone server');
    console.log(`  → http://localhost:${PORT}${SERVE_DIST && existsSync(distDir) ? '' : '/api/health'}`);
    for (const ip of localAddresses()) {
        console.log(`  → ${scheme}://${ip}:${PORT}   (LAN)`);
    }
    if (!(SERVE_DIST && existsSync(distDir))) {
        console.log('');
        console.log('  SPA not served here. Run `npm run dev` and open the Vite URL on the phone.');
        console.log('  Remember: camera access needs HTTPS or localhost.');
    }
    console.log('');
});

server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
        console.error(
            `\n[mobile-server] Port ${PORT} is already in use.\n` +
            'Another process owns it — check with `netstat -ano | findstr LISTENING` on Windows,\n' +
            'or start this server with `npm run server -- --port 8788`.\n'
        );
    } else {
        console.error('[mobile-server] fatal:', err);
    }
    process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        console.log(`\n[mobile-server] ${signal} received, shutting down...`);
        for (const client of sseClients) client.end();
        sseClients.clear();
        server.close(() => process.exit(0));
        // Do not hang forever on lingering keep-alive sockets.
        setTimeout(() => process.exit(0), 2000).unref();
    });
}

// Cheap sanity check: fail loudly if `dist` exists but is empty (broken build).
if (SERVE_DIST && existsSync(distDir) && statSync(distDir).isDirectory()) {
    const index = path.join(distDir, 'index.html');
    if (!existsSync(index)) {
        console.warn('[mobile-server] warning: dist/index.html is missing — run `npm run build`.');
    }
}
