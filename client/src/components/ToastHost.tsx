import { useToastStore } from '@abyss/shared';

export default function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast ${t.type}${t.onAction ? ' clickable' : ''}`}
          onClick={() => {
            if (t.onAction) t.onAction();
            removeToast(t.id);
          }}
        >
          <div className="toast-content">
            {t.title && <div className="toast-title">{t.title}</div>}
            <div className="toast-message">{t.message}</div>
          </div>
          <button
            className="toast-close"
            onClick={(e) => {
              e.stopPropagation();
              removeToast(t.id);
            }}
          >
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}
