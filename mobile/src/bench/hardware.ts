/**
 * What the browser will say about this machine, and a first guess at what kind
 * of machine it is.
 *
 * Everything here is best-effort by design: `deviceMemory` only exists in
 * Chromium, the GPU string is hidden behind an extension that Firefox exposes but
 * Safari does not, and a laptop and a desktop can look identical through a
 * browser. So the probe fills in what it can, the page shows it, and the user
 * decides the category (and can name the machine). Guessing wrong costs one
 * click; guessing nothing costs the whole comparison.
 */

export interface Hardware {
    cores: number | null;
    /** Gigabytes, as coarse as the browser reports it (0.25/0.5/1/2/4/8). */
    memoryGb: number | null;
    /** Best GPU name available; `null` when every source masked it. */
    gpu: string | null;
    gpuVendor: string | null;
    gpuArchitecture: string | null;
    /** Exactly what WebGL claimed, kept even when it was useless, to explain a blank. */
    gpuWebgl?: string | null;
    /** True when the browser substituted a generic name for privacy/blocklisting. */
    gpuMasked?: boolean;
    /** True when the value was typed by the user rather than read. */
    gpuManual?: boolean;
    memoryManual?: boolean;
    platform: string | null;
    screen: string | null;
    dpr: number;
    webgpu: boolean;
    userAgent: string;
    mobile: boolean;
}

export type Category = 'sobremesa' | 'portatil' | 'movil';

export const CATEGORY_LABELS: Record<Category, string> = {
    sobremesa: 'Sobremesa',
    portatil: 'Portátil',
    movil: 'Móvil',
};

/** WebGL renderer string, with the extensions that actually reveal it. */
function readGpu(): { gpu: string | null; vendor: string | null } {
    try {
        const canvas = document.createElement('canvas');
        const gl = (canvas.getContext('webgl') ??
            canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
        if (!gl) return { gpu: null, vendor: null };
        const info = gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = info
            ? (gl.getParameter(info.UNMASKED_RENDERER_WEBGL) as string)
            : (gl.getParameter(gl.RENDERER) as string);
        const vendor = info
            ? (gl.getParameter(info.UNMASKED_VENDOR_WEBGL) as string)
            : (gl.getParameter(gl.VENDOR) as string);
        return { gpu: renderer || null, vendor: vendor || null };
    } catch {
        return { gpu: null, vendor: null };
    }
}

/**
 * Whether the renderer string is a placeholder.
 *
 * Chrome appends "or similar" when it is not telling the truth (GPU blocklisted,
 * software fallback, or a generic driver database entry), and Firefox with
 * `privacy.resistFingerprinting` returns one uniform string for every machine —
 * which is exactly how two different desktops ended up listed with the same GPU.
 */
export function isMaskedGpu(name: string | null): boolean {
    if (!name) return true;
    return /or similar|swiftshader|llvmpipe|software|basic render|generic/i.test(name);
}

export async function probeHardware(): Promise<Hardware> {
    const navigatorExt = navigator as Navigator & {
        deviceMemory?: number;
        userAgentData?: { platform?: string; mobile?: boolean };
    };
    const { gpu: webglGpu, vendor } = readGpu();

    let gpuArchitecture: string | null = null;
    let webgpuName: string | null = null;
    let webgpu = false;
    try {
        // Deliberately duck-typed: WebGPU types are not in every TS lib version,
        // and a missing `navigator.gpu` is a perfectly normal outcome here.
        const gpuApi = (navigator as unknown as {
            gpu?: { requestAdapter?: () => Promise<unknown> };
        }).gpu;
        const adapter = await gpuApi?.requestAdapter?.();
        if (adapter) {
            webgpu = true;
            /**
             * WebGPU is the better source here: its `info` gives a real model
             * ("NVIDIA GeForce RTX 5080") and it is not subject to the WebGL
             * renderer blocklist, so it survives where the WebGL string is masked.
             */
            const info = (adapter as {
                info?: { architecture?: string; description?: string; device?: string };
            }).info;
            gpuArchitecture = info?.architecture ?? null;
            webgpuName = info?.description ?? info?.device ?? null;
        }
    } catch {
        // No WebGPU: the benchmark will say so anyway.
    }

    const masked = isMaskedGpu(webglGpu);
    // Prefer the WebGPU description only when WebGL could not name the card.
    const gpu = masked && webgpuName && !isMaskedGpu(webgpuName) ? webgpuName : webglGpu;

    return {
        cores: navigatorExt.hardwareConcurrency ?? null,
        memoryGb: typeof navigatorExt.deviceMemory === 'number' ? navigatorExt.deviceMemory : null,
        gpu,
        gpuVendor: vendor,
        gpuArchitecture,
        gpuWebgl: webglGpu,
        gpuMasked: masked,
        platform: navigatorExt.userAgentData?.platform ?? navigator.platform ?? null,
        screen: `${window.screen.width}x${window.screen.height}`,
        dpr: window.devicePixelRatio,
        webgpu,
        userAgent: navigator.userAgent,
        mobile: /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent),
    };
}

/** First guess, only to pre-select the radio button. */
export function guessCategory(hardware: Hardware): Category {
    if (hardware.mobile || /Android|iPhone|iPad|iPod/i.test(hardware.userAgent)) return 'movil';
    /**
     * Core count is the most reliable signal a browser gives.
     *
     * `navigator.getBattery` is *not*: desktop Chrome implements it too, so it
     * used to label this 32-thread tower as a laptop. A big logical core count is
     * a desktop with near certainty; below that it is a coin toss, and the user
     * can fix it with one click.
     */
    const cores = hardware.cores ?? 4;
    if (cores >= 20) return 'sobremesa';
    const screenWidth = Number(hardware.screen?.split('x')[0] ?? 0);
    if (cores >= 12 && screenWidth > 1920) return 'sobremesa';
    return 'portatil';
}

/** A readable, stable id from a nickname. */
export function slugify(name: string): string {
    return name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
}

/** One line that identifies the machine in a table, without a wall of text. */
export function describeHardware(hardware: Hardware | null): string {
    if (!hardware) return 'sin datos';
    const parts: string[] = [];
    if (hardware.cores) parts.push(`${hardware.cores} núcleos`);
    if (hardware.memoryGb) parts.push(`${hardware.memoryGb} GB${hardware.memoryManual ? '*' : ''}`);

    /**
     * Never print a masked GPU name as if it were the model.
     *
     * "NVIDIA GeForce GTX 980 … or similar" is Chrome saying *I am not telling
     * you*, and showing it in the table made two very different desktops look
     * identical. The string is checked as well as the stored flag, so profiles
     * saved before this existed are not mislabelled either. The asterisk marks a
     * value typed by hand.
     */
    const masked = hardware.gpuMasked ?? isMaskedGpu(hardware.gpu);
    if (masked && !hardware.gpuManual) {
        parts.push('GPU no revelada');
    } else if (hardware.gpu) {
        const clean = hardware.gpu.replace(/^ANGLE \(|\)$/g, '').replace(/,?\s*or similar/i, '').trim();
        parts.push(`${clean.slice(0, 38)}${hardware.gpuManual ? '*' : ''}`);
    }

    if (hardware.webgpu && !hardware.gpu) parts.push('WebGPU');
    return parts.join(' · ') || 'sin datos';
}
