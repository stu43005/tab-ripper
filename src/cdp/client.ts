export class CdpError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = "CdpError";
  }
}

export class CdpTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`CDP 請求 ${method} 逾時（${timeoutMs} ms）`);
    this.name = "CdpTimeoutError";
  }
}

export class CdpClosedError extends Error {
  constructor() {
    super("CDP 連線已關閉");
    this.name = "CdpClosedError";
  }
}

export class CdpConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CdpConnectError";
  }
}

export class CdpSessionClosedError extends Error {
  constructor(readonly sessionId: string) {
    super(`CDP session ${sessionId} 已中斷`);
    this.name = "CdpSessionClosedError";
  }
}

export type CdpEventHandler = (params: unknown, sessionId?: string) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Minimal browser-level CDP client. */
export class CdpClient {
  readonly closed: Promise<void>;
  #ws: WebSocket;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #handlers = new Map<string, Set<CdpEventHandler>>();
  #closedSessions = new Set<string>();
  #isClosed = false;
  #resolveClosed!: () => void;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    ws.onmessage = (event) => this.#onMessage(event.data);
    ws.onclose = () => this.#teardown();
    ws.onerror = () => this.#teardown();
  }

  /** The timeout covers the user's wait on the browser permission dialog. */
  static connect(
    url: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<CdpClient> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (error) {
        reject(
          new CdpConnectError(
            error instanceof Error ? error.message : String(error),
          ),
        );
        return;
      }
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };
      const timer = setTimeout(() => {
        settle(() => {
          ws.close();
          reject(new CdpConnectError(`連線逾時（${timeoutMs / 1000} 秒）`));
        });
      }, timeoutMs);
      ws.onopen = () => settle(() => resolve(new CdpClient(ws)));
      ws.onerror = (event) =>
        settle(() =>
          reject(
            new CdpConnectError(
              (event as ErrorEvent).message || "WebSocket 連線失敗",
            ),
          )
        );
      ws.onclose = (event) =>
        settle(() =>
          reject(new CdpConnectError(`連線被關閉（${event.code}）`))
        );
    });
  }

  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.#isClosed) return Promise.reject(new CdpClosedError());
    if (sessionId !== undefined && this.#closedSessions.has(sessionId)) {
      return Promise.reject(new CdpSessionClosedError(sessionId));
    }
    const id = this.#nextId++;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        sessionId,
      });
      try {
        this.#ws.send(
          JSON.stringify(
            sessionId === undefined
              ? { id, method, params }
              : { id, method, params, sessionId },
          ),
        );
      } catch {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(new CdpClosedError());
      }
    });
  }

  on(method: string, handler: CdpEventHandler): () => void {
    let set = this.#handlers.get(method);
    if (!set) {
      set = new Set();
      this.#handlers.set(method, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  close(): void {
    if (this.#isClosed) return;
    try {
      this.#ws.close();
    } catch {
      // Socket already closing.
    }
    this.#teardown();
  }

  #onMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let message: {
      id?: unknown;
      result?: unknown;
      error?: { code?: number; message?: string };
      method?: unknown;
      params?: unknown;
      sessionId?: unknown;
    };
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return; // Late reply after a timeout.
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new CdpError(
            message.error.code ?? 0,
            message.error.message ?? "CDP error",
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string") return;
    const sessionId = typeof message.sessionId === "string"
      ? message.sessionId
      : undefined;
    if (message.method === "Target.detachedFromTarget") {
      const detached = (message.params as { sessionId?: unknown } | undefined)
        ?.sessionId;
      if (typeof detached === "string") this.#failSession(detached);
    }
    const handlers = this.#handlers.get(message.method);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        handler(message.params, sessionId);
      } catch (error) {
        console.error(error);
      }
    }
  }

  #failSession(sessionId: string): void {
    this.#closedSessions.add(sessionId);
    for (const [id, pending] of this.#pending) {
      if (pending.sessionId !== sessionId) continue;
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new CdpSessionClosedError(sessionId));
    }
  }

  #teardown(): void {
    if (this.#isClosed) return;
    this.#isClosed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CdpClosedError());
    }
    this.#pending.clear();
    this.#resolveClosed();
  }
}
