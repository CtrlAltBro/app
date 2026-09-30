import { runPowerShell } from './powershell';

// Blocked websites, written as Edge policies into each monitored child's own
// registry hive (HKU\<SID>\Software\Policies\Microsoft\Edge): the child can read
// but not change it, and the parent's Edge is not affected. Edge picks a policy
// change up by itself, no restart needed. A hive is only loaded while its account
// is signed in, so the service applies the list at each sign-in; while a child is
// signed out, their hive keeps the last list written.
//
// URLBlocklist entries use Chromium's URL filter format: "youtube.com" also blocks
// its subdomains, any scheme and path. InPrivate is turned off while sites are
// blocked, as it is the first way around it.

// null until the rules are known, so a service start never wipes the list early.
let sites: string[] | null = null;
// SID → the list last written to that hive (JSON), so each hive is rewritten only on change.
const applied = new Map<string, string>();

export function setBlockedSites(next: string[]) {
  const sorted = [...new Set(next)].sort();
  if (sites && JSON.stringify(sites) === JSON.stringify(sorted)) return;
  sites = sorted;
  applied.clear();
}

const WRITE_EDGE_POLICY = `$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
$edge = "Registry::HKEY_USERS\\$($in.sid)\\Software\\Policies\\Microsoft\\Edge"
$list = "$edge\\URLBlocklist"
if (Test-Path $list) { Remove-Item $list -Recurse -Force }
$sites = @($in.sites)
if ($sites.Count) {
  New-Item $list -Force | Out-Null
  for ($i = 0; $i -lt $sites.Count; $i++) {
    New-ItemProperty $list -Name ($i + 1) -Value $sites[$i] -PropertyType String -Force | Out-Null
  }
  New-ItemProperty $edge -Name InPrivateModeAvailability -Value 1 -PropertyType DWord -Force | Out-Null
} elseif (Test-Path $edge) {
  Remove-ItemProperty $edge -Name InPrivateModeAvailability -ErrorAction SilentlyContinue
}`;

// Bring the hives of the signed-in monitored accounts in line with the list.
export async function syncSitePolicies(signedInSids: Iterable<string>) {
  if (sites === null) return;
  const want = JSON.stringify(sites);
  const live = new Set(signedInSids);
  // Signed out: its hive is unloaded, rewrite it at the next sign-in.
  for (const sid of applied.keys()) if (!live.has(sid)) applied.delete(sid);
  for (const sid of live) {
    if (applied.get(sid) === want) continue;
    try {
      await runPowerShell(WRITE_EDGE_POLICY, JSON.stringify({ sid, sites }));
      applied.set(sid, want);
      console.log(`[sites] 🌐 Edge : ${sites.length ? `${sites.length} site(s) bloqué(s)` : 'aucun site bloqué'} pour ${sid}`);
    } catch (err) {
      console.error(`[sites] écriture de la stratégie Edge échouée pour ${sid}`, err);
    }
  }
}
