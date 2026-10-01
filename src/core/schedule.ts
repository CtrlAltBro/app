import type { Rules, Schedule } from '../shared/api-types';
import { totalUsedMs } from './limits';

// The time schedule the parent set: allowed windows and a total screen-time cap per
// weekday. Enforced by the service, which locks the child's session when we are
// outside the allowed hours or the day's total is used up. Everything is in the PC's
// local time (the child's own clock), which the child cannot change (standard user).

// Warn the child this long before a boundary (30 s in dev to test without waiting).
const warnBeforeMs = (dev: boolean) => (dev ? 30_000 : 5 * 60_000);

let schedule: Schedule = { days: {} };
// Extra minutes the parent granted for today, added to the day's cap.
let extraMs = 0;

export function setSchedule(rules: Rules) {
  // Never trust the shape: a device without a schedule yet may come as {}.
  schedule = { days: rules.schedule?.days ?? {} };
  extraMs = (rules.screen?.extraMinutes ?? 0) * 60_000;
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export type ScheduleState =
  | { locked: false; warn: { reason: 'bedtime' | 'exhausted'; minutes: number } | null }
  | { locked: true; reason: 'bedtime' | 'exhausted' };

// Decide, for the child's local `now`, whether the session must be locked, or a
// warning is due. `dev` only shortens the warning lead time.
export function scheduleState(now = new Date(), dev = false): ScheduleState {
  const day = schedule.days[String(now.getDay())];
  if (!day) return { locked: false, warn: null };

  const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;

  // Bedtime: windows are set and we are inside none of them.
  if (day.windows.length) {
    const current = day.windows.find((w) => nowMin >= toMin(w.from) && nowMin < toMin(w.to));
    if (!current) return { locked: true, reason: 'bedtime' };
  }

  // Total screen time for the day.
  if (day.maxMinutes != null) {
    const capMs = day.maxMinutes * 60_000 + extraMs;
    if (totalUsedMs() >= capMs) return { locked: true, reason: 'exhausted' };
  }

  // Not locked: how long until the next boundary, to warn ahead of it.
  const lead = warnBeforeMs(dev);
  let warn: { reason: 'bedtime' | 'exhausted'; minutes: number } | null = null;
  const consider = (reason: 'bedtime' | 'exhausted', msLeft: number) => {
    if (msLeft <= lead && (!warn || msLeft < warn.minutes * 60_000)) {
      warn = { reason, minutes: Math.max(1, Math.round(msLeft / 60_000)) };
    }
  };
  if (day.windows.length) {
    const current = day.windows.find((w) => nowMin >= toMin(w.from) && nowMin < toMin(w.to));
    if (current) consider('bedtime', (toMin(current.to) - nowMin) * 60_000);
  }
  if (day.maxMinutes != null) consider('exhausted', day.maxMinutes * 60_000 + extraMs - totalUsedMs());
  return { locked: false, warn };
}

export const hasSchedule = () => Object.keys(schedule.days).length > 0;
