/**
 * A client for obs-websocket version 5, the server OBS Studio 28 and later
 * ship with (Tools → WebSocket Server Settings).
 *
 * Only what Domino needs: connect, authenticate, send requests, and send
 * batches whose replies nobody waits for. Written against the protocol
 * directly - it is a JSON envelope with a handful of opcodes, and a
 * dependency would be larger than this file.
 *
 * Lives in the renderer because that is where the audio is analysed; the
 * page has a WebSocket of its own and the numbers never need to cross to
 * the main process first.
 */

export type ObsState = 'off' | 'connecting' | 'connected' | 'error';

export interface ObsStatus {
  state: ObsState;
  /** OBS's own version string once identified, e.g. "30.1.2". */
  obsVersion: string;
  error: string;
  /** Requests sent since connecting, batches counted once. */
  requestsSent: number;
  /** The most recent complaint from OBS about a fire-and-forget request. */
  lastError: string;
}

export interface ObsRequest {
  requestType: string;
  requestData?: Record<string, unknown>;
}

interface Hello {
  obsWebSocketVersion: string;
  rpcVersion: number;
  authentication?: { challenge: string; salt: string };
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
}

/** Opcodes from the protocol. Names are the spec's. */
const enum Op {
  Hello = 0,
  Identify = 1,
  Identified = 2,
  Request = 6,
  RequestResponse = 7,
  RequestBatch = 8,
  RequestBatchResponse = 9,
}

/** Base64 of SHA-256 of the string, as the auth handshake needs. */
async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The authentication string for a password, per the obs-websocket spec. */
export async function obsAuthString(
  password: string,
  salt: string,
  challenge: string,
): Promise<string> {
  const secret = await sha256Base64(password + salt);
  return await sha256Base64(secret + challenge);
}

export class ObsClient {
  private socket: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private nextId = 1;
  private reconnectTimer: number | null = null;
  private wanted: { host: string; port: number; password: string } | null = null;
  private backoffMs = 1500;
  private listeners = new Set<(s: ObsStatus) => void>();
  private status: ObsStatus = { state: 'off', obsVersion: '', error: '', requestsSent: 0, lastError: '' };

  getStatus(): ObsStatus {
    return this.status;
  }

  onStatus(cb: (s: ObsStatus) => void): () => void {
    this.listeners.add(cb);
    cb(this.status);
    return () => this.listeners.delete(cb);
  }

