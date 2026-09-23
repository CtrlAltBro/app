export type SyncState = { lastSyncAt: string | null; error: string | null };

export type AgentStatus =
  | { paired: false; suggestedName: string }
  | { paired: true; deviceId: string; deviceName: string; sync: SyncState };

export type PairResult = { ok: true; status: AgentStatus } | { ok: false; error: string };

export interface AgentApi {
  getStatus(): Promise<AgentStatus>;
  pair(code: string, name: string): Promise<PairResult>;
  onStatus(listener: (status: AgentStatus) => void): () => void;
}
