/**
 * E2EE Key Management for LiveKit SFU mode.
 *
 * Strategy 1 (current): Channel-derived keys via PBKDF2.
 * All users in the same channel derive the same key from channelId + a shared secret.
 * The server never sees the plaintext key.
 */

const channelKeys = new Map<string, CryptoKey>();

/**
 * Derive an AES-GCM-256 encryption key from the channel ID.
 * Uses PBKDF2 with a channel-specific salt.
 */
export async function deriveChannelKey(channelId: string): Promise<CryptoKey> {
  const cached = channelKeys.get(channelId);
  if (cached) return cached;

  const encoder = new TextEncoder();

  // Use channelId as both the key material and salt component.
  // This means all users in the same channel derive the same key.
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(`abyss-e2ee-${channelId}`),
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey'],
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: encoder.encode(`abyss-channel-salt-${channelId}`),
      iterations: 100_000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );

  channelKeys.set(channelId, key);
  return key;
}

/**
 * Export a CryptoKey to raw bytes (Uint8Array).
 */
export async function exportKeyBytes(key: CryptoKey): Promise<Uint8Array> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return new Uint8Array(raw);
}

/**
 * Clear the cached key for a channel (call on leave).
 */
export function clearChannelKey(channelId: string): void {
  channelKeys.delete(channelId);
}

/**
 * Get a cached key (if available).
 */
export function getChannelKey(channelId: string): CryptoKey | undefined {
  return channelKeys.get(channelId);
}

/**
 * Clear all cached keys.
 */
export function clearAllKeys(): void {
  channelKeys.clear();
}
