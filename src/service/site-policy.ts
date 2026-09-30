import { filteringActive } from '../core/browsers';
import type { Rules } from '../shared/api-types';
import { runPowerShell } from './powershell';

// Browser filtering (blocked websites, forced SafeSearch, YouTube Restricted Mode),
// written as browser policies into each monitored child's own registry hive
// (HKU\<SID>\Software\Policies\...): the child can read but not change it, and the
// parent's browsers are not affected. Browsers pick a policy change up by
// themselves, no restart needed. A hive is only loaded while its account is signed
// in, so the service applies the policy at each sign-in; while a child is signed
// out, their hive keeps the last one written.
//
// Chromium-based browsers share the policy names and the URLBlocklist format
// ("youtube.com" also blocks its subdomains, any scheme and path), each under its own
// key. Keys are written even for a browser that is not installed, so one the child
// installs later for themselves is covered from its first start. Private windows are
// turned off while any filtering is on. Firefox is not here: its site filter is
// honored only machine-wide, which would filter the parent too (see core/browsers.ts).

// Keep in sync with Clear-SitePolicy in installer/preuninstall.ps1.
const BROWSERS = [
  { name: 'Edge', key: 'Microsoft\\Edge', privateSwitch: 'InPrivateModeAvailability' },
  { name: 'Chrome', key: 'Google\\Chrome', privateSwitch: 'IncognitoModeAvailability' },
  { name: 'Chromium', key: 'Chromium', privateSwitch: 'IncognitoModeAvailability' },
  { name: 'Brave', key: 'BraveSoftware\\Brave', privateSwitch: 'IncognitoModeAvailability' },
  { name: 'Vivaldi', key: 'Vivaldi', privateSwitch: 'IncognitoModeAvailability' },
];

// Other domains that serve the same content, blocked along with a whole site: its
// player embedded in other pages (e.g. YouTube videos inside Bing's results) or
// its short links would otherwise still work.
const TWIN_DOMAINS: Record<string, string[]> = {
  'youtube.com': ['youtube-nocookie.com', 'youtu.be'],
};

// Search engines whose SafeSearch no policy can force: blocked while it is on, so
// searches go through Google or Bing, which are locked. Brave Search is Brave's
// default engine, so without this Brave's address bar would get around it.
const UNFILTERED_SEARCH = [
  'duckduckgo.com',
  'search.brave.com',
  'qwant.com',
  'ecosia.org',
  'startpage.com',
  'search.yahoo.com',
  'yandex.com',
  'yandex.ru',
  'ya.ru',
];

const YOUTUBE_LEVEL = { off: null, moderate: 1, strict: 2 } as const;

type Policy = { sites: string[]; switches: Record<string, Record<string, number | null>> };

// What to write for a set of rules (null = unpaired: lift everything).
function policyFor(rules: Rules | null): Policy {
  const sites = rules ? rules.sites.map((s) => s.pattern) : [];
  const filters = rules?.filters ?? { safeSearch: false, youtube: 'off' as const };
  const active = !!rules && filteringActive(rules);
  const switches: Policy['switches'] = {};
  for (const b of BROWSERS) {
    // null = remove the value.
    switches[b.key] = {
      [b.privateSwitch]: active ? 1 : null,
      ForceGoogleSafeSearch: filters.safeSearch ? 1 : null,
      ForceYouTubeRestrict: YOUTUBE_LEVEL[filters.youtube],
      // Edge only: Bing is its default search engine (2 = strict).
      ...(b.name === 'Edge' && { ForceBingSafeSearch: filters.safeSearch ? 2 : null }),
      // Brave's "private window with Tor" would bypass everything.
      ...(b.name === 'Brave' && { TorDisabled: active ? 1 : null }),
    };
  }
  const expanded = [
    ...sites.flatMap((site) => [site, ...(TWIN_DOMAINS[site] ?? [])]),
    ...(filters.safeSearch ? UNFILTERED_SEARCH : []),
  ];
  return { sites: [...new Set(expanded)].sort(), switches };
}

// null until the rules are known, so a service start never wipes the policy early.
let policy: Policy | null = null;
// SID → the policy last written to that hive (JSON), so each hive is rewritten only on change.
const applied = new Map<string, string>();

export function setBrowserPolicy(rules: Rules | null) {
  const next = policyFor(rules);
  if (policy && JSON.stringify(policy) === JSON.stringify(next)) return;
  policy = next;
  applied.clear();
}

const WRITE_POLICIES = `$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
$sites = @($in.sites)
foreach ($b in $in.switches.PSObject.Properties) {
  $key = "Registry::HKEY_USERS\\$($in.sid)\\Software\\Policies\\$($b.Name)"
  $list = "$key\\URLBlocklist"
  if (Test-Path $list) { Remove-Item $list -Recurse -Force }
  if ($sites.Count) {
    New-Item $list -Force | Out-Null
    for ($i = 0; $i -lt $sites.Count; $i++) {
      New-ItemProperty $list -Name ($i + 1) -Value $sites[$i] -PropertyType String -Force | Out-Null
    }
  }
  foreach ($v in $b.Value.PSObject.Properties) {
    if ($null -ne $v.Value) {
      if (-not (Test-Path $key)) { New-Item $key -Force | Out-Null }
      New-ItemProperty $key -Name $v.Name -Value $v.Value -PropertyType DWord -Force | Out-Null
    } elseif (Test-Path $key) {
      Remove-ItemProperty $key -Name $v.Name -ErrorAction SilentlyContinue
    }
  }
}`;

// Bring the hives of the signed-in monitored accounts in line with the policy.
export async function syncSitePolicies(signedInSids: Iterable<string>) {
  if (policy === null) return;
  const want = JSON.stringify(policy);
  const live = new Set(signedInSids);
  // Signed out: its hive is unloaded, rewrite it at the next sign-in.
  for (const sid of applied.keys()) if (!live.has(sid)) applied.delete(sid);
  for (const sid of live) {
    if (applied.get(sid) === want) continue;
    try {
      await runPowerShell(WRITE_POLICIES, JSON.stringify({ sid, ...policy }));
      applied.set(sid, want);
      const edge = policy.switches['Microsoft\\Edge'];
      const youtube = edge.ForceYouTubeRestrict ? ` · YouTube restreint ${edge.ForceYouTubeRestrict}` : '';
      const safe = edge.ForceGoogleSafeSearch ? ' · recherche sécurisée' : '';
      console.log(`[sites] 🌐 ${policy.sites.length} site(s) bloqué(s)${safe}${youtube} pour ${sid}`);
    } catch (err) {
      console.error(`[sites] écriture des stratégies navigateur échouée pour ${sid}`, err);
    }
  }
}
