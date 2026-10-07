import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
} from "@std/assert";
import {
  CdpClient,
  CdpClosedError,
  CdpConnectError,
  CdpError,
  CdpSessionClosedError,
  CdpTimeoutError,
} from "../src/cdp/client.ts";
import {
  type CdpRequest,
  FakeCdpServer,
  reply,
  replyError,
} from "./helpers/fake_cdp.ts";
import { waitFor } from "./helpers/fixtures.ts";

const opts = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  name: "CdpClient matches out-of-order responses by id",
  ...opts,
  fn: async () => {
    const held: { request: CdpRequest; reply: (r: unknown) => void }[] = [];
    const server = new FakeCdpServer({
      handler: (request, connection) => {
        held.push({ request, reply: (r) => reply(connection, request, r) });
        if (held.length === 2) {
          held[1].reply({ value: "second" });
          held[0].reply({ value: "first" });
        }
      },
    });
    const client = await CdpClient.connect(server.wsUrl);
    try {
      const [a, b] = await Promise.all([
        client.send("A.one"),
        client.send("A.two"),
      ]);
      assertEquals(a, { value: "first" });
      assertEquals(b, { value: "second" });
    } finally {
      client.close();
      await server.close();
    }
  },
});

Deno.test({
  name: "CdpClient routes sessionId on requests and events",
  ...opts,
  fn: async () => {
    const server = new FakeCdpServer({
      handler: (request, connection) => {
        reply(connection, request, { echoed: request.sessionId ?? null });
        connection.send({
          method: "Page.ping",
          params: { n: 1 },
          sessionId: "S1",
        });
      },
    });
    const client = await CdpClient.connect(server.wsUrl);
    try {
      const events: { params: unknown; sessionId?: string }[] = [];
      const off = client.on(
        "Page.ping",
        (params, sessionId) => events.push({ params, sessionId }),
      );
      assertEquals(await client.send("X.y", {}, "S1"), { echoed: "S1" });
      await waitFor(() => events.length === 1, "event");
      assertEquals(events[0], { params: { n: 1 }, sessionId: "S1" });
      off();
      assertEquals(await client.send("X.y"), { echoed: null });
      assertEquals(server.requests[1].sessionId, undefined);
      assertEquals(events.length, 1);
    } finally {
      client.close();
      await server.close();
    }
  },
});

Deno.test({
  name: "CdpClient rejects protocol errors with CdpError",
  ...opts,
  fn: async () => {
    const server = new FakeCdpServer({
      handler: (request, connection) =>
        replyError(connection, request, -32000, "No target"),
    });
    const client = await CdpClient.connect(server.wsUrl);
    try {
      const error = await assertRejects(
        () => client.send("Target.attachToTarget"),
        CdpError,
        "No target",
      );
      assertEquals((error as CdpError).code, -32000);
    } finally {
      client.close();
      await server.close();
    }
  },
});

Deno.test({
  name: "CdpClient times out a request and ignores the late reply",
  ...opts,
  fn: async () => {
    const pending: (() => void)[] = [];
    const server = new FakeCdpServer({
      handler: (request, connection) =>
        pending.push(() => reply(connection, request, { late: true })),
    });
    const client = await CdpClient.connect(server.wsUrl);
    try {
      await assertRejects(
        () => client.send("Slow.call", {}, undefined, { timeoutMs: 100 }),
        CdpTimeoutError,
      );
      pending[0]();
      await new Promise((resolve) => setTimeout(resolve, 50));
      // The client is still usable after a dropped late reply.
      const ok = client.send("Slow.call", {}, undefined, { timeoutMs: 1000 });
      await waitFor(() => pending.length === 2, "second request");
      pending[1]();
      assertEquals(await ok, { late: true });
    } finally {
      client.close();
      await server.close();
    }
  },
});

Deno.test({
  name: "CdpClient rejects all pending requests when the socket closes",
  ...opts,
  fn: async () => {
    const server = new FakeCdpServer({ handler: () => {} });
    const client = await CdpClient.connect(server.wsUrl);
    try {
      const a = client.send("Never.one");
      const b = client.send("Never.two");
      await waitFor(() => server.requests.length === 2, "requests");
      server.connections[0].close();
      await assertRejects(() => a, CdpClosedError);
      await assertRejects(() => b, CdpClosedError);
      await client.closed;
      await assertRejects(() => client.send("After.close"), CdpClosedError);
    } finally {
      client.close();
      await server.close();
    }
  },
});

Deno.test({
  name: "CdpClient.close rejects pending requests immediately",
  ...opts,
  fn: async () => {
    const server = new FakeCdpServer({ handler: () => {} });
    const client = await CdpClient.connect(server.wsUrl);
    try {
      const pending = client.send("Never.reply");
      client.close();
      await assertRejects(() => pending, CdpClosedError);
    } finally {
      await server.close();
    }
  },
});

Deno.test({
  name:
    "CdpClient fails a session's pending requests on Target.detachedFromTarget",
  ...opts,
  fn: async () => {
    const server = new FakeCdpServer({
      handler: (request, connection) => {
        if (request.method === "Other.call") {
          reply(connection, request, { ok: true });
        }
      },
    });
    const client = await CdpClient.connect(server.wsUrl);
    try {
      const doomed = client.send("Runtime.evaluate", {}, "S-dead", {
        timeoutMs: 60_000,
      });
      await waitFor(() => server.requests.length === 1, "request");
      const start = Date.now();
      server.connections[0].send({
        method: "Target.detachedFromTarget",
        params: { sessionId: "S-dead" },
      });
      const error = await assertRejects(() => doomed, CdpSessionClosedError);
      assertInstanceOf(error, CdpSessionClosedError);
      assert(Date.now() - start < 1000);
      await assertRejects(
        () => client.send("Runtime.evaluate", {}, "S-dead"),
        CdpSessionClosedError,
      );
      assertEquals(await client.send("Other.call", {}, "S-alive"), {
        ok: true,
      });
    } finally {
      client.close();
      await server.close();
    }
  },
});

Deno.test({
  name: "CdpClient.connect times out while the upgrade is pending",
  ...opts,
  fn: async () => {
    const server = new FakeCdpServer({ upgradeDelayMs: 1500 });
    try {
      await assertRejects(
        () => CdpClient.connect(server.wsUrl, { timeoutMs: 200 }),
        CdpConnectError,
        "逾時",
      );
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 1600));
      await server.close();
    }
  },
});

Deno.test({
  name: "CdpClient.connect rejects when the endpoint refuses the upgrade",
  ...opts,
  fn: async () => {
    const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const { port } = listener.addr as Deno.NetAddr;
    listener.close();
    await assertRejects(
      () => CdpClient.connect(`ws://127.0.0.1:${port}/devtools/browser`),
      CdpConnectError,
    );
  },
});
