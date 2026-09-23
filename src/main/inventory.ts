import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { shell } from 'electron';
import type { InstalledApp } from '../shared/api-types';

const run = promisify(execFile);

const EXE_NAME = /^[^\\/:*?"<>|]{1,255}\.exe$/;
// Installers, updaters and uninstallers are not apps a parent wants to see.
const NOT_AN_APP = /^(unins\d*|uninst(all)?|.*setup.*|.*install(er)?|update(r)?|vc_redist.*|winsdksetup)\.exe$/i;
const NOT_AN_APP_NAME = /^(uninstall|désinstaller|remove)\b/i;
const WINDOWS_DIR = (process.env.SystemRoot ?? 'C:\\Windows').toLowerCase() + '\\';

const START_MENUS = [
  path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
];

const UNINSTALL_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$paths = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
$apps = Get-ItemProperty $paths |
  Where-Object { $_.DisplayName -and -not $_.SystemComponent -and -not $_.ParentKeyName } |
  Select-Object DisplayName, DisplayIcon
ConvertTo-Json -Compress -InputObject @($apps)
`;

type Candidate = { exePath: string; name: string };

function toApp({ exePath, name }: Candidate): InstalledApp | null {
  const exeName = path.win32.basename(exePath).toLowerCase();
  const cleanName = name.trim().slice(0, 255);
  if (!EXE_NAME.test(exeName) || NOT_AN_APP.test(exeName) || !cleanName || NOT_AN_APP_NAME.test(cleanName)) return null;
  if (exePath.toLowerCase().startsWith(WINDOWS_DIR) || /\\package cache\\/i.test(exePath)) return null;
  return { exeName, name: cleanName, path: path.win32.isAbsolute(exePath) ? exePath.slice(0, 1024) : undefined };
}

const expandEnv = (value: string) => value.replace(/%([^%]+)%/g, (m, name: string) => process.env[name] ?? m);

async function fromStartMenu(): Promise<Candidate[]> {
  const found: Candidate[] = [];
  for (const dir of START_MENUS) {
    let files: string[];
    try {
      files = await fs.readdir(dir, { recursive: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.toLowerCase().endsWith('.lnk')) continue;
      let link: Electron.ShortcutDetails;
      try {
        link = shell.readShortcutLink(path.join(dir, file));
      } catch {
        continue;
      }
      const name = path.basename(file, path.extname(file));
      // Squirrel apps (Discord, Teams…) start through Update.exe --processStart App.exe.
      const squirrel = /--processStart\s+"?([^"\s]+\.exe)"?/i.exec(link.args ?? '');
      if (squirrel) found.push({ exePath: squirrel[1], name });
      else if (link.target?.toLowerCase().endsWith('.exe')) found.push({ exePath: expandEnv(link.target), name });
    }
  }
  return found;
}

async function fromUninstallKeys(): Promise<Candidate[]> {
  const script = Buffer.from(UNINSTALL_SCRIPT, 'utf16le').toString('base64');
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', script], {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const rows = JSON.parse(stdout || '[]') as { DisplayName: string; DisplayIcon: string | null }[];
  return rows.flatMap((row) => {
    // DisplayIcon looks like "C:\path\app.exe",0
    const icon = expandEnv((row.DisplayIcon ?? '').replace(/,-?\d+$/, '').replace(/"/g, '').trim());
    return icon.toLowerCase().endsWith('.exe') ? [{ exePath: icon, name: row.DisplayName }] : [];
  });
}

export async function scanInstalledApps(): Promise<InstalledApp[]> {
  const [shortcuts, registry] = await Promise.all([
    fromStartMenu(),
    fromUninstallKeys().catch((err: Error): Candidate[] => {
      console.error('Uninstall keys scan failed:', err.message);
      return [];
    }),
  ]);

  const apps = new Map<string, InstalledApp>();
  // Start menu names are what the child sees, so they win over registry names.
  for (const candidate of [...shortcuts, ...registry]) {
    const found = toApp(candidate);
    if (!found) continue;
    const existing = apps.get(found.exeName);
    if (!existing) apps.set(found.exeName, found);
    else if (!existing.path && found.path) existing.path = found.path;
  }
  return [...apps.values()].sort((a, b) => a.exeName.localeCompare(b.exeName));
}

export function inventoryHash(apps: InstalledApp[]) {
  return createHash('sha256').update(JSON.stringify(apps)).digest('hex');
}
