import path from 'node:path';

// Executables the agent must never kill or block, whatever the rules say.
const PROTECTED = new Set([
  'csrss.exe',
  'dwm.exe',
  'explorer.exe',
  'lsass.exe',
  'services.exe',
  'smss.exe',
  'svchost.exe',
  'taskmgr.exe',
  'wininit.exe',
  'winlogon.exe',
  'logonui.exe',
  'fontdrvhost.exe',
  'sihost.exe',
  'ctfmon.exe',
  'conhost.exe',
  'rundll32.exe',
  path.basename(process.execPath).toLowerCase(),
]);

export function isProtected(exeName: string) {
  return PROTECTED.has(exeName.toLowerCase());
}
