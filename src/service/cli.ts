import { clearPairing, getStatus, initAgent, pairFromCli } from '../core/agent';
import {
  addMonitored,
  isDefaultMonitored,
  monitoredSids,
  nameForSid,
  removeMonitored,
  resolveSid,
  useDefaultMonitored,
} from './monitored';

// Admin commands, run once and exit (the child never pairs from their session):
//   service.js pair <code> <name...> [--force]
//   service.js unpair
//   service.js status
//   service.js monitor [list | add <user|sid> | remove <user|sid> | default]
// Returns true when it handled a command, false to fall through to the service.
export async function runCli(argv: string[]): Promise<boolean> {
  const [cmd, ...rest] = argv.filter((a) => a !== '--dev');
  if (cmd !== 'pair' && cmd !== 'unpair' && cmd !== 'status' && cmd !== 'monitor') return false;

  if (cmd === 'status') {
    await initAgent();
    const s = getStatus();
    console.log(s.paired ? `Appairé : ${s.deviceName} (${s.deviceId})` : 'Non appairé.');
    return true;
  }

  if (cmd === 'monitor') {
    await runMonitor(rest);
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

async function printMonitored() {
  const sids = await monitoredSids();
  const source = (await isDefaultMonitored()) ? 'défaut : comptes non-admin' : 'liste explicite';
  console.log(`Comptes surveillés (${source}) :`);
  if (!sids.length) console.log('  (aucun)');
  for (const sid of sids) console.log(`  ${await nameForSid(sid)}  ${sid}`);
}

async function runMonitor(rest: string[]) {
  const [action, target] = rest;

  if (!action || action === 'list') {
    await printMonitored();
    return;
  }

  if (action === 'default') {
    await useDefaultMonitored();
    await printMonitored();
    return;
  }

  if (action === 'add' || action === 'remove') {
    if (!target) {
      console.error(`Usage : service.js monitor ${action} <nom d'utilisateur | SID>`);
      process.exitCode = 2;
      return;
    }
    const sid = await resolveSid(target);
    if (!sid) {
      console.error(`Compte introuvable : ${target}`);
      process.exitCode = 1;
      return;
    }
    if (action === 'add') await addMonitored(sid);
    else await removeMonitored(sid);
    await printMonitored();
    return;
  }

  console.error('Usage : service.js monitor [list | add <user|sid> | remove <user|sid> | default]');
  process.exitCode = 2;
}
