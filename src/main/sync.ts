import { app } from 'electron';
import type { CommandResult, Rules, SyncInput, SyncResponse } from '../shared/api-types';
import { executeCommand } from './commands';
import { inventoryHash, scanInstalledApps } from './inventory';
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
const DEFAULT_INTERVAL_S = 15;
const MAX_BACKOFF_S = 300;
const INVENTORY_INTERVAL_MS = 60 * 60 * 1000;

const loadState = async (): Promise<AgentState> =>
  (await readJson<AgentState>(STATE_FILE)) ?? { rules: null, pendingResults: [], handledCommandIds: [] };

export const clearAgentState = () => removeJson(STATE_FILE);

type SyncCallbacks = {
  onSynced(at: Date): void;
  onError(message: string): void;
  onRules(rules: Rules): void;
  onUnauthorized(): void;
};

class HttpError extends Error {}

export function startSyncLoop(credentials: Credentials, callbacks: SyncCallbacks) {
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopped = false;
  let failures = 0;
  let lastInventoryAt = 0;

  async function syncOnce(): Promise<number | null> {
    const state = await loadState();
    const body: SyncInput = {
      agentVersion: app.getVersion(),
      rulesVersion: state.rules?.version ?? -1,
      commandResults: state.pendingResults,
    };

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

    const res = await fetch(`${credentials.apiUrl}/api/agent/v1/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${credentials.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401) {
      callbacks.onUnauthorized();
      return null;
    }
    if (!res.ok) throw new HttpError(`Erreur du serveur (HTTP ${res.status})`);
    const data = (await res.json()) as SyncResponse;

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

    callbacks.onSynced(new Date());
    if (data.rules) callbacks.onRules(data.rules);
    // Report command results right away instead of waiting a full interval.
    return next.pendingResults.length ? 1 : data.nextSyncSeconds || DEFAULT_INTERVAL_S;
  }

  async function tick() {
    if (running || stopped) return;
    running = true;
    clearTimeout(timer);
    let delay: number | null;
    try {
      delay = await syncOnce();
      failures = 0;
    } catch (err) {
      failures++;
      callbacks.onError(err instanceof HttpError ? err.message : 'Serveur injoignable');
      delay = Math.min(DEFAULT_INTERVAL_S * 2 ** failures, MAX_BACKOFF_S);
    } finally {
      running = false;
    }
    if (delay === null) stopped = true;
    if (!stopped && delay !== null) timer = setTimeout(tick, delay * 1000);
  }

  void tick();

  return {
    syncNow: () => void tick(),
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
