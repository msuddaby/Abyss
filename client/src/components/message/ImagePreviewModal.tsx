import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { getApiBase } from "@abyss/shared";
import type { Attachment } from "@abyss/shared";

type ImagePreviewSource =
  | { kind: "attachment"; attachment: Attachment }
  | { kind: "url"; url: string; fileName: string };

export default function ImagePreviewModal({
  source,
  onClose,
}: {
  source: ImagePreviewSource;
  onClose: () => void;
}) {
  const imgUrl =
    source.kind === "attachment"
      ? `${getApiBase()}${source.attachment.filePath}`
      : source.url;
  const fileName =
    source.kind === "attachment" ? source.attachment.fileName : source.fileName;
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const isDragging = useRef(false);
  const didDrag = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const translateStart = useRef({ x: 0, y: 0 });
  const mouseDownTarget = useRef<EventTarget | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setScale((prev) => {
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const next = prev * delta;
      if (next <= 1) {
        setTranslate({ x: 0, y: 0 });
        return 1;
      }
      return Math.min(next, 10);
    });
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      mouseDownTarget.current = e.target;
      didDrag.current = false;
      dragStart.current = { x: e.clientX, y: e.clientY };
      translateStart.current = { ...translate };
      if (scale > 1) {
        e.preventDefault();
        isDragging.current = true;
      }
    },
    [scale, translate],
  );

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag.current = true;
    if (!isDragging.current) return;
    setTranslate({
      x: translateStart.current.x + dx,
      y: translateStart.current.y + dy,
    });
  }, []);

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      isDragging.current = false;
      if (!didDrag.current && mouseDownTarget.current === e.target) {
        const tag = (e.target as HTMLElement).tagName;
        if (tag !== "IMG") onClose();
      }
    },
    [onClose],
  );

  const handleDoubleClick = useCallback(() => {
    if (scale > 1) {
      setScale(1);
      setTranslate({ x: 0, y: 0 });
    } else {
      setScale(3);
    }
  }, [scale]);

  const isZoomed = scale > 1;

  return createPortal(
    <div
      className="image-preview-overlay"
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onDoubleClick={handleDoubleClick}
      style={{ cursor: isZoomed ? "grab" : "default" }}
    >
      <div className="image-preview-toolbar" onMouseDown={(e) => e.stopPropagation()}>
        <button
          className="image-preview-toolbar-btn"
          title="Download"
          onClick={(e) => {
            e.stopPropagation();
            fetch(imgUrl)
              .then((res) => res.blob())
              .then((blob) => {
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = fileName;
                a.click();
                URL.revokeObjectURL(a.href);
              })
              .catch(() => {
                window.open(imgUrl, "_blank", "noopener");
              });
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
        <button
          className="image-preview-toolbar-btn"
          onClick={onClose}
          title="Close"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <img
        src={imgUrl}
        alt={fileName}
        className="image-preview-img"
        draggable={false}
        style={{
          transform: `scale(${scale}) translate(${translate.x / scale}px, ${translate.y / scale}px)`,
        }}
      />
    </div>,
    document.body,
  );
}
