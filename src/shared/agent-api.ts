export type SyncState = { lastSyncAt: string | null; error: string | null };

export type AgentStatus =
  | { paired: false; suggestedName: string }
  | { paired: true; deviceId: string; deviceName: string; sync: SyncState };

export type PairResult = { ok: true; status: AgentStatus } | { ok: false; error: string };

// Server and monitored accounts, as the service sees them (read-only over the pipe;
// changing them goes through a UAC-elevated admin command).
export type AgentSettings = {
  apiUrl: string;
  // false: no explicit list yet, the default (non-admin accounts) applies.
  explicit: boolean;
  accounts: { sid: string; name: string; admin: boolean; monitored: boolean }[];
};

export type SaveResult = { ok: true } | { ok: false; error: string };

export interface AgentApi {
  getStatus(): Promise<AgentStatus>;
  pair(code: string, name: string): Promise<PairResult>;
  getSettings(): Promise<AgentSettings>;
  saveSettings(apiUrl: string, monitoredSids: string[]): Promise<SaveResult>;
  onStatus(listener: (status: AgentStatus) => void): () => void;
}
