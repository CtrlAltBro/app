import type { CommandResult, Rules, SyncInput, SyncResponse } from '../shared/api-types';
import { executeCommand } from './commands';
import { inventoryHash, scanInstalledApps } from './inventory';
import { host } from './host';
import { acknowledgeScreenTime, pendingScreenTime, pendingScreenTimeCount } from './screen-time-queue';
import type { Credentials } from './credentials';
import { readJson, removeJson, writeJson } from './storage';

type AgentState = {
  rules: Rules | null;
  // Reported on the next sync, then dropped.
  pendingResults: CommandResult[];
  // So a command re-delivered after a crash is not executed twice.
  handledCommandIds: string[];
  // Hash of the last app inventory the API accepted, so it is only re-sent when it changes.
  appsHash?: string;
};

const STATE_FILE = 'agent-state.json';
const INVENTORY_INTERVAL_MS = 60 * 60 * 1000;

// Cheap heartbeat: /ping hits only KV on the server, never Neon. A full /sync
// (which does touch Neon) runs only when there is a reason to.
const PING_MS = 30_000; // idle cadence: just say hi
const FAST_MS = 15_000; // parent is watching: stream screen time live
const SLOW_FLUSH_MS = 15 * 60 * 1000; // batch screen time this often when nobody watches
const MAX_BACKOFF_S = 300;

const loadState = async (): Promise<AgentState> =>
  (await readJson<AgentState>(STATE_FILE)) ?? { rules: null, pendingResults: [], handledCommandIds: [] };

export const clearAgentState = () => removeJson(STATE_FILE);

// Rules from the last successful sync, so limits apply at startup even offline.
export const cachedRules = async () => (await loadState()).rules;

type SyncCallbacks = {
  onSynced(at: Date): void;
  onError(message: string): void;
  onRules(rules: Rules): void;
  onUnauthorized(): void;
};

class HttpError extends Error {}
class Unauthorized extends Error {}

type PingResponse = { rev: string; fast: boolean; nextPingSeconds: number };

export function startSyncLoop(credentials: Credentials, callbacks: SyncCallbacks) {
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopped = false;
  let failures = 0;
  let lastInventoryAt = 0;
  let lastRev: string | null = null;
  let lastScreenFlushAt = Date.now();
  // Set by flush(): upload now, whatever the batching says (lock, app quit, shutdown).
  let forceFlush = false;
  let currentTick: Promise<void> = Promise.resolve();

  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${credentials.apiUrl}/api/agent/v1/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${credentials.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new HttpError(`Erreur du serveur (HTTP ${res.status})`);
    return (await res.json()) as T;
  }

  const ping = () =>
    host()
      .health()
      .catch(() => ({ appConnected: false, childSignedIn: false }))
      .then((h) => post<PingResponse>('ping', { agentVersion: host().version, ...h }));

  // Full sync: uploads inventory / screen time / command results, applies rules and commands.
  async function syncOnce(): Promise<number> {
    const state = await loadState();
    const body: SyncInput = {
      agentVersion: host().version,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      rulesVersion: state.rules?.version ?? -1,
      commandResults: state.pendingResults,
    };
    const screenTime = pendingScreenTime();
    if (screenTime.length) body.screenTime = screenTime;

    let appsHash = state.appsHash;
    if (Date.now() - lastInventoryAt > INVENTORY_INTERVAL_MS) {
      try {
        const apps = await scanInstalledApps();
        const hash = inventoryHash(apps);
        if (hash !== state.appsHash) {
          body.apps = apps;
          appsHash = hash;
        }
        lastInventoryAt = Date.now();
      } catch (err) {
        console.error('App inventory failed:', err);
      }
    }

    const data = await post<SyncResponse>('sync', body);

    const next: AgentState = {
      rules: data.rules ?? state.rules,
      pendingResults: [],
      handledCommandIds: state.handledCommandIds,
      appsHash,
    };
    for (const command of data.commands) {
      if (next.handledCommandIds.includes(command.id)) {
        next.pendingResults.push({ id: command.id, status: 'done' });
        continue;
      }
      next.pendingResults.push(await executeCommand(command));
      next.handledCommandIds = [...next.handledCommandIds, command.id].slice(-200);
    }
    await writeJson(STATE_FILE, next);
    if (screenTime.length) await acknowledgeScreenTime(screenTime.map((s) => s.id));
    if (screenTime.length) lastScreenFlushAt = Date.now();

    callbacks.onSynced(new Date());
    if (data.rules) callbacks.onRules(data.rules);
    return next.pendingResults.length; // results to report → sync again promptly
  }

  function tick() {
    currentTick = runTick();
    return currentTick;
  }

  async function runTick() {
    if (running || stopped) return;
    running = true;
    clearTimeout(timer);
    let delayMs = PING_MS;
    try {
      const state = await loadState();
      const heartbeat = await ping();

      const revChanged = lastRev === null || heartbeat.rev !== lastRev;
      const hasResults = state.pendingResults.length > 0;
      const screenPending = pendingScreenTimeCount();
      const flushDue = screenPending > 0 && Date.now() - lastScreenFlushAt > SLOW_FLUSH_MS;
      const forced = forceFlush && screenPending > 0;
      forceFlush = false;
      const doSync = forced || heartbeat.fast || revChanged || hasResults || flushDue;

      if (doSync) {
        const why = forced
          ? `🔒 verrouillage / fermeture → j'envoie tout (${screenPending} sessions)`
          : heartbeat.fast
            ? '🔥 parent connecté (mode rapide)'
            : revChanged
              ? '🔔 une règle/commande a changé'
              : hasResults
                ? '📮 résultats de commande à remonter'
                : `📦 lot de temps d'écran (${screenPending} sessions)`;
        console.log(`[sync] ${why} → full sync`);
        const resultsPending = await syncOnce();
        lastRev = heartbeat.rev;
        // Report command results on the next tick without waiting a full interval.
        delayMs = resultsPending ? 1_000 : heartbeat.fast ? FAST_MS : heartbeat.nextPingSeconds * 1000 || PING_MS;
      } else {
        console.log(
          `[ping] 😴 rien de neuf${screenPending ? ` (${screenPending} sessions en attente du prochain lot)` : ''} — Neon pas touché`,
        );
        lastRev = heartbeat.rev;
        delayMs = heartbeat.nextPingSeconds * 1000 || PING_MS;
      }
      failures = 0;
    } catch (err) {
      if (err instanceof Unauthorized) {
        callbacks.onUnauthorized();
        stopped = true;
        running = false;
        return;
      }
      failures++;
      callbacks.onError(err instanceof HttpError ? err.message : 'Serveur injoignable');
      delayMs = Math.min(PING_MS / 1000 * 2 ** failures, MAX_BACKOFF_S) * 1000;
    } finally {
      running = false;
    }
    if (!stopped) timer = setTimeout(tick, delayMs);
  }

  void tick();

  return {
    syncNow: () => void tick(),
    // Upload the screen-time queue now. Awaitable, for app quit.
    async flush() {
      forceFlush = true;
      await currentTick;
      await tick();
    },
    // Tell the API we are leaving so the dashboard shows the PC offline right away.
    async bye() {
      await fetch(`${credentials.apiUrl}/api/agent/v1/bye`, {
        method: 'POST',
        headers: { authorization: `Bearer ${credentials.token}` },
        signal: AbortSignal.timeout(3_000),
      }).catch(() => undefined);
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
