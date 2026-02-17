/**
 * Parses ASP.NET Core validation error response into a structured format.
 * Handles both the standard validation error format and simple string errors.
 *
 * @param error - Axios error object from API call
 * @returns Object mapping field names to error messages, or null if no validation errors
 */
export function parseValidationErrors(error: any): Record<string, string[]> | null {
  const data = error?.response?.data;
  const status = error?.response?.status;

  // Only handle 400 Bad Request (validation errors)
  if (status !== 400) return null;

  // ASP.NET Core validation error format: { errors: { fieldName: ["error"] } }
  if (data?.errors && typeof data.errors === 'object') {
    return data.errors as Record<string, string[]>;
  }

  // Simple string error - treat as general error
  if (typeof data === 'string') {
    return { '': [data] };
  }

  // Array of Identity errors: [{ code, description }]
  if (Array.isArray(data)) {
    return { '': data.map((e: any) => e.description || e.code || String(e)) };
  }

  return null;
}

/**
 * Gets the first error message for a specific field.
 * Field names are case-insensitive (Password = password).
 *
 * @param errors - Validation errors object
 * @param fieldName - Name of the field to get error for
 * @returns First error message for the field, or null if none
 */
export function getFieldError(errors: Record<string, string[]> | null, fieldName: string): string | null {
  if (!errors) return null;

  // Try exact match first
  if (errors[fieldName]?.[0]) return errors[fieldName][0];

  // Try case-insensitive match
  const lowerFieldName = fieldName.toLowerCase();
  for (const [key, messages] of Object.entries(errors)) {
    if (key.toLowerCase() === lowerFieldName && messages[0]) {
      return messages[0];
    }
  }

  return null;
}

/**
 * Gets the general error message (errors with empty key or no specific field).
 *
 * @param errors - Validation errors object
 * @returns General error message, or null if none
 */
export function getGeneralError(errors: Record<string, string[]> | null): string | null {
  if (!errors) return null;

  // Check for errors with empty key
  if (errors['']?.[0]) return errors[''][0];

  // If there's only one field with errors, show it as general
  const entries = Object.entries(errors);
  if (entries.length === 1 && entries[0][1][0]) {
    return entries[0][1][0];
  }

  return null;
}

/**
 * Checks if there are any validation errors for a specific field.
 *
 * @param errors - Validation errors object
 * @param fieldName - Name of the field to check
 * @returns True if the field has errors
 */
export function hasFieldError(errors: Record<string, string[]> | null, fieldName: string): boolean {
  return getFieldError(errors, fieldName) !== null;
}
