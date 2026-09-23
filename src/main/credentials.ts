import { safeStorage } from 'electron';
import { readJson, removeJson, writeJson } from './storage';

export type Credentials = {
  apiUrl: string;
  deviceId: string;
  deviceName: string;
  token: string;
};

// The token is encrypted with the OS keystore (DPAPI on Windows, Keychain on macOS).
type StoredCredentials = Omit<Credentials, 'token'> & { encryptedToken: string };

const FILE = 'device.json';

export async function loadCredentials(): Promise<Credentials | null> {
  const stored = await readJson<StoredCredentials>(FILE);
  if (!stored) return null;
  try {
    const { encryptedToken, ...rest } = stored;
    return { ...rest, token: safeStorage.decryptString(Buffer.from(encryptedToken, 'base64')) };
  } catch (err) {
    console.error('Stored device token cannot be decrypted; pairing again is required.', err);
    return null;
  }
}

export async function saveCredentials({ token, ...rest }: Credentials) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS encryption is unavailable, refusing to store the device token in clear text.');
  }
  await writeJson(FILE, { ...rest, encryptedToken: safeStorage.encryptString(token).toString('base64') });
}

export async function clearCredentials() {
  await removeJson(FILE);
}
