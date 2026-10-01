import { stat } from 'node:fs/promises';
import { runPowerShell } from './powershell';

// An app is identified by more than its on-disk file name, so a renamed or copied
// exe (issue #18) is still recognized. The canonical name is, in order: the exe's
// OriginalFilename (set by its author, survives renaming and updates), else
// "<product> by <signer>" for a validly signed exe, else the on-disk file name.
// A signed exe needs no hash: its signature already guarantees the bytes; if the
// signature is broken, it falls back to OriginalFilename / product like an unsigned
// one, and pretending to be a blocked app that way is surfaced as a tamper event.

export type Identity = {
  name: string; // on-disk file name, lowercased (e.g. "truc.exe")
  path: string; // full image path
  canonical: string; // what rules match on (e.g. "firefox.exe")
  renamed: boolean; // canonical !== name
  signatureValid: boolean;
  signatureBroken: boolean; // signed, but the signature does not verify
};

type Process = { pid: number; path: string };

type Resolved = { canonical: string; signatureValid: boolean; signatureBroken: boolean };

// Identity per image path, keyed by the file's (size, mtime) so a self-updating app
// (Discord…) is re-read only when its bytes actually change.
const cache = new Map<string, { key: string; identity: Resolved }>();

const clean = (s: string) => s.trim().toLowerCase();

// Read OriginalFilename / ProductName / signature for a batch of paths, one call.
const RESOLVE = `$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
$out = foreach ($p in $in) {
  try {
    $vi = (Get-Item -LiteralPath $p -ErrorAction Stop).VersionInfo
    $sig = Get-AuthenticodeSignature -LiteralPath $p
    $signer = if ($sig.SignerCertificate) { ($sig.SignerCertificate.Subject -split ',')[0] -replace '^CN=','' } else { '' }
    [pscustomobject]@{ path = $p; orig = $vi.OriginalFilename; product = $vi.ProductName; status = [string]$sig.Status; signer = $signer }
  } catch { [pscustomobject]@{ path = $p; error = $true } }
}
ConvertTo-Json -InputObject @($out) -Compress -Depth 3`;

type Raw = { path: string; orig?: string | null; product?: string | null; status?: string; signer?: string; error?: boolean };

const baseName = (path: string) => clean(path.replace(/^.*[\\/]/, ''));

function canonicalOf(r: Raw): Resolved {
  const name = baseName(r.path);
  const signatureValid = r.status === 'Valid';
  const signatureBroken = !!r.signer && !signatureValid;
  const orig = r.orig ? clean(r.orig) : '';
  // Ignore an OriginalFilename that is not an .exe (e.g. notepad's "NOTEPAD.EXE.MUI").
  if (orig.endsWith('.exe')) return { canonical: orig, signatureValid, signatureBroken };
  if (signatureValid && r.product) return { canonical: `${clean(r.product)} by ${clean(r.signer ?? '')}`, signatureValid, signatureBroken };
  return { canonical: name, signatureValid, signatureBroken };
}

// The (size, mtime) key for a path, or null if it cannot be read.
async function fileKey(path: string): Promise<string | null> {
  try {
    const s = await stat(path);
    return `${s.size}|${s.mtimeMs}`;
  } catch {
    return null;
  }
}

// Resolve identities for a set of running processes, reading from disk only the paths
// that are new or whose bytes changed since last time.
export async function identify(procs: Process[]): Promise<Map<number, Identity>> {
  const keys = new Map<string, string>();
  const toRead = new Set<string>();
  for (const p of procs) {
    if (keys.has(p.path)) continue;
    const key = await fileKey(p.path);
    if (!key) continue;
    keys.set(p.path, key);
    if (cache.get(p.path)?.key !== key) toRead.add(p.path);
  }
  if (toRead.size) {
    const raw = JSON.parse((await runPowerShell(RESOLVE, JSON.stringify([...toRead])).catch(() => '[]')) || '[]') as Raw[];
    for (const r of raw) {
      if (r.error) continue;
      const key = keys.get(r.path);
      if (key) cache.set(r.path, { key, identity: canonicalOf(r) });
    }
  }
  const out = new Map<number, Identity>();
  for (const p of procs) {
    const hit = cache.get(p.path);
    if (!hit || keys.get(p.path) !== hit.key) continue;
    const name = baseName(p.path);
    out.set(p.pid, { name, path: p.path, ...hit.identity, renamed: hit.identity.canonical !== name });
  }
  return out;
}
