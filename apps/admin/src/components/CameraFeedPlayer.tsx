import { useEffect, useRef } from "react";
import Hls from "hls.js";

export function CameraFeedPlayer({ playbackUrl, cameraName }: { playbackUrl: string; cameraName: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    video.muted = true;
    video.playsInline = true;

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = playbackUrl;
      void video.play().catch(() => undefined);
      const keepNearLiveEdge = () => {
        const seekable = video.seekable;
        if (!seekable || seekable.length === 0) return;
        const liveEdge = seekable.end(seekable.length - 1);
        const lag = liveEdge - video.currentTime;
        if (lag > 1.2) {
          video.currentTime = Math.max(0, liveEdge - 0.15);
        }
      };
      const timer = window.setInterval(keepNearLiveEdge, 500);
      return () => {
        window.clearInterval(timer);
        video.pause();
        video.removeAttribute("src");
        video.load();
      };
    }

    if (!Hls.isSupported()) return;

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      liveSyncDurationCount: 1,
      liveMaxLatencyDurationCount: 2,
      maxBufferLength: 1,
      maxMaxBufferLength: 2,
      backBufferLength: 0,
      maxBufferSize: 0,
      highBufferWatchdogPeriod: 0.5
    });
    hlsRef.current = hls;
    hls.attachMedia(video);
    hls.on(Hls.Events.MEDIA_ATTACHED, () => {
      hls.loadSource(playbackUrl);
    });
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      void video.play().catch(() => undefined);
    });
    const liveEdgeTimer = window.setInterval(() => {
      const liveSyncPosition = hls.liveSyncPosition;
      if (typeof liveSyncPosition !== "number") return;
      if (liveSyncPosition - video.currentTime > 1.2) {
        video.currentTime = Math.max(0, liveSyncPosition - 0.1);
      }
    }, 500);

    return () => {
      window.clearInterval(liveEdgeTimer);
      hlsRef.current?.destroy();
      hlsRef.current = null;
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [playbackUrl]);

  return <video ref={videoRef} className="aspect-video w-full rounded-box bg-black" controls autoPlay playsInline title={cameraName} />;
}
