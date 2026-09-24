import { BrowserWindow, powerMonitor } from 'electron';
import os from 'node:os';
import type { AgentStatus, PairResult, SyncState } from '../shared/agent-api';
import { API_URL } from './config';
import { clearCredentials, loadCredentials, saveCredentials, type Credentials } from './credentials';
import { setLimitRules, startLimits, stopLimits } from './limits';
import { onFlushRequested, saveCurrentSession, startScreenTime, stopScreenTime } from './screen-time';
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
  // Session locked / PC going to sleep: upload now instead of waiting for the next batch.
  onFlushRequested(() => void syncLoop?.flush());
}

// App quit or Windows shutdown: keep the running session, then try to upload
// everything within a short delay (anything left stays on disk for next start).
let shuttingDown: Promise<void> | null = null;

export function shutdownAgent() {
  shuttingDown ??= (async () => {
    await saveCurrentSession();
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
  onFlushRequested(null);
  syncLoop?.stop();
  syncLoop = null;
  await stopScreenTime({ clear: true });
  await stopLimits();
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