  private setStatus(patch: Partial<ObsStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const cb of this.listeners) cb(this.status);
  }

  /**
   * Connect, and keep trying while connected is wanted. OBS may not be open
   * yet when Domino starts, and losing it mid-set should not need a click.
   */
  connect(host: string, port: number, password: string): void {
    this.wanted = { host, port, password };
    this.backoffMs = 1500;
    this.open();
  }

  disconnect(): void {
    this.wanted = null;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardown();
    this.setStatus({ state: 'off', error: '', obsVersion: '', requestsSent: 0, lastError: '' });
  }

  get connected(): boolean {
    return this.status.state === 'connected';
  }

  private open(): void {
    if (!this.wanted) return;
    this.teardown();
    const { host, port } = this.wanted;
    this.setStatus({ state: 'connecting', error: '', obsVersion: '', requestsSent: 0, lastError: '' });

    let socket: WebSocket;
    try {
      socket = new WebSocket(`ws://${host}:${port}`);
    } catch (err) {
      this.failed(err instanceof Error ? err.message : String(err));
      return;
    }
    this.socket = socket;

    socket.onmessage = (event) => void this.onMessage(socket, String(event.data));
    socket.onerror = () => {
      /* onclose carries the outcome; the error event has no detail. */
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.rejectAll(new Error('OBS connection closed'));
      // 4009 is the server's "authentication failed"; retrying with the same
      // password would only fill the OBS log.
      if (event.code === 4009) {
        this.wanted = null;
        this.setStatus({ state: 'error', error: 'OBS rejected the password.' });
        return;
      }
      if (event.code === 4010 || event.code === 4011) {
        this.wanted = null;
        this.setStatus({ state: 'error', error: 'OBS does not support this protocol version.' });
        return;
      }
      this.failed(
        this.status.state === 'connected'
          ? 'Lost the connection to OBS.'
          : `Cannot reach OBS at ${host}:${port}. Is the WebSocket server on?`,
      );
    };
  }

  private failed(message: string): void {
    this.setStatus({ state: 'error', error: message });
    if (!this.wanted || this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 1.6, 10000);
  }

  private teardown(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    }
    this.rejectAll(new Error('OBS connection closed'));
  }

  private rejectAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private async onMessage(socket: WebSocket, text: string): Promise<void> {
    let message: { op: number; d: unknown };
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (this.socket !== socket) return;

    switch (message.op) {
      case Op.Hello: {
        const hello = message.d as Hello;
        const identify: Record<string, unknown> = { rpcVersion: 1, eventSubscriptions: 0 };
        if (hello.authentication) {
          identify.authentication = await obsAuthString(
            this.wanted?.password ?? '',
            hello.authentication.salt,
            hello.authentication.challenge,
          );
        }
        if (this.socket !== socket) return;
        socket.send(JSON.stringify({ op: Op.Identify, d: identify }));
        return;
      }
      case Op.Identified: {
        this.backoffMs = 1500;
        this.setStatus({ state: 'connected', error: '' });
        // The version is a courtesy for the panel; failing to get it is fine.
        void this.request<{ obsVersion: string }>('GetVersion')
          .then((v) => this.setStatus({ obsVersion: v.obsVersion }))
          .catch(() => undefined);
        return;
      }
      case Op.RequestResponse: {
        const d = message.d as {
          requestId: string;
          requestStatus: { result: boolean; code: number; comment?: string };
          responseData?: unknown;
        };
        const waiting = this.pending.get(d.requestId);
        if (!waiting) {
          // A fire-and-forget request nobody is waiting on. Its failure is
          // still worth showing: a rule aimed at a filter that was renamed
          // would otherwise fail silently forever.
          if (!d.requestStatus.result) this.noteFailure(d.requestStatus.comment, d.requestStatus.code);
          return;
        }
        this.pending.delete(d.requestId);
        if (d.requestStatus.result) {
          waiting.resolve(d.responseData ?? {});
        } else {
          waiting.reject(
            new Error(d.requestStatus.comment ?? `OBS request failed (${d.requestStatus.code})`),
          );
        }
        return;
      }
      case Op.RequestBatchResponse: {
        const d = message.d as {
          results: Array<{ requestStatus: { result: boolean; code: number; comment?: string } }>;
        };
        for (const r of d.results ?? []) {
          if (!r.requestStatus.result) {
            this.noteFailure(r.requestStatus.comment, r.requestStatus.code);
            break;
          }
        }
        return;
      }
      default:
        return; // events are not subscribed to
    }
  }

  private noteFailure(comment: string | undefined, code: number): void {
    const text = comment ?? `request failed (${code})`;
    if (text !== this.status.lastError) this.setStatus({ lastError: text });
  }

  /** One request, answered. */
  request<T = Record<string, unknown>>(
    requestType: string,
    requestData?: Record<string, unknown>,
  ): Promise<T> {
    const socket = this.socket;
    if (!socket || !this.connected) return Promise.reject(new Error('Not connected to OBS'));
    const requestId = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve: resolve as (d: unknown) => void, reject });
      socket.send(JSON.stringify({ op: Op.Request, d: { requestType, requestId, requestData } }));
      this.status.requestsSent++;
    });
  }

  /**
   * Several requests at once, nobody waiting.
   *
   * This is the path the render loop uses: one batch per tick with every
   * changed value in it. A reply would only arrive after the next frame was
   * already due, so none is asked for.
   */
  send(requests: ObsRequest[]): void {
    const socket = this.socket;
    if (!socket || !this.connected || requests.length === 0) return;
    if (requests.length === 1) {
      socket.send(
        JSON.stringify({
          op: Op.Request,
          d: { requestType: requests[0].requestType, requestId: `f${this.nextId++}`, requestData: requests[0].requestData },
        }),
      );
    } else {
      socket.send(
        JSON.stringify({
          op: Op.RequestBatch,
          d: { requestId: `b${this.nextId++}`, haltOnFailure: false, requests },
        }),
      );
    }
    this.setStatus({ requestsSent: this.status.requestsSent + 1 });
  }

  /* ------------------------- catalogue queries -------------------------- */

  async listScenes(): Promise<string[]> {
    const r = await this.request<{ scenes: Array<{ sceneName: string; sceneIndex: number }> }>(
      'GetSceneList',
    );
    // OBS lists them bottom-up; the panel wants the order the user sees.
    return [...r.scenes].sort((a, b) => b.sceneIndex - a.sceneIndex).map((s) => s.sceneName);
  }

  async listInputs(): Promise<string[]> {
    const r = await this.request<{ inputs: Array<{ inputName: string }> }>('GetInputList');
    return r.inputs.map((i) => i.inputName).sort((a, b) => a.localeCompare(b));
  }

  async listFilters(sourceName: string): Promise<Array<{ name: string; kind: string; settings: string[] }>> {
    const r = await this.request<{
      filters: Array<{ filterName: string; filterKind: string; filterSettings: Record<string, unknown> }>;
    }>('GetSourceFilterList', { sourceName });
    const out: Array<{ name: string; kind: string; settings: string[] }> = [];
    for (const f of r.filters) {
      // Settings left at their defaults are omitted from the filter itself,
      // so the defaults are fetched to offer the full set of keys.
      let keys = Object.keys(f.filterSettings ?? {});
      try {
        const d = await this.request<{ defaultFilterSettings: Record<string, unknown> }>(
          'GetSourceFilterDefaultSettings',
          { filterKind: f.filterKind },
        );
        keys = [...new Set([...keys, ...Object.keys(d.defaultFilterSettings ?? {})])];
      } catch {
        /* an unknown kind: keep what the filter itself reported */
      }
      out.push({ name: f.filterName, kind: f.filterKind, settings: keys.sort() });
    }
    return out;
  }

  async listSceneItems(sceneName: string): Promise<Array<{ id: number; source: string }>> {
    const r = await this.request<{ sceneItems: Array<{ sceneItemId: number; sourceName: string }> }>(
      'GetSceneItemList',
      { sceneName },
    );
    return r.sceneItems.map((i) => ({ id: i.sceneItemId, source: i.sourceName }));
  }

  async listHotkeys(): Promise<string[]> {
    const r = await this.request<{ hotkeys: string[] }>('GetHotkeyList');
    return r.hotkeys;
  }
}
