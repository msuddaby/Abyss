// SignalRProxy — mimics the HubConnection API surface used by consumer code.
// Routes all calls through a Web Worker via postMessage.

import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  SignalRConnection,
} from './signalr.protocol.js';

type LifecycleCb = (err?: string | null) => void;

let nextId = 1;

export class SignalRProxy implements SignalRConnection {
  private worker: Worker;
  private handlers = new Map<string, Set<(...args: any[]) => void>>();
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private reconnectingCbs: LifecycleCb[] = [];
  private reconnectedCbs: LifecycleCb[] = [];
  private closeCbs: LifecycleCb[] = [];
  private _state = 'Disconnected';

  // Called by signalr.ts when the worker requests a token
  onTokenRequest: ((id: number) => void) | null = null;
  // Called when the worker logs
  onLog: ((level: 'log' | 'warn' | 'debug', message: string) => void) | null = null;

  constructor(worker: Worker) {
    this.worker = worker;
    this.worker.onmessage = (e: MessageEvent<WorkerToMainMessage>) => {
      this.handleMessage(e.data);
    };
  }

  // ── SignalRConnection interface ──────────────────────────────────────────

  get state(): string {
    return this._state;
  }

  on(event: string, handler: (...args: any[]) => void): void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
  }

  off(event: string, handler?: (...args: any[]) => void): void {
    if (!handler) {
      this.handlers.delete(event);
      return;
    }
    const set = this.handlers.get(event);
    if (set) {
      set.delete(handler);
      if (set.size === 0) this.handlers.delete(event);
    }
  }

  invoke(method: string, ...args: unknown[]): Promise<any> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post({ type: 'invoke', id, method, args });
    });
  }

  // ── Lifecycle callbacks (mirrors HubConnection API) ─────────────────────

  onreconnecting(cb: LifecycleCb): void {
    this.reconnectingCbs.push(cb);
  }

  onreconnected(cb: LifecycleCb): void {
    this.reconnectedCbs.push(cb);
  }

  onclose(cb: LifecycleCb): void {
    this.closeCbs.push(cb);
  }

  // ── Control messages to worker ──────────────────────────────────────────

  sendInit(url: string, hubPath: string): void {
    this.post({ type: 'init', url, hubPath });
  }

  sendStart(): Promise<void> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: () => resolve(),
        reject: (e) => reject(e),
      });
      // Use the id for correlating start result
      // Worker will post back 'started' or 'start-error'
      // We handle those specially — store the id so handleMessage can find it
      this._pendingStartId = id;
      this.post({ type: 'start' });
    });
  }

  sendStop(): Promise<void> {
    const id = nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve: () => resolve(), reject: () => resolve() });
      this._pendingStopId = id;
      this.post({ type: 'stop' });
    });
  }

  sendSuspend(): void {
    this.post({ type: 'suspend' });
  }

  sendReset(): void {
    this.post({ type: 'reset' });
  }

  sendTokenResponse(id: number, token: string): void {
    this.post({ type: 'token-response', id, token });
  }

  sendVisibilityChange(hidden: boolean): void {
    this.post({ type: 'visibility-change', hidden });
  }

  sendFocusReconnect(restartOnFailure: boolean): Promise<boolean> {
    const id = nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, {
        resolve: (alive: boolean) => resolve(alive),
        reject: () => resolve(false),
      });
      this.post({ type: 'focus-reconnect', id, restartOnFailure });
    });
  }

  sendEnsureConnected(): Promise<void> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: () => resolve(), reject: (e) => reject(e) });
      this.post({ type: 'ensure-connected', id });
    });
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private _pendingStartId: number | null = null;
  private _pendingStopId: number | null = null;

  private post(msg: MainToWorkerMessage): void {
    this.worker.postMessage(msg);
  }

  private handleMessage(msg: WorkerToMainMessage): void {
    switch (msg.type) {
      case 'event': {
        const set = this.handlers.get(msg.name);
        if (msg.name === 'ReceiveMessage' || msg.name === 'ReactionAdded' || msg.name === 'ReactionRemoved') {
          console.log(`[SignalR Proxy] event=${msg.name} handlers=${set?.size ?? 0} hidden=${document.hidden}`);
        }
        if (set) {
          for (const handler of set) {
            try {
              handler(...msg.args);
            } catch (err) {
              console.error(`[SignalR Proxy] handler error for ${msg.name}:`, err);
            }
          }
        } else if (msg.name === 'ReceiveMessage') {
          console.warn(`[SignalR Proxy] ReceiveMessage arrived but NO HANDLERS registered!`);
        }
        break;
      }

      case 'invoke-result': {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(new Error(msg.error));
        }
        break;
      }

      case 'state-change':
        this._state = msg.state;
        break;

      case 'reconnecting':
        this._state = 'Reconnecting';
        for (const cb of this.reconnectingCbs) cb(msg.error);
        break;

      case 'reconnected':
        this._state = 'Connected';
        for (const cb of this.reconnectedCbs) cb();
        break;

      case 'closed':
        this._state = 'Disconnected';
        if (!msg.intentional) {
          for (const cb of this.closeCbs) cb(msg.error);
        }
        break;

      case 'started': {
        this._state = 'Connected';
        const id = this._pendingStartId;
        if (id !== null) {
          this._pendingStartId = null;
          const p = this.pending.get(id);
          if (p) { this.pending.delete(id); p.resolve(undefined); }
        }
        break;
      }

      case 'start-error': {
        const id = this._pendingStartId;
        if (id !== null) {
          this._pendingStartId = null;
          const p = this.pending.get(id);
          if (p) { this.pending.delete(id); p.reject(new Error(msg.error)); }
        }
        break;
      }

      case 'stopped': {
        this._state = 'Disconnected';
        const id = this._pendingStopId;
        if (id !== null) {
          this._pendingStopId = null;
          const p = this.pending.get(id);
          if (p) { this.pending.delete(id); p.resolve(undefined); }
        }
        break;
      }

      case 'token-request':
        this.onTokenRequest?.(msg.id);
        break;

      case 'focus-reconnect-result': {
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); p.resolve(msg.alive); }
        break;
      }

      case 'ensure-connected-result': {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.ok) p.resolve(undefined);
          else p.reject(new Error(msg.error));
        }
        break;
      }

      case 'log':
        this.onLog?.(msg.level, msg.message);
        break;
    }
  }
}
