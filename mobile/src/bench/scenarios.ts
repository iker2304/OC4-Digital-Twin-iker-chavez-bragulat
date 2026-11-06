/**
 * Synthetic camera for the benchmark page.
 *
 * The real camera cannot be scripted: pointing a phone at the same platform with
 * the same motion twice is not a thing, and the whole point of a benchmark is
 * comparing devices on *identical* input. So the source here is a canvas the page
 * animates deterministically from a couple of reference photographs, and each
 * test is one kind of camera behaviour:
 *
 *   - `estatico`  — nothing moves: the floor. Any jitter here is the model's own.
 *   - `pan`       — hand-held sideways movement, which is what exposes the lag
 *                   between the frame the model read and the frame on screen.
 *   - `vibracion` — small, fast shake: the case where the overlay "resbala".
 *   - `rotacion`  — the phone rolling: tests whether the solve survives yaw/roll.
 *   - `zoom`      — walking towards the platform: scale changes every frame.
 *   - `cambio`    — alternates the two reference photos, forcing re-acquisition.
 *   - `video`     — a video file picked by the user (looped), for real footage.
 *
 * Every scenario draws through the same path (`drawImage`), so the capture cost
 * measured by the page is comparable across them.
 */

export type ScenarioId =
    | 'estatico'
    | 'pan'
    | 'vibracion'
    | 'rotacion'
    | 'zoom'
    | 'cambio'
    | 'video';

export interface Scenario {
    id: ScenarioId;
    label: string;
    hint: string;
    /** Needs a video file from the user. */
    needsVideo?: boolean;
}

export const SCENARIOS: Scenario[] = [
    { id: 'estatico', label: 'Estático', hint: 'Referencia: sin movimiento alguno.' },
    { id: 'pan', label: 'Paneo', hint: 'Desplazamiento lateral ±40 px a 1 Hz.' },
    { id: 'vibracion', label: 'Vibración', hint: 'Sacudida rápida ±3 px a 8 Hz.' },
    { id: 'rotacion', label: 'Rotación', hint: 'Balanceo de ±8° a 0.5 Hz.' },
    { id: 'zoom', label: 'Zoom', hint: 'Acercamiento ±10 % a 0.3 Hz.' },
    { id: 'cambio', label: 'Cambio de escena', hint: 'Alterna las dos fotos cada 2 s.' },
    { id: 'video', label: 'Vídeo', hint: 'Bucle de un vídeo local (mp4/webm).', needsVideo: true },
];

const IMAGE_URLS = ['escena-1.png', 'escena-2.png'];
/**
 * Test footage that ships with the app.
 *
 * A real clip of the platform, so the benchmark does not depend on the tester
 * having a video at hand. Only the first seconds are useful (the platform drifts
 * away and becomes too small to detect), so the range below loops instead of
 * playing the whole thing: `LOOP_START`-`LOOP_END` is replayed forever.
 */
const TEST_VIDEO = 'video.mp4';
const LOOP_START = 0;
const LOOP_END = 5;

/**
 * Builds the video element **without waiting for it to load**.
 *
 * The previous version resolved `null` unless `loadeddata` arrived within a few
 * seconds, and on a phone that event never comes: mobile browsers defer media
 * loading until a user gesture (and data-saver mode blocks it outright), so the
 * bench concluded "no hay vídeo" and the test told the user to upload a file
 * even though the clip was right there. The element is created eagerly instead;
 * the renderer already falls back to the photographs while `readyState < 2`.
 */
function createVideo(url: string): HTMLVideoElement {
    const video = document.createElement('video');
    video.src = url;
    video.loop = true;
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', 'true');
    video.setAttribute('webkit-playsinline', 'true');
    video.preload = 'auto';
    return video;
}

/** Where the synthetic canvas gets its pictures. */
export class SceneSource {
    readonly canvas = document.createElement('canvas');
    scenario: ScenarioId = 'estatico';
    video: HTMLVideoElement | null = null;
    /** Seconds of the clip that get replayed; `null` plays it straight through. */
    videoLoop: { start: number; end: number } | null = { start: LOOP_START, end: LOOP_END };
    /** True when the clip came with the app rather than from a file input. */
    bundledVideo = false;

    private context: CanvasRenderingContext2D | null = null;
    private images: HTMLImageElement[] = [];
    private rafId = 0;
    private startedAt = 0;

    async load(base: string): Promise<void> {
        this.images = await Promise.all(
            IMAGE_URLS.map(
                (url) =>
                    new Promise<HTMLImageElement>((resolve, reject) => {
                        const image = new Image();
                        image.crossOrigin = 'anonymous';
                        image.onload = () => resolve(image);
                        image.onerror = () => reject(new Error(`no pude cargar ${url}`));
                        image.src = `${base}${url}`;
                    })
            )
        );
        /**
         * Match the canvas to the reference photographs instead of forcing 16:9.
         *
         * They are portrait phone pictures; cropping them into a landscape buffer
         * with `cover` cut the platform out of the frame and the model detected
         * nothing at all — a benchmark that measures the cost of looking at empty
         * water. Portrait is also what the phone camera actually delivers.
         */
        const first = this.images[0];
        const width = first?.naturalWidth || 720;
        const height = first?.naturalHeight || 1280;
        this.canvas.width = width;
        this.canvas.height = height;
        // Portrait, but never taller than the viewport: the page is a control
        // panel, and a 1280 px preview pushes every button out of reach.
        this.canvas.className = 'h-[42vh] w-auto rounded-xl border border-white/10';
        this.context = this.canvas.getContext('2d', { alpha: false, desynchronized: true });

        // The bundled clip is attached straight away: on a phone nothing loads
        // until something asks for it, so waiting here is what made the video test
        // claim it had no file.
        this.video = createVideo(`${base}${TEST_VIDEO}`);
        this.bundledVideo = true;
    }

