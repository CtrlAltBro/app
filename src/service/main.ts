import net from 'node:net';
import path from 'node:path';
import { flushNow, getStatus, initAgent, shutdownAgent, sleepNow } from '../core/agent';
import { setHost } from '../core/host';
import { foregroundTick, isEnforced, launchBlockText, ruledExes, runningTick, screenTick, setEnforcementUser } from '../core/limits';
import { scheduleState } from '../core/schedule';
import { recordEvent } from '../core/events-queue';
import { addSession } from '../core/screen-time-queue';
import type { AgentStatus, PairResult } from '../shared/agent-api';
import type { ScreenTimeSession } from '../shared/api-types';
import { PIPE_PATH, PipeConnection, type CoreApi, type SessionApi } from '../shared/pipe';
import { runCli } from './cli';
import { monitoredSids, nameForSid } from './monitored';
import { lockUserSession, messageUser, sessionIdForUser, sessionUsers } from './session-control';
import { nodeHost, type SessionLink } from './node-host';
import { clearStaleBlocks, pauseLaunchBlocks } from './ifeo';
import { killPids, launchApp, loggedOnSids, runningProcessesForSession, syncTasks } from './session-app';
import { identify, type Identity } from './app-identity';
import { syncSitePolicies } from './site-policy';
import { checkSafeMode, checkUncleanStop, ensureSafeBootStart, markCleanStop, startTimeWatch } from './tamper';

// The core in its own Node process (milestone 2). Today it runs as the current
// user from a terminal (`npm run service`); milestone 3 runs it as a SYSTEM service.
// The session app (Electron) connects over the named pipe.

type Client = PipeConnection<CoreApi, SessionApi>;

// Anyone on the PC can connect to the pipe: sessions are checked before they are
// queued, since one invalid row makes the API reject the whole upload.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXE = /^[^\\/:*?"<>|]{1,255}\.exe$/;
function validSession(s: ScreenTimeSession) {
  const start = Date.parse(s?.startedAt);
  const end = Date.parse(s?.endedAt);
  return (
    UUID.test(s?.id) &&
    typeof s.app === 'string' && s.app.length > 0 && s.app.length <= 255 &&
    (s.exeName === undefined || (typeof s.exeName === 'string' && EXE.test(s.exeName))) &&
    (s.title === undefined || (typeof s.title === 'string' && s.title.length <= 1000)) &&
    end >= start && end - start <= 24 * 3600_000
  );
}

const dev = process.argv.includes('--dev');
const clients = new Set<Client>();
// SID each connected session app runs as (from its 'hello').
const clientSids = new Map<Client, string>();
// Clients whose session is watched: their screen time / foreground drive the agent,
// and limits may close their apps. In dev every client counts (one-user loop).
const monitoredClients = new Set<Client>();
const isMonitored = (client: Client) => dev || monitoredClients.has(client);
// Cached set of monitored SIDs, refreshed from config so a `monitor` change is picked up.
let monitored = new Set<string>();
// Clients that closed cleanly (sent 'goodbye'), and monitored SIDs whose app dropped
// without one — i.e. killed. The supervisor turns the latter into an 'app_killed' event.
const saidGoodbye = new WeakSet<Client>();
const killedAppSids = new Set<string>();

// UI requests go to the most recently connected session app.
const latest = () => [...clients].at(-1);
// Connected session apps whose account is monitored (every client in dev).
const monitoredConnected = () => (dev ? [...clients] : [...monitoredClients]);

