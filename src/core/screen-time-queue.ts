import type { ScreenTimeSession } from '../shared/api-types';
import { readJson, removeJson, writeJson } from './storage';

// Screen-time sessions waiting to be uploaded. Sessions come from the foreground
// sensor on the child's desktop (main/screen-time.ts) and are sent by sync.ts.

const QUEUE_FILE = 'screen-time-queue.json';
const MAX_QUEUE = 10_000;
// Consecutive sessions closer than this (same app and title) are merged into one row.
const MERGE_GAP_MS = 10_000;

let queue: ScreenTimeSession[] = [];
let inFlight = new Set<string>();
let loaded: Promise<void> | null = null;

export function loadScreenTimeQueue() {
  loaded ??= readJson<ScreenTimeSession[]>(QUEUE_FILE).then((saved) => {
    queue = [...(saved ?? []), ...queue];
  });
  return loaded;
}

// Writes run one after another, each saving the queue as it is when its turn comes,
// so the file on disk always ends up with the latest state.
let writing: Promise<void> = Promise.resolve();

export function persistScreenTime() {
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  writing = writing.catch(() => undefined).then(() => writeJson(QUEUE_FILE, queue));
  return writing;
}

export function addSession(session: ScreenTimeSession) {
  // Same app and window right after the previous session: extend it instead of adding a row.
  // Sessions already handed to a sync in progress are left alone (they may be acknowledged).
  const prev = queue[queue.length - 1];
  if (
    prev &&
    !inFlight.has(prev.id) &&
    prev.app === session.app &&
    prev.exeName === session.exeName &&
    prev.title === session.title &&
    Date.parse(session.startedAt) - Date.parse(prev.endedAt) <= MERGE_GAP_MS
  ) {
    prev.endedAt = session.endedAt;
  } else {
    queue.push(session);
  }
  persistScreenTime().catch((err) => console.error('Screen time queue write failed:', err));
}

export async function clearScreenTime() {
  queue = [];
  inFlight = new Set();
  await writing.catch(() => undefined);
  await removeJson(QUEUE_FILE);
}

export const pendingScreenTimeCount = () => queue.length;

// Sessions to send with the next sync (oldest first, API accepts 2000 per call).
// Copies, so a merge during the upload cannot change what is being sent.
export function pendingScreenTime() {
  const batch = queue.slice(0, 2000).map((s) => ({ ...s }));
  inFlight = new Set(batch.map((s) => s.id));
  return batch;
}

export async function acknowledgeScreenTime(ids: string[]) {
  const sent = new Set(ids);
  queue = queue.filter((s) => !sent.has(s.id));
  inFlight = new Set();
  await persistScreenTime();
}
