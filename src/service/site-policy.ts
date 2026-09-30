import { runPowerShell } from './powershell';

// Blocked websites, written as browser policies into each monitored child's own
// registry hive (HKU\<SID>\Software\Policies\...): the child can read but not change
// it, and the parent's browsers are not affected. Browsers pick a policy change up
// by themselves, no restart needed. A hive is only loaded while its account is
// signed in, so the service applies the list at each sign-in; while a child is
// signed out, their hive keeps the last list written.
//
// Chromium-based browsers share the URLBlocklist format ("youtube.com" also blocks
// its subdomains, any scheme and path), each under its own key. Keys are written
// even for a browser that is not installed, so one the child installs later for
// themselves is covered from its first start. Private windows are turned off while
// sites are blocked, as they are the first way around it. Firefox is not here: its
// site filter is honored only machine-wide, which would block the parent too.

type Browser = { name: string; key: string; switches: Record<string, number> };

// Keep in sync with Clear-SitePolicy in installer/preuninstall.ps1.
const BROWSERS: Browser[] = [
  { name: 'Edge', key: 'Microsoft\\Edge', switches: { InPrivateModeAvailability: 1 } },
  { name: 'Chrome', key: 'Google\\Chrome', switches: { IncognitoModeAvailability: 1 } },
  { name: 'Chromium', key: 'Chromium', switches: { IncognitoModeAvailability: 1 } },
  // TorDisabled: Brave's "private window with Tor" would bypass the list.
  { name: 'Brave', key: 'BraveSoftware\\Brave', switches: { IncognitoModeAvailability: 1, TorDisabled: 1 } },
  { name: 'Vivaldi', key: 'Vivaldi', switches: { IncognitoModeAvailability: 1 } },
];

// Other domains that serve the same content, blocked along with a whole site: its
// player embedded in other pages (e.g. YouTube videos inside Bing's results) or
// its short links would otherwise still work.
const TWIN_DOMAINS: Record<string, string[]> = {
  'youtube.com': ['youtube-nocookie.com', 'youtu.be'],
};

// null until the rules are known, so a service start never wipes the list early.
let sites: string[] | null = null;
// SID → the list last written to that hive (JSON), so each hive is rewritten only on change.
const applied = new Map<string, string>();

export function setBlockedSites(next: string[]) {
  const sorted = [...new Set(next.flatMap((site) => [site, ...(TWIN_DOMAINS[site] ?? [])]))].sort();
  if (sites && JSON.stringify(sites) === JSON.stringify(sorted)) return;
  sites = sorted;
  applied.clear();
}

const WRITE_POLICIES = `$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
$sites = @($in.sites)
foreach ($b in $in.browsers) {
  $key = "Registry::HKEY_USERS\\$($in.sid)\\Software\\Policies\\$($b.key)"
  $list = "$key\\URLBlocklist"
  if (Test-Path $list) { Remove-Item $list -Recurse -Force }
  $switches = $b.switches.PSObject.Properties
  if ($sites.Count) {
    New-Item $list -Force | Out-Null
    for ($i = 0; $i -lt $sites.Count; $i++) {
      New-ItemProperty $list -Name ($i + 1) -Value $sites[$i] -PropertyType String -Force | Out-Null
    }
    foreach ($s in $switches) { New-ItemProperty $key -Name $s.Name -Value $s.Value -PropertyType DWord -Force | Out-Null }
  } elseif (Test-Path $key) {
    foreach ($s in $switches) { Remove-ItemProperty $key -Name $s.Name -ErrorAction SilentlyContinue }
  }
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
      await runPowerShell(WRITE_POLICIES, JSON.stringify({ sid, sites, browsers: BROWSERS }));
      applied.set(sid, want);
      const names = BROWSERS.map((b) => b.name).join(', ');
      console.log(`[sites] 🌐 ${sites.length ? `${sites.length} site(s) bloqué(s)` : 'aucun site bloqué'} (${names}) pour ${sid}`);
    } catch (err) {
      console.error(`[sites] écriture des stratégies navigateur échouée pour ${sid}`, err);
    }
  }
}
