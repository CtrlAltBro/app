import { contextBridge, ipcRenderer } from 'electron';
import type { AgentApi } from './shared/agent-api';

const agent: AgentApi = {
  getStatus: () => ipcRenderer.invoke('agent:getStatus'),
  pair: (code, name) => ipcRenderer.invoke('agent:pair', code, name),
};

contextBridge.exposeInMainWorld('agent', agent);
