/**
 * The frame that was actually inferred, kept around so it can be shown.
 *
 * ## The problem this solves
 *
 * The preview used to be the live `<video>`: what the camera sees *now*. The
 * detections, however, belong to a frame grabbed one inference ago — 100 ms on
 * this laptop, more on a phone. So the boxes and the twin were painted on top of
 * a *newer* image than the one the model looked at, and any camera movement in
 * between showed up as the overlay "sliding" away from the platform.
 *
 * Capturing the frame into a canvas before running the model fixes it at the
 * source: the canvas is both what the model reads (`engine.run` takes any
 * `CanvasImageSource`) and what the user sees, so the two can never disagree.
 *
 * Cost is one `drawImage` of a video frame per inference (≈0.5-2 ms, GPU-backed),
 * and only while the mode is on.
 */
let canvas: HTMLCanvasElement | null = null;
let context: CanvasRenderingContext2D | null = null;

/** The canvas everyone shares: one buffer, so no allocation per frame. */
export function syncedFrameCanvas(): HTMLCanvasElement {
    if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.width = 2;
        canvas.height = 2;
        // Same covering rule as the `<video>` it replaces.
        canvas.className = 'absolute inset-0 h-full w-full object-cover';
        canvas.setAttribute('aria-hidden', 'true');
        // Invisible until it holds a real frame: otherwise a 2x2 black canvas
        // stretched full-screen would hide the live video for the second and a
        // half before the first inference lands.
        canvas.style.opacity = '0';
    }
    return canvas;
}

/**
 * Copies the current video frame into the shared canvas and returns it.
 *
 * Returns `null` when the video has no usable frame yet, so the caller can fall
 * back to the element itself instead of feeding the model a 2×2 black canvas.
 */
export function captureFrame(video: HTMLVideoElement): HTMLCanvasElement | null {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return null;

    const target = syncedFrameCanvas();
    if (target.width !== width || target.height !== height) {
        target.width = width;
        target.height = height;
        // Resizing resets the context state, so drop the cached handle.
        context = null;
    }
    context ??= target.getContext('2d', { alpha: false, desynchronized: true });
    if (!context) return null;

    try {
        context.drawImage(video, 0, 0, width, height);
    } catch (error) {
        /**
         * A camera that renegotiates its format, or a frame that cannot be decoded
         * at that instant, makes `drawImage` throw. Returning `null` hands the
         * caller the live element instead of killing the inference loop, which is
         * what a thrown exception here used to do (it left the loop's `busy` flag
         * stuck for good and the preview frozen).
         */
        console.warn('[syncedFrame] no pude copiar el frame:', error);
        return null;
    }

    if (target.style.opacity !== '1') target.style.opacity = '1';
    return target;
}
