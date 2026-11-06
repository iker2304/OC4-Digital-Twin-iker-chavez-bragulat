/**
 * Minimal linear algebra for the PnP solver: 3×3 rotations, Rodrigues and a
 * dense linear solver. No dependencies — this runs on a phone, per frame.
 */

export type Vec3 = [number, number, number];
/** Row-major 3×3. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export function mat3Identity(): Mat3 {
    return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

export function mat3Mul(a: Mat3, b: Mat3): Mat3 {
    const out = new Array(9) as Mat3;
    for (let row = 0; row < 3; row += 1) {
        for (let col = 0; col < 3; col += 1) {
            out[row * 3 + col] =
                a[row * 3] * b[col] + a[row * 3 + 1] * b[3 + col] + a[row * 3 + 2] * b[6 + col];
        }
    }
    return out;
}

export function mat3Transpose(a: Mat3): Mat3 {
    return [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
}

export function mat3Vec(a: Mat3, v: Vec3): Vec3 {
    return [
        a[0] * v[0] + a[1] * v[1] + a[2] * v[2],
        a[3] * v[0] + a[4] * v[1] + a[5] * v[2],
        a[6] * v[0] + a[7] * v[1] + a[8] * v[2],
    ];
}

export function vec3Length(v: Vec3): number {
    return Math.hypot(v[0], v[1], v[2]);
}

export function vec3Normalize(v: Vec3): Vec3 {
    const norm = vec3Length(v);
    return norm > 0 ? [v[0] / norm, v[1] / norm, v[2] / norm] : [0, 0, 0];
}

export function vec3Cross(a: Vec3, b: Vec3): Vec3 {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function vec3Dot(a: Vec3, b: Vec3): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Skew-symmetric matrix of a vector, such that `skew(a)·b = a × b`. */
export function skew(v: Vec3): Mat3 {
    return [0, -v[2], v[1], v[2], 0, -v[0], -v[1], v[0], 0];
}

/**
 * Rodrigues: rotation vector → rotation matrix.
 * `rvec` direction is the axis, its norm the angle in radians.
 */
export function rodriguesToMatrix(rvec: Vec3): Mat3 {
    const theta = vec3Length(rvec);
    if (theta < 1e-12) return mat3Identity();

    const [kx, ky, kz] = [rvec[0] / theta, rvec[1] / theta, rvec[2] / theta];
    const s = Math.sin(theta);
    const c = 1 - Math.cos(theta);
    const k = skew([kx, ky, kz]);
    const kk = mat3Mul(k, k);

    const out = new Array(9) as Mat3;
    for (let i = 0; i < 9; i += 1) {
        out[i] = (i % 4 === 0 ? 1 : 0) + s * k[i] + c * kk[i];
    }
    return out;
}

/** Rotation matrix → rotation vector (inverse of `rodriguesToMatrix`). */
export function matrixToRodrigues(R: Mat3): Vec3 {
    const trace = R[0] + R[4] + R[8];
    const cosTheta = Math.min(1, Math.max(-1, (trace - 1) / 2));
    const theta = Math.acos(cosTheta);

    // Axis from the antisymmetric part; the factor keeps it exact for any angle.
    const axis: Vec3 = [R[7] - R[5], R[2] - R[6], R[3] - R[1]];

    if (theta < 1e-8) {
        // Near identity: the antisymmetric part is already ≈ 2·rvec.
        return [axis[0] / 2, axis[1] / 2, axis[2] / 2];
    }
    if (Math.PI - theta < 1e-6) {
        // Near π the antisymmetric part vanishes; recover the axis from R + I.
        const xx = Math.max(0, (R[0] + 1) / 2);
        const yy = Math.max(0, (R[4] + 1) / 2);
        const zz = Math.max(0, (R[8] + 1) / 2);
        const x = Math.sqrt(xx);
        const y = Math.sqrt(yy);
        const z = Math.sqrt(zz);
        // Fix the signs using the symmetric off-diagonal terms.
        const sx = R[1] + R[3] >= 0 ? 1 : -1;
        const sy = R[2] + R[6] >= 0 ? 1 : -1;
        const sz = R[5] + R[7] >= 0 ? 1 : -1;
        const axisPi = vec3Normalize([x * sx, y * sy, z * sz]);
        return [axisPi[0] * theta, axisPi[1] * theta, axisPi[2] * theta];
    }

    const scale = theta / (2 * Math.sin(theta));
    return [axis[0] * scale, axis[1] * scale, axis[2] * scale];
}

/**
 * Builds the closest rotation matrix to two (supposedly orthonormal) columns,
 * using Gram-Schmidt. `r1` and `r2` are the first two columns.
 */
export function rotationFromColumns(r1: Vec3, r2: Vec3): Mat3 {
    const c1 = vec3Normalize(r1);
    const projection = vec3Dot(c1, r2);
    const c2 = vec3Normalize([r2[0] - projection * c1[0], r2[1] - projection * c1[1], r2[2] - projection * c1[2]]);
    const c3 = vec3Cross(c1, c2);
    return [c1[0], c2[0], c3[0], c1[1], c2[1], c3[1], c1[2], c2[2], c3[2]];
}

/**
 * Solves `A x = b` for a dense square system by Gaussian elimination with
 * partial pivoting. Returns null when the system is singular or nearly so,
 * which the caller must treat as "no solution" rather than as a pose.
 */
export function solveLinearSystem(A: number[][], b: number[]): number[] | null {
    const n = A.length;
    if (n === 0 || b.length !== n) return null;

    // Work on a copy; augment with b.
    const m = A.map((row, index) => [...row, b[index]]);

    for (let col = 0; col < n; col += 1) {
        let pivotRow = col;
        let pivotValue = Math.abs(m[col][col]);
        for (let row = col + 1; row < n; row += 1) {
            const value = Math.abs(m[row][col]);
            if (value > pivotValue) {
                pivotValue = value;
                pivotRow = row;
            }
        }
        // Relative threshold: the matrices here mix units (pixels, metres).
        let rowScale = 0;
        for (let k = 0; k <= n; k += 1) rowScale = Math.max(rowScale, Math.abs(m[col][k]));
        if (pivotValue < 1e-12 * Math.max(1, rowScale)) return null;

        if (pivotRow !== col) {
            const swap = m[col];
            m[col] = m[pivotRow];
            m[pivotRow] = swap;
        }

        for (let row = col + 1; row < n; row += 1) {
            const factor = m[row][col] / m[col][col];
            if (factor === 0) continue;
            for (let k = col; k <= n; k += 1) m[row][k] -= factor * m[col][k];
        }
    }

    const x = new Array(n).fill(0);
    for (let row = n - 1; row >= 0; row -= 1) {
        let sum = m[row][n];
        for (let col = row + 1; col < n; col += 1) sum -= m[row][col] * x[col];
        x[row] = sum / m[row][row];
    }
    return x.every((value) => Number.isFinite(value)) ? x : null;
}

/** Inverse of a 3×3 matrix, or null when it is singular. */
export function mat3Inverse(m: Mat3): Mat3 | null {
    const [a, b, c, d, e, f, g, h, i] = m;
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if (Math.abs(det) < 1e-12) return null;
    const inv = 1 / det;
    return [
        (e * i - f * h) * inv, (c * h - b * i) * inv, (b * f - c * e) * inv,
        (f * g - d * i) * inv, (a * i - c * g) * inv, (c * d - a * f) * inv,
        (d * h - e * g) * inv, (b * g - a * h) * inv, (a * e - b * d) * inv,
    ];
}
