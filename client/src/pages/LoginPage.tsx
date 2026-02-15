import { useState } from "react";
import { useAuthStore, useServerConfigStore } from "@abyss/shared";
import { Link, useNavigate } from "react-router-dom";
import { Capacitor } from "@capacitor/core";
import ServerSetupModal from "../components/ServerSetupModal";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const login = useAuthStore((s) => s.login);
  const navigate = useNavigate();
  const hasConfigured = useServerConfigStore((s) => s.hasConfigured);
  const [showServerSetup, setShowServerSetup] = useState(!hasConfigured);

  // Check if we're on production web (hide server selection)
  const isProductionWeb = typeof window !== 'undefined' &&
    !window.location.hostname.includes('localhost') &&
    !window.location.hostname.includes('127.0.0.1') &&
    !Capacitor.isNativePlatform() &&
    typeof window.electron === 'undefined';

  const handleSubmit = async (e: React.SubmitEvent) => {
    e.preventDefault();
    setError("");
    try {
      await login(username, password);
      navigate("/");
    } catch (err: any) {
      setError(err.response?.data || "Login failed");
    }
  };

  return (
    <>
      {showServerSetup && (
        <ServerSetupModal
          onComplete={() => setShowServerSetup(false)}
          allowSkip={!!import.meta.env.VITE_API_URL}
        />
      )}
      <div className="auth-page">
        <form className="auth-form" onSubmit={handleSubmit}>
          <h1>Welcome back!</h1>
          <p className="auth-subtitle">We're so excited to see you again!</p>
          {error && <div className="auth-error">{error}</div>}
          <label>
            Username
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <button type="submit">Log In</button>
          <p className="auth-link">
            Need an account? <Link to="/register">Register</Link>
          </p>
          {!isProductionWeb && (
            <p className="auth-link">
              <button
                type="button"
                className="link-button"
                onClick={() => setShowServerSetup(true)}
              >
                Change Server
              </button>
            </p>
          )}
        </form>
      </div>
    </>
  );
}
