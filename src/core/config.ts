import { readJson, writeJson } from './storage';

declare const __API_URL__: string;

// The API server this PC pairs with. Chosen at install (or later by an admin) and
// kept in config.json in the state dir, next to the monitored accounts; the URL
// baked at build time is only the default. A paired PC keeps the server it paired
// with in its credentials, so changing this only matters for the next pairing.

export const CONFIG_FILE = 'config.json';
export const DEFAULT_API_URL = normalizeApiUrl(__API_URL__) ?? 'http://localhost:5173';

export type Config = { apiUrl?: string; monitoredSids?: string[] };

let apiUrl = DEFAULT_API_URL;

// "https://example.com/" → "https://example.com"; null if it is not an http(s) URL.
export function normalizeApiUrl(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export const readConfig = async (): Promise<Config> => (await readJson<Config>(CONFIG_FILE)) ?? {};

// Load the configured server (call once at startup, before pairing or syncing).
export async function loadApiUrl() {
  const configured = (await readConfig().catch((): Config => ({}))).apiUrl;
  apiUrl = (configured && normalizeApiUrl(configured)) || DEFAULT_API_URL;
}

export const currentApiUrl = () => apiUrl;

// Admin only (CLI): save a new server. Returns the normalized URL, or null if invalid.
export async function saveApiUrl(input: string): Promise<string | null> {
  const url = normalizeApiUrl(input);
  if (!url) return null;
  await writeJson(CONFIG_FILE, { ...(await readConfig()), apiUrl: url });
  apiUrl = url;
  return url;
}
