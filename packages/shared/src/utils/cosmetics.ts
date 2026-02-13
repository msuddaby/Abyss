import type { User } from '../types/index.js';

const NAMEPLATE_ALLOWED = new Set([
  'background', 'backgroundClip', 'WebkitBackgroundClip', 'WebkitTextFillColor',
  'color', 'textShadow', 'fontWeight', 'fontStyle',
  'letterSpacing', 'textTransform', 'animation', 'filter',
  'backgroundSize',
]);

const MESSAGE_STYLE_ALLOWED = new Set([
  'borderLeft', 'borderRight', 'borderTop', 'borderBottom', 'border',
  'borderRadius', 'borderImage', 'background', 'backgroundColor',
  'backgroundImage', 'backgroundSize', 'boxShadow', 'animation', 'outline', 'outlineOffset',
  'fontFamily', 'color',
]);

const DANGEROUS_VALUES = /url\s*\(|expression\s*\(|javascript:|@import|behavior\s*:/i;

function filterAllowedProperties(
  obj: Record<string, string>,
  allowed: Set<string>,
): React.CSSProperties {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (allowed.has(key) && !DANGEROUS_VALUES.test(value)) {
      result[key] = value;
    }
  }
  return result as unknown as React.CSSProperties;
}

export function getNameplateStyle(user: User): React.CSSProperties | undefined {
  const cssData = user.cosmetics?.nameplate?.cssData;
  if (!cssData) return undefined;
  try {
    return filterAllowedProperties(JSON.parse(cssData), NAMEPLATE_ALLOWED);
  } catch {
    return undefined;
  }
}

export function getMessageStyle(user: User): React.CSSProperties | undefined {
  const cssData = user.cosmetics?.messageStyle?.cssData;
  if (!cssData) return undefined;
  try {
    return filterAllowedProperties(JSON.parse(cssData), MESSAGE_STYLE_ALLOWED);
  } catch {
    return undefined;
  }
}

export function parseCosmeticCss(cssData: string, type: 'nameplate' | 'messageStyle'): React.CSSProperties | undefined {
  try {
    const allowed = type === 'nameplate' ? NAMEPLATE_ALLOWED : MESSAGE_STYLE_ALLOWED;
    return filterAllowedProperties(JSON.parse(cssData), allowed);
  } catch {
    return undefined;
  }
}