const session: SessionLink = {
  broadcast(status: AgentStatus) {
    for (const client of clients) client.emit('status', status);
  },
  emit(type, data) {
    const client = latest();
    if (client) (client.emit as (t: string, d: unknown) => void)(type, data);
    else console.log(`[pipe] 🙈 pas d'app de session connectée, "${type}" ignoré`);
  },
  async request(type) {
    const client = latest();
    if (client) await client.request(type);
  },
  async showMessage(text) {
    // Prefer the child's session app; otherwise a plain msg.exe box in their session.
    const targets = monitoredConnected();
    if (targets.length) {
      await Promise.any(targets.map((c) => c.request('message', { text })));
      return;
    }
    if (!dev) {
      const on = await loggedOnSids().catch(() => new Set<string>());
      let sent = false;
      for (const sid of monitored) if (on.has(sid)) sent = (await messageUser(await nameForSid(sid), text)) || sent;
      if (sent) return;
    }
    throw new Error("Service actif, mais aucune session enfant n'est ouverte sur le PC");
  },
  async lockSession() {
    // The session app locks its own desktop; for any monitored session it did not
    // lock (app absent or too old to handle it), the service disconnects it.
    let done = false;
    const locked = new Set<string>();
    for (const client of monitoredConnected()) {
      if (await client.request('lock').then(() => true, () => false)) {
        done = true;
        const sid = clientSids.get(client);
        if (sid) locked.add(sid);
      }
    }
    if (!dev) {
      const on = await loggedOnSids().catch(() => new Set<string>());
      for (const sid of monitored) {
        if (on.has(sid) && !locked.has(sid)) done = (await lockUserSession(await nameForSid(sid))) || done;
      }
    }
    if (!done) throw new Error("Aucune session enfant à verrouiller");
  },
};

// Health for the dashboard: is a monitored child signed in, and is their session app connected.
const health = async () => {
  const on = await loggedOnSids().catch(() => new Set<string>());
  return {
    appConnected: (await sidsWithGenuineApp()).size > 0,
    childSignedIn: dev ? clients.size > 0 : [...monitored].some((sid) => on.has(sid)),
  };
};

setHost(nodeHost({ dev, session, health }));

// Anti-spoof for foreground ticks (pitfall #2). The pipe is world-connectable, so a
// process the child runs can pretend to be the session app and send fake foreground
// ticks. We never trust the pipe to decide that a limited app is being used: a tick
// is counted only for an exe that is really running under the reporting account.
// tasklist is cached per SID for a few seconds so the 5 s ticks don't each shell out.
// A scan of a session's processes: the actual image names running (for the spoof
// cross-check), a map from each running name to the rule key it counts as (an exe's
// canonical identity, so a renamed copy maps back — issue #18), and the identities
// with their PIDs (to close a renamed blocked app).
type Scan = { names: Set<string>; toCanonical: Map<string, string>; identities: (Identity & { pid: number })[] };
const emptyScan = (): Scan => ({ names: new Set(), toCanonical: new Map(), identities: [] });

const RUNNING_TTL_MS = 5_000;
const runningCache = new Map<string, { at: number; scan: Promise<Scan> }>();
function scanSession(sid: string): Promise<Scan> {
  const hit = runningCache.get(sid);
  if (hit && Date.now() - hit.at < RUNNING_TTL_MS) return hit.scan;
  const scan = (async (): Promise<Scan> => {
    const name = await nameForSid(sid);
    const sessionId = await sessionIdForUser(name);
    if (sessionId == null) return emptyScan();
    const procs = await runningProcessesForSession(sessionId).catch(() => []);
    const byPid = await identify(procs);
    const out = emptyScan();
    for (const p of procs) {
      // Always listed under its file name, even when its identity could not be read
      // (e.g. Store apps in the locked-down WindowsApps folder), so it still counts.
      const name = p.path.replace(/^.*[\\/]/, '').toLowerCase();
      out.names.add(name);
      const id = byPid.get(p.pid);
      if (!id) continue;
      out.toCanonical.set(id.name, id.canonical);
      out.identities.push({ ...id, pid: p.pid });
    }
    return out;
  })().catch(() => emptyScan());
  runningCache.set(sid, { at: Date.now(), scan });
  return scan;
}

