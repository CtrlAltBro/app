// Mirror of the agent contract in ctrlaltbro-web/worker/schemas.ts (/api/agent/v1).
// Keep in sync by hand.

export type AppRule = {
  exeName: string;
  mode: 'block' | 'limit';
  dailyLimitMinutes: number | null;
  // What the API knows of today's usage (since midnight or the latest reset).
  usedTodaySeconds?: number;
  // Latest reset of today by the parent: the local counter drops to usedTodaySeconds.
  usageResetAt?: string | null;
};
export type SiteRule = { pattern: string };
// Content filters forced in the child's browsers.
export type Filters = { safeSearch: boolean; youtube: 'off' | 'moderate' | 'strict' };
// Time schedule enforced by locking the child's session. Weekday keys are getDay()
// as strings ("0" = Sunday … "6" = Saturday); a weekday absent from `days` is free.
export type TimeWindow = { from: string; to: string }; // local "HH:MM"
export type DaySchedule = { windows: TimeWindow[]; maxMinutes: number | null };
export type Schedule = { days: Record<string, DaySchedule> };
// day: the PC's local date the usage above belongs to (YYYY-MM-DD).
// filters: absent from an older API or older cached rules (= all off).
// schedule / screen: absent from an older API. screen = total screen time used today
// (all apps) and the parent's extra minutes for the day.
export type Rules = {
  version: number;
  apps: AppRule[];
  sites: SiteRule[];
  filters?: Filters;
  schedule?: Schedule;
  screen?: { usedTodaySeconds: number; extraMinutes: number };
  day?: string;
};

export type Command =
  | { id: string; type: 'kill_app'; payload: { exeName: string } }
  | { id: string; type: 'lock_session'; payload: null }
  | { id: string; type: 'recalibrate'; payload: null }
  | { id: string; type: 'show_message'; payload: { text: string } };

export type InstalledApp = { exeName: string; name: string; path?: string };

export type ScreenTimeSession = {
  id: string;
  app: string;
  exeName?: string;
  title?: string;
  startedAt: string;
  endedAt: string;
};

export type CommandResult = { id: string; status: 'done' | 'failed'; error?: string };

// Signs of tampering the agent noticed, reported through /sync.
export type TamperEventType =
  | 'app_killed'
  | 'service_restarted'
  | 'clock_changed'
  | 'timezone_changed'
  | 'pipe_spoof'
  | 'safe_mode'
  | 'uninstall'
  | 'app_renamed';

export type TamperEvent = { id: string; type: TamperEventType; at: string; detail?: string };

export type SyncInput = {
  agentVersion?: string;
  timeZone?: string;
  rulesVersion: number;
  apps?: InstalledApp[];
  screenTime?: ScreenTimeSession[];
  history?: { id: string; browser: string; url: string; title?: string; visitedAt: string }[];
  commandResults?: CommandResult[];
  events?: TamperEvent[];
};

export type SyncResponse = {
  rules: Rules | null;
  commands: Command[];
  nextSyncSeconds: number;
};