    /**
     * Starts (or restarts) playback and waits until there is a frame to draw.
     *
     * Must be called from a user gesture on mobile — the bench calls it at the
     * start of every test, which is exactly that. Returns `false` when the clip
     * cannot be played, so the caller can say why instead of "upload a video".
     */
    async ensurePlaying(timeoutMs = 5000): Promise<boolean> {
        const video = this.video;
        if (!video) return false;
        // A gesture is the one moment mobile browsers allow starting playback.
        void video.play().catch(() => undefined);
        if (video.readyState >= 2) return true;
        const deadline = performance.now() + timeoutMs;
        while (performance.now() < deadline) {
            await new Promise((resolve) => window.setTimeout(resolve, 120));
            if (video.error) return false;
            if (video.readyState >= 2) {
                void video.play().catch(() => undefined);
                return true;
            }
        }
        return video.readyState >= 2;
    }

    /** Human-readable reason the clip is unusable, or `null` when it is fine. */
    videoProblem(): string | null {
        const video = this.video;
        if (!video) return 'no hay vídeo cargado';
        if (video.error) return `el vídeo no se pudo decodificar (código ${video.error.code})`;
        if (video.readyState < 2) return 'el vídeo aún no tiene ningún frame listo';
        return null;
    }

    /** Draws continuously so the motion is real while the benchmark runs. */
    start(): void {
        if (this.rafId) return;
        this.startedAt = performance.now();
        const loop = () => {
            this.rafId = requestAnimationFrame(loop);
            this.render(performance.now());
        };
        this.rafId = requestAnimationFrame(loop);
    }

    stop(): void {
        cancelAnimationFrame(this.rafId);
        this.rafId = 0;
    }

    /**
     * Draws the current frame and returns how long the copy took.
     *
     * The benchmark calls this itself, immediately before handing the canvas to
     * the engine, so the number it gets is the capture cost on exactly the frame
     * the model will read (not a leftover from the animation loop).
     */
    frame(): number {
        const started = performance.now();
        this.render(performance.now());
        return performance.now() - started;
    }

    private render(now: number): void {
        const ctx = this.context;
        if (!ctx) return;

        // Keep the clip inside its useful window instead of letting it run off to
        // frames where the platform is a few pixels wide.
        if (this.video && this.videoLoop && this.video.readyState >= 1) {
            const { start, end } = this.videoLoop;
            const now = this.video.currentTime;
            if (now < start || now > end) {
                // Seeking before metadata arrives throws on iOS; the guard above is
                // the contract, the try/catch is the belt and braces.
                try {
                    this.video.currentTime = start;
                } catch {
                    // Nothing to do: the next frame tries again.
                }
            }
        }

        const t = (now - this.startedAt) / 1000;
        const width = this.canvas.width;
        const height = this.canvas.height;

        ctx.fillStyle = '#05070d';
        ctx.fillRect(0, 0, width, height);
        ctx.save();

        let dx = 0;
        let dy = 0;
        let rotation = 0;
        let scale = 1;

        switch (this.scenario) {
            case 'pan':
                dx = Math.sin(t * 2 * Math.PI) * 40;
                dy = Math.cos(t * 2 * Math.PI) * 12;
                break;
            case 'vibracion':
                // 8 Hz, a couple of pixels: the "resbala" case, deliberately.
                dx = Math.sin(t * 2 * Math.PI * 8) * 3;
                dy = Math.cos(t * 2 * Math.PI * 7) * 2;
                break;
            case 'rotacion':
                rotation = (Math.sin(t * 2 * Math.PI * 0.5) * 8 * Math.PI) / 180;
                break;
            case 'zoom':
                scale = 1 + Math.sin(t * 2 * Math.PI * 0.3) * 0.1;
                break;
            default:
                break;
        }

        ctx.translate(width / 2 + dx, height / 2 + dy);
        ctx.rotate(rotation);
        ctx.scale(scale, scale);
        ctx.translate(-width / 2, -height / 2);

        if (this.scenario === 'video' && this.video && this.video.readyState >= 2) {
            this.drawCover(ctx, this.video, width, height);
        } else {
            const index =
                this.scenario === 'cambio' ? (Math.floor(t / 2) % 2 === 0 ? 0 : 1) : 0;
            const image = this.images[index] ?? this.images[0];
            if (image) this.drawCover(ctx, image, width, height);
        }

        ctx.restore();
    }

    /** `object-fit: cover`, so the aspect ratio never distorts the platform. */
    private drawCover(
        ctx: CanvasRenderingContext2D,
        source: CanvasImageSource & { width?: number; height?: number; videoWidth?: number; videoHeight?: number },
        width: number,
        height: number
    ): void {
        const sourceWidth =
            (source as HTMLVideoElement).videoWidth || (source as HTMLImageElement).naturalWidth || width;
        const sourceHeight =
            (source as HTMLVideoElement).videoHeight || (source as HTMLImageElement).naturalHeight || height;
        const scale = Math.max(width / sourceWidth, height / sourceHeight);
        const drawWidth = sourceWidth * scale;
        const drawHeight = sourceHeight * scale;
        ctx.drawImage(source, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
    }
}
