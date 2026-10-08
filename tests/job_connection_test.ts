import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  ADDRESS_CHANGED_MESSAGE,
  JobManager,
  NOT_CONNECTED_MESSAGE,
} from "../src/job.ts";
import type { Settings } from "../src/types.ts";
import { FakeCdpServer } from "./helpers/fake_cdp.ts";
import { fakePage } from "./helpers/fake_page.ts";
import { waitFor } from "./helpers/fixtures.ts";

const opts = { sanitizeOps: false, sanitizeResources: false };

function settingsFor(cdpAddress: string): Settings {
  return {
    cdpAddress,
    outputDir: "/tmp/tab-ripper-unused",
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
  };
}

function closedPortAddress(): string {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return `127.0.0.1:${port}`;
}

Deno.test("a new JobManager is idle and returns status copies", () => {
  const job = new JobManager(settingsFor("127.0.0.1:9222"));
  const status = job.getStatus();
  assertEquals(status, { state: "idle" });
  (status as { state: string }).state = "mutated";
  assertEquals(job.getStatus(), { state: "idle" });
  assertEquals(job.isConnected(), false);
  assertEquals(job.isShuttingDown, false);
});

Deno.test({
  name:
    "connect opens one browser connection and listTabs filters by URL_PATTERN",
  ...opts,
  fn: async () => {
    const server = new FakeCdpServer({ handler: fakePage().handler });
    const job = new JobManager(settingsFor(server.address));
    try {
      await job.connect();
      assertEquals(job.isConnected(), true);
      assertEquals(await job.listTabs(), [
        {
          targetId: "T1",
          title: "Clip page",
          url: "https://example.com/watch/1",
        },
      ]);
      await job.connect();
      assertEquals(server.upgradeRequests, 1);
    } finally {
      await server.close();
    }
  },
});

Deno.test({
  name: "overlapping connect calls share one attempt",
  ...opts,
  fn: async () => {
    const server = new FakeCdpServer({
      handler: fakePage().handler,
      upgradeDelayMs: 300,
    });
    const job = new JobManager(settingsFor(server.address));
    try {
      await Promise.all([job.connect(), job.connect()]);
      assertEquals(server.upgradeRequests, 1);
      assertEquals(job.isConnected(), true);
    } finally {
      await server.close();
    }
  },
});

Deno.test({
  name: "connect failure explains how to fix it and can be retried",
  ...opts,
  fn: async () => {
    const address = closedPortAddress();
    const job = new JobManager(settingsFor(address));
    const error = await assertRejects(
      () => job.connect(),
      Error,
      `無法連線到 ${address}`,
    );
    assertStringIncludes(
      (error as Error).message,
      "chrome://inspect/#remote-debugging",
    );
    assertEquals(job.isConnected(), false);
    await assertRejects(() => job.connect(), Error, "無法連線到");
  },
});

Deno.test({
  name: "updateSettings changes the address used by the next connect",
  ...opts,
  fn: async () => {
    const server = new FakeCdpServer({ handler: fakePage().handler });
    const job = new JobManager(settingsFor(closedPortAddress()));
    try {
      job.updateSettings(settingsFor(server.address));
      await job.connect();
      assertEquals(job.isConnected(), true);
    } finally {
      await server.close();
    }
  },
});

Deno.test({
  name: "changing the CDP address drops the current connection",
  ...opts,
  fn: async () => {
    const server = new FakeCdpServer({ handler: fakePage().handler });
    const other = new FakeCdpServer({ handler: fakePage().handler });
    const job = new JobManager(settingsFor(server.address));
    try {
      await job.connect();
      job.updateSettings(settingsFor(server.address)); // Same address: connection kept.
      assertEquals(job.isConnected(), true);
      job.updateSettings(settingsFor(other.address));
      assertEquals(job.isConnected(), false);
      await waitFor(
        () => server.connections[0].socket.readyState === WebSocket.CLOSED,
        "old socket closed",
      );
      await job.connect();
      assertEquals(other.upgradeRequests, 1);
      assertEquals(job.isConnected(), true);
    } finally {
      await server.close();
      await other.close();
    }
  },
});

Deno.test({
  name:
    "a connection attempt to the old address is rejected after an address change",
  ...opts,
  fn: async () => {
    const server = new FakeCdpServer({
      handler: fakePage().handler,
      upgradeDelayMs: 300,
    });
    const job = new JobManager(settingsFor(server.address));
    try {
      const connecting = job.connect();
      connecting.catch(() => {});
      job.updateSettings(settingsFor(closedPortAddress()));
      await assertRejects(() => connecting, Error, ADDRESS_CHANGED_MESSAGE);
      assertEquals(job.isConnected(), false);
      await waitFor(
        () => server.connections[0]?.socket.readyState === WebSocket.CLOSED,
        "stale socket closed",
      );
    } finally {
      await server.close();
    }
  },
});

Deno.test("assertSettingsChangeAllowed accepts changes while not extracting", () => {
  const job = new JobManager(settingsFor("127.0.0.1:9222"));
  job.assertSettingsChangeAllowed(settingsFor("127.0.0.1:9333"));
  job.assertSettingsChangeAllowed({
    ...settingsFor("127.0.0.1:9222"),
    outputDir: "/tmp/elsewhere",
  });
});

Deno.test({
  name:
    "a dropped connection is detected and a stale close does not affect the next one",
  ...opts,
  fn: async () => {
    const server = new FakeCdpServer({ handler: fakePage().handler });
    const job = new JobManager(settingsFor(server.address));
    try {
      await job.connect();
      server.connections[0].close();
      await waitFor(() => !job.isConnected(), "disconnect");
      await assertRejects(() => job.listTabs(), Error, NOT_CONNECTED_MESSAGE);
      await job.connect();
      assertEquals(server.upgradeRequests, 2);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert(job.isConnected());
      assertEquals((await job.listTabs()).length, 1);
    } finally {
      await server.close();
    }
  },
});
