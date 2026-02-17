import { useState } from "react";
import { useAuthStore, useServerConfigStore, parseValidationErrors, getGeneralError } from "@abyss/shared";
import { Link, useNavigate } from "react-router-dom";
import { Capacitor } from "@capacitor/core";
import ServerSetupModal from "../components/ServerSetupModal";
import FormField from "../components/FormField";

export default function RegisterPage() {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState("");
  const [validationErrors, setValidationErrors] = useState<Record<string, string[]> | null>(null);
  const register = useAuthStore((s) => s.register);
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
      await register(
        username,
        email,
        password,
        displayName,
        inviteCode.trim() || undefined,
      );
      navigate("/");
    } catch (err: any) {
      // Try to parse validation errors
      const parsedErrors = parseValidationErrors(err);
      if (parsedErrors) {
        setValidationErrors(parsedErrors);
        // Show general error if present
        const generalError = getGeneralError(parsedErrors);
        if (generalError) {
          setError(generalError);
        }
      } else {
        // Fallback to old error handling for non-validation errors
        const data = err.response?.data;
        if (Array.isArray(data)) {
          setError(data.map((e: any) => e.description).join(", "));
        } else {
          setError(data || "Registration failed");
        }
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
          <h1>Create an account</h1>
          {error && <div className="auth-error">{error}</div>}

          <FormField
            label="Email"
            name="Email"
            type="email"
            value={email}
            onChange={setEmail}
            required
            errors={validationErrors}
            autoComplete="email"
          />

          <FormField
            label="Display Name"
            name="DisplayName"
            type="text"
            value={displayName}
            onChange={setDisplayName}
            required
            errors={validationErrors}
            autoComplete="name"
          />

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
            autoComplete="new-password"
          />

          <FormField
            label="Invite Code"
            name="InviteCode"
            type="text"
            value={inviteCode}
            onChange={setInviteCode}
            placeholder="Only required if invite-only is enabled"
            errors={validationErrors}
          />

          <button type="submit">Continue</button>
          <p className="auth-link">
            <Link to="/login">Already have an account?</Link>
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
