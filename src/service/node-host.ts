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

// DPAPI, machine scope: the admin pairs (writes the token), the SYSTEM service
// reads it, so both must be able to decrypt. Machine scope means any process on
// this PC can, so the real protection is the ACL the installer puts on dataDir
// (SYSTEM + Administrators only) — see pitfall #4 in CLAUDE.md.
const PROTECT = `Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd()
[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($in), $null, 'LocalMachine'))`;
const UNPROTECT = `Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd().Trim()
[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in), $null, 'LocalMachine'))`;

// Target and arguments of each .lnk path read from stdin (JSON array), as JSON.
const READ_SHORTCUTS = `$ErrorActionPreference = 'SilentlyContinue'
$shell = New-Object -ComObject WScript.Shell
$files = [Console]::In.ReadToEnd() | ConvertFrom-Json
$out = foreach ($f in $files) {
  $l = $shell.CreateShortcut($f)
  if ($l) { [pscustomobject]@{ target = $l.TargetPath; args = $l.Arguments } } else { $null }
}
ConvertTo-Json -InputObject @($out) -Compress`;

// State lives here, not in the child's %APPDATA%: as a service the core runs as
// SYSTEM, and the installer locks this folder down to SYSTEM + Administrators so
// the child cannot read the token or edit the cached rules / counters. In dev
// (core run as the user) the folder is created on first write, world-writable
// until the installer applies the ACL.
export const dataDir = () => path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'CtrlAltBro');

export function nodeHost({ dev, session }: { dev: boolean; session: SessionLink }): Host {
  return {
    version: __APP_VERSION__,
    isDev: dev,
    dataDir: dataDir(),
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
