import os from 'node:os';
import type { AgentStatus, PairResult, SyncState } from '../shared/agent-api';
import { API_URL } from './config';
import { clearCredentials, loadCredentials, saveCredentials, type Credentials } from './credentials';
import { clearEvents, loadEventsQueue } from './events-queue';
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
  void cachedRules().then((rules) => {
    if (rules) host().sitePolicy.setBlockedSites(rules.sites.map((s) => s.pattern));
    return startLimits(rules);
  });
  syncLoop = startSyncLoop(creds, {
    onSynced: (at) => setSyncState({ lastSyncAt: at.toISOString(), error: null }),
    onError: (message) => setSyncState({ ...syncState, error: message }),
    onRules: (rules) => {
      console.log(`Rules v${rules.version}:`, JSON.stringify(rules));
      setLimitRules(rules);
      host().sitePolicy.setBlockedSites(rules.sites.map((s) => s.pattern));
    },
    onUnauthorized: () => void unpair(),
  });
  broadcast();
}

// Session locked / PC going to sleep: upload now instead of waiting for the next batch.
export const flushNow = () => void syncLoop?.flush();

// PC resumed from sleep.
export const syncNow = () => syncLoop?.syncNow();

// PC going to sleep: say goodbye at once (one quick KV-only request, before Windows
// suspends), so the dashboard shows it offline instead of "silent". Pending screen
// time stays queued and goes up after wake.
let lastSleepBye = 0;
export function sleepNow() {
  if (Date.now() - lastSleepBye < 10_000) return; // one goodbye per sleep
  lastSleepBye = Date.now();
  void syncLoop?.bye('sleep');
}

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
  await clearEvents();
  await stopLimits();
  host().sitePolicy.setBlockedSites([]);
  credentials = null;
  syncState = { lastSyncAt: null, error: null };
  await clearCredentials();
  await clearAgentState();
  broadcast();
}

export async function initAgent() {
  await loadScreenTimeQueue();
  await loadEventsQueue();
  credentials = await loadCredentials();
  if (credentials) startSync(credentials);
  // Not paired (e.g. unpaired by the admin CLI): lift the sites the last pairing blocked.
  else host().sitePolicy.setBlockedSites([]);
}

export const isPaired = () => credentials !== null;

// Talks to the API and returns the new credentials, without saving or starting
// anything. Shared by the live pair() and the admin CLI.
async function pairRequest(code: string, name: string): Promise<{ ok: true; creds: Credentials } | { ok: false; error: string }> {
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
  return { ok: true, creds: { apiUrl: API_URL, deviceId: body.deviceId, deviceName, token: body.token } };
}

// Live pairing (loop already running, e.g. a first-run flow). Refused when the PC
// is already paired, so it can only ever be set up once without an explicit reset.
export async function pair(code: string, name: string): Promise<PairResult> {
  if (credentials) return { ok: false, error: 'Ce PC est déjà appairé. Dissocie-le d’abord depuis le dashboard.' };
  const result = await pairRequest(code, name);
  if (!result.ok) return result;
  credentials = result.creds;
  await saveCredentials(credentials);
  await clearAgentState();
  await clearScreenTime();
  await clearEvents();
  syncState = { lastSyncAt: null, error: null };
  startSync(credentials);
  return { ok: true, status: getStatus() };
}

// Admin CLI: pair (or re-pair with --force) without starting the loop, then the
// process exits. The running service reads the saved credentials on its next start.
export async function pairFromCli(code: string, name: string, force: boolean): Promise<PairResult> {
  if ((await loadCredentials()) && !force) {
    return { ok: false, error: 'Ce PC est déjà appairé. Relance avec --force pour ré-appairer.' };
  }
  const result = await pairRequest(code, name);
  if (!result.ok) return result;
  await saveCredentials(result.creds);
  await clearAgentState();
  await clearScreenTime();
  await clearEvents();
  return {
    ok: true,
    status: { paired: true, deviceId: result.creds.deviceId, deviceName: result.creds.deviceName, sync: { lastSyncAt: null, error: null } },
  };
}

// Admin CLI: forget the pairing (files on disk), whether or not the loop runs.
export async function clearPairing() {
  syncLoop?.stop();
  syncLoop = null;
  credentials = null;
  // Lift any launch blocks (IFEO) so unpairing never leaves a blocked app behind.
  await stopLimits();
  await clearCredentials();
  await clearAgentState();
  await clearScreenTime();
  await clearEvents();
}
