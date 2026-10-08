import { assertEquals } from "@std/assert";
import { CdpClient } from "../src/cdp/client.ts";
import { listTabs, statelessPattern } from "../src/tabs.ts";
import { FakeCdpServer, reply } from "./helpers/fake_cdp.ts";

Deno.test("statelessPattern drops g and y flags and keeps the rest", () => {
  const re = statelessPattern(/^https:\/\/EXAMPLE\.com\//gimy);
  assertEquals(re.source, "^https:\\/\\/EXAMPLE\\.com\\/");
  assertEquals(re.flags, "im");
});

Deno.test("statelessPattern gives stable results for repeated tests", () => {
  const re = statelessPattern(/example/g);
  assertEquals([re.test("example"), re.test("example"), re.test("example")], [
    true,
    true,
    true,
  ]);
});

Deno.test({
  name: "listTabs keeps matching page targets in CDP order",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = new FakeCdpServer({
      handler: (request, connection) =>
        reply(connection, request, {
          targetInfos: [
            {
              targetId: "1",
              type: "page",
              title: "A",
              url: "https://example.com/a",
              attached: false,
            },
            {
              targetId: "2",
              type: "service_worker",
              title: "SW",
              url: "https://example.com/sw.js",
            },
            {
              targetId: "3",
              type: "page",
              title: "Other",
              url: "https://other.com/",
            },
            {
              targetId: "4",
              type: "page",
              title: "B",
              url: "https://example.com/b",
            },
            {
              targetId: "5",
              type: "iframe",
              title: "F",
              url: "https://example.com/frame",
            },
          ],
        }),
    });
    const client = await CdpClient.connect(server.wsUrl);
    try {
      const pattern = /^https:\/\/example\.com\//g;
      const first = await listTabs(client, pattern);
      const second = await listTabs(client, pattern);
      const expected = [
        { targetId: "1", title: "A", url: "https://example.com/a" },
        { targetId: "4", title: "B", url: "https://example.com/b" },
      ];
      assertEquals(first, expected);
      assertEquals(second, expected);
      assertEquals(server.requests[0].method, "Target.getTargets");
    } finally {
      client.close();
      await server.close();
    }
  },
});
