import { host } from './host';
import { readJson, removeJson, writeJson } from './storage';

export type Credentials = {
  apiUrl: string;
  deviceId: string;
  deviceName: string;
  token: string;
};

// The token is encrypted by the host (Electron: OS keystore, DPAPI on Windows).
type StoredCredentials = Omit<Credentials, 'token'> & { encryptedToken: string };

const FILE = 'device.json';

export async function loadCredentials(): Promise<Credentials | null> {
  const stored = await readJson<StoredCredentials>(FILE);
  if (!stored) return null;
  try {
    const { encryptedToken, ...rest } = stored;
    return { ...rest, token: host().secrets.decrypt(encryptedToken) };
  } catch (err) {
    console.error('Stored device token cannot be decrypted; pairing again is required.', err);
    return null;
  }
}

export async function saveCredentials({ token, ...rest }: Credentials) {
  if (!host().secrets.available()) {
    throw new Error('OS encryption is unavailable, refusing to store the device token in clear text.');
  }
  await writeJson(FILE, { ...rest, encryptedToken: host().secrets.encrypt(token) });
}

export async function clearCredentials() {
  await removeJson(FILE);
}
