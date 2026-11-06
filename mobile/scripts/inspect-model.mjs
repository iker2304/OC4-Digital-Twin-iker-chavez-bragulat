#!/usr/bin/env node
/**
 * Inspects an ONNX file without any dependency.
 *
 * ONNX is a protobuf, so a ~120-line walker is enough to read the *contract*
 * that matters here: input/output names, tensor shapes, dtypes and the
 * `metadata_props` block that Ultralytics writes (`names`, `task`, `imgsz`).
 * Weights are skipped by length, so a 40 MB model is read in milliseconds.
 *
 *   node scripts/inspect-model.mjs ../best.onnx
 *   node scripts/inspect-model.mjs ../best.onnx --write-labels public/models/best.labels.txt
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DTYPES = {
    1: 'float32',
    2: 'uint8',
    3: 'int8',
    4: 'uint16',
    5: 'int16',
    6: 'int32',
    7: 'int64',
    9: 'bool',
    10: 'float16',
    11: 'float64',
    12: 'uint32',
    13: 'uint64',
};

function readVarint(buffer, position) {
    let result = 0;
    let shift = 0;
    let cursor = position;
    while (cursor < buffer.length) {
        const byte = buffer[cursor];
        cursor += 1;
        result += (byte & 0x7f) * 2 ** shift;
        if ((byte & 0x80) === 0) return [result, cursor];
        shift += 7;
        if (shift > 63) throw new Error('varint demasiado largo');
    }
    throw new Error('varint truncado');
}

/**
 * Yields the top-level fields of a protobuf message.
 *
 * Group wire types (3/4) never appear in ONNX; hitting one means the cursor
 * drifted, so the walk stops instead of throwing. `walkComplete` tells the
 * caller whether the whole range was consumed, which is what makes a silent
 * truncation visible.
 */
let walkAbort = null;
function* fields(buffer, start, end, label = '?') {
    let cursor = start;
    while (cursor < end) {
        const keyAt = cursor;
        let key;
        [key, cursor] = readVarint(buffer, cursor);
        const field = key >>> 3;
        const wire = key & 7;
        if (wire === 0) {
            let value;
            [value, cursor] = readVarint(buffer, cursor);
            yield { field, value };
        } else if (wire === 2) {
            let length;
            [length, cursor] = readVarint(buffer, cursor);
            yield { field, start: cursor, end: cursor + length };
            cursor += length;
        } else if (wire === 5) {
            cursor += 4;
        } else if (wire === 1) {
            cursor += 8;
        } else {
            walkAbort = { label, field, wire, keyAt, start, end };
            return;
        }
    }
}

const text = (buffer, start, end) => buffer.toString('utf8', start, end);

const find = (buffer, start, end, wanted, label) => {
    for (const entry of fields(buffer, start, end, label)) {
        if (entry.field === wanted) return entry;
    }
    return null;
};

const findAll = (buffer, start, end, wanted, label) =>
    [...fields(buffer, start, end, label)].filter((entry) => entry.field === wanted);

/** ValueInfoProto → { name, dtype, shape } */
function readValueInfo(buffer, start, end) {
    const nameEntry = find(buffer, start, end, 1);
    const typeEntry = find(buffer, start, end, 2);
    const info = { name: nameEntry ? text(buffer, nameEntry.start, nameEntry.end) : '?', dtype: '?', shape: [] };
    if (!typeEntry) return info;

    const tensor = find(buffer, typeEntry.start, typeEntry.end, 1);
    if (!tensor) return info;

    const dtypeEntry = find(buffer, tensor.start, tensor.end, 1);
    if (dtypeEntry) info.dtype = DTYPES[dtypeEntry.value] ?? `tipo ${dtypeEntry.value}`;

    const shapeEntry = find(buffer, tensor.start, tensor.end, 2);
    if (!shapeEntry) return info;

    const dims = [];
    for (const dim of fields(buffer, shapeEntry.start, shapeEntry.end)) {
        if (dim.field !== 1) continue;
        const value = find(buffer, dim.start, dim.end, 1);
        if (value) {
            dims.push(value.value);
            continue;
        }
        const param = find(buffer, dim.start, dim.end, 2);
        dims.push(param ? text(buffer, param.start, param.end) : '?');
    }
    info.shape = dims;
    return info;
}

/**
 * ModelProto.metadata_props → { key: value }.
 *
 * It must be given the *model* range (field 14 is filtered here). Passing the
 * range of a single entry instead would walk the value bytes as a message: the
 * value is a plain UTF-8 string, so the cursor drifts and the walk aborts.
 */
function readMetadata(buffer, start, end) {
    const out = {};
    for (const entry of fields(buffer, start, end, 'model')) {
        if (entry.field !== 14 || entry.start === undefined) continue;
        const keyField = find(buffer, entry.start, entry.end, 1, 'meta.key');
        const valueField = find(buffer, entry.start, entry.end, 2, 'meta.value');
        if (keyField && valueField) {
            out[text(buffer, keyField.start, keyField.end)] = text(buffer, valueField.start, valueField.end);
        }
    }
    return out;
}

