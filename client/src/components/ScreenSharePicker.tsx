import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';

export default function ScreenSharePicker() {
  const [sources, setSources] = useState<ScreenShareSource[] | null>(null);

  useEffect(() => {
    if (!window.electron) return;
    return window.electron.onScreenShareSources((incoming) => {
      setSources(incoming);
    });
  }, []);

  const select = useCallback((id: string | null) => {
    window.electron?.selectScreenShareSource(id);
    setSources(null);
  }, []);

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) select(null);
  }, [select]);

  useEffect(() => {
    if (!sources) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sources, select]);

  if (!sources) return null;

  const screens = sources.filter((s) => s.isScreen);
  const windows = sources.filter((s) => !s.isScreen);

  return createPortal(
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="screen-share-picker-modal">
        <div className="screen-share-picker-header">
          <h2>Choose what to share</h2>
          <button className="screen-share-picker-close" onClick={() => select(null)}>
            &times;
          </button>
        </div>

        {screens.length > 0 && (
          <>
            <h3 className="screen-share-picker-section">Screens</h3>
            <div className="screen-share-picker-grid">
              {screens.map((source) => (
                <button
                  key={source.id}
                  className="screen-share-picker-item"
                  onClick={() => select(source.id)}
                >
                  <img
                    className="screen-share-picker-thumbnail"
                    src={source.thumbnail}
                    alt={source.name}
                  />
                  <span className="screen-share-picker-name">{source.name}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {windows.length > 0 && (
          <>
            <h3 className="screen-share-picker-section">Windows</h3>
            <div className="screen-share-picker-grid">
              {windows.map((source) => (
                <button
                  key={source.id}
                  className="screen-share-picker-item"
                  onClick={() => select(source.id)}
                >
                  <img
                    className="screen-share-picker-thumbnail"
                    src={source.thumbnail}
                    alt={source.name}
                  />
                  <div className="screen-share-picker-label">
                    {source.appIcon && (
                      <img
                        className="screen-share-picker-icon"
                        src={source.appIcon}
                        alt=""
                      />
                    )}
                    <span className="screen-share-picker-name">{source.name}</span>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
