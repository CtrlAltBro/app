// Mirror of the agent contract in ctrlaltbro-web/worker/schemas.ts (/api/agent/v1).
// Keep in sync by hand.

export type AppRule = { exeName: string; mode: 'block' | 'limit'; dailyLimitMinutes: number | null };
export type SiteRule = { pattern: string };
export type Rules = { version: number; apps: AppRule[]; sites: SiteRule[] };

export type Command =
  | { id: string; type: 'kill_app'; payload: { exeName: string } }
  | { id: string; type: 'lock_session'; payload: null }
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

export type SyncInput = {
  agentVersion?: string;
  rulesVersion: number;
  apps?: InstalledApp[];
  screenTime?: ScreenTimeSession[];
  history?: { id: string; browser: string; url: string; title?: string; visitedAt: string }[];
  commandResults?: CommandResult[];
};

export type SyncResponse = {
  rules: Rules | null;
  commands: Command[];
  nextSyncSeconds: number;
};
