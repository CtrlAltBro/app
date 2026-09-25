import type { AppRule, Rules } from '../shared/api-types';
import { killApp } from './commands';
import { host } from './host';
import { knownAppName } from './inventory';
import { readJson, removeJson, writeJson } from './storage';

// Daily limits: count how long each app is in the foreground and, once a rule is
// hit, close it and tell the child. Everything is fed by foregroundTick() (one tick
// every 5 s with the counted app and the time since the last tick), so this file
// never watches the screen itself — it only decides what to do with each tick.

const USAGE_FILE = 'daily-usage.json';
// Warn the child once, this long before a limited app reaches its daily limit
// (30 s in dev, so a 1-min limit can be tested without waiting).
const warnBeforeMs = () => (host().isDev ? 30_000 : 5 * 60 * 1000);
// Don't kill (and nag about) the same app more than once within this window: after
// a kill the process takes a moment to disappear, and it may be reopened at once.
const KILL_COOLDOWN_MS = 10_000;
// Counters change every tick; write them to disk at most this often (plus on any
// kill / warn / day rollover), so a crash loses at most a few seconds of counting.
const PERSIST_EVERY_MS = 15_000;

type Usage = {
  // Local day (YYYY-MM-DD) the counters below belong to; they reset at midnight.
  day: string;
  // Foreground milliseconds per exeName since local midnight.
  ms: Record<string, number>;
  // exeName → latest parent reset already applied, so each reset is applied once.
  resets?: Record<string, string>;
};

let usage: Usage = { day: today(), ms: {} };
let rules: AppRule[] = [];
let started = false;
// Account whose apps limits may close (the monitored child). null = don't scope,
// i.e. any session — used only in dev when running everything as one user.
let enforcementUser: string | null = null;

// Set by the service to the monitored child's Windows account name.
export function setEnforcementUser(name: string | null) {
  enforcementUser = name;
}
// exeNames already warned today, so the "almost out of time" nag fires only once.
const warned = new Set<string>();
// exeName → last time we killed it, for the cooldown above.
const lastKillAt = new Map<string, number>();
let lastPersistAt = 0;