// Issue #13: anyone can connect to the pipe and announce a child's account, which
// would make the service believe the session app is there (no fallback counting, no
// relaunch) while nothing is counted. So an account only has its session app when a
// client announced it AND our packaged exe, in Program Files (not writable by the
// child), really runs in that session. A claim without it is reported as spoofing.
const APP_EXE = path
  .join(process.env.ProgramFiles ?? 'C:\\Program Files', 'CtrlAltBro', 'app', 'ctrlaltbro.exe')
  .toLowerCase();
async function sidsWithGenuineApp(): Promise<Set<string>> {
  const claimed = new Set([...monitoredClients].map((c) => clientSids.get(c)).filter((s): s is string => !!s));
  if (dev) return claimed;
  const genuine = new Set<string>();
  for (const sid of claimed) {
    const scan = await scanSession(sid);
    if (scan.identities.some((i) => i.path.toLowerCase() === APP_EXE)) {
      genuine.add(sid);
    } else if (Date.now() - (spoofReportedAt.get(sid) ?? 0) > SPOOF_REPORT_MS) {
      spoofReportedAt.set(sid, Date.now());
      console.log(`[pipe] 🕵️  client du pipe pour ${sid} sans la vraie app de session : ignoré`);
      recordEvent('pipe_spoof', "Un programme se fait passer pour l'app de contrôle alors qu'elle ne tourne pas : le comptage de secours reste actif.");
    }
  }
  return genuine;
}

// A just-launched exe can miss the cached tasklist for a tick or two, so only a
// streak of rejected ticks on one connection is reported as spoofing (then at most
// once per SPOOF_REPORT_MS per account).
const SPOOF_STREAK = 3;
const SPOOF_REPORT_MS = 10 * 60 * 1000;
const spoofStreak = new WeakMap<Client, number>();
const spoofReportedAt = new Map<string, number>();

async function countForegroundTick(client: Client, exeName: string | null, elapsedMs: number) {
  // In dev everything runs as one user and there is no monitored SID to check against.
  if (dev) return foregroundTick(exeName, elapsedMs);
  // A null tick (locked, idle, Store app) carries no exe to verify — pass it through
  // so the day rollover still runs; it counts nothing.
  if (exeName) {
    const sid = clientSids.get(client);
    const scan = sid ? await scanSession(sid) : emptyScan();
    if (!scan.names.has(exeName.toLowerCase())) {
      console.log(`[pipe] 🕵️  tick ignoré : ${exeName} ne tourne pas dans la session (probable spoof)`);
      const streak = (spoofStreak.get(client) ?? 0) + 1;
      spoofStreak.set(client, streak);
      if (sid && streak >= SPOOF_STREAK && Date.now() - (spoofReportedAt.get(sid) ?? 0) > SPOOF_REPORT_MS) {
        spoofReportedAt.set(sid, Date.now());
        recordEvent(
          'pipe_spoof',
          `Un programme se fait passer pour l'app de contrôle et envoie un faux usage (ex. « ${exeName} », qui ne tourne pas).`,
        );
      }
      return;
    }
    spoofStreak.delete(client);
    // Count under the app's canonical name, so a renamed copy counts as the original.
    foregroundTick(scan.toCanonical.get(exeName.toLowerCase()) ?? exeName, elapsedMs);
    return;
  }
  foregroundTick(exeName, elapsedMs);
}

