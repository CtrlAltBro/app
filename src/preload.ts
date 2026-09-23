import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AgentApi, AgentStatus } from './shared/agent-api';

const agent: AgentApi = {
  getStatus: () => ipcRenderer.invoke('agent:getStatus'),
  pair: (code, name) => ipcRenderer.invoke('agent:pair', code, name),
  onStatus: (listener) => {
    const handler = (_event: IpcRendererEvent, status: AgentStatus) => listener(status);
    ipcRenderer.on('agent:status', handler);
    return () => ipcRenderer.removeListener('agent:status', handler);
  },
};

contextBridge.exposeInMainWorld('agent', agent);
