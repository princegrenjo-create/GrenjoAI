/**
 * Secure API-key storage for mobile.
 *
 * Platform mapping, and why it is the right one:
 *  - iOS:  Keychain (`kSecClassGenericPassword`), non-synchronising.
 *  - Android: Keystore-backed `EncryptedSharedPreferences`.
 * Both are per-app, per-device, and survive app updates but not an uninstall.
 *
 * This is the mobile counterpart of the desktop's DPAPI store. It is a different
 * mechanism on purpose: the desktop file is encrypted with the Windows user's
 * DPAPI key, which does not exist here. The interface is the same shape, so the
 * credential abstraction documented for a future web client still holds.
 *
 * A key is bound to the base URL it was entered for, exactly as on desktop, so a
 * provider whose URL changes cannot silently receive the old key.
 */
import * as SecureStore from 'expo-secure-store';
import { createHash } from './hash';

const BINDING_PREFIX = 'binding:';

export async function isAvailable(): Promise<boolean> {
  return SecureStore.isAvailableAsync();
}

function normaliseBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/** sha256(key) first 8 hex chars, shown in the UI instead of the key. */
export function fingerprint(apiKey: string): string {
  return createHash(apiKey).slice(0, 8);
}

export async function setProviderKey(providerId: string, baseUrl: string, apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) throw new Error('An API key cannot be empty.');
  await SecureStore.setItemAsync(providerId, trimmed, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  await SecureStore.setItemAsync(`${BINDING_PREFIX}${providerId}`, normaliseBaseUrl(baseUrl));
}

/**
 * Reads a key only when it is still bound to the provider's current base URL.
 * A stale key is deleted rather than left in place, so a later URL change cannot
 * resurrect it.
 */
export async function getProviderKey(providerId: string, baseUrl: string): Promise<string | null> {
  const key = await SecureStore.getItemAsync(providerId);
  if (key === null) return null;
  const binding = await SecureStore.getItemAsync(`${BINDING_PREFIX}${providerId}`);
  if (binding === null || binding !== normaliseBaseUrl(baseUrl)) {
    await clearProviderKey(providerId);
    return null;
  }
  return key;
}

export async function clearProviderKey(providerId: string): Promise<void> {
  await SecureStore.deleteItemAsync(providerId);
  await SecureStore.deleteItemAsync(`${BINDING_PREFIX}${providerId}`);
}

export async function hasProviderKey(providerId: string, baseUrl: string): Promise<string | null> {
  const key = await getProviderKey(providerId, baseUrl);
  return key === null ? null : fingerprint(key);
}
