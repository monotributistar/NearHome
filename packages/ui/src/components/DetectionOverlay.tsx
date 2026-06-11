import React from "react";
import type { Detection } from "./useDetectionFeed";

interface DetectionOverlayProps {
  detections: Detection[];
  width: number;
  height: number;
  visible?: boolean;
}

/**
 * Renders bounding boxes and labels over a video element.
 * Positioned absolutely to overlay on top of the <video>.
 */
export function DetectionOverlay({
  detections,
  width,
  height,
  visible = true,
}: DetectionOverlayProps) {
  if (!visible || detections.length === 0) return null;

  return (
    <svg
      data-testid="detection-overlay"
      className="pointer-events-none absolute inset-0 z-10"
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height="100%"
    >
      {detections.map((det, i) => {
        const x = (det.bbox.x * width) / (det.bbox.w > 1 ? width : 1);
        const y = (det.bbox.y * height) / (det.bbox.h > 1 ? height : 1);
        const w = det.bbox.w > 1 ? det.bbox.w : det.bbox.w * width;
        const h = det.bbox.h > 1 ? det.bbox.h : det.bbox.h * height;

        return (
          <g key={`${det.label}-${i}`} data-testid="detection-box">
            <rect
              x={x}
              y={y}
              width={w}
              height={h}
              fill="none"
              stroke="#22c55e"
              strokeWidth={2}
              rx={2}
            />
            <rect
              x={x}
              y={Math.max(0, y - 20)}
              width={Math.max(60, w)}
              height={20}
              fill="#22c55e"
              rx={2}
            />
            <text
              x={x + 4}
              y={Math.max(0, y - 6)}
              fill="white"
              fontSize={12}
              fontFamily="monospace"
            >
              {det.label} {(det.confidence * 100).toFixed(0)}%
            </text>
          </g>
        );
      })}
    </svg>
  );
}