const server = net.createServer((socket): void => {
  const client: Client = new PipeConnection(socket);
  clients.add(client);
  console.log(`[pipe] 🔌 app de session connectée (${clients.size})`);
  client
    .handle('getStatus', () => getStatus())
    // The child must not pair from their session: pairing is an admin command.
    .handle('pair', (): PairResult => ({ ok: false, error: "L'appairage se fait par l'administrateur du PC." }))
    // IFEO blocks are machine-wide: only a monitored account is really kept out.
    // The SID is claimed, not proven, but faking it only gets what a hand-made IFEO
    // bypass already gets, and the child's session still kills the app on sight.
    .handle('launchCheck', async ({ sid, exeName }) => {
      const exe = String(exeName).toLowerCase();
      if (!dev && !monitored.has(String(sid))) return { allowed: true };
      const text = await launchBlockText(exe);
      console.log(`[ifeo] 🚪 lancement de ${exe} ${text ? 'refusé' : 'autorisé (blocage périmé)'}`);
      return text ? { allowed: false, text } : { allowed: true };
    })
    .on('hello', ({ sid }) => {
      const id = String(sid);
      clientSids.set(client, id);
      const watched = monitored.has(id);
      if (watched) monitoredClients.add(client);
      killedAppSids.delete(id); // the app is back
      void nameForSid(id).then((name) => {
        console.log(`[pipe] 👤 session app pour ${name} — ${dev ? 'dev (comptée)' : watched ? 'surveillée' : 'non surveillée (ignorée)'}`);
        // Limits close only this account's apps, never the parent's.
        if (watched && !dev) setEnforcementUser(name);
      });
    })
    .on('session', (s) => {
      if (!isMonitored(client)) return; // ignore the parent's session
      if (validSession(s)) addSession({ id: s.id, app: s.app, exeName: s.exeName, title: s.title, startedAt: s.startedAt, endedAt: s.endedAt });
      else console.warn('[pipe] ⚠️ session invalide ignorée');
    })
    .on('foreground', ({ exeName, elapsedMs }) => {
      if (!isMonitored(client)) return; // ignore the parent's session
      const exe = typeof exeName === 'string' ? exeName : null;
      const ms = Math.max(0, Math.min(Number(elapsedMs) || 0, 60_000));
      void countForegroundTick(client, exe, ms);
    })
    .on('leave', () => {
      if (isMonitored(client)) flushNow();
    })
    .on('goodbye', () => saidGoodbye.add(client))
    .on('suspend', () => {
      if (isMonitored(client)) sleepNow();
    });
  socket.on('close', () => {
    const sid = clientSids.get(client);
    // Dropped without 'goodbye' = killed, unless another app for this account is still
    // connected (e.g. a fake client going away while the real app keeps running).
    const othersForSid = [...monitoredClients].some((c) => c !== client && clientSids.get(c) === sid);
    if (!dev && sid && monitoredClients.has(client) && !saidGoodbye.has(client) && !othersForSid) killedAppSids.add(sid);
    clients.delete(client);
    clientSids.delete(client);
    monitoredClients.delete(client);
    console.log(`[pipe] 🔌 app de session déconnectée (${clients.size})`);
  });
});

server.on('error', (err) => {
  console.error('[service] impossible d’ouvrir le pipe (un autre service tourne déjà ?)', err.message);
  process.exit(1);
});

