import { getFieldError } from "@abyss/shared";

interface FormFieldProps {
  label: string;
  name: string;
  type?: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  placeholder?: string;
  errors?: Record<string, string[]> | null;
  autoComplete?: string;
}

/**
 * Reusable form field component with built-in validation error display.
 * Automatically shows field-level errors from ASP.NET Core validation responses.
 */
export default function FormField({
  label,
  name,
  type = "text",
  value,
  onChange,
  required = false,
  placeholder,
  errors,
  autoComplete,
}: FormFieldProps) {
  const error = getFieldError(errors, name);
  const hasError = !!error;

  return (
    <label className={hasError ? "has-error" : ""}>
      {label}
      <input
        type={type}
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        placeholder={placeholder}
        autoComplete={autoComplete}
        aria-invalid={hasError}
        aria-describedby={hasError ? `${name}-error` : undefined}
      />
      {hasError && (
        <span className="field-error" id={`${name}-error`} role="alert">
          {error}
        </span>
      )}
    </label>
  );
}
