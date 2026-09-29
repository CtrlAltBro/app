import { randomUUID } from 'node:crypto';
import type { TamperEvent, TamperEventType } from '../shared/api-types';
import { readJson, removeJson, writeJson } from './storage';

// Tamper events waiting to be uploaded (app killed, service restarted, clock
// changed…). Queued on disk so none is lost offline, sent with the next /sync.

const QUEUE_FILE = 'events-queue.json';
const MAX_QUEUE = 500;
// The API accepts this many per /sync.
const BATCH = 100;
const MAX_DETAIL = 500;

let queue: TamperEvent[] = [];
let loaded: Promise<void> | null = null;
let writing: Promise<void> = Promise.resolve();

export function loadEventsQueue() {
  loaded ??= readJson<TamperEvent[]>(QUEUE_FILE).then((saved) => {
    queue = [...(saved ?? []), ...queue];
  });
  return loaded;
}

function persist() {
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  writing = writing.catch(() => undefined).then(() => writeJson(QUEUE_FILE, queue));
  return writing;
}

export function recordEvent(type: TamperEventType, detail?: string) {
  queue.push({
    id: randomUUID(),
    type,
    at: new Date().toISOString(),
    ...(detail ? { detail: detail.slice(0, MAX_DETAIL) } : {}),
  });
  console.log(`[events] 🚨 ${type}${detail ? ` — ${detail}` : ''}`);
  persist().catch((err) => console.error('[events] écriture de la file échouée:', err));
}

export const pendingEventsCount = () => queue.length;

// Oldest first, copied so the batch being sent cannot change underneath.
export const pendingEvents = () => queue.slice(0, BATCH).map((e) => ({ ...e }));

export async function acknowledgeEvents(ids: string[]) {
  const sent = new Set(ids);
  queue = queue.filter((e) => !sent.has(e.id));
  await persist();
}

export async function clearEvents() {
  queue = [];
  await writing.catch(() => undefined);
  await removeJson(QUEUE_FILE);
}
