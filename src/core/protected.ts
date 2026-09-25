import path from 'node:path';

// Executables the agent must never kill or block, whatever the rules say.
// Mirrored server-side in web-api `worker/lib/protected.ts` (keep both in sync).
const PROTECTED = new Set([
  'applicationframehost.exe', // hosts every Store app window
  'conhost.exe',
  'csrss.exe',
  'ctfmon.exe',
  'ctrlaltbro.exe',
  'dwm.exe',
  'electron.exe', // the agent itself in dev
  'explorer.exe',
  'fontdrvhost.exe',
  'lockapp.exe',
  'logonui.exe',
  'lsass.exe',
  'powershell.exe', // runs the screen-time watcher and the inventory scan
  'rundll32.exe',
  'searchhost.exe',
  'sechealthui.exe',
  'services.exe',
  'shellexperiencehost.exe',
  'sihost.exe',
  'smss.exe',
  'startmenuexperiencehost.exe',
  'svchost.exe',
  'taskkill.exe',
  'taskmgr.exe',
  'textinputhost.exe',
  'wininit.exe',
  'winlogon.exe',
  path.basename(process.execPath).toLowerCase(),
]);

export function isProtected(exeName: string) {
  return PROTECTED.has(exeName.toLowerCase());
}
