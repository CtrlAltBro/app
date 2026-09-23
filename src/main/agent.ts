import { BrowserWindow, powerMonitor } from 'electron';
import os from 'node:os';
import type { AgentStatus, PairResult, SyncState } from '../shared/agent-api';
import { API_URL } from './config';
import { clearCredentials, loadCredentials, saveCredentials, type Credentials } from './credentials';
import { startScreenTime, stopScreenTime } from './screen-time';
import { clearAgentState, startSyncLoop } from './sync';

let credentials: Credentials | null = null;
let syncState: SyncState = { lastSyncAt: null, error: null };
let syncLoop: ReturnType<typeof startSyncLoop> | null = null;

export function getStatus(): AgentStatus {
  if (!credentials) return { paired: false, suggestedName: os.hostname().replace(/\.local$/, '') };
  return { paired: true, deviceId: credentials.deviceId, deviceName: credentials.deviceName, sync: syncState };
}

function broadcast() {
  const status = getStatus();
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('agent:status', status);
}

function setSyncState(state: SyncState) {
  syncState = state;
  broadcast();
}

function startSync(creds: Credentials) {
  syncLoop?.stop();
  void startScreenTime();
  syncLoop = startSyncLoop(creds, {
    onSynced: (at) => setSyncState({ lastSyncAt: at.toISOString(), error: null }),
    onError: (message) => setSyncState({ ...syncState, error: message }),
    onRules: (rules) => console.log(`Rules v${rules.version}:`, JSON.stringify(rules)),
    onUnauthorized: () => void unpair(),
  });
}

// The device was deleted from the dashboard: its token no longer works.
async function unpair() {
  syncLoop?.stop();
  syncLoop = null;
  await stopScreenTime({ clear: true });
  credentials = null;
  syncState = { lastSyncAt: null, error: null };
  await clearCredentials();
  await clearAgentState();
  broadcast();
}

export async function initAgent() {
  credentials = await loadCredentials();
  if (credentials) startSync(credentials);
  powerMonitor.on('resume', () => syncLoop?.syncNow());
}

export async function pair(code: string, name: string): Promise<PairResult> {
  const deviceName = name.trim();
  if (!code.trim() || !deviceName) return { ok: false, error: 'Renseigne le code et le nom du PC.' };

  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/agent/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.trim(), name: deviceName }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, error: 'Impossible de joindre le serveur. Vérifie la connexion internet.' };
  }

  if (res.status === 400) {
    return { ok: false, error: 'Code invalide ou expiré. Génère un nouveau code depuis le dashboard.' };
  }
  if (!res.ok) return { ok: false, error: `Erreur du serveur (HTTP ${res.status}). Réessaie plus tard.` };

  const body = (await res.json().catch((): null => null)) as { deviceId?: unknown; token?: unknown } | null;
  if (typeof body?.deviceId !== 'string' || typeof body?.token !== 'string') {
    return { ok: false, error: 'Réponse inattendue du serveur.' };
  }

  credentials = { apiUrl: API_URL, deviceId: body.deviceId, deviceName, token: body.token };
  await saveCredentials(credentials);
  await clearAgentState();
  await stopScreenTime({ clear: true });
  syncState = { lastSyncAt: null, error: null };
  startSync(credentials);
  return { ok: true, status: getStatus() };
}
