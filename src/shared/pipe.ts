import type { Socket } from 'node:net';
import type { AgentStatus, PairResult } from './agent-api';
import type { ScreenTimeSession } from './api-types';

// Named pipe between the core (service) and the session app (Electron, on the
// child's desktop). One JSON object per line. Requests carry an id and get a
// reply with the same id in `re`; events carry no id.

export const PIPE_PATH = '\\\\.\\pipe\\ctrlaltbro';

export type TimeUpText = { title: string; app: string; detail: string };

// Handled by the core.
export type CoreApi = {
  requests: {
    getStatus: [void, AgentStatus];
    pair: [{ code: string; name: string }, PairResult];
  };
  events: {
    // Sent first on connect: which Windows account this session app runs as, so
    // the service can tell the child's session from the parent's. Advisory for now;
    // hardened in part 2 once the service launches the app into a known session.
    hello: { sid: string };
    session: ScreenTimeSession;
    foreground: { exeName: string | null; elapsedMs: number };
    leave: void;
  };
};

// Handled by the session app.
export type SessionApi = {
  requests: {
    // Replies once the message is on screen (not when it is closed).
    message: [{ text: string }, void];
    // Lock this session's desktop (LockWorkStation).
    lock: [void, void];
    snapshotForeground: [void, void];
    saveCurrentSession: [void, void];
  };
  events: {
    status: AgentStatus;
    timeUp: TimeUpText;
  };
};

type Api = { requests: Record<string, [unknown, unknown]>; events: Record<string, unknown> };
type Frame = { id?: number; re?: number; type?: string; data?: unknown; error?: string };

// A line longer than this is not one of ours: drop the connection.
const MAX_LINE = 1_000_000;
// Pairing waits for the API (15 s timeout) and token encryption.
const REQUEST_TIMEOUT_MS = 30_000;

// Local: what this side handles. Remote: what the other side handles.
export class PipeConnection<Local extends Api, Remote extends Api> {
  private nextId = 1;
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }>();
  private requestHandlers = new Map<string, (data: never) => unknown>();
  private eventHandlers = new Map<string, (data: never) => void>();

  constructor(readonly socket: Socket) {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line) void this.receive(line);
      }
      if (buffer.length > MAX_LINE) socket.destroy();
    });
    socket.on('close', () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('pipe closed'));
      }
      this.pending.clear();
    });
    socket.on('error', () => undefined);
  }

  handle<K extends keyof Local['requests'] & string>(
    type: K,
    handler: (data: Local['requests'][K][0]) => Local['requests'][K][1] | Promise<Local['requests'][K][1]>,
  ) {
    this.requestHandlers.set(type, handler as (data: never) => unknown);
    return this;
  }

  on<K extends keyof Local['events'] & string>(type: K, handler: (data: Local['events'][K]) => void) {
    this.eventHandlers.set(type, handler as (data: never) => void);
    return this;
  }

  emit<K extends keyof Remote['events'] & string>(type: K, ...data: Remote['events'][K] extends void ? [] : [Remote['events'][K]]) {
    this.write({ type, data: data[0] });
  }

  request<K extends keyof Remote['requests'] & string>(
    type: K,
    ...data: Remote['requests'][K][0] extends void ? [] : [Remote['requests'][K][0]]
  ): Promise<Remote['requests'][K][1]> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pipe request ${type} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.write({ id, type, data: data[0] });
    });
  }

  // Resolves once everything written so far has been handed to the pipe.
  flushed() {
    return new Promise<void>((resolve) => (this.socket.destroyed ? resolve() : this.socket.write('', () => resolve())));
  }

  private write(frame: Frame) {
    if (!this.socket.destroyed) this.socket.write(`${JSON.stringify(frame)}\n`);
  }

  private async receive(line: string) {
    let frame: Frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof frame.re === 'number') {
      const waiting = this.pending.get(frame.re);
      if (!waiting) return;
      this.pending.delete(frame.re);
      clearTimeout(waiting.timer);
      if (frame.error) waiting.reject(new Error(frame.error));
      else waiting.resolve(frame.data);
      return;
    }
    if (typeof frame.type !== 'string') return;
    if (typeof frame.id === 'number') {
      const handler = this.requestHandlers.get(frame.type);
      try {
        if (!handler) throw new Error(`unknown request ${frame.type}`);
        this.write({ re: frame.id, data: await handler(frame.data as never) });
      } catch (err) {
        this.write({ re: frame.id, error: (err as Error).message });
      }
      return;
    }
    try {
      this.eventHandlers.get(frame.type)?.(frame.data as never);
    } catch (err) {
      console.error(`[pipe] ${frame.type} handler failed:`, err);
    }
  }
}
