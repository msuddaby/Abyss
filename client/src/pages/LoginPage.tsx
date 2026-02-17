import { useState } from "react";
import { useAuthStore, useServerConfigStore, parseValidationErrors, getGeneralError } from "@abyss/shared";
import { Link, useNavigate } from "react-router-dom";
import { Capacitor } from "@capacitor/core";
import ServerSetupModal from "../components/ServerSetupModal";
import FormField from "../components/FormField";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [validationErrors, setValidationErrors] = useState<Record<string, string[]> | null>(null);
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
    setValidationErrors(null);
    try {
      await login(username, password);
      navigate("/");
    } catch (err: any) {
      const parsedErrors = parseValidationErrors(err);
      if (parsedErrors) {
        setValidationErrors(parsedErrors);
        const generalError = getGeneralError(parsedErrors);
        if (generalError) {
          setError(generalError);
        }
      } else {
        setError(err.response?.data || "Login failed");
      }
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

          <FormField
            label="Username"
            name="Username"
            type="text"
            value={username}
            onChange={setUsername}
            required
            errors={validationErrors}
            autoComplete="username"
          />

          <FormField
            label="Password"
            name="Password"
            type="password"
            value={password}
            onChange={setPassword}
            required
            errors={validationErrors}
            autoComplete="current-password"
          />

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
