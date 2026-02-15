import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useServerConfigStore, setApiBase } from '@abyss/shared';
import axios from 'axios';

interface ServerSetupModalProps {
  onComplete: () => void;
  allowSkip?: boolean;
}

export default function ServerSetupModal({ onComplete, allowSkip = false }: ServerSetupModalProps) {
  const setServerUrl = useServerConfigStore((s) => s.setServerUrl);
  const [url, setUrl] = useState(import.meta.env.VITE_API_URL || '');
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const testAndSave = async () => {
    setError(null);
    setTesting(true);

    try {
      const trimmed = url.trim();
      if (!trimmed) {
        setError('Please enter a server URL');
        setTesting(false);
        return;
      }

      // Test if the server is reachable
      const testUrl = `${trimmed}/health`;
      try {
        await axios.get(testUrl, { timeout: 5000 });
      } catch (err: any) {
        if (err.code === 'ECONNABORTED') {
          setError('Server connection timed out. Please check the URL.');
        } else if (err.response) {
          // Server responded but maybe with error - that's still better than no response
          console.warn('Server responded with status:', err.response.status);
        } else {
          setError('Unable to connect to server. Please check the URL.');
        }
        setTesting(false);
        return;
      }

      // Save and apply
      setServerUrl(trimmed);
      setApiBase(trimmed);
      onComplete();
    } catch (err) {
      console.error('Server setup error:', err);
      setError('Failed to configure server');
    } finally {
      setTesting(false);
    }
  };

  const handleSkip = () => {
    // Use the default from env var
    const defaultUrl = import.meta.env.VITE_API_URL || '';
    if (defaultUrl) {
      setServerUrl(defaultUrl);
      setApiBase(defaultUrl);
    }
    onComplete();
  };

  return createPortal(
    <div className="modal-overlay">
      <div className="modal server-setup-modal" onClick={(e) => e.stopPropagation()}>
        <div className="server-setup-content">
          <h1 className="server-setup-title">Welcome to Abyss</h1>
          <p className="server-setup-subtitle">
            Connect to your Abyss server to get started.
          </p>

          <div className="us-card">
            <label>
              Server URL
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://your-server.com"
                disabled={testing}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') testAndSave();
                }}
                autoFocus
              />
            </label>

            {error && <div className="server-setup-error">{error}</div>}

            <div className="server-setup-help">
              Enter the URL of your Abyss server. If you're self-hosting, this is the address where your server is running.
            </div>
          </div>

          <div className="server-setup-actions">
            {allowSkip && (
              <button
                type="button"
                className="btn-secondary"
                onClick={handleSkip}
                disabled={testing}
              >
                Use Default
              </button>
            )}
            <button
              type="button"
              onClick={testAndSave}
              disabled={testing}
            >
              {testing ? 'Connecting...' : 'Connect'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
