import os from 'node:os';
import type { AgentStatus, PairResult, SyncState } from '../shared/agent-api';
import { API_URL } from './config';
import { clearCredentials, loadCredentials, saveCredentials, type Credentials } from './credentials';
import { host } from './host';
import { setLimitRules, startLimits, stopLimits } from './limits';
import { clearScreenTime, loadScreenTimeQueue, persistScreenTime } from './screen-time-queue';
import { cachedRules, clearAgentState, startSyncLoop } from './sync';

// Longest we hold the app open at quit / shutdown to upload pending screen time.
const QUIT_FLUSH_TIMEOUT_MS = 4_000;

let credentials: Credentials | null = null;
let syncState: SyncState = { lastSyncAt: null, error: null };
let syncLoop: ReturnType<typeof startSyncLoop> | null = null;

export function getStatus(): AgentStatus {
  if (!credentials) return { paired: false, suggestedName: os.hostname().replace(/\.local$/, '') };
  return { paired: true, deviceId: credentials.deviceId, deviceName: credentials.deviceName, sync: syncState };
}

function broadcast() {
  host().statusChanged(getStatus());
}

function setSyncState(state: SyncState) {
  syncState = state;
  broadcast();
}

function startSync(creds: Credentials) {
  syncLoop?.stop();
  // Enforce with the rules cached from the last sync, so limits apply at startup even offline.
  void cachedRules().then((rules) => startLimits(rules));
  syncLoop = startSyncLoop(creds, {
    onSynced: (at) => setSyncState({ lastSyncAt: at.toISOString(), error: null }),
    onError: (message) => setSyncState({ ...syncState, error: message }),
    onRules: (rules) => {
      console.log(`Rules v${rules.version}:`, JSON.stringify(rules));
      setLimitRules(rules);
    },
    onUnauthorized: () => void unpair(),
  });
  broadcast();
}

// Session locked / PC going to sleep: upload now instead of waiting for the next batch.
export const flushNow = () => void syncLoop?.flush();

// PC resumed from sleep.
export const syncNow = () => syncLoop?.syncNow();

// App quit or Windows shutdown: keep the running session, then try to upload
// everything within a short delay (anything left stays on disk for next start).
let shuttingDown: Promise<void> | null = null;

export function shutdownAgent() {
  shuttingDown ??= (async () => {
    await host().ui.saveCurrentSession();
    await persistScreenTime();
    const loop = syncLoop;
    if (!loop) return;
    console.log('[sync] 👋 fermeture → dernier envoi, puis je me déclare hors ligne');
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, QUIT_FLUSH_TIMEOUT_MS));
    const goodbye = loop
      .flush()
      .catch(() => {})
      .then(() => loop.bye());
    await Promise.race([goodbye, timeout]);
    loop.stop();
  })();
  return shuttingDown;
}

// The device was deleted from the dashboard: its token no longer works.
async function unpair() {
  syncLoop?.stop();
  syncLoop = null;
  await clearScreenTime();
  await stopLimits();
  credentials = null;
  syncState = { lastSyncAt: null, error: null };
  await clearCredentials();
  await clearAgentState();
  broadcast();
}

export async function initAgent() {
  await loadScreenTimeQueue();
  credentials = await loadCredentials();
  if (credentials) startSync(credentials);
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
  await clearScreenTime();
  syncState = { lastSyncAt: null, error: null };
  startSync(credentials);
  return { ok: true, status: getStatus() };
}