/** `{0: 'turbine', 1: 'person'}` (Ultralytics) or a JSON object. */
function parseNames(raw) {
    if (!raw) return null;
    const trimmed = raw.trim();
    try {
        const parsed = JSON.parse(trimmed.replace(/'/g, '"'));
        if (parsed && typeof parsed === 'object') {
            return Object.keys(parsed)
                .sort((a, b) => Number(a) - Number(b))
                .map((key) => String(parsed[key]));
        }
    } catch {
        /* fall through to the regex pass */
    }
    const pairs = [...trimmed.matchAll(/(\d+)\s*:\s*['"]([^'"]+)['"]/g)];
    if (pairs.length === 0) return null;
    return pairs.sort((a, b) => Number(a[1]) - Number(b[1])).map((match) => match[2]);
}

async function main() {
    const args = process.argv.slice(2);
    const file = args.find((arg) => !arg.startsWith('--'));
    if (!file) {
        console.error('uso: node scripts/inspect-model.mjs <modelo.onnx> [--write-labels <ruta>]');
        process.exitCode = 1;
        return;
    }

    const buffer = await readFile(file);
    const debug = args.includes('--debug');
    const graph = find(buffer, 0, buffer.length, 7, 'model');
    if (!graph) {
        console.error('No parece un modelo ONNX (falta el mensaje GraphProto).');
        process.exitCode = 1;
        return;
    }

    const inputs = findAll(buffer, graph.start, graph.end, 11, 'graph.input').map((entry) =>
        readValueInfo(buffer, entry.start, entry.end)
    );
    const outputs = findAll(buffer, graph.start, graph.end, 12, 'graph.output').map((entry) =>
        readValueInfo(buffer, entry.start, entry.end)
    );
    const metaEntry = findAll(buffer, 0, buffer.length, 14, 'model.metadata_props');
    const metadata = readMetadata(buffer, 0, buffer.length);
    if (debug) console.log(`  metadata_props: ${metaEntry.length} entradas`);
    if (walkAbort) {
        console.warn(
            `  aviso: recorrido protobuf detenido en ${walkAbort.label} (campo ${walkAbort.field}, wire ${walkAbort.wire}) ` +
            `@ ${walkAbort.keyAt} de [${walkAbort.start}, ${walkAbort.end}]`
        );
        if (debug) console.warn('   ', JSON.stringify(walkAbort));
    }
    const nodeCount = findAll(buffer, graph.start, graph.end, 1, 'graph.node').length;
    const irVersion = find(buffer, 0, buffer.length, 1);

    const names = parseNames(metadata.names);

    console.log(`\n  ${path.basename(file)}  (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
    console.log(`  ir_version ${irVersion?.value ?? '?'} · nodos ${nodeCount}`);
    console.log('\n  entradas');
    for (const input of inputs) {
        console.log(`    ${input.name.padEnd(16)} ${input.dtype.padEnd(8)} [${input.shape.join(', ')}]`);
    }
    console.log('  salidas');
    for (const output of outputs) {
        console.log(`    ${output.name.padEnd(16)} ${output.dtype.padEnd(8)} [${output.shape.join(', ')}]`);
    }

    if (Object.keys(metadata).length > 0) {
        console.log('  metadata');
        for (const [key, value] of Object.entries(metadata)) {
            if (key === 'names') continue;
            console.log(`    ${key}: ${value.length > 90 ? `${value.slice(0, 90)}...` : value}`);
        }
    }
    if (names) {
        console.log(`  clases (${names.length}): ${names.slice(0, 12).join(', ')}${names.length > 12 ? ', ...' : ''}`);
    }

    // Cross-check against what the runtime decoder will infer.
    const shape = outputs[0]?.shape ?? [];
    const declaredKeypoints = metadata.kpt_shape ? Number(String(metadata.kpt_shape).match(/\d+/)?.[0]) : null;
    const endToEnd = String(metadata.end2end ?? '').toLowerCase() === 'true';
    if (shape.length === 3) {
        const anchorsFirst = Number(shape[1]) > Number(shape[2]);
        const attrs = anchorsFirst ? Number(shape[2]) : Number(shape[1]);
        const keypoints = (attrs - 5) / 3;
        const known = [11, 14, 17, 19, 21, 23, 26];
        let kind = 'detect';
        let detail = `${attrs - 4} clases`;
        if (Number.isInteger(keypoints) && known.includes(keypoints)) {
            kind = 'pose';
            detail = `${keypoints} keypoints`;
        } else if (declaredKeypoints) {
            kind = 'pose';
            detail = `${declaredKeypoints} keypoints (según kpt_shape)`;
        }
        console.log(`\n  decoder → ${kind} (${detail}) · layout ${anchorsFirst ? '[N, attrs]' : '[attrs, N]'}`);
    }
    if (endToEnd) {
        console.log(
            '  end2end=True: el grafo ya incluye NMS, la salida NO es [attrs, anchors]. ' +
            'Comprobar el layout antes de fiarse del decoder.'
        );
    }

    const labelsPathIndex = args.indexOf('--write-labels');
    if (labelsPathIndex >= 0) {
        const target = args[labelsPathIndex + 1];
        if (!target) {
            console.error('--write-labels necesita una ruta de salida');
            process.exitCode = 1;
            return;
        }
        if (!names) {
            console.warn('  El modelo no expone `names` en metadata: no hay etiquetas que escribir.');
            return;
        }
        await writeFile(target, `${names.join('\n')}\n`, 'utf8');
        console.log(`  ${names.length} etiquetas escritas en ${target}\n`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
