import { useEffect } from "react";
import { createPortal } from "react-dom";
import { getApiBase } from "@abyss/shared";
import type { Attachment } from "@abyss/shared";

export default function ImagePreviewModal({
  attachment,
  onClose,
}: {
  attachment: Attachment;
  onClose: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return createPortal(
    <div className="modal-overlay image-preview-overlay" onClick={onClose}>
      <div className="image-preview-modal" onClick={(e) => e.stopPropagation()}>
        <img
          src={`${getApiBase()}${attachment.filePath}`}
          alt={attachment.fileName}
          className="image-preview-img"
        />
        <div className="image-preview-actions">
          <a
            className="image-download-btn"
            href={`${getApiBase()}${attachment.filePath}`}
            download={attachment.fileName}
          >
            Download
          </a>
          <button className="btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
