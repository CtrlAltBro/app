import type { AgentStatus } from '../shared/agent-api';

// Everything the core needs from the process it runs in. The core never imports
// Electron: today the Electron main process provides this (main/electron-host.ts);
// later the Windows service will, forwarding UI requests to the session app.

export type TimeUpText = { title: string; app: string; detail: string };

export type Host = {
  version: string;
  isDev: boolean;
  // Where state files live (device.json, agent-state.json…).
  dataDir: string;
  // Protects the device token at rest.
  secrets: {
    available(): boolean;
    encrypt(text: string): string;
    decrypt(data: string): string;
  };
  readShortcut(file: string): { target?: string; args?: string };
  // Pairing or sync status changed.
  statusChanged(status: AgentStatus): void;
  // Things only the child's desktop can do.
  ui: {
    message(text: string): void;
    // Picture the foreground window before an app is closed, for showTimeUp.
    snapshotForeground(): Promise<void>;
    showTimeUp(text: TimeUpText): void;
    // Close the running screen-time session so it gets uploaded (app quit).
    saveCurrentSession(): Promise<void>;
  };
};

let current: Host | null = null;

export function setHost(host: Host) {
  current = host;
}

export function host(): Host {
  if (!current) throw new Error('core host not set: call setHost() at startup');
  return current;
}
