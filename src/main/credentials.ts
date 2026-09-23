import { app, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

export type Credentials = {
  apiUrl: string;
  deviceId: string;
  deviceName: string;
  token: string;
};

// The token is encrypted with the OS keystore (DPAPI on Windows, Keychain on macOS).
type StoredCredentials = Omit<Credentials, 'token'> & { encryptedToken: string };

const credentialsFile = () => path.join(app.getPath('userData'), 'device.json');

export async function loadCredentials(): Promise<Credentials | null> {
  let stored: StoredCredentials;
  try {
    stored = JSON.parse(await fs.readFile(credentialsFile(), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

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
  const stored: StoredCredentials = {
    ...rest,
    encryptedToken: safeStorage.encryptString(token).toString('base64'),
  };
  const file = credentialsFile();
  const tmp = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(stored, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}
