import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { runPowerShell } from './powershell';

const run = promisify(execFile);

// Launches and keeps the session app alive in each monitored child's session.
// The service (SYSTEM, session 0) cannot show windows itself, so it starts the
// packaged Electron app in the child's session through a per-user scheduled task
// that runs as that account with its interactive token (no password needed):
//   - a logon trigger starts it when the child signs in;
//   - `schtasks /run` restarts it on demand when the child has killed it.

// The packaged session app installed by install-service.ps1.
const APP_EXE = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'CtrlAltBro', 'app', 'ctrlaltbro.exe');
const taskName = (sid: string) => `CtrlAltBro-${sid}`;

function taskXml(sid: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>CtrlAltBro session app for ${sid}</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${sid}</UserId></LogonTrigger></Triggers>
  <Principals>
    <Principal id="Author"><UserId>${sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
  </Settings>
  <Actions Context="Author"><Exec><Command>${APP_EXE}</Command></Exec></Actions>
</Task>`;
}

async function schtasks(args: string[]) {
  return run('schtasks.exe', args, { windowsHide: true });
}

// Create or replace the launch task for one account.
export async function ensureTask(sid: string) {
  const file = path.join(os.tmpdir(), `cab-task-${sid}.xml`);
  // schtasks /xml wants UTF-16 with a BOM.
  await fs.writeFile(file, Buffer.from('\ufeff' + taskXml(sid), 'utf16le'));
  try {
    await schtasks(['/create', '/tn', taskName(sid), '/xml', file, '/f']);
  } finally {
    await fs.rm(file, { force: true });
  }
}

export async function removeTask(sid: string) {
  await schtasks(['/delete', '/tn', taskName(sid), '/f']).catch(() => undefined);
}

// Start (or restart) the session app in the account's session.
export async function launchApp(sid: string) {
  await schtasks(['/run', '/tn', taskName(sid)]);
}

// SIDs currently logged on: a signed-in user's hive is mounted under HKEY_USERS.
export async function loggedOnSids(): Promise<Set<string>> {
  const out = await runPowerShell(
    `Get-ChildItem Registry::HKEY_USERS | Select-Object -ExpandProperty PSChildName`,
  ).catch(() => '');
  return new Set(
    out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => /^S-1-5-21-/.test(s) && !s.endsWith('_Classes')),
  );
}

// Lowercased .exe names currently running under one account (for the limit fallback
// when the session app is down). tasklist filters by USERNAME = COMPUTER\user.
export async function runningExesForUser(user: string): Promise<Set<string>> {
  const who = `${process.env.COMPUTERNAME ?? ''}\\${user}`;
  const { stdout } = await run('tasklist.exe', ['/FI', `USERNAME eq ${who}`, '/FO', 'CSV', '/NH'], { windowsHide: true }).catch(
    () => ({ stdout: '' }),
  );
  const exes = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^"([^"]+\.exe)"/i.exec(line.trim());
    if (m) exes.add(m[1].toLowerCase());
  }
  return exes;
}

// Make the set of launch tasks match the monitored accounts. ensureTask is
// idempotent, so calling it every refresh also restores a task a child deleted.
export async function syncTasks(monitored: Set<string>, previous: Set<string>) {
  for (const sid of monitored) await ensureTask(sid).catch((e) => console.error('[app] tâche création échouée', e));
  for (const sid of previous) if (!monitored.has(sid)) await removeTask(sid);
}
