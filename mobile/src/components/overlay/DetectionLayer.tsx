/**
 * 2D overlay: bounding boxes, labels and pose keypoints.
 *
 * Drawn on a plain 2D canvas instead of as DOM nodes because it is repainted up
 * to ~15 times per second; a few dozen divs would thrash layout, a canvas does
 * not. Detections arrive in *source-video pixels*, so the cover-crop transform
 * is applied here to keep boxes glued to the objects they describe.
 */
import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/appStore';
import { computeCover, sourceToDisplay } from '../../lib/geometry';
import { POSE_SKELETON } from '../../lib/labels';
import { KEYPOINTS_SCENE } from '../../lib/pose/keypoints3d';
import { projectToSource } from '../../lib/pose/cameraRig';
import { intrinsicsFromFov } from '../../lib/pose/solvePnP';
import { cn } from '../../lib/cn';

const MIN_KEYPOINT_SCORE = 0.35;

export function DetectionLayer({ className }: { className?: string }) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [resizeTick, setResizeTick] = useState(0);

    const detections = useAppStore((state) => state.detections);
    const videoSize = useAppStore((state) => state.videoSize);
    const rawMirrored = useAppStore((state) => state.mirrored);
    const poseEnabled = useAppStore((state) => state.poseEnabled);
    const blend = useAppStore((state) => state.blend);
    const showBoxes = useAppStore((state) => state.showBoxes);
    const showKeypoints = useAppStore((state) => state.showKeypoints);
    const showReprojection = useAppStore((state) => state.showReprojection);
    const pose = useAppStore((state) => state.pose);
    const poseHfovDeg = useAppStore((state) => state.poseHfovDeg);

    /**
     * The canvas is a sibling of the video, so it only mirrors when the video
     * does. PnP mode keeps the preview unmirrored (see `CameraStack`), otherwise
     * the blue boxes would sit on the wrong side of the platform.
     */
    const mirrored = rawMirrored && !poseEnabled;
    useEffect(() => {
        const canvas = canvasRef.current;
        const parent = canvas?.parentElement;
        if (!canvas || !parent) return; const observer = new ResizeObserver(() => setResizeTick((tick) => tick + 1));
        observer.observe(parent);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        const canvas = canvasRef.current;
        const parent = canvas?.parentElement;
        if (!canvas || !parent) return;

        const width = parent.clientWidth;
        const height = parent.clientHeight;
        if (width <= 0 || height <= 0) return;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const pixelWidth = Math.round(width * dpr);
        const pixelHeight = Math.round(height * dpr);
        if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
            canvas.width = pixelWidth;
            canvas.height = pixelHeight;
        }

        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);

        // Reticle: helps the user aim even when nothing is detected yet.
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(width / 2 - 9, height / 2);
        ctx.lineTo(width / 2 + 9, height / 2);
        ctx.moveTo(width / 2, height / 2 - 9);
        ctx.lineTo(width / 2, height / 2 + 9);
        ctx.stroke();

        if ((!showBoxes && !showKeypoints) || detections.length === 0) {
            // The reprojection check still has to run: it is the alignment proof.
            drawReprojection(ctx, width, height);
            return;
        }

        const { width: srcWidth, height: srcHeight } = videoSize;
        if (srcWidth <= 0 || srcHeight <= 0) return;

        const cover = computeCover(srcWidth, srcHeight, width, height, mirrored);
        // As the twin takes over, detections fade back so they read as annotations
        // of the real feed rather than competing with the 3D scene.
        const alpha = 1 - blend * 0.4;

        for (const detection of detections) {
            const [x1, y1] = sourceToDisplay(detection.bbox[0], detection.bbox[1], cover, mirrored);
            const [x2, y2] = sourceToDisplay(detection.bbox[2], detection.bbox[3], cover, mirrored);
            const boxWidth = Math.max(1, x2 - x1);
            const boxHeight = Math.max(1, y2 - y1);
            const stroke = detection.score > 0.6 ? '#22d3ee' : '#fbbf24';

            ctx.globalAlpha = alpha;
            ctx.lineWidth = 2;
            ctx.strokeStyle = stroke;
            if (showBoxes) ctx.strokeRect(x1, y1, boxWidth, boxHeight);

            // Corner ticks: cheaper visually and cleaner than a full glow.
            if (showBoxes) {
                const corner = Math.min(18, boxWidth * 0.25, boxHeight * 0.25);
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.moveTo(x1, y1 + corner);
                ctx.lineTo(x1, y1);
                ctx.lineTo(x1 + corner, y1);
                ctx.moveTo(x2 - corner, y1);
                ctx.lineTo(x2, y1);
                ctx.lineTo(x2, y1 + corner);
                ctx.moveTo(x2, y2 - corner);
                ctx.lineTo(x2, y2);
                ctx.lineTo(x2 - corner, y2);
                ctx.moveTo(x1 + corner, y2);
                ctx.lineTo(x1, y2);
                ctx.lineTo(x1, y2 - corner);
                ctx.stroke();

                const label = `${detection.label} ${(detection.score * 100).toFixed(0)}%`;
                ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
                const textWidth = ctx.measureText(label).width;
                const chipHeight = 20;
                const chipY = y1 - chipHeight - 6 < 0 ? y1 + 6 : y1 - chipHeight - 6;
                ctx.fillStyle = 'rgba(2, 6, 23, 0.78)';
                ctx.beginPath();
                ctx.roundRect(x1, chipY, textWidth + 14, chipHeight, 6);
                ctx.fill();
                ctx.strokeStyle = stroke;
                ctx.lineWidth = 1;
                ctx.stroke();
                ctx.fillStyle = '#e2e8f0';
                ctx.fillText(label, x1 + 7, chipY + 14);
            }

            if (showKeypoints && detection.keypoints && detection.keypoints.length > 0) {
                const points = detection.keypoints.map((keypoint) => {
                    const [px, py] = sourceToDisplay(keypoint.x, keypoint.y, cover, mirrored);
                    return { x: px, y: py, score: keypoint.score };
                });

                ctx.strokeStyle = 'rgba(56, 189, 248, 0.85)';
                ctx.lineWidth = 2;
                ctx.beginPath();
                for (const [a, b] of POSE_SKELETON) {
                    const from = points[a];
                    const to = points[b];
                    if (!from || !to) continue;
                    if (from.score < MIN_KEYPOINT_SCORE || to.score < MIN_KEYPOINT_SCORE) continue;
                    ctx.moveTo(from.x, from.y);
                    ctx.lineTo(to.x, to.y);
                }
                ctx.stroke();

                for (const point of points) {
                    if (point.score < MIN_KEYPOINT_SCORE) continue;
                    ctx.beginPath();
                    ctx.fillStyle = point.score > 0.6 ? '#f0abfc' : '#fb923c';
                    ctx.arc(point.x, point.y, 3.2, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }

        ctx.globalAlpha = 1;
        drawReprojection(ctx, width, height);
    }, [detections, videoSize, mirrored, blend, showBoxes, showKeypoints, showReprojection, pose, poseHfovDeg, resizeTick]);

    /**
     * Where the solved pose puts each 3D keypoint. When the twin is aligned, these
     * marks sit exactly on the detected keypoints — that is the whole trick, made
     * visible instead of asserted.
     */
    function drawReprojection(
        ctx: CanvasRenderingContext2D,
        width: number,
        height: number
    ): void {
        if (!showReprojection || !pose) return;
        const { width: srcWidth, height: srcHeight } = videoSize;
        if (srcWidth <= 0 || srcHeight <= 0) return;

        const intrinsics = intrinsicsFromFov(srcWidth, srcHeight, poseHfovDeg);
        const projected = projectToSource(KEYPOINTS_SCENE, pose, intrinsics);
        const cover = computeCover(srcWidth, srcHeight, width, height, mirrored);

        ctx.strokeStyle = '#f0abfc';
        ctx.lineWidth = 1.5;
        for (const [u, v] of projected) {
            if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
            const [x, y] = sourceToDisplay(u, v, cover, mirrored);
            if (x < -20 || y < -20 || x > width + 20 || y > height + 20) continue;
            ctx.beginPath();
            ctx.arc(x, y, 5, 0, Math.PI * 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(x - 8, y);
            ctx.lineTo(x + 8, y);
            ctx.moveTo(x, y - 8);
            ctx.lineTo(x, y + 8);
            ctx.stroke();
        }
    }
    return <canvas ref={canvasRef} className={cn('h-full w-full', className)} />;
}
