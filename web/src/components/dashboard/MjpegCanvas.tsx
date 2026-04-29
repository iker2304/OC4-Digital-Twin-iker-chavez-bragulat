import { useEffect, useRef } from 'react';

interface MjpegCanvasProps {
  src: string;
  className?: string;
  onFrame?: () => void;
  onLoad?: () => void;
  onError?: () => void;
}

/**
 * Consumes an MJPEG stream via fetch + ReadableStream instead of <img>.
 * This allows detecting each delivered frame, which <img> cannot do for MJPEG
 * (onLoad fires only once at connection open, never per-frame).
 */
export function MjpegCanvas({ src, className, onFrame, onLoad, onError }: MjpegCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Stable refs so callbacks never trigger stream restart
  const onFrameRef = useRef(onFrame);
  const onLoadRef = useRef(onLoad);
  const onErrorRef = useRef(onError);
  onFrameRef.current = onFrame;
  onLoadRef.current = onLoad;
  onErrorRef.current = onError;

  useEffect(() => {
    if (!src) return;

    const controller = new AbortController();
    let firstFrame = true;
    let decoding = false;

    const run = async () => {
      try {
        const response = await fetch(src, { signal: controller.signal });
        if (!response.ok || !response.body) {
          onErrorRef.current?.();
          return;
        }

        const reader = response.body.getReader();
        let buf = new Uint8Array(0);

        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;

          // Append incoming chunk to buffer
          const tmp = new Uint8Array(buf.length + value.length);
          tmp.set(buf);
          tmp.set(value, buf.length);
          buf = tmp;

          // Extract all complete JPEG frames from the buffer
          let offset = 0;
          while (offset < buf.length - 1) {
            // Find SOI marker (0xFF 0xD8)
            let soi = -1;
            for (let i = offset; i < buf.length - 1; i++) {
              if (buf[i] === 0xFF && buf[i + 1] === 0xD8) { soi = i; break; }
            }
            if (soi === -1) break;

            // Find EOI marker (0xFF 0xD9) after SOI
            let eoi = -1;
            for (let i = soi + 2; i < buf.length - 1; i++) {
              if (buf[i] === 0xFF && buf[i + 1] === 0xD9) { eoi = i + 1; break; }
            }
            if (eoi === -1) break; // Frame not yet complete

            const frame = buf.slice(soi, eoi + 1);
            offset = eoi + 1;

            // Skip frame if the previous decode hasn't finished (keep latency low)
            if (!decoding) {
              decoding = true;
              createImageBitmap(new Blob([frame], { type: 'image/jpeg' }))
                .then((bitmap) => {
                  decoding = false;
                  if (controller.signal.aborted) { bitmap.close(); return; }
                  const canvas = canvasRef.current;
                  if (canvas) {
                    if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
                    if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
                    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
                    bitmap.close();
                  }
                  if (firstFrame) { firstFrame = false; onLoadRef.current?.(); }
                  onFrameRef.current?.();
                })
                .catch(() => { decoding = false; });
            }
          }

          if (offset > 0) buf = buf.slice(offset);
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') onErrorRef.current?.();
      }
    };

    run();
    return () => controller.abort();
  }, [src]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ display: 'block', maxWidth: '100%', maxHeight: '100%' }}
    />
  );
}
