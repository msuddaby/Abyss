import { useState } from "react";
import { Link } from "react-router-dom";
import api from "@abyss/shared/services/api";
import FormField from "../components/FormField";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await api.post("/auth/forgot-password", { email });
      setSuccess(true);
    } catch (err: any) {
      setError(err.response?.data || "Failed to send reset email. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="auth-page">
        <div className="auth-form">
          <h1>Check your email</h1>
          <p className="auth-subtitle">
            If an account with that email exists, we've sent a password reset link. Check your inbox and spam folder.
          </p>
          <p className="auth-link">
            <Link to="/login">Back to Login</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <form className="auth-form" onSubmit={handleSubmit}>
        <h1>Forgot your password?</h1>
        <p className="auth-subtitle">
          Enter the email address associated with your account and we'll send you a link to reset your password.
        </p>
        {error && <div className="auth-error">{error}</div>}

        <FormField
          label="Email"
          name="Email"
          type="email"
          value={email}
          onChange={setEmail}
          required
          errors={null}
          autoComplete="email"
        />

        <button type="submit" disabled={loading}>
          {loading ? "Sending..." : "Send Reset Link"}
        </button>
        <p className="auth-link">
          <Link to="/login">Back to Login</Link>
        </p>
      </form>
    </div>
  );
}
