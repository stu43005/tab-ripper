// In-process fake of a browser-level CDP WebSocket endpoint for tests.

export interface CdpRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export interface FakeConnection {
  readonly socket: WebSocket;
  send(message: unknown): void;
  close(): void;
}

export type FakeHandler = (
  request: CdpRequest,
  connection: FakeConnection,
) => void;

export interface FakeCdpOptions {
  handler?: FakeHandler;
  /** Delay before answering the WebSocket upgrade (simulates the permission dialog). */
  upgradeDelayMs?: number;
}

export class FakeCdpServer {
  readonly requests: CdpRequest[] = [];
  readonly connections: FakeConnection[] = [];
  upgradeRequests = 0;
  readonly address: string;
  #server: Deno.HttpServer<Deno.NetAddr>;
  #abort = new AbortController();

  constructor(options: FakeCdpOptions = {}) {
    this.#server = Deno.serve(
      {
        hostname: "127.0.0.1",
        port: 0,
        onListen: () => {},
        signal: this.#abort.signal,
      },
      async (request) => {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return new Response("Not Found", { status: 404 });
        }
        this.upgradeRequests++;
        if (options.upgradeDelayMs) {
          await new Promise((resolve) =>
            setTimeout(resolve, options.upgradeDelayMs)
          );
        }
        const { socket, response } = Deno.upgradeWebSocket(request);
        const connection: FakeConnection = {
          socket,
          send: (message) => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify(message));
            }
          },
          close: () => socket.close(),
        };
        this.connections.push(connection);
        socket.onmessage = (event) => {
          const parsed = JSON.parse(String(event.data)) as CdpRequest;
          this.requests.push(parsed);
          options.handler?.(parsed, connection);
        };
        return response;
      },
    );
    this.address = `127.0.0.1:${this.#server.addr.port}`;
  }

  get wsUrl(): string {
    return `ws://${this.address}/devtools/browser`;
  }

  async close(): Promise<void> {
    for (const connection of this.connections) {
      try {
        connection.close();
      } catch {
        // Already closed.
      }
    }
    // A socket upgraded after its client already dropped the TCP connection
    // stays CONNECTING forever (Deno.serve does not notice the disconnect), so
    // a graceful shutdown() would never settle. Aborting the serve signal
    // force-closes such connections; `finished` settles once it has stopped.
    this.#abort.abort();
    await this.#server.finished;
  }
}

export function reply(
  connection: FakeConnection,
  request: CdpRequest,
  result: unknown,
): void {
  connection.send({
    id: request.id,
    result,
    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
  });
}

export function replyError(
  connection: FakeConnection,
  request: CdpRequest,
  code: number,
  message: string,
): void {
  connection.send({ id: request.id, error: { code, message } });
}

/** A Runtime.evaluate response carrying an exception thrown in the page. */
export function replyException(
  connection: FakeConnection,
  request: CdpRequest,
  message: string,
): void {
  reply(connection, request, {
    result: { type: "object", subtype: "error" },
    exceptionDetails: {
      exceptionId: 1,
      text: "Uncaught",
      lineNumber: 0,
      columnNumber: 0,
      exception: {
        type: "object",
        subtype: "error",
        description: `Error: ${message}\n    at <anonymous>:1:1`,
      },
    },
  });
}
