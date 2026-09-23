export type AgentStatus =
  | { paired: false; suggestedName: string }
  | { paired: true; deviceId: string; deviceName: string };

export type PairResult = { ok: true; status: AgentStatus } | { ok: false; error: string };

export interface AgentApi {
  getStatus(): Promise<AgentStatus>;
  pair(code: string, name: string): Promise<PairResult>;
}
