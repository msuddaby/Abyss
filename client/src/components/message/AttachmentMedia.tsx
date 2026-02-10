import { useState, useRef, useEffect } from "react";
import { getApiBase } from "@abyss/shared";
import type { Attachment } from "@abyss/shared";
import { formatFileSize } from "../../utils/messageUtils";

// Extend HTMLVideoElement with webkit-specific properties for iOS
interface WebkitHTMLVideoElement extends HTMLVideoElement {
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
}

export default function AttachmentMedia({ att }: { att: Attachment }) {
  const [active, setActive] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const videoShellRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setActive(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const src = active ? `${getApiBase()}${att.filePath}` : undefined;
  const poster = att.posterPath
    ? `${getApiBase()}${att.posterPath}`
    : undefined;
  const sizeLabel = formatFileSize(att.size);
  const isVideo = att.contentType.startsWith("video/");
  const isAudio = att.contentType.startsWith("audio/");

  const formatPlaybackTime = (timeSeconds: number) => {
    if (!Number.isFinite(timeSeconds)) return "0:00";
    const total = Math.max(0, Math.floor(timeSeconds));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  useEffect(() => {
    if (!isVideo || !videoRef.current) return;
    const video = videoRef.current;

    const handleLoaded = () => {
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      setCurrentTime(video.currentTime || 0);
    };
    const handleTime = () => setCurrentTime(video.currentTime || 0);
    const handlePlay = () => setPlaying(true);
    const handlePause = () => setPlaying(false);
    const handleVolume = () => {
      setVolume(video.volume);
      setMuted(video.muted);
    };

    video.addEventListener("loadedmetadata", handleLoaded);
    video.addEventListener("timeupdate", handleTime);
    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);
    video.addEventListener("volumechange", handleVolume);

    return () => {
      video.removeEventListener("loadedmetadata", handleLoaded);
      video.removeEventListener("timeupdate", handleTime);
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePause);
      video.removeEventListener("volumechange", handleVolume);
    };
  }, [isVideo]);

  useEffect(() => {
    if (!isAudio || !audioRef.current) return;
    const audio = audioRef.current;

    const handleLoaded = () => {
      setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
      setCurrentTime(audio.currentTime || 0);
    };
    const handleTime = () => setCurrentTime(audio.currentTime || 0);
    const handlePlay = () => setPlaying(true);
    const handlePause = () => setPlaying(false);
    const handleVolume = () => {
      setVolume(audio.volume);
      setMuted(audio.muted);
    };

    audio.addEventListener("loadedmetadata", handleLoaded);
    audio.addEventListener("timeupdate", handleTime);
    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("volumechange", handleVolume);

    return () => {
      audio.removeEventListener("loadedmetadata", handleLoaded);
      audio.removeEventListener("timeupdate", handleTime);
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("volumechange", handleVolume);
    };
  }, [isAudio]);

  useEffect(() => {
    if (!isVideo) return;
    const handleFullscreen = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", handleFullscreen);
    return () =>
      document.removeEventListener("fullscreenchange", handleFullscreen);
  }, [isVideo]);

  const togglePlay = () => {
    if (isVideo) {
      const video = videoRef.current;
      if (!video) return;
      if (video.paused) {
        video.play().catch(() => {});
      } else {
        video.pause();
      }
      return;
    }
    if (isAudio) {
      const audio = audioRef.current;
      if (!audio) return;
      if (audio.paused) {
        audio.play().catch(() => {});
      } else {
        audio.pause();
      }
    }
  };

  const handleSeek = (value: number) => {
    if (isVideo) {
      const video = videoRef.current;
      if (!video) return;
      video.currentTime = value;
    } else if (isAudio) {
      const audio = audioRef.current;
      if (!audio) return;
      audio.currentTime = value;
    }
    setCurrentTime(value);
  };

  const handleVolumeChange = (value: number) => {
    if (isVideo) {
      const video = videoRef.current;
      if (!video) return;
      video.volume = value;
      video.muted = value === 0;
      setVolume(value);
      setMuted(video.muted);
    } else if (isAudio) {
      const audio = audioRef.current;
      if (!audio) return;
      audio.volume = value;
      audio.muted = value === 0;
      setVolume(value);
      setMuted(audio.muted);
    }
  };

  const toggleMute = () => {
    if (isVideo) {
      const video = videoRef.current;
      if (!video) return;
      video.muted = !video.muted;
      setMuted(video.muted);
      if (!video.muted && video.volume === 0) {
        video.volume = 0.5;
        setVolume(0.5);
      }
      return;
    }
    if (isAudio) {
      const audio = audioRef.current;
      if (!audio) return;
      audio.muted = !audio.muted;
      setMuted(audio.muted);
      if (!audio.muted && audio.volume === 0) {
        audio.volume = 0.5;
        setVolume(0.5);
      }
    }
  };

  const toggleFullscreen = () => {
    const container = videoShellRef.current ?? containerRef.current;
    const video = videoRef.current;
    if (!document.fullscreenElement) {
      if (container?.requestFullscreen) {
        container.requestFullscreen().catch(() => {});
        return;
      }
      if (video && (video as WebkitHTMLVideoElement).webkitEnterFullscreen) {
        (video as WebkitHTMLVideoElement).webkitEnterFullscreen?.();
      }
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  };

  if (isVideo) {
    return (
      <div className="attachment-media" ref={containerRef}>
        <div className="attachment-video-shell" ref={videoShellRef}>
          <video
            className="attachment-video"
            ref={videoRef}
            preload="metadata"
            playsInline
            poster={poster}
            src={src}
            onClick={togglePlay}
          />
          {!playing && (
            <button className="attachment-play-overlay" onClick={togglePlay}>
              Play
            </button>
          )}
          {playing && (
            <>
              <div className="attachment-video-topbar">
                <button
                  className="attachment-control-btn"
                  onClick={toggleFullscreen}
                >
                  {isFullscreen ? "Exit" : "Full"}
                </button>
                <a
                  className="attachment-download"
                  href={`${getApiBase()}${att.filePath}`}
                  download={att.fileName}
                >
                  Download
                </a>
              </div>
              <div className="attachment-video-bottombar">
                <button className="attachment-control-btn" onClick={togglePlay}>
                  Pause
                </button>
                <span className="attachment-time">
                  {formatPlaybackTime(currentTime)} /{" "}
                  {formatPlaybackTime(duration)}
                </span>
                <input
                  className="attachment-seek"
                  type="range"
                  min={0}
                  max={duration || 0}
                  step={0.1}
                  value={Math.min(currentTime, duration || 0)}
                  onChange={(e) => handleSeek(Number(e.target.value))}
                />
                <button className="attachment-control-btn" onClick={toggleMute}>
                  {muted || volume === 0 ? "Muted" : "Mute"}
                </button>
                <input
                  className="attachment-volume"
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={muted ? 0 : volume}
                  onChange={(e) => handleVolumeChange(Number(e.target.value))}
                />
              </div>
            </>
          )}
        </div>
        <div className="attachment-meta">
          <div className="attachment-meta-left">
            <span className="attachment-name">{att.fileName}</span>
            {sizeLabel && <span className="attachment-size">{sizeLabel}</span>}
          </div>
        </div>
      </div>
    );
  }

  if (isAudio) {
    return (
      <div className="attachment-media" ref={containerRef}>
        <div className="attachment-audio-shell">
          <audio
            className="attachment-audio"
            ref={audioRef}
            preload="metadata"
            src={src}
            onClick={togglePlay}
          />
          <div className="attachment-audio-controls">
            <button className="attachment-control-btn" onClick={togglePlay}>
              {playing ? "Pause" : "Play"}
            </button>
            <span className="attachment-time">
              {formatPlaybackTime(currentTime)} / {formatPlaybackTime(duration)}
            </span>
            <input
              className="attachment-seek"
              type="range"
              min={0}
              max={duration || 0}
              step={0.1}
              value={Math.min(currentTime, duration || 0)}
              onChange={(e) => handleSeek(Number(e.target.value))}
            />
            <button className="attachment-control-btn" onClick={toggleMute}>
              {muted || volume === 0 ? "Muted" : "Mute"}
            </button>
            <input
              className="attachment-volume"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={muted ? 0 : volume}
              onChange={(e) => handleVolumeChange(Number(e.target.value))}
            />
            <a
              className="attachment-download"
              href={`${getApiBase()}${att.filePath}`}
              download={att.fileName}
            >
              Download
            </a>
          </div>
        </div>
        <div className="attachment-meta">
          <span className="attachment-name">{att.fileName}</span>
          {sizeLabel && <span className="attachment-size">{sizeLabel}</span>}
        </div>
      </div>
    );
  }

  return (
    <a
      className="attachment-file"
      href={`${getApiBase()}${att.filePath}`}
      target="_blank"
      rel="noopener noreferrer"
    >
      {att.fileName}
      {sizeLabel && <span className="attachment-size"> · {sizeLabel}</span>}
    </a>
  );
}
