/**
 * Utility to convert CSS cosmetic styles (from getNameplateStyle / getMessageStyle)
 * into React Native compatible ViewStyle / TextStyle objects.
 */

// CSS properties that are safe for RN Text components
const TEXT_SAFE_KEYS = new Set([
  'color',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'textTransform',
]);

// CSS properties we intentionally skip (no RN equivalent without extra libs)
const SKIP_KEYS = new Set([
  'textShadow',
  'backgroundImage',
  'animation',
  'filter',
  'backgroundClip',
  'WebkitBackgroundClip',
  'WebkitTextFillColor',
  'backgroundSize',
  'borderImage',
  'outline',
  'outlineOffset',
  'fontFamily',
]);

/**
 * Parse a CSS length value (e.g. "4px", "0.5em", "12") into a numeric value.
 * Treats `em` as px * 16.  Returns undefined for unparseable values.
 */
export function parseCSSLength(value: string | number): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  if (trimmed === '') return undefined;

  // Try parsing as a plain number first
  const plain = Number(trimmed);
  if (!Number.isNaN(plain)) return plain;

  // Match number + unit
  const match = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*(px|em|rem|pt|dp)?$/i);
  if (!match) return undefined;

  const num = parseFloat(match[1]);
  const unit = (match[2] || '').toLowerCase();

  if (unit === 'em' || unit === 'rem') return num * 16;
  // px, pt, dp, or no unit — use raw number
  return num;
}

/**
 * Parse a CSS border shorthand value like "2px solid #ed4245"
 * into { width, style, color }.
 */
function parseBorderShorthand(
  value: string,
): { width: number; color: string } | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  // Pattern: <width> <style> <color>
  // e.g. "2px solid #ed4245", "1px dashed rgba(0,0,0,0.5)"
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return undefined;

  const width = parseCSSLength(parts[0]);
  if (width === undefined) return undefined;

  // Style is the second token (solid, dashed, etc.) — RN doesn't support border-style per side,
  // so we just extract width and color.
  // Color is everything after the style keyword (could contain spaces in rgba)
  const styleKeywords = new Set([
    'solid',
    'dashed',
    'dotted',
    'double',
    'groove',
    'ridge',
    'inset',
    'outset',
    'none',
    'hidden',
  ]);

  let colorStart = 1;
  if (styleKeywords.has(parts[1].toLowerCase())) {
    colorStart = 2;
  }

  const color = parts.slice(colorStart).join(' ') || '#000000';
  return { width, color };
}

/**
 * Attempt to parse a CSS boxShadow value and produce approximate RN shadow props.
 * CSS: "0 2px 8px rgba(0,0,0,0.3)"
 * RN: shadowColor, shadowOffset, shadowOpacity, shadowRadius, elevation
 */
