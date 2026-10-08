import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { serveUi, UI_ASSETS } from "../src/ui-assets.ts";

Deno.test("serveUi serves the three UI files with content types", async () => {
  const cases: [string, string, string][] = [
    ["/", "text/html; charset=utf-8", "<title>Tab Ripper</title>"],
    ["/app.js", "text/javascript; charset=utf-8", "__showShuttingDown"],
    ["/style.css", "text/css; charset=utf-8", ".screen"],
  ];
  for (const [path, contentType, marker] of cases) {
    const response = serveUi(new Request(`http://127.0.0.1${path}`));
    assertEquals(response.status, 200, path);
    assertEquals(response.headers.get("content-type"), contentType);
    assertStringIncludes(await response.text(), marker);
  }
});

Deno.test("serveUi returns 404 for anything else, including inherited property names", async () => {
  for (
    const path of [
      "/settings.json",
      "/constructor",
      "/toString",
      "/__proto__",
      "/hasOwnProperty",
    ]
  ) {
    const response = serveUi(new Request(`http://127.0.0.1${path}`));
    assertEquals(response.status, 404, path);
    await response.body?.cancel();
  }
});

Deno.test("every element id used by app.js exists in index.html", () => {
  const html = UI_ASSETS.get("/")!.body;
  const js = UI_ASSETS.get("/app.js")!.body;
  const ids = [
    ...js.matchAll(/(?:\$|setText|setHidden|showError)\("([\w-]+)"/g),
  ].map((match) => match[1]);
  assert(new Set(ids).size > 30, "expected app.js to reference many elements");
  for (const id of new Set(ids)) {
    assertStringIncludes(html, `id="${id}"`, `missing #${id}`);
  }
});

Deno.test("app.js only calls bindings that main.ts registers", () => {
  const registered = [
    "getSettings",
    "saveSettings",
    "probe",
    "connect",
    "getConnection",
    "listTabs",
    "extract",
    "getStatus",
    "discard",
    "startProcess",
    "cancel",
    "reset",
    "revealInFinder",
  ];
  const js = UI_ASSETS.get("/app.js")!.body;
  const used = new Set(
    [...js.matchAll(/bindings\.(\w+)\(/g)].map((match) => match[1]),
  );
  assertEquals(
    used.size,
    registered.length,
    `app.js uses ${[...used].join(", ")}`,
  );
  for (const name of used) {
    assert(registered.includes(name), `unregistered binding ${name}`);
  }
});
