import React, { useRef, useEffect, useState } from "react";

interface DetectionOverlayProps {
  detections: Detection[];
  width: number;
  height: number;
  visible?: boolean;
}

interface Detection {
  label: string;
  confidence: number;
  bbox: { x: number; y: number; w: number; h: number };
}

const labelStyle = (label: string) =>
  label
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

/**
 * Returns opacity based on confidence thresholds (same structure as color).
 */
const confOpacity = (c: number) => (c > 0.7 ? 0.85 : c > 0.4 ? 0.6 : 0.35);

const confColor = (c: number) => (c > 0.7 ? "#22c55e" : c > 0.4 ? "#f59e0b" : "#ef4444");

export function DetectionOverlay({ detections, width: frameW, height: frameH, visible = true }: DetectionOverlayProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [vw, setVw] = useState(frameW);
  const [vh, setVh] = useState(frameH);

  // Match viewBox to actual rendered container size
  useEffect(() => {
    const el = svgRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width: w, height: h } = entry.contentRect;
      if (w > 0 && h > 0) {
        setVw(Math.round(w));
        setVh(Math.round(h));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!visible || detections.length === 0) return null;

  // Scale bbox from frame pixel space to rendered viewBox
  const sx = vw / frameW;
  const sy = vh / frameH;

  return (
    <svg
      ref={svgRef}
      data-testid="detection-overlay"
      className="pointer-events-none absolute inset-0 z-10"
      viewBox={`0 0 ${vw} ${vh}`}
      width="100%"
      height="100%"
    >
      {detections.map((det, i) => {
        // bbox in rendered viewBox coordinates
        const x = det.bbox.x * sx;
        const y = det.bbox.y * sy;
        const w = det.bbox.w * sx;
        const h = det.bbox.h * sy;

        const color = confColor(det.confidence);
        const alpha = confOpacity(det.confidence);
        const label = labelStyle(det.label);
        const pct = (det.confidence * 100).toFixed(0);

        return (
          <g key={`${det.label}-${i}`} data-testid="detection-box">
            {/* Bounding box — finer stroke, opacity = f(confidence) */}
            <rect
              x={x}
              y={y}
              width={w}
              height={h}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              rx={0}
              opacity={alpha}
            />
            {/* Label bar */}
            <rect
              x={x}
              y={Math.max(0, y - 24)}
              width={Math.max(70, label.length * 7 + 36)}
              height={24}
              fill={color}
              rx={0}
              opacity={Math.max(alpha, 0.7)}
            />
            <text
              x={x + 5}
              y={Math.max(0, y - 7)}
              fill="white"
              fontSize={12}
              fontFamily="system-ui, sans-serif"
              fontWeight={700}
              className="select-none"
            >
              {label} {pct}%
            </text>
          </g>
        );
      })}
    </svg>
  );
}
