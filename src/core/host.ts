import type { AgentStatus } from '../shared/agent-api';
import type { TimeUpText } from '../shared/pipe';

// Everything the core needs from the process it runs in. The core never imports
// Electron: the service provides it (service/node-host.ts) and forwards UI
// requests to the session app over the pipe.

export type Shortcut = { target?: string; args?: string };

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
  // Target and arguments of .lnk files, in the same order (null: unreadable).
  readShortcuts(files: string[]): Promise<(Shortcut | null)[]>;
  // Pairing or sync status changed.
  statusChanged(status: AgentStatus): void;
  // Cheap health snapshot sent with each /ping, for the dashboard.
  health(): Promise<{ appConnected: boolean; childSignedIn: boolean }>;
  // Things only the child's desktop can do.
  ui: {
    // Rejects when nobody can see it (no session app on the desktop).
    message(text: string): Promise<void>;
    // Lock the monitored child's session (session app if it can, else the service).
    lockSession(): Promise<void>;
    // Picture the foreground window before an app is closed, for showTimeUp.
    snapshotForeground(): Promise<void>;
    showTimeUp(text: TimeUpText): void;
    // Close the running screen-time session so it gets uploaded (app quit).
    saveCurrentSession(): Promise<void>;
  };
  // Stop / allow a limited app from starting again once its limit is reached, so
  // the child cannot reopen it (nor by killing the session app). Implemented by
  // the service (machine-wide); a no-op in the Electron dev host.
  launchGuard: {
    block(exeName: string): Promise<void>;
    allow(exeName: string): Promise<void>;
    allowAll(): Promise<void>;
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
