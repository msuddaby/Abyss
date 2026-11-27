import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { SHORTCUT_GROUPS } from './shortcuts';

export default function StudioShortcutsModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?' || e.key === 'F1') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal studio-shortcuts-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Studio keyboard shortcuts">
        <div className="studio-shortcuts-head">
          <h2>Keyboard shortcuts</h2>
          <button className="studio-icon-btn" onClick={onClose} title="Close (Esc)">✕</button>
        </div>
        <div className="studio-shortcuts-grid">
          {SHORTCUT_GROUPS.map((g) => (
            <section key={g.title} className="studio-shortcuts-group">
              <h3>{g.title}</h3>
              {g.note && <p className="studio-shortcuts-note">{g.note}</p>}
              <table>
                <tbody>
                  {g.items.map((s) => (
                    <tr key={s.action}>
                      <td className="studio-shortcuts-keys">
                        {s.keys.map((combo, i) => (
                          <span key={i} className="studio-shortcuts-combo">
                            {i > 0 && <span className="studio-shortcuts-or">or</span>}
                            {combo.map((key, j) => (
                              <span key={j}>
                                {j > 0 && <span className="studio-shortcuts-plus">+</span>}
                                <kbd>{key}</kbd>
                              </span>
                            ))}
                          </span>
                        ))}
                      </td>
                      <td>{s.action}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
