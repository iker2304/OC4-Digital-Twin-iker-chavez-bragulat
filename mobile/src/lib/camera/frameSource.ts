/**
 * Frame source: the `<video>` element currently feeding the app.
 *
 * The light estimate is a one-shot action triggered from the settings sheet, so
 * it needs the current frame. Threading a ref down through the camera stack into
 * the panel would mean a prop on six components; a module singleton set by the
 * one place that attaches the stream is enough and keeps the tree clean.
 */
let element: HTMLVideoElement | null = null;

export function setFrameSource(video: HTMLVideoElement | null) {
    element = video;
}

export function getFrameSource(): HTMLVideoElement | null {
    if (!element) return null;
    // A detached or paused element has no usable frame.
    if (!element.isConnected || element.readyState < 2) return null;
    return element;
}
