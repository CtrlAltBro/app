import type { AppRule, Rules } from '../shared/api-types';

// Is any browser filtering asked for: a blocked site, SafeSearch or YouTube restricted.
export const filteringActive = (rules: Rules) =>
  rules.sites.length > 0 || !!rules.filters?.safeSearch || (rules.filters?.youtube ?? 'off') !== 'off';

// Browsers we cannot filter for one account only (no per-account policy: Firefox and
// its forks honor their site filter machine-wide only, the others have no usable
// policy at all). While any filtering is on, they are blocked like an app for the
// child, unless the parent set a rule of their own on them. Tor Browser runs
// as firefox.exe. Chromium-based browsers with policies are in service/site-policy.ts.
export const UNFILTERED_BROWSERS = new Set([
  'firefox.exe',
  'waterfox.exe',
  'librewolf.exe',
  'floorp.exe',
  'palemoon.exe',
  'seamonkey.exe',
  'opera.exe',
  'browser.exe', // Yandex
  'maxthon.exe',
  'ucbrowser.exe',
  'dragon.exe', // Comodo Dragon
  'epic.exe',
  'thorium.exe',
]);

// The app rules with the unfiltered browsers added as blocks, while filtering is on.
export function withUnfilteredBrowsers(rules: Rules): AppRule[] {
  if (!filteringActive(rules)) return rules.apps;
  const ruled = new Set(rules.apps.map((r) => r.exeName));
  const added = [...UNFILTERED_BROWSERS]
    .filter((exe) => !ruled.has(exe))
    .map((exeName): AppRule => ({ exeName, mode: 'block', dailyLimitMinutes: null }));
  return [...rules.apps, ...added];
}
