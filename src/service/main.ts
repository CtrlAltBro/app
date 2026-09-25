import net from 'node:net';
import { flushNow, getStatus, initAgent, shutdownAgent } from '../core/agent';
import { setHost } from '../core/host';
import { foregroundTick, ruledExes, runningTick, setEnforcementUser } from '../core/limits';
import { addSession } from '../core/screen-time-queue';
import type { AgentStatus, PairResult } from '../shared/agent-api';
import type { ScreenTimeSession } from '../shared/api-types';
import { PIPE_PATH, PipeConnection, type CoreApi, type SessionApi } from '../shared/pipe';
import { runCli } from './cli';
import { monitoredSids, nameForSid } from './monitored';
import { nodeHost, type SessionLink } from './node-host';
import { launchApp, loggedOnSids, runningExesForUser, syncTasks } from './session-app';

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

// UI requests go to the most recently connected session app.
const latest = () => [...clients].at(-1);

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
    const client = latest();
    if (!client) throw new Error("Service actif, mais l'app CtrlAltBro n'est pas ouverte sur le PC");
    await client.request('message', { text });
  },
};

setHost(nodeHost({ dev: process.argv.includes('--dev'), session }));

const server = net.createServer((socket): void => {
  const client: Client = new PipeConnection(socket);
  clients.add(client);
  console.log(`[pipe] 🔌 app de session connectée (${clients.size})`);
  client
    .handle('getStatus', () => getStatus())
    // The child must not pair from their session: pairing is an admin command.
    .handle('pair', (): PairResult => ({ ok: false, error: "L'appairage se fait par l'administrateur du PC." }))
    .on('hello', ({ sid }) => {
      const id = String(sid);
      clientSids.set(client, id);
      const watched = monitored.has(id);
      if (watched) monitoredClients.add(client);
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
      foregroundTick(typeof exeName === 'string' ? exeName : null, Math.max(0, Math.min(Number(elapsedMs) || 0, 60_000)));
    })
    .on('leave', () => {
      if (isMonitored(client)) flushNow();
    });
  socket.on('close', () => {
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
  const refreshMonitored = async () => {
    const next = new Set(await monitoredSids().catch(() => [...monitored]));
    if (!dev) await syncTasks(next, monitored).catch((e) => console.error('[app] synchro des tâches échouée', e));
    monitored = next;
  };
  await refreshMonitored();
  setInterval(() => void refreshMonitored(), 60_000).unref();
  const names = await Promise.all([...monitored].map(nameForSid)).catch(() => [...monitored]);
  console.log(`[service] 👁️  comptes surveillés : ${names.length ? names.join(', ') : '(aucun)'}${dev ? ' (dev: tout compté)' : ''}`);

  // Keep the session app running in each monitored, signed-in session: if the
  // child killed it, start it again through its launch task (dev: never launch).
  if (!dev) {
    const relaunchAt = new Map<string, number>();
    const RELAUNCH_COOLDOWN_MS = 20_000;
    const supervise = async () => {
      const on = await loggedOnSids().catch(() => new Set<string>());
      const withApp = new Set([...monitoredClients].map((c) => clientSids.get(c)));
      for (const sid of monitored) {
        if (!on.has(sid) || withApp.has(sid)) continue;
        if (Date.now() - (relaunchAt.get(sid) ?? 0) < RELAUNCH_COOLDOWN_MS) continue;
        relaunchAt.set(sid, Date.now());
        console.log(`[app] 🚀 (re)lancement de l'app de session pour ${await nameForSid(sid)}`);
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
      const ruled = ruledExes();
      if (!ruled.size) return;
      const on = await loggedOnSids().catch(() => new Set<string>());
      const withApp = new Set([...monitoredClients].map((c) => clientSids.get(c)));
      for (const sid of monitored) {
        if (!on.has(sid) || withApp.has(sid)) continue;
        const name = await nameForSid(sid);
        const running = await runningExesForUser(name);
        const hits = [...ruled].filter((exe) => running.has(exe));
        if (!hits.length) continue;
        console.log(`[limits] 🛟 app absente pour ${name}, comptage secours : ${hits.join(', ')}`);
        setEnforcementUser(name);
        for (const exe of hits) runningTick(exe, FALLBACK_MS);
      }
    };
    setInterval(() => void fallback(), FALLBACK_MS).unref();
  }
  // readableAll/writableAll: the service runs as SYSTEM, so without this the pipe
  // it creates is reachable only by SYSTEM and Administrators — the child's session
  // app (a standard, medium-integrity process) could not connect. Anyone can connect
  // anyway, so the pipe is never trusted for sensitive actions (see CLAUDE.md #2).
  server.listen({ path: PIPE_PATH, readableAll: true, writableAll: true }, () =>
    console.log(`[service] 🚀 cœur démarré, pipe ${PIPE_PATH}`),
  );
})();
