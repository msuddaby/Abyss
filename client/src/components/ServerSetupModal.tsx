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
  const recentInstances = useServerConfigStore((s) => s.recentInstances);
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
          setTesting(false);
          return;
        } else if (err.response) {
          // Server responded - that's good enough (CORS errors still mean server is reachable)
          console.log('Server is reachable (status:', err.response.status, ')');
        } else if (err.message?.includes('Network Error') || err.message?.includes('CORS')) {
          // CORS error means server exists but doesn't allow app://abyss origin - that's fine
          console.log('Server detected (CORS blocked but server is reachable)');
        } else {
          setError('Unable to connect to server. Please check the URL.');
          setTesting(false);
          return;
        }
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

  const handleSelectInstance = (instanceUrl: string) => {
    setServerUrl(instanceUrl);
    setApiBase(instanceUrl);
    onComplete();
  };

  return createPortal(
    <div className="modal-overlay">
      <div className="modal server-setup-modal" onClick={(e) => e.stopPropagation()}>
        <div className="server-setup-content">
          <h1 className="server-setup-title">Welcome to Abyss</h1>
          <p className="server-setup-subtitle">
            Connect to an Abyss instance to get started.
          </p>

          {recentInstances.length > 0 && (
            <div className="recent-instances">
              <div className="recent-instances-title">Recent Instances</div>
              <div className="recent-instances-list">
                {recentInstances.map((instance) => (
                  <button
                    key={instance.url}
                    type="button"
                    className="recent-instance-card"
                    onClick={() => handleSelectInstance(instance.url)}
                    disabled={testing}
                  >
                    <div className="recent-instance-name">
                      {instance.nickname || new URL(instance.url).hostname}
                    </div>
                    <div className="recent-instance-url">{instance.url}</div>
                  </button>
                ))}
              </div>
              <div className="recent-instances-divider">
                <span>or connect to a new instance</span>
              </div>
            </div>
          )}

          <div className="us-card">
            <label>
              Instance URL
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://abyss.example.com"
                disabled={testing}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') testAndSave();
                }}
                autoFocus={recentInstances.length === 0}
              />
            </label>

            {error && <div className="server-setup-error">{error}</div>}

            <div className="server-setup-help">
              Enter the URL of your Abyss instance. If you're self-hosting, this is the address where your backend is running.
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
