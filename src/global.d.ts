import type { AgentApi } from './shared/agent-api';

declare global {
  interface Window {
    agent: AgentApi;
  }
}
