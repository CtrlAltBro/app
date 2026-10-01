// Manual test for issue #13: a pipe client that announces the current account
// without being the real session app. Run it in the child's session, with the real
// app closed, using the installed Node:
//
//   taskkill /IM ctrlaltbro.exe /F
//   "C:\Program Files\CtrlAltBro\node.exe" C:\Users\Public\test-pipe-client.mjs
//
// Expected within ~10-20 s: the service still relaunches the real app, keeps its
// fallback counting on, and sends a pipe_spoof alert to the dashboard.
import { execFileSync } from 'node:child_process';
import net from 'node:net';

const sid = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' })
  .trim()
  .split(',')
  .pop()
  .replace(/"/g, '');

const socket = net.connect('\\\\.\\pipe\\ctrlaltbro', () => {
  socket.write(`${JSON.stringify({ type: 'hello', data: { sid } })}\n`);
  console.log(`Connecté au pipe en tant que ${sid}. Ctrl+C pour arrêter.`);
});
socket.on('data', () => undefined);
socket.on('error', (err) => {
  console.error(`Pipe injoignable : ${err.message}`);
  process.exit(1);
});
socket.on('close', () => {
  console.log('Connexion fermée par le service.');
  process.exit(0);
});
