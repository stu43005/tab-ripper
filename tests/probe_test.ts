import { assertEquals } from "@std/assert";
import { probeCdpPort } from "../src/cdp/probe.ts";

Deno.test("probeCdpPort returns true for a listening port", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  try {
    assertEquals(await probeCdpPort(`127.0.0.1:${port}`), true);
  } finally {
    listener.close();
  }
});

Deno.test("probeCdpPort returns false for a closed port", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  assertEquals(await probeCdpPort(`127.0.0.1:${port}`), false);
});

Deno.test("probeCdpPort returns false for a malformed address", async () => {
  assertEquals(await probeCdpPort("not-an-address"), false);
});
