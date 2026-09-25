import path from 'node:path';
import type { Host, Shortcut } from '../core/host';
import type { AgentStatus } from '../shared/agent-api';
import type { SessionApi, TimeUpText } from '../shared/pipe';
import { runPowerShell, runPowerShellSync } from './powershell';

declare const __APP_VERSION__: string;

// The session app connected over the pipe, if any.
export type SessionLink = {
  broadcast(status: AgentStatus): void;
  emit<K extends keyof SessionApi['events']>(type: K, data: SessionApi['events'][K]): void;
  request(type: 'snapshotForeground' | 'saveCurrentSession'): Promise<void>;
  // Throws when no session app is connected.
  showMessage(text: string): Promise<void>;
};

// DPAPI, current-user scope: only this Windows account (SYSTEM once installed as
// a service) can decrypt. The real protection comes later from the data dir ACL.
const PROTECT = `Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd()
[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($in), $null, 'CurrentUser'))`;
const UNPROTECT = `Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd().Trim()
[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in), $null, 'CurrentUser'))`;

// Target and arguments of each .lnk path read from stdin (JSON array), as JSON.
const READ_SHORTCUTS = `$ErrorActionPreference = 'SilentlyContinue'
$shell = New-Object -ComObject WScript.Shell
$files = [Console]::In.ReadToEnd() | ConvertFrom-Json
$out = foreach ($f in $files) {
  $l = $shell.CreateShortcut($f)
  if ($l) { [pscustomobject]@{ target = $l.TargetPath; args = $l.Arguments } } else { $null }
}
ConvertTo-Json -InputObject @($out) -Compress`;

export function nodeHost({ dev, session }: { dev: boolean; session: SessionLink }): Host {
  return {
    version: __APP_VERSION__,
    isDev: dev,
    // Same folder as the Electron app used, for now. Milestone 3: %ProgramData%\CtrlAltBro.
    dataDir: path.join(process.env.APPDATA ?? '.', 'ctrlaltbro'),
    secrets: {
      available: () => process.platform === 'win32',
      encrypt: (text) => runPowerShellSync(PROTECT, text).trim(),
      decrypt: (data) => runPowerShellSync(UNPROTECT, data).replace(/\r?\n$/, ''),
    },
    async readShortcuts(files) {
      if (!files.length) return [];
      const parsed = JSON.parse((await runPowerShell(READ_SHORTCUTS, JSON.stringify(files))) || '[]') as (Shortcut | null)[];
      return files.map((_, i) => parsed[i] ?? null);
    },
    statusChanged: (status) => session.broadcast(status),
    ui: {
      message: (text) => session.showMessage(text),
      snapshotForeground: () => session.request('snapshotForeground'),
      showTimeUp: (text: TimeUpText) => session.emit('timeUp', text),
      saveCurrentSession: () => session.request('saveCurrentSession'),
    },
  };
}
