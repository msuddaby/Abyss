import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { parseValidationErrors, getGeneralError } from "@abyss/shared";
import api from "@abyss/shared/services/api";
import FormField from "../components/FormField";

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") || "";
  const email = searchParams.get("email") || "";

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [validationErrors, setValidationErrors] = useState<Record<string, string[]> | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  if (!token || !email) {
    return (
      <div className="auth-page">
        <div className="auth-form">
          <h1>Invalid Reset Link</h1>
          <p className="auth-subtitle">
            This password reset link is invalid or has expired. Please request a new one.
          </p>
          <p className="auth-link">
            <Link to="/forgot-password">Request New Link</Link>
          </p>
        </div>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setValidationErrors(null);

    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    try {
      await api.post("/auth/reset-password", { email, token, newPassword });
      setSuccess(true);
    } catch (err: any) {
      const parsedErrors = parseValidationErrors(err);
      if (parsedErrors) {
        setValidationErrors(parsedErrors);
        const generalError = getGeneralError(parsedErrors);
        if (generalError) setError(generalError);
      } else {
        setError(err.response?.data || "Failed to reset password. The link may have expired.");
      }
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="auth-page">
        <div className="auth-form">
          <h1>Password Reset</h1>
          <p className="auth-subtitle">
            Your password has been reset successfully. You can now log in with your new password.
          </p>
          <p className="auth-link">
            <Link to="/login">Go to Login</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <form className="auth-form" onSubmit={handleSubmit}>
        <h1>Reset your password</h1>
        <p className="auth-subtitle">Enter your new password below.</p>
        {error && <div className="auth-error">{error}</div>}

        <FormField
          label="New Password"
          name="NewPassword"
          type="password"
          value={newPassword}
          onChange={setNewPassword}
          required
          errors={validationErrors}
          autoComplete="new-password"
        />

        <FormField
          label="Confirm Password"
          name="ConfirmPassword"
          type="password"
          value={confirmPassword}
          onChange={setConfirmPassword}
          required
          errors={null}
          autoComplete="new-password"
        />

        <button type="submit" disabled={loading}>
          {loading ? "Resetting..." : "Reset Password"}
        </button>
        <p className="auth-link">
          <Link to="/login">Back to Login</Link>
        </p>
      </form>
    </div>
  );
}
