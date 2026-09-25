import { execFileSync, spawn } from 'node:child_process';

const args = (script: string) => [
  '-NoProfile',
  '-NonInteractive',
  '-EncodedCommand',
  Buffer.from(
    `$ProgressPreference = 'SilentlyContinue'\n[Console]::InputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8\n${script}`,
    'utf16le',
  ).toString('base64'),
];

// Runs a script with `input` on stdin (never on the command line, where other
// processes could read it) and returns stdout.
export function runPowerShell(script: string, input = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', args(script), { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `powershell exited ${code}`))));
    child.stdin.end(input, 'utf8');
  });
}

export function runPowerShellSync(script: string, input = ''): string {
  try {
    return execFileSync('powershell.exe', args(script), { input, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
  } catch (err) {
    // Keep the PowerShell exception, not the (long, encoded) command line.
    const stderr = String((err as { stderr?: string }).stderr ?? '');
    const m = /Exception calling "(\w+)"[^:]*: "([^"_]*)/.exec(stderr);
    throw new Error(m ? `${m[1]}: ${m[2]}` : 'powershell failed');
  }
}
