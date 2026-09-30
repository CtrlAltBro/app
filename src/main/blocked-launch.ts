import net from 'node:net';
import path from 'node:path';
import { app } from 'electron';
import { PIPE_PATH, PipeConnection, type CoreApi, type SessionApi, type TimeUpText } from '../shared/pipe';
import { runPowerShell } from '../service/powershell';
import { showTimeUp } from './time-up';

// When a limit or block is hit, the service points the exe's IFEO "Debugger" at us
// (src/service/ifeo.ts), so Windows starts `ctrlaltbro.exe <target> <args…>` instead
// of the target. IFEO is machine-wide, so we act as a short-lived stub: a monitored
// account gets the blocked screen, anyone else (the parent) gets the real app.

const CHECK_TIMEOUT_MS = 3_000;
const FALLBACK_TEXT: TimeUpText = {
  title: 'Application bloquée',
  app: '',
  detail: 'Cette application est bloquée sur ce PC pour le moment.',
};

// The intercepted command line, or null for a normal start of the session app.
// Our own launches (scheduled task, Squirrel) carry no argument or only switches.
export function interceptedLaunch(): string[] | null {
  if (!app.isPackaged) return null;
  const args = process.argv.slice(1);
  return args.length && !args[0].startsWith('-') ? args : null;
}

export function runInterceptedLaunch(argv: string[]) {
  // Own profile, so the stub never competes with the running session app for it.
  app.setPath('userData', path.join(app.getPath('temp'), 'ctrlaltbro-stub'));
  app.on('window-all-closed', () => app.quit());
  void app.whenReady().then(async () => {
    let exeName = path.win32.basename(argv[0]).toLowerCase();
    if (!exeName.endsWith('.exe')) exeName += '.exe';
    const verdict = await checkLaunch(exeName);
    if (!verdict.allowed) {
      showTimeUp(null, verdict.text ?? { ...FALLBACK_TEXT, app: exeName.replace(/\.exe$/, '') });
      return;
    }
    await startWithoutIfeo(argv).catch((err) => console.error('[stub] lancement échoué:', err));
    app.quit();
  });
}

async function identity(): Promise<{ sid: string; admin: boolean }> {
  const out = await runPowerShell(
    `$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$admin = [bool]((whoami /groups) -match 'S-1-5-32-544')
"$sid|$admin"`,
  );
  const [sid, admin] = out.trim().split('|');
  return { sid, admin: admin === 'True' };
}

// Ask the service. If it can't be reached, let only an Administrators member through,
// so the child stays blocked while the parent is never locked out of their own apps.
async function checkLaunch(exeName: string): Promise<{ allowed: boolean; text?: TimeUpText }> {
  const me = await identity().catch(() => ({ sid: '', admin: false }));
  const socket = net.connect(PIPE_PATH);
  try {
    const answer = await new Promise<{ allowed: boolean; text?: TimeUpText }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
      socket.once('error', reject);
      socket.once('connect', () => {
        const core = new PipeConnection<SessionApi, CoreApi>(socket);
        core.request('launchCheck', { sid: me.sid, exeName }).then(resolve, reject).finally(() => clearTimeout(timer));
      });
    });
    return answer;
  } catch {
    return { allowed: me.admin };
  } finally {
    socket.destroy();
  }
}

// Windows quoting (CommandLineToArgvW rules), to rebuild the command line.
function quoteArg(a: string) {
  if (a && !/[\s"]/.test(a)) return a;
  return `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

// Windows skips the IFEO Debugger for a process created under a debugger, so create
// it with DEBUG_ONLY_THIS_PROCESS and detach at once. An exe that needs elevation
// (740) goes through UAC instead: IFEO brings it back to us elevated, then allowed.
const START_SCRIPT = `$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class NoIfeo {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct StartupInfo {
    public int cb; public string reserved, desktop, title;
    public int x, y, xSize, ySize, xChars, yChars, fill, flags;
    public short show, reserved2; public IntPtr reserved3, stdIn, stdOut, stdErr;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessInfo { public IntPtr process, thread; public int pid, tid; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref StartupInfo si, out ProcessInfo pi);
  [DllImport("kernel32.dll")] static extern bool DebugSetProcessKillOnExit(bool kill);
  [DllImport("kernel32.dll")] static extern bool DebugActiveProcessStop(int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static int Start(string cmd, string cwd) {
    var si = new StartupInfo(); si.cb = Marshal.SizeOf(si);
    ProcessInfo pi;
    // DEBUG_ONLY_THIS_PROCESS | CREATE_NEW_CONSOLE
    if (!CreateProcessW(null, new StringBuilder(cmd), IntPtr.Zero, IntPtr.Zero, false, 0x12, IntPtr.Zero, cwd, ref si, out pi))
      return Marshal.GetLastWin32Error();
    DebugSetProcessKillOnExit(false);
    DebugActiveProcessStop(pi.pid);
    CloseHandle(pi.thread); CloseHandle(pi.process);
    return 0;
  }
}
'@
$err = [NoIfeo]::Start($in.cmd, $in.cwd)
if ($err -eq 740) {
  $p = @{ FilePath = $in.file; WorkingDirectory = $in.cwd; Verb = 'RunAs' }
  if ($in.tail) { $p.ArgumentList = $in.tail }
  try { Start-Process @p } catch { }
} elseif ($err -ne 0) { throw "CreateProcess $err" }`;

async function startWithoutIfeo(argv: string[]) {
  const tail = argv.slice(1).map(quoteArg).join(' ');
  const input = { cmd: argv.map(quoteArg).join(' '), cwd: process.cwd(), file: argv[0], tail };
  await runPowerShell(START_SCRIPT, JSON.stringify(input));
}
