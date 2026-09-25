import net from 'node:net';
import { flushNow, getStatus, initAgent, pair, shutdownAgent } from '../core/agent';
import { setHost } from '../core/host';
import { foregroundTick } from '../core/limits';
import { addSession } from '../core/screen-time-queue';
import type { AgentStatus } from '../shared/agent-api';
import type { ScreenTimeSession } from '../shared/api-types';
import { PIPE_PATH, PipeConnection, type CoreApi, type SessionApi } from '../shared/pipe';
import { nodeHost, type SessionLink } from './node-host';

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

const clients = new Set<Client>();
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

const server = net.createServer((socket) => {
  const client: Client = new PipeConnection(socket);
  clients.add(client);
  console.log(`[pipe] 🔌 app de session connectée (${clients.size})`);
  client
    .handle('getStatus', () => getStatus())
    .handle('pair', ({ code, name }) => pair(String(code), String(name)))
    .on('session', (s) => {
      if (validSession(s)) addSession({ id: s.id, app: s.app, exeName: s.exeName, title: s.title, startedAt: s.startedAt, endedAt: s.endedAt });
      else console.warn('[pipe] ⚠️ session invalide ignorée');
    })
    .on('foreground', ({ exeName, elapsedMs }) =>
      foregroundTick(typeof exeName === 'string' ? exeName : null, Math.max(0, Math.min(Number(elapsedMs) || 0, 60_000))),
    )
    .on('leave', flushNow);
  socket.on('close', () => {
    clients.delete(client);
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
  await initAgent();
  server.listen(PIPE_PATH, () => console.log(`[service] 🚀 cœur démarré, pipe ${PIPE_PATH}`));
})();