let stopping = false;
async function stop(reason: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[service] 🛑 ${reason} → dernier envoi puis arrêt`);
  server.close();
  // Clean stop: not a kill (and report an uninstall in progress), before the last upload.
  if (!dev) await markCleanStop().catch((e) => console.error('[tamper] marqueur d’arrêt échoué', e));
  await shutdownAgent();
  process.exit(0);
}
process.on('SIGINT', () => void stop('Ctrl+C'));
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGBREAK', () => void stop('Ctrl+Break'));

void (async () => {
  // Admin one-shot commands (pair / unpair / status) run and exit; no pipe server.
  if (await runCli(process.argv.slice(2))) {
    process.exit(process.exitCode ?? 0);
  }
  await initAgent();
  // Lift any app-launch blocks left over from a previous day (service off past midnight).
  if (!dev) await clearStaleBlocks().catch((e) => console.error('[ifeo] nettoyage échoué', e));
  // After initAgent, so these land in the loaded event queue.
  if (!dev) {
    await ensureSafeBootStart().catch((e) => console.error('[tamper] inscription mode sans échec échouée', e));
    await checkSafeMode().catch((e) => console.error('[tamper] détection mode sans échec échouée', e));
    await checkUncleanStop().catch((e) => console.error('[tamper] vérification du dernier arrêt échouée', e));
    startTimeWatch();
  }
  // Lowercased names of the monitored accounts, to tell their sessions from the parent's.
  let monitoredNames = new Set<string>();
  const refreshMonitored = async () => {
    const next = new Set(await monitoredSids().catch(() => [...monitored]));
    if (!dev) await syncTasks(next, monitored).catch((e) => console.error('[app] synchro des tâches échouée', e));
    monitored = next;
    const names = await Promise.all([...next].map(nameForSid)).catch(() => null);
    if (names) monitoredNames = new Set(names.map((n) => n.toLowerCase()));
  };
  await refreshMonitored();
  setInterval(() => void refreshMonitored(), 60_000).unref();
  const names = [...monitoredNames];
  console.log(`[service] 👁️  comptes surveillés : ${names.length ? names.join(', ') : '(aucun)'}${dev ? ' (dev: tout compté)' : ''}`);

  // IFEO launch blocks catch every account: lift them while a parent session is
  // open (even locked or switched away from), put them back when it is closed.
  if (!dev) {
    const checkParentSession = async () => {
      const users = await sessionUsers().catch(() => null);
      if (!users) return; // unreadable: keep the current state
      const parentOn = users.some((u) => !monitoredNames.has(u));
      await pauseLaunchBlocks(parentOn).catch((e) => console.error('[ifeo] suspension échouée', e));
    };
    setInterval(() => void checkParentSession(), 5_000).unref();
    await checkParentSession();
  }

  // Keep the session app running in each monitored, signed-in session: if the
  // child killed it, start it again through its launch task (dev: never launch).
  if (!dev) {
    const relaunchAt = new Map<string, number>();
    const RELAUNCH_COOLDOWN_MS = 20_000;
    const supervise = async () => {
      const on = await loggedOnSids().catch(() => new Set<string>());
      // Blocked sites go into each signed-in child's hive (loaded only while signed in).
      await syncSitePolicies([...monitored].filter((sid) => on.has(sid)));
      // Signed out: the app went away with the session, not a kill.
      for (const sid of killedAppSids) if (!on.has(sid)) killedAppSids.delete(sid);
      const withApp = await sidsWithGenuineApp();
      for (const sid of monitored) {
        if (!on.has(sid) || withApp.has(sid)) continue;
        if (Date.now() - (relaunchAt.get(sid) ?? 0) < RELAUNCH_COOLDOWN_MS) continue;
        relaunchAt.set(sid, Date.now());
        const name = await nameForSid(sid);
        if (killedAppSids.delete(sid)) recordEvent('app_killed', `L'app de session de ${name} a été fermée de force, puis relancée.`);
        console.log(`[app] 🚀 (re)lancement de l'app de session pour ${name}`);
        await launchApp(sid).catch((e) => console.error('[app] lancement échoué', e));
      }
    };
    setInterval(() => void supervise(), 10_000).unref();
    void supervise();

    // Limit fallback: while a monitored session has no connected app (its foreground
    // sensor is down), count the running time of each ruled exe and enforce it, so
    // killing the app never pauses the limits. When the app is up, the foreground
    // sensor counts instead, so this stays off to avoid double counting.
    const FALLBACK_MS = 20_000;
    const fallback = async () => {
      const on = await loggedOnSids().catch(() => new Set<string>());
      const withApp = await sidsWithGenuineApp();
      const ruled = ruledExes();
      let anySignedInWithoutApp = false;
      for (const sid of monitored) {
        if (!on.has(sid) || withApp.has(sid)) continue;
        anySignedInWithoutApp = true;
        if (!ruled.size) continue;
        const name = await nameForSid(sid);
        // Count each running ruled app under its canonical name (a renamed copy too).
        const scan = await scanSession(sid);
        const hits = [...new Set([...scan.toCanonical.values()].filter((c) => ruled.has(c)))];
        if (!hits.length) continue;
        console.log(`[limits] 🛟 app absente pour ${name}, comptage secours : ${hits.join(', ')}`);
        setEnforcementUser(name);
        for (const exe of hits) runningTick(exe, FALLBACK_MS);
      }
      // Screen-on time for the schedule's total cap: while a child is signed in with
      // the app down, count the whole span (the foreground sensor is what counts it
      // when the app is up), so killing the app never pauses the total.
      if (anySignedInWithoutApp) screenTick(FALLBACK_MS);
    };
    setInterval(() => void fallback(), FALLBACK_MS).unref();

    // Close a renamed or copied blocked app (issue #18): the foreground/fallback count
    // it under its real identity, but IFEO blocks by file name only, so a renamed copy
    // still starts. Here the service kills any running process whose canonical app is
    // blocked (or over its limit) while its file name differs, and warns the parent.
    const renamedReportedAt = new Map<string, number>();
    const RENAME_REPORT_MS = 10 * 60 * 1000;
    const killRenamed = async () => {
      const on = await loggedOnSids().catch(() => new Set<string>());
      for (const sid of monitored) {
        if (!on.has(sid)) continue;
        const scan = await scanSession(sid);
        for (const id of scan.identities) {
          if (!id.renamed || !isEnforced(id.canonical)) continue;
          console.log(`[limits] 🎭 ${id.canonical} lancé sous le nom ${id.name} → fermeture`);
          await killPids([id.pid]).catch(() => undefined);
          const key = `${sid}|${id.canonical}`;
          if (Date.now() - (renamedReportedAt.get(key) ?? 0) > RENAME_REPORT_MS) {
            renamedReportedAt.set(key, Date.now());
            recordEvent('app_renamed', `${id.canonical} a été relancé sous le nom « ${id.name} » pour contourner le blocage.`);
          }
        }
      }
    };
    setInterval(() => void killRenamed(), 5_000).unref();

    // Enforce the time schedule: outside the allowed hours or once the day's total is
    // used up, lock the child's session (it goes back to the sign-in screen; logging
    // back in is locked again at the next check). Runs even with the app down, since
    // the child cannot change the PC's clock (standard user). Warn 5 min ahead.
    let lockedEpisode = false;
    let lastWarnKey = '';
    const enforceSchedule = async () => {
      const on = await loggedOnSids().catch(() => new Set<string>());
      const signedIn = [...monitored].some((sid) => on.has(sid));
      if (!signedIn) {
        lockedEpisode = false;
        return;
      }
      const state = scheduleState();
      if (state.locked) {
        if (!lockedEpisode) {
          lockedEpisode = true;
          const text =
            state.reason === 'bedtime'
              ? { title: "C'est l'heure de déconnecter", app: '', detail: "Ce n'est plus l'heure d'utiliser le PC. À demain !" }
              : { title: 'Temps d’écran écoulé', app: '', detail: "Tu as utilisé tout ton temps d'écran pour aujourd'hui." };
          session.emit('timeUp', text);
          await new Promise((r) => setTimeout(r, 4_000));
        }
        await session.lockSession().catch(() => undefined);
      } else {
        lockedEpisode = false;
        if (state.warn) {
          const key = `${new Date().toDateString()}:${state.warn.reason}`;
          if (key !== lastWarnKey) {
            lastWarnKey = key;
            const msg =
              state.warn.reason === 'bedtime'
                ? `Le PC se verrouille dans ${state.warn.minutes} min (heure limite).`
                : `Plus que ${state.warn.minutes} min de temps d'écran aujourd'hui.`;
            await session.showMessage(msg).catch(() => undefined);
          }
        }
      }
    };
    setInterval(() => void enforceSchedule(), 20_000).unref();
    void enforceSchedule();
  }
  // readableAll/writableAll: the service runs as SYSTEM, so without this the pipe
  // it creates is reachable only by SYSTEM and Administrators — the child's session
  // app (a standard, medium-integrity process) could not connect. Anyone can connect
  // anyway, so the pipe is never trusted for sensitive actions (see CLAUDE.md #2).
  server.listen({ path: PIPE_PATH, readableAll: true, writableAll: true }, () =>
    console.log(`[service] 🚀 cœur démarré, pipe ${PIPE_PATH}`),
  );
})();
