import { clearPairing, getStatus, initAgent, pairFromCli } from '../core/agent';
import { currentApiUrl, loadApiUrl, saveApiUrl } from '../core/config';
import { loadCredentials } from '../core/credentials';
import {
  addMonitored,
  isDefaultMonitored,
  monitoredSids,
  nameForSid,
  removeMonitored,
  resolveSid,
  setMonitored,
  useDefaultMonitored,
} from './monitored';

// Admin commands, run once and exit (the child never pairs from their session):
//   service.js pair <code> <name...> [--force]
//   service.js unpair
//   service.js status
//   service.js monitor [list | add <user|sid> | remove <user|sid> | set <user|sid>,... | default]
//   service.js server [<url>]
// Returns true when it handled a command, false to fall through to the service.
export async function runCli(argv: string[]): Promise<boolean> {
  const [cmd, ...rest] = argv.filter((a) => a !== '--dev');
  if (cmd !== 'pair' && cmd !== 'unpair' && cmd !== 'status' && cmd !== 'monitor' && cmd !== 'server') return false;

  if (cmd === 'server') {
    await runServer(rest[0]);
    return true;
  }

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

  if (action === 'set') {
    const sids: string[] = [];
    for (const target of (rest[1] ?? '').split(',').map((t) => t.trim()).filter(Boolean)) {
      const sid = await resolveSid(target);
      if (!sid) {
        console.error(`Compte introuvable : ${target}`);
        process.exitCode = 1;
        return;
      }
      sids.push(sid);
    }
    if (!sids.length) {
      console.error('Usage : service.js monitor set <user|sid>,<user|sid>…');
      process.exitCode = 2;
      return;
    }
    await setMonitored(sids);
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

  console.error('Usage : service.js monitor [list | add <user|sid> | remove <user|sid> | set <user|sid>,… | default]');
  process.exitCode = 2;
}

// Show or change the API server. A paired PC keeps the server it paired with, so
// moving to another server forgets the pairing (its token is worthless there): the
// PC must be paired again with a code from the new dashboard.
async function runServer(url: string | undefined) {
  await loadApiUrl();
  if (!url) {
    console.log(`Serveur : ${currentApiUrl()}`);
    return;
  }
  const before = currentApiUrl();
  const saved = await saveApiUrl(url);
  if (!saved) {
    console.error(`Adresse invalide : ${url} (attendu : http(s)://…)`);
    process.exitCode = 2;
    return;
  }
  console.log(`Serveur : ${saved}`);
  const creds = await loadCredentials();
  if (creds && creds.apiUrl !== saved && before !== saved) {
    await clearPairing();
    console.log('Ce PC était appairé à un autre serveur : appairage effacé, ré-appaire-le avec un code du nouveau dashboard.');
  }
}
