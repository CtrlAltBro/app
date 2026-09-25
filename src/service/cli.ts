import { clearPairing, getStatus, initAgent, pairFromCli } from '../core/agent';

// Admin commands, run once and exit (the child never pairs from their session):
//   service.js pair <code> <name...> [--force]
//   service.js unpair
//   service.js status
// Returns true when it handled a command, false to fall through to the service.
export async function runCli(argv: string[]): Promise<boolean> {
  const [cmd, ...rest] = argv.filter((a) => a !== '--dev');
  if (cmd !== 'pair' && cmd !== 'unpair' && cmd !== 'status') return false;

  if (cmd === 'status') {
    await initAgent();
    const s = getStatus();
    console.log(s.paired ? `Appairé : ${s.deviceName} (${s.deviceId})` : 'Non appairé.');
    return true;
  }

  if (cmd === 'unpair') {
    await clearPairing();
    console.log('Ce PC est dissocié.');
    return true;
  }

  // pair
  const force = rest.includes('--force');
  const args = rest.filter((a) => a !== '--force');
  const code = args[0];
  const name = args.slice(1).join(' ');
  if (!code || !name) {
    console.error('Usage : service.js pair <code> <nom du PC> [--force]');
    process.exitCode = 2;
    return true;
  }
  const result = await pairFromCli(code, name, force);
  if (result.ok) console.log(`Appairé : ${result.status.paired ? result.status.deviceName : ''}`);
  else {
    console.error(`Échec de l'appairage : ${result.error}`);
    process.exitCode = 1;
  }
  return true;
}
