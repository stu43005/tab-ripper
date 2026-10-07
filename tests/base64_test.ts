import { assertEquals } from "@std/assert";
import { decodeBase64, encodeBase64 } from "../src/base64.ts";

Deno.test("encodeBase64 encodes bytes with the standard alphabet", () => {
  assertEquals(encodeBase64(new TextEncoder().encode("foobar")), "Zm9vYmFy");
  assertEquals(encodeBase64(new Uint8Array([0xfb, 0xff])), "+/8=");
  assertEquals(encodeBase64(new Uint8Array()), "");
});

Deno.test("decodeBase64 decodes to the original bytes", () => {
  assertEquals(new TextDecoder().decode(decodeBase64("Zm9vYmFy")), "foobar");
  assertEquals(decodeBase64("+/8="), new Uint8Array([0xfb, 0xff]));
  assertEquals(decodeBase64(""), new Uint8Array());
});

Deno.test("base64 round-trips a subarray view without leaking the parent buffer", () => {
  const parent = new Uint8Array(256).map((_, i) => i);
  const view = parent.subarray(10, 20);
  assertEquals(decodeBase64(encodeBase64(view)), parent.slice(10, 20));
});