function today(): string {
  // Local date: limits follow the child's own midnight, not UTC.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const label = (exeName: string) => knownAppName(exeName) ?? exeName.replace(/\.exe$/i, '');

async function persist() {
  lastPersistAt = Date.now();
  await writeJson(USAGE_FILE, usage).catch((err) => console.error('[limits] écriture du compteur échouée:', err));
}

// New day since the counters were written: start every total back at zero.
function rolloverIfNewDay() {
  const day = today();
  if (day === usage.day) return;
  usage = { day, ms: {} };
  warned.clear();
  void persist();
}

// Close an app and tell the child why, but not more than once per cooldown so a
// program that lingers or relaunches doesn't spam dialogs.
// minutes: the daily limit, or null for a blocked app.
function enforce(exeName: string, minutes: number | null) {
  const now = Date.now();
  if (now - (lastKillAt.get(exeName) ?? 0) < KILL_COOLDOWN_MS) return;
  lastKillAt.set(exeName, now);
  void persist();
  void (async () => {
    // Picture the window before it disappears, for the "time's up" screen.
    await host().ui.snapshotForeground().catch(() => undefined);
    // Only close the app in the monitored child's session, never the parent's.
    const outcome = await killApp(exeName, { ownerUser: enforcementUser ?? undefined });
    if (outcome === 'protected') return; // system app we must not touch
    console.log(`[limits] ✋ ${exeName} → ${outcome} (${minutes === null ? 'bloquée' : `limite ${minutes} min`})`);
    host().ui.showTimeUp(
      minutes === null
        ? { title: 'Application bloquée', app: label(exeName), detail: "Tes parents ont bloqué cette application sur ce PC." }
        : {
            title: 'Temps écoulé',
            app: label(exeName),
            detail: `Tu as utilisé tes ${minutes} min d'aujourd'hui. On se retrouve demain !`,
          },
    );
  })().catch((err) => console.error('[limits] fermeture échouée:', err));
}

// One tick from the foreground sensor: the counted app and the time since the last tick.
export function foregroundTick(exeName: string | null, elapsedMs: number) {
  if (!started) return;
  rolloverIfNewDay();
  if (!exeName) return; // locked, idle desktop, system UI, or a Store app (no exe)
  account(exeName, elapsedMs);
}

// Fallback from the service when the session app (foreground sensor) is down: the
// service counts the time a limited exe is *running* in the child's session. Coarser
// than foreground time, but untamperable — killing the app never buys time.
export function runningTick(exeName: string, elapsedMs: number) {
  if (!started) return;
  rolloverIfNewDay();
  account(exeName, elapsedMs);
}

// Exe names that carry a rule, so the service only counts those in the fallback.
export const ruledExes = () => new Set(rules.map((r) => r.exeName));

// Add elapsed time to an app's daily counter and enforce its rule.
function account(exeName: string, elapsedMs: number) {
  // Count every app, not only limited ones: a limit added mid-day must see the
  // time already spent today, like the dashboard does.
  const used = (usage.ms[exeName] = (usage.ms[exeName] ?? 0) + elapsedMs);
  if (Date.now() - lastPersistAt > PERSIST_EVERY_MS) void persist();

  const rule = rules.find((r) => r.exeName === exeName);
  if (!rule) return;

  if (rule.mode === 'block') {
    enforce(exeName, null);
    return;
  }

  // mode 'limit': a null limit means "no cap", so nothing to enforce.
  if (rule.dailyLimitMinutes == null) return;
  const limitMs = rule.dailyLimitMinutes * 60_000;
  if (used >= limitMs) {
    enforce(exeName, rule.dailyLimitMinutes);
  } else if (used >= limitMs - warnBeforeMs() && !warned.has(exeName)) {
    warned.add(exeName);
    const leftMin = Math.max(1, Math.round((limitMs - used) / 60_000));
    console.log(`[limits] ⏳ ${exeName} : encore ${leftMin} min`);
    void host()
      .ui.message(`${label(exeName)} : encore ${leftMin} min aujourd'hui.`)
      .catch(() => undefined);
  }
}

// Line the local counters up with what the API knows (sent with the rules):
// - after a parent reset, the counter drops to the usage since that reset;
// - otherwise keep the higher value, so usage from before a reinstall or before
//   the limit existed still counts (the API lags behind by the unsent sessions).
function mergeServerUsage(next: Rules) {
  if (next.day !== usage.day) return; // usage from another day, or an old API
  const resets = (usage.resets ??= {});
  for (const rule of next.apps) {
    if (rule.usedTodaySeconds === undefined) continue;
    const serverMs = rule.usedTodaySeconds * 1000;
    const localMs = usage.ms[rule.exeName] ?? 0;
    if (rule.usageResetAt && rule.usageResetAt !== resets[rule.exeName]) {
      resets[rule.exeName] = rule.usageResetAt;
      usage.ms[rule.exeName] = serverMs;
      warned.delete(rule.exeName);
      console.log(`[limits] ⏪ ${rule.exeName} remis à zéro par le parent → ${Math.round(serverMs / 60_000)} min`);
    } else if (serverMs > localMs) {
      usage.ms[rule.exeName] = serverMs;
      console.log(`[limits] 🔄 ${rule.exeName} : le serveur connaît ${Math.round(serverMs / 60_000)} min, j'en avais ${Math.round(localMs / 60_000)}`);
    }
  }
  void persist();
}

// Replace the rules the limits act on. Called from agent.ts at each rules change.
export function setLimitRules(next: Rules) {
  rules = next.apps;
  rolloverIfNewDay();
  mergeServerUsage(next);
}

// Start counting and enforcing. Loads the counters and the rules cached from the
// last sync, so limits apply right away, even before the first sync or offline.
export async function startLimits(initialRules: Rules | null) {
  const saved = await readJson<Usage>(USAGE_FILE);
  usage = saved && saved.day === today() ? saved : { day: today(), ms: {} };
  if (initialRules) setLimitRules(initialRules);
  started = true;
}

// Stop enforcing and forget today's counters (device unpaired).
export async function stopLimits() {
  started = false;
  rules = [];
  warned.clear();
  lastKillAt.clear();
  usage = { day: today(), ms: {} };
  await removeJson(USAGE_FILE);
}
