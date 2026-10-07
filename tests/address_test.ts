import { assertEquals, assertThrows } from "@std/assert";
import { browserWsUrl, parseCdpAddress } from "../src/cdp/address.ts";

const FORMAT_ERROR = "CDP 位址格式應為 主機:埠，例如 127.0.0.1:9222";

Deno.test("parseCdpAddress parses host and port", () => {
  assertEquals(parseCdpAddress("127.0.0.1:9222"), {
    host: "127.0.0.1",
    port: 9222,
  });
  assertEquals(parseCdpAddress("localhost:1"), { host: "localhost", port: 1 });
  assertEquals(parseCdpAddress("localhost:65535"), {
    host: "localhost",
    port: 65535,
  });
});

Deno.test("parseCdpAddress trims surrounding whitespace", () => {
  assertEquals(parseCdpAddress("  127.0.0.1:9222 \n"), {
    host: "127.0.0.1",
    port: 9222,
  });
});

Deno.test("parseCdpAddress rejects malformed addresses", () => {
  for (
    const bad of [
      "",
      "127.0.0.1",
      "127.0.0.1:",
      ":9222",
      "127.0.0.1:abc",
      "127.0.0.1:0",
      "127.0.0.1:65536",
      "127.0.0.1:92.5",
      "ws://127.0.0.1:9222",
      "a b:9222",
      "host/path:9222",
      "localhost?x:9222",
      "local#host:9222",
      "user@host:9222",
      "[::1]:9222",
      "back\\slash:9222",
    ]
  ) {
    assertThrows(
      () => parseCdpAddress(bad),
      Error,
      FORMAT_ERROR,
      `should reject ${JSON.stringify(bad)}`,
    );
  }
});

Deno.test("browserWsUrl builds the uuid-less browser endpoint", () => {
  assertEquals(
    browserWsUrl("127.0.0.1:9222"),
    "ws://127.0.0.1:9222/devtools/browser",
  );
  assertEquals(
    browserWsUrl(" localhost:9333 "),
    "ws://localhost:9333/devtools/browser",
  );
});

Deno.test("browserWsUrl rejects malformed addresses", () => {
  assertThrows(() => browserWsUrl("nope"), Error, FORMAT_ERROR);
});
