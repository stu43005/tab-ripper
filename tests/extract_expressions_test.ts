import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { decodeBase64 } from "../src/base64.ts";
import { buildReadExpression, buildWrapperExpression } from "../src/extract.ts";

interface PageEntry {
  main: Uint8Array;
  aux: Uint8Array;
}
type FakeWindow = Record<string, unknown> & {
  __ffdl?: Record<string, PageEntry>;
};

function evaluateInPage(
  expression: string,
  window: FakeWindow,
  href: string,
): Promise<unknown> {
  const run = new Function("window", "location", `return ${expression};`) as (
    window: FakeWindow,
    location: { href: string },
  ) => Promise<unknown>;
  return run(window, { href });
}

const PATTERN = /^https:\/\/example\.com\//gi;
const HREF = "https://example.com/watch";
const SCRIPT = `async () => {
  window.calls = (window.calls ?? 0) + 1;
  return { main: new Uint8Array([1, 2, 3]).buffer, aux: new Uint8Array([9]), info: { title: "Clip", n: 1, ok: true } };
}`;

Deno.test("wrapper starts with a parseable marker and embeds the stateless pattern", () => {
  const expression = buildWrapperExpression("TOKEN-1", PATTERN, SCRIPT);
  assert(expression.startsWith('/*ffdl-wrapper:{"token":"TOKEN-1"}*/'));
  assertStringIncludes(expression, JSON.stringify(PATTERN.source));
  assertStringIncludes(
    expression,
    "new RegExp(" + JSON.stringify(PATTERN.source) + ', "i")',
  );
});

Deno.test("wrapper stores the buffers under its token on a fresh page", async () => {
  const window: FakeWindow = {};
  const result = await evaluateInPage(
    buildWrapperExpression("T", PATTERN, SCRIPT),
    window,
    HREF,
  );
  assertEquals(result, {
    info: { title: "Clip", n: 1, ok: true },
    sizes: { main: 3, aux: 1 },
  });
  assertEquals(window.__ffdl?.T.main, new Uint8Array([1, 2, 3]));
  assertEquals(window.__ffdl?.T.aux, new Uint8Array([9]));
});

Deno.test("wrapper refuses to run the script when the URL no longer matches", async () => {
  const window: FakeWindow = {};
  await assertRejects(
    () =>
      evaluateInPage(
        buildWrapperExpression("T", PATTERN, SCRIPT),
        window,
        "https://other.com/",
      ),
    Error,
    "分頁網址已變更為 https://other.com/，不符合網址規則，請重新選擇分頁",
  );
  assertEquals(window.calls, undefined);
  assertEquals(window.__ffdl, undefined);
});

Deno.test("two extractions on one page keep separate token slots", async () => {
  const window: FakeWindow = {};
  const second =
    `async () => ({ main: new Uint8Array([7]), aux: new Uint8Array([8]), info: {} })`;
  await evaluateInPage(
    buildWrapperExpression("A", PATTERN, SCRIPT),
    window,
    HREF,
  );
  await evaluateInPage(
    buildWrapperExpression("B", PATTERN, second),
    window,
    HREF,
  );
  assertEquals(window.__ffdl?.A.main, new Uint8Array([1, 2, 3]));
  assertEquals(window.__ffdl?.B.main, new Uint8Array([7]));
});

Deno.test("wrapper accepts ArrayBufferView with a byte offset", async () => {
  const window: FakeWindow = {};
  const script = `async () => {
    const buffer = new Uint8Array([0, 0, 5, 6, 7, 0]).buffer;
    return { main: new Uint8Array(buffer, 2, 3), aux: new DataView(buffer, 0, 2), info: {} };
  }`;
  const result = await evaluateInPage(
    buildWrapperExpression("T", PATTERN, script),
    window,
    HREF,
  );
  assertEquals(result, { info: {}, sizes: { main: 3, aux: 2 } });
  assertEquals(window.__ffdl?.T.main, new Uint8Array([5, 6, 7]));
});

Deno.test("wrapper validates the script result", async () => {
  const cases: [string, string][] = [
    [
      `async () => ({ main: "x", aux: new Uint8Array(), info: {} })`,
      "main 必須是 ArrayBuffer 或 ArrayBufferView",
    ],
    [
      `async () => ({ main: new Uint8Array(), aux: null, info: {} })`,
      "aux 必須是 ArrayBuffer 或 ArrayBufferView",
    ],
    [
      `async () => ({ main: new Uint8Array(), aux: new Uint8Array(), info: [] })`,
      "info 必須是純物件",
    ],
    [
      `async () => ({ main: new Uint8Array(), aux: new Uint8Array(), info: { x: {} } })`,
      "info.x 的值只能是",
    ],
    [`async () => null`, "頁面腳本必須回傳 { main, aux, info } 物件"],
  ];
  for (const [script, message] of cases) {
    await assertRejects(
      () =>
        evaluateInPage(buildWrapperExpression("T", PATTERN, script), {}, HREF),
      Error,
      message,
    );
  }
});

Deno.test("read expression returns the requested slice as base64", async () => {
  const window: FakeWindow = {};
  await evaluateInPage(
    buildWrapperExpression("T", PATTERN, SCRIPT),
    window,
    HREF,
  );
  const expression = buildReadExpression("T", "main", 1, 2);
  assert(
    expression.startsWith(
      '/*ffdl-read:{"token":"T","name":"main","offset":1,"length":2}*/',
    ),
  );
  const encoded = await evaluateInPage(expression, window, HREF);
  assertEquals(decodeBase64(encoded as string), new Uint8Array([2, 3]));
});

Deno.test("read expression only reads its own token", async () => {
  const window: FakeWindow = {};
  await evaluateInPage(
    buildWrapperExpression("A", PATTERN, SCRIPT),
    window,
    HREF,
  );
  await assertRejects(
    () => evaluateInPage(buildReadExpression("B", "main", 0, 1), window, HREF),
    Error,
    "FFDL_MISSING",
  );
});

Deno.test("read expression falls back to FileReader without toBase64", async () => {
  const window: FakeWindow = {};
  await evaluateInPage(
    buildWrapperExpression("T", PATTERN, SCRIPT),
    window,
    HREF,
  );
  const proto = Uint8Array.prototype as unknown as Record<string, unknown>;
  const original = proto.toBase64;
  delete proto.toBase64;
  try {
    const encoded = await evaluateInPage(
      buildReadExpression("T", "main", 0, 3),
      window,
      HREF,
    );
    assertEquals(decodeBase64(encoded as string), new Uint8Array([1, 2, 3]));
  } finally {
    proto.toBase64 = original;
  }
});