function parseBoxShadow(
  value: string,
): Record<string, any> | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'none') return undefined;

  // Try to extract color — look for rgb/rgba/hsl/hsla or hex at the end or beginning
  let color = 'rgba(0,0,0,0.3)';
  let opacity = 0.3;
  let remaining = trimmed;

  // Extract rgba/rgb color
  const rgbaMatch = trimmed.match(/(rgba?\([^)]+\))/);
  if (rgbaMatch) {
    color = rgbaMatch[1];
    remaining = trimmed.replace(rgbaMatch[1], '').trim();

    // Try to extract opacity from rgba
    const opacityMatch = rgbaMatch[1].match(
      /rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/,
    );
    if (opacityMatch) {
      opacity = parseFloat(opacityMatch[1]);
    }
  } else {
    // Look for hex color
    const hexMatch = trimmed.match(/(#[0-9a-fA-F]{3,8})/);
    if (hexMatch) {
      color = hexMatch[1];
      remaining = trimmed.replace(hexMatch[1], '').trim();
      opacity = 1;
    }
  }

  // Parse numeric values (offsetX, offsetY, blurRadius, spreadRadius)
  const nums = remaining.split(/\s+/).filter((s) => s !== '').map(parseCSSLength).filter(
    (n): n is number => n !== undefined,
  );

  const offsetX = nums[0] ?? 0;
  const offsetY = nums[1] ?? 0;
  const blurRadius = nums[2] ?? 4;
  // spreadRadius (nums[3]) is not supported in RN — ignored

  return {
    shadowColor: color,
    shadowOffset: { width: offsetX, height: offsetY },
    shadowOpacity: opacity,
    shadowRadius: blurRadius,
    elevation: Math.max(1, Math.ceil(blurRadius / 2)), // Android approximation
  };
}

/**
 * Convert a CSS properties object (from getNameplateStyle/getMessageStyle)
 * to a React Native compatible style object (ViewStyle + TextStyle).
 * Unsupported properties are silently skipped.
 */
export function cssToRNStyle(
  css: Record<string, any> | undefined,
): Record<string, any> | undefined {
  if (!css || typeof css !== 'object') return undefined;

  const result: Record<string, any> = {};
  let hasKeys = false;

  for (const [key, value] of Object.entries(css)) {
    if (value === undefined || value === null || value === '') continue;
    if (SKIP_KEYS.has(key)) continue;

    switch (key) {
      // Direct pass-through (string values)
      case 'color':
      case 'backgroundColor':
      case 'fontStyle':
      case 'textTransform':
        result[key] = value;
        hasKeys = true;
        break;

      case 'fontWeight':
        // RN accepts fontWeight as string ('400', '700', etc.) or keyword
        result.fontWeight = String(value);
        hasKeys = true;
        break;

      case 'letterSpacing': {
        const parsed = typeof value === 'number' ? value : parseCSSLength(value);
        if (parsed !== undefined) {
          result.letterSpacing = parsed;
          hasKeys = true;
        }
        break;
      }

      case 'borderRadius': {
        const parsed = typeof value === 'number' ? value : parseCSSLength(value);
        if (parsed !== undefined) {
          result.borderRadius = parsed;
          hasKeys = true;
        }
        break;
      }

      // Background shorthand — try to extract a solid color
      case 'background': {
        const strVal = String(value).trim();
        // Only handle solid colors, not gradients
        if (
          strVal.startsWith('#') ||
          strVal.startsWith('rgb') ||
          strVal.startsWith('hsl') ||
          /^[a-z]+$/i.test(strVal)
        ) {
          result.backgroundColor = strVal;
          hasKeys = true;
        }
        break;
      }

      // Individual border sides
      case 'borderLeft':
      case 'borderRight':
      case 'borderTop':
      case 'borderBottom': {
        const parsed = parseBorderShorthand(String(value));
        if (parsed) {
          // Convert "borderLeft" -> "Left", then "borderLeftWidth" and "borderLeftColor"
          const side = key.replace('border', '');
          result[`border${side}Width`] = parsed.width;
          result[`border${side}Color`] = parsed.color;
          hasKeys = true;
        }
        break;
      }

      // Border shorthand
      case 'border': {
        const parsed = parseBorderShorthand(String(value));
        if (parsed) {
          result.borderWidth = parsed.width;
          result.borderColor = parsed.color;
          hasKeys = true;
        }
        break;
      }

      // Box shadow — approximate
      case 'boxShadow': {
        const shadow = parseBoxShadow(String(value));
        if (shadow) {
          Object.assign(result, shadow);
          hasKeys = true;
        }
        break;
      }

      default:
        // Unknown/unsupported property — skip silently
        break;
    }
  }

  return hasKeys ? result : undefined;
}

/**
 * Convert a CSS properties object to a React Native TextStyle.
 * Only includes text-safe properties (color, fontWeight, fontStyle,
 * letterSpacing, textTransform).
 */
export function cssToRNTextStyle(
  css: Record<string, any> | undefined,
): Record<string, any> | undefined {
  if (!css || typeof css !== 'object') return undefined;

  const result: Record<string, any> = {};
  let hasKeys = false;

  for (const [key, value] of Object.entries(css)) {
    if (value === undefined || value === null || value === '') continue;
    if (!TEXT_SAFE_KEYS.has(key)) continue;

    switch (key) {
      case 'color':
      case 'fontStyle':
      case 'textTransform':
        result[key] = value;
        hasKeys = true;
        break;

      case 'fontWeight':
        result.fontWeight = String(value);
        hasKeys = true;
        break;

      case 'letterSpacing': {
        const parsed = typeof value === 'number' ? value : parseCSSLength(value);
        if (parsed !== undefined) {
          result.letterSpacing = parsed;
          hasKeys = true;
        }
        break;
      }

      default:
        break;
    }
  }

  return hasKeys ? result : undefined;
}
