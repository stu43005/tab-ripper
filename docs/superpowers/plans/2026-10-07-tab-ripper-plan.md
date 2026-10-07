# Tab Ripper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-codex:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Tab Ripper, a `deno desktop` app that connects to the user's running Chromium-based browser over CDP, runs a user-written script inside a chosen tab to pull out two files plus an info record, lets the user confirm the output filename, and processes the main file with ffmpeg while showing live progress.

**Architecture:** A single Deno process (`deno desktop`, default WKWebView backend) serves a plain-JS UI via `Deno.serve` and exposes backend operations through `win.bind()` bindings. A hand-written CDP client talks to `ws://<cdpAddress>/devtools/browser`; a `JobManager` class owns the connection, the single job's state machine, temp files, ffmpeg child processes and the shutdown protocol. User-specific behaviour (URL pattern, page script, info columns, ffmpeg args) lives in `user/`.

**Tech Stack:** Deno 2.9.7 (`deno desktop`, `deno test`), TypeScript, `jsr:@std/assert@1.0.19`, `jsr:@std/path@1.1.6`, ffmpeg/ffprobe 8.0, Chrome DevTools Protocol (Target/Runtime domains), plain HTML/CSS/JS UI.

**Spec:** `docs/superpowers/specs/2026-10-07-tab-ripper-design.md` (section numbers below refer to it).

---

## Conventions for every task

- Run all commands from the repository root.
- Test command for one file: `deno task test tests/<name>_test.ts`. Whole suite: `deno task test`.
- Every task ends with the project verification gate: `deno task check`, `deno task lint`, `deno fmt` (formatter rewrites files), then `deno fmt --check`, and the task's tests. All must pass before committing.
- Commits are made with the **git-master** skill, staging only the files listed in the task (never `git add -A` / `git add .`), plus `deno.lock` whenever the task changed it. Each commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- TDD order is mandatory: write the test, add a compiling skeleton, run the test and observe a **behavioural** failure, then implement, then observe the pass. Skeleton bodies throw `new Error("not implemented")` so the first run proves the test reaches the API.
- Error/UI strings are Traditional Chinese (user-facing); code comments are English.
- Tests that need ffmpeg use `ignore: !FFMPEG` where `FFMPEG` comes from `tests/helpers/fixtures.ts`.

## File structure

| Path | Responsibility |
| --- | --- |
| `deno.json` | imports, compilerOptions.lib, tasks |
| `main.ts` | desktop entry: window, menu, bindings, close handling, UI server, startup cleanup |
| `src/types.ts` | shared types (`Settings`, `Info`, `JobStatus`, …) |
| `src/session.ts` | `SESSION_ID` for this app run (spec §6.9 ownership boundary) |
| `src/base64.ts` | typed wrappers for `Uint8Array.fromBase64` / `toBase64` |
| `src/settings.ts` | settings file load/save/defaults (spec §6.1) |
| `src/cdp/address.ts` | `parseCdpAddress`, `browserWsUrl` (spec §6.3) |
| `src/cdp/probe.ts` | TCP-only port probe (spec §6.2) |
| `src/cdp/client.ts` | minimal CDP client (spec §6.4) |
| `src/tabs.ts` | stateless URL pattern + `listTabs` (spec §6.5) |
| `src/extract.ts` | page expressions + `extractFromTab` (spec §6.6) |
| `src/filename.ts` | `sanitizeFilename` (spec §6.7) |
| `src/ffmpeg.ts` | child registry, `checkTool`, `probeDuration`, parsers, `runFfmpeg` (spec §6.8) |
| `src/publish.ts` | `publishOutput`, `copyThenRename` (spec §6.9 step 8) |
| `src/cleanup.ts` | startup cleanup of stale artifacts (spec §6.9 暫存清理) |
| `src/job.ts` | `JobManager`: connection, state machine, processing, shutdown (spec §6.9, §6.11) |
| `src/ui-assets.ts` | text-imported UI files + `serveUi` (spec §6.10) |
| `ui/index.html`, `ui/style.css`, `ui/app.js` | UI (spec §6.12) |
| `user/config.ts`, `user/page-script.js`, `user/info.ts`, `user/ffmpeg-args.ts` | user extension points (spec §5) |
| `tests/helpers/fixtures.ts` | temp dirs, fake executables, test video, `waitFor`, process checks |
| `tests/helpers/fake_cdp.ts` | in-process fake CDP WebSocket server |
| `tests/helpers/fake_page.ts` | fake page behaviour (attach, evaluate, wrapper, chunk reads, targets) |
| `tests/*_test.ts` | unit/integration tests |

`src/session.ts`, `src/base64.ts` and `src/cleanup.ts` are small additions to the spec's file tree: they give the session id, base64 typing and startup cleanup their own focused, testable homes.

---

### Task 1: Project scaffold, shared types, user extension points

**Files:**
- Create: `deno.json`
- Create: `src/types.ts`
- Create: `src/session.ts`
- Create: `user/config.ts`
- Create: `user/page-script.js`
- Create: `user/info.ts`
- Create: `user/ffmpeg-args.ts`

This task has no behaviour to test (types and placeholders only); its gate is type check + lint + fmt.

- [ ] **Step 1: Create `deno.json`**

```json
{
  "compilerOptions": {
    "lib": ["deno.desktop", "deno.unstable", "dom"]
  },
  "imports": {
    "@std/assert": "jsr:@std/assert@^1.0.19",
    "@std/path": "jsr:@std/path@^1.1.6"
  },
  "exclude": ["dist/"],
  "tasks": {
    "dev": "deno desktop --hmr --allow-net --allow-read --allow-write --allow-run --allow-env main.ts",
    "build": "deno desktop --allow-net --allow-read --allow-write --allow-run --allow-env -o dist/TabRipper main.ts",
    "test": "deno test --allow-net --allow-read --allow-write --allow-run --allow-env",
    "check": "deno check src/ user/",
    "lint": "deno lint",
    "fmt": "deno fmt"
  }
}
```

(`check` gains `tests/` in Task 2 and `main.ts` in Task 20, once those exist — `deno check` fails on a missing directory. `-o dist/TabRipper` produces `dist/TabRipper.app`; spec §3.1.)

- [ ] **Step 2: Create `src/types.ts`**

```ts
// Shared types for the Deno side, the user extension points and the UI contract.

export type Info = Record<string, string | number | boolean>;

export interface InfoColumn {
  key: string;
  label: string;
}

export interface Settings {
  cdpAddress: string;
  outputDir: string;
  ffmpegPath: string;
  ffprobePath: string;
}

export interface TabInfo {
  targetId: string;
  title: string;
  url: string;
}

export interface ExtractResult {
  info: Info;
  mainPath: string;
  auxPath: string;
  mainSize: number;
  auxSize: number;
}

export interface FfmpegArgsContext {
  mainPath: string;
  auxPath: string;
  info: Info;
  outputPath: string;
}

export interface ToolCheck {
  ok: boolean;
  version?: string;
  error?: string;
}

export interface ProgressUpdate {
  percent: number | null;
  outTimeSec: number;
  durationSec: number | null;
  speed: number | null;
  /** Last stderr line printed by ffmpeg. */
  message: string | null;
}

export type JobStatus =
  | { state: "idle" }
  | { state: "extracting"; received: number; total: number }
  | {
    state: "ready";
    info: Info;
    columns: InfoColumn[];
    mainSize: number;
    auxSize: number;
    defaultFilename: string;
    /** Set when returning to ready after a destination failure. */
    lastError?: string;
  }
  | (
    & { state: "processing"; phase: "preparing" | "running" | "publishing" }
    & ProgressUpdate
  )
  | { state: "done"; outputPath: string; cleanupWarning?: string }
  | {
    state: "failed";
    stage: "extract" | "process";
    message: string;
    detail?: string[];
    cleanupWarning?: string;
  }
  | { state: "cancelled"; cleanupWarning?: string };
```

- [ ] **Step 3: Create `src/session.ts`**

```ts
// Identifies this app run. Temp dirs and staging files carry it so the
// startup cleanup never touches artifacts that belong to the current run.
export const SESSION_ID: string = crypto.randomUUID();
```

- [ ] **Step 4: Create `user/config.ts`**

```ts
/** Only tabs whose URL matches are listed. */
export const URL_PATTERN: RegExp = /^https:\/\/example\.com\//;

/** true: run ffprobe on the main file to get total duration (percentage progress).
 *  false: skip ffprobe; UI shows indeterminate progress with elapsed media time. */
export const PROBE_DURATION: boolean = true;
```

- [ ] **Step 5: Create `user/page-script.js`**

```js
/**
 * Runs INSIDE the selected browser tab. Must be self-contained:
 * it is serialized with Function.prototype.toString(), so it cannot
 * reference imports or variables outside its own body.
 * @returns {Promise<{ main: ArrayBuffer | ArrayBufferView,
 *                     aux: ArrayBuffer | ArrayBufferView,
 *                     info: Record<string, string | number | boolean> }>}
 */
// deno-lint-ignore require-await
export default async function pageScript() {
  throw new Error("TODO: implement user/page-script.js");
}
```

(The `TODO` is the spec-mandated user extension stub, spec §5.2. The lint suppression covers the stub only: an `async` function without `await` trips `require-await`; remove it once the real script awaits something.)

- [ ] **Step 6: Create `user/info.ts`**

```ts
import type { Info, InfoColumn } from "../src/types.ts";

/** Table columns, in display order. Keys missing from info show as empty. */
export const INFO_COLUMNS: InfoColumn[] = [
  { key: "title", label: "標題" },
];

/** Default output filename (including extension) shown for confirmation. */
export function defaultFilename(info: Info): string {
  return `${info.title ?? "output"}.mp4`;
}
```

- [ ] **Step 7: Create `user/ffmpeg-args.ts`**

```ts
import type { FfmpegArgsContext } from "../src/types.ts";

/** Return ffmpeg arguments WITHOUT the leading global options the app adds
 *  (-hide_banner -stats -progress pipe:1 -y). Must write to ctx.outputPath.
 *  Do not add -nostats: the live status message relies on ffmpeg's stats line. */
export function buildFfmpegArgs(ctx: FfmpegArgsContext): string[] {
  return ["-i", ctx.mainPath, "-c", "copy", ctx.outputPath];
}
```

- [ ] **Step 8: Verify**

Run: `deno task check && deno task lint && deno fmt && deno fmt --check`
Expected: `Check` lines for `src/` and `user/` with no errors; lint `Checked N files`; fmt check passes. (`deno task check` creates `deno.lock` when resolving `@std/*` later; if it appears now, include it in the commit.)

- [ ] **Step 9: Commit**

Use git-master to commit `deno.json`, `deno.lock` (if created), `src/types.ts`, `src/session.ts`, `user/config.ts`, `user/page-script.js`, `user/info.ts`, `user/ffmpeg-args.ts` with message `chore: scaffold Tab Ripper project and user extension points`.

---

### Task 2: Base64 helpers

**Files:**
- Create: `src/base64.ts`
- Test: `tests/base64_test.ts`
- Modify: `deno.json` (`check` task)

- [ ] **Step 0: Include tests in type checking** — in `deno.json`, change `"check": "deno check src/ user/"` to `"check": "deno check src/ user/ tests/"` (the `tests/` directory is created in Step 1).

- [ ] **Step 1: Write the failing test** — `tests/base64_test.ts`

```ts
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
```

- [ ] **Step 2: Create the skeleton** — `src/base64.ts`

```ts
export function decodeBase64(_base64: string): Uint8Array {
  throw new Error("not implemented");
}

export function encodeBase64(_bytes: Uint8Array): string {
  throw new Error("not implemented");
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `deno task test tests/base64_test.ts`
Expected: 3 tests FAIL with `Error: not implemented`.

- [ ] **Step 4: Implement** — replace `src/base64.ts`

```ts
// Deno 2.9.7 and current Chromium both ship the TC39 base64 methods, but
// the TypeScript lib may not declare them, so they are reached through
// narrow casts.
type Base64Constructor = { fromBase64(base64: string): Uint8Array };
type Base64Bytes = Uint8Array & { toBase64(): string };

export function decodeBase64(base64: string): Uint8Array {
  return (Uint8Array as unknown as Base64Constructor).fromBase64(base64);
}

export function encodeBase64(bytes: Uint8Array): string {
  return (bytes as Base64Bytes).toBase64();
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `deno task test tests/base64_test.ts`
Expected: `ok | 3 passed | 0 failed`.

- [ ] **Step 6: Verification gate** — `deno task check && deno task lint && deno fmt && deno fmt --check`

- [ ] **Step 7: Commit** — git-master: `deno.json`, `src/base64.ts`, `tests/base64_test.ts`, `deno.lock`; message `feat: add base64 helpers`.

---

### Task 3: CDP address parsing

**Files:**
- Create: `src/cdp/address.ts`
- Test: `tests/address_test.ts`

- [ ] **Step 1: Write the failing test** — `tests/address_test.ts`

```ts
import { assertEquals, assertThrows } from "@std/assert";
import { browserWsUrl, parseCdpAddress } from "../src/cdp/address.ts";

const FORMAT_ERROR = "CDP 位址格式應為 主機:埠，例如 127.0.0.1:9222";

Deno.test("parseCdpAddress parses host and port", () => {
  assertEquals(parseCdpAddress("127.0.0.1:9222"), { host: "127.0.0.1", port: 9222 });
  assertEquals(parseCdpAddress("localhost:1"), { host: "localhost", port: 1 });
  assertEquals(parseCdpAddress("localhost:65535"), { host: "localhost", port: 65535 });
});

Deno.test("parseCdpAddress trims surrounding whitespace", () => {
  assertEquals(parseCdpAddress("  127.0.0.1:9222 \n"), { host: "127.0.0.1", port: 9222 });
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
    assertThrows(() => parseCdpAddress(bad), Error, FORMAT_ERROR, `should reject ${JSON.stringify(bad)}`);
  }
});

Deno.test("browserWsUrl builds the uuid-less browser endpoint", () => {
  assertEquals(browserWsUrl("127.0.0.1:9222"), "ws://127.0.0.1:9222/devtools/browser");
  assertEquals(browserWsUrl(" localhost:9333 "), "ws://localhost:9333/devtools/browser");
});

Deno.test("browserWsUrl rejects malformed addresses", () => {
  assertThrows(() => browserWsUrl("nope"), Error, FORMAT_ERROR);
});
```

- [ ] **Step 2: Create the skeleton** — `src/cdp/address.ts`

```ts
export function parseCdpAddress(_address: string): { host: string; port: number } {
  throw new Error("not implemented");
}

export function browserWsUrl(_address: string): string {
  throw new Error("not implemented");
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `deno task test tests/address_test.ts`
Expected: FAIL — the parsing tests report `Error: not implemented`; the rejection tests fail because the thrown message is `not implemented` instead of the format error.

- [ ] **Step 4: Implement** — replace `src/cdp/address.ts`

```ts
// The app never reads browser data dirs; it only needs host:port.
const FORMAT_ERROR = "CDP 位址格式應為 主機:埠，例如 127.0.0.1:9222";

export function parseCdpAddress(address: string): { host: string; port: number } {
  const trimmed = address.trim();
  const colon = trimmed.lastIndexOf(":");
  if (colon <= 0) throw new Error(FORMAT_ERROR);
  const host = trimmed.slice(0, colon);
  const portText = trimmed.slice(colon + 1);
  // URL delimiters in the host would make the WebSocket URL target a
  // different endpoint than the TCP probe.
  if (/[\s/?#@[\]\\:]/.test(host)) throw new Error(FORMAT_ERROR);
  if (!/^\d+$/.test(portText)) throw new Error(FORMAT_ERROR);
  const port = Number(portText);
  if (port < 1 || port > 65535) throw new Error(FORMAT_ERROR);
  return { host, port };
}

/** Toggle-mode endpoints accept `/devtools/browser` without the uuid. */
export function browserWsUrl(address: string): string {
  const { host, port } = parseCdpAddress(address);
  return `ws://${host}:${port}/devtools/browser`;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `deno task test tests/address_test.ts`
Expected: `ok | 5 passed | 0 failed`.

- [ ] **Step 6: Verification gate** — `deno task check && deno task lint && deno fmt && deno fmt --check`

- [ ] **Step 7: Commit** — git-master: `src/cdp/address.ts`, `tests/address_test.ts`; message `feat: parse CDP address and build browser WebSocket URL`.

---

### Task 4: TCP-only CDP port probe

**Files:**
- Create: `src/cdp/probe.ts`
- Test: `tests/probe_test.ts`

- [ ] **Step 1: Write the failing test** — `tests/probe_test.ts`

```ts
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
```

- [ ] **Step 2: Create the skeleton** — `src/cdp/probe.ts`

```ts
export function probeCdpPort(_address: string, _timeoutMs = 1000): Promise<boolean> {
  return Promise.reject(new Error("not implemented"));
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `deno task test tests/probe_test.ts`
Expected: 3 tests FAIL with `Error: not implemented`.

- [ ] **Step 4: Implement** — replace `src/cdp/probe.ts`

```ts
import { parseCdpAddress } from "./address.ts";

/**
 * TCP connect + immediate close. No bytes are sent and no WebSocket
 * handshake happens, so the browser's permission dialog is not triggered.
 */
export async function probeCdpPort(address: string, timeoutMs = 1000): Promise<boolean> {
  let host: string;
  let port: number;
  try {
    ({ host, port } = parseCdpAddress(address));
  } catch {
    return false;
  }
  const attempt = Deno.connect({ hostname: host, port }).then(
    (conn) => conn,
    () => null,
  );
  let timer: number | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const outcome = await Promise.race([attempt, timeout]);
  clearTimeout(timer);
  if (outcome === "timeout") {
    // A connection that completes after the timeout must still be closed.
    void attempt.then((conn) => conn?.close());
    return false;
  }
  if (outcome === null) return false;
  outcome.close();
  return true;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `deno task test tests/probe_test.ts`
Expected: `ok | 3 passed | 0 failed`.

- [ ] **Step 6: Verification gate** — `deno task check && deno task lint && deno fmt && deno fmt --check`

- [ ] **Step 7: Commit** — git-master: `src/cdp/probe.ts`, `tests/probe_test.ts`; message `feat: add TCP-only CDP port probe`.

---

### Task 5: Filename sanitizing

**Files:**
- Create: `src/filename.ts`
- Test: `tests/filename_test.ts`

- [ ] **Step 1: Write the failing test** — `tests/filename_test.ts`

```ts
import { assertEquals, assertThrows } from "@std/assert";
import { sanitizeFilename } from "../src/filename.ts";

Deno.test("sanitizeFilename keeps ordinary names unchanged", () => {
  assertEquals(sanitizeFilename("My Clip 01.mp4"), "My Clip 01.mp4");
  assertEquals(sanitizeFilename("影片（完整版）.mkv"), "影片（完整版）.mkv");
});

Deno.test("sanitizeFilename removes forbidden characters", () => {
  assertEquals(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j.mp4'), "abcdefghij.mp4");
});

Deno.test("sanitizeFilename removes control characters", () => {
  assertEquals(sanitizeFilename("a\u0000b\u001fc\u007fd.mp4"), "abcd.mp4");
  assertEquals(sanitizeFilename("line\nbreak\t.mp4"), "linebreak.mp4");
});

Deno.test("sanitizeFilename trims whitespace and leading dots", () => {
  assertEquals(sanitizeFilename("  clip.mp4  "), "clip.mp4");
  assertEquals(sanitizeFilename("...hidden.mp4"), "hidden.mp4");
  assertEquals(sanitizeFilename(" .  clip.mp4"), "clip.mp4");
});

Deno.test("sanitizeFilename does not add an extension", () => {
  assertEquals(sanitizeFilename("noext"), "noext");
});

Deno.test("sanitizeFilename rejects names that become empty", () => {
  for (const bad of ["", "   ", "...", "/:*?", ". ."]) {
    assertThrows(() => sanitizeFilename(bad), Error, "檔名無效");
  }
});
```

- [ ] **Step 2: Create the skeleton** — `src/filename.ts`

```ts
export function sanitizeFilename(_name: string): string {
  throw new Error("not implemented");
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `deno task test tests/filename_test.ts`
Expected: FAIL — value tests throw `not implemented`; the rejection test fails because the message is not `檔名無效`.

- [ ] **Step 4: Implement** — replace `src/filename.ts`

```ts
// deno-lint-ignore no-control-regex
const FORBIDDEN = /[/\\:*?"<>|\u0000-\u001f\u007f]/g;

/** Strips forbidden/control chars, trims, and drops leading dots. */
export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(FORBIDDEN, "").trim().replace(/^[.\s]+/, "").trim();
  if (cleaned === "") throw new Error("檔名無效");
  return cleaned;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `deno task test tests/filename_test.ts`
Expected: `ok | 6 passed | 0 failed`.

- [ ] **Step 6: Verification gate** — `deno task check && deno task lint && deno fmt && deno fmt --check`

- [ ] **Step 7: Commit** — git-master: `src/filename.ts`, `tests/filename_test.ts`; message `feat: add output filename sanitizing`.

---

### Task 6: Settings file

**Files:**
- Create: `src/settings.ts`
- Test: `tests/settings_test.ts`

- [ ] **Step 1: Write the failing test** — `tests/settings_test.ts`

```ts
import { assertEquals, assertExists, assertRejects, assertThrows } from "@std/assert";
import { dirname, join } from "@std/path";
import { defaultSettings, loadSettings, saveSettings, settingsPath, validateSettings } from "../src/settings.ts";

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await Deno.makeTempDir({ prefix: "tabripper-home-" });
  const previous = Deno.env.get("HOME");
  Deno.env.set("HOME", home);
  try {
    await fn(home);
  } finally {
    if (previous === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", previous);
    await Deno.remove(home, { recursive: true });
  }
}

Deno.test("settingsPath lives under Application Support/tab-ripper", async () => {
  await withHome((home) => {
    assertEquals(
      settingsPath(),
      join(home, "Library", "Application Support", "tab-ripper", "settings.json"),
    );
    return Promise.resolve();
  });
});

Deno.test("defaultSettings returns the expected application defaults", async () => {
  await withHome((home) => {
    assertEquals(defaultSettings(), {
      cdpAddress: "127.0.0.1:9222",
      outputDir: join(home, "Downloads"),
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe",
    });
    return Promise.resolve();
  });
});

Deno.test("loadSettings returns defaults without warning when the file is missing", async () => {
  await withHome(async () => {
    const { settings, warning } = await loadSettings();
    assertEquals(settings, defaultSettings());
    assertEquals(warning, undefined);
  });
});

Deno.test("loadSettings returns defaults with a warning for corrupt JSON", async () => {
  await withHome(async () => {
    await Deno.mkdir(dirname(settingsPath()), { recursive: true });
    await Deno.writeTextFile(settingsPath(), "{ not json");
    const { settings, warning } = await loadSettings();
    assertEquals(settings, defaultSettings());
    assertExists(warning);
  });
});

Deno.test("loadSettings fills missing or mistyped fields with defaults", async () => {
  await withHome(async () => {
    await Deno.mkdir(dirname(settingsPath()), { recursive: true });
    await Deno.writeTextFile(
      settingsPath(),
      JSON.stringify({ cdpAddress: "127.0.0.1:9333", ffmpegPath: 42, outputDir: "" }),
    );
    const { settings, warning } = await loadSettings();
    assertEquals(settings, { ...defaultSettings(), cdpAddress: "127.0.0.1:9333" });
    assertEquals(warning, undefined);
  });
});

Deno.test("saveSettings then loadSettings round-trips", async () => {
  await withHome(async (home) => {
    const next = {
      cdpAddress: "localhost:9444",
      outputDir: join(home, "out"),
      ffmpegPath: "/opt/homebrew/bin/ffmpeg",
      ffprobePath: "/opt/homebrew/bin/ffprobe",
    };
    await saveSettings(next);
    assertEquals((await loadSettings()).settings, next);
  });
});

Deno.test("saveSettings rejects an invalid CDP address and writes nothing", async () => {
  await withHome(async () => {
    await assertRejects(
      () => saveSettings({ ...defaultSettings(), cdpAddress: "bad" }),
      Error,
      "CDP 位址格式應為",
    );
    await assertRejects(() => Deno.stat(settingsPath()), Deno.errors.NotFound);
  });
});

Deno.test("validateSettings checks synchronously without touching the disk", async () => {
  await withHome(async () => {
    assertThrows(
      () => validateSettings({ ...defaultSettings(), cdpAddress: "bad" }),
      Error,
      "CDP 位址格式應為",
    );
    assertThrows(() => validateSettings({ ...defaultSettings(), ffmpegPath: "" }), Error, "設定欄位不可為空");
    validateSettings(defaultSettings());
    await assertRejects(() => Deno.stat(settingsPath()), Deno.errors.NotFound);
  });
});

Deno.test("saveSettings rejects empty fields", async () => {
  await withHome(async () => {
    await assertRejects(
      () => saveSettings({ ...defaultSettings(), outputDir: "  " }),
      Error,
      "設定欄位不可為空",
    );
  });
});
```

- [ ] **Step 2: Create the skeleton** — `src/settings.ts`

```ts
import type { Settings } from "./types.ts";

export function settingsPath(): string {
  throw new Error("not implemented");
}

export function defaultSettings(): Settings {
  throw new Error("not implemented");
}

export function loadSettings(): Promise<{ settings: Settings; warning?: string }> {
  return Promise.reject(new Error("not implemented"));
}

export function validateSettings(_settings: Settings): void {
  throw new Error("not implemented");
}

export function saveSettings(_settings: Settings): Promise<void> {
  return Promise.reject(new Error("not implemented"));
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `deno task test tests/settings_test.ts`
Expected: all 9 tests FAIL (`not implemented`, or message mismatch in the rejection tests).

- [ ] **Step 4: Implement** — replace `src/settings.ts`

```ts
import { dirname, join } from "@std/path";
import { parseCdpAddress } from "./cdp/address.ts";
import type { Settings } from "./types.ts";

const CORRUPT_WARNING = "設定檔格式損毀，已使用預設值";
const KEYS = ["cdpAddress", "outputDir", "ffmpegPath", "ffprobePath"] as const;

function home(): string {
  const value = Deno.env.get("HOME");
  if (!value) throw new Error("HOME is not set");
  return value;
}

export function settingsPath(): string {
  return join(home(), "Library", "Application Support", "tab-ripper", "settings.json");
}

export function defaultSettings(): Settings {
  return {
    cdpAddress: "127.0.0.1:9222",
    outputDir: join(home(), "Downloads"),
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
  };
}

export async function loadSettings(): Promise<{ settings: Settings; warning?: string }> {
  const defaults = defaultSettings();
  let text: string;
  try {
    text = await Deno.readTextFile(settingsPath());
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { settings: defaults };
    return {
      settings: defaults,
      warning: `無法讀取設定檔：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { settings: defaults, warning: CORRUPT_WARNING };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { settings: defaults, warning: CORRUPT_WARNING };
  }
  const record = raw as Record<string, unknown>;
  const settings = { ...defaults };
  for (const key of KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") settings[key] = value;
  }
  return { settings };
}

/** Synchronous validation, usable before any await (e.g. by the save binding). */
export function validateSettings(settings: Settings): void {
  for (const key of KEYS) {
    if (typeof settings[key] !== "string" || settings[key].trim() === "") {
      throw new Error("設定欄位不可為空");
    }
  }
  parseCdpAddress(settings.cdpAddress);
}

export async function saveSettings(settings: Settings): Promise<void> {
  validateSettings(settings);
  const path = settingsPath();
  await Deno.mkdir(dirname(path), { recursive: true });
  const clean: Settings = {
    cdpAddress: settings.cdpAddress.trim(),
    outputDir: settings.outputDir.trim(),
    ffmpegPath: settings.ffmpegPath.trim(),
    ffprobePath: settings.ffprobePath.trim(),
  };
  await Deno.writeTextFile(path, JSON.stringify(clean, null, 2) + "\n");
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `deno task test tests/settings_test.ts`
Expected: `ok | 9 passed | 0 failed`.

- [ ] **Step 6: Verification gate** — `deno task check && deno task lint && deno fmt && deno fmt --check`

- [ ] **Step 7: Commit** — git-master: `src/settings.ts`, `tests/settings_test.ts`; message `feat: load and save settings`.

---

### Task 7: ffmpeg output parsers (`parseProgress`, `splitStderr`)

**Files:**
- Create: `src/ffmpeg.ts`
- Test: `tests/ffmpeg_parse_test.ts`

The stats-line format and `\r` separators were verified against ffmpeg 8.0 (spec §6.8; project MEMORY `ffmpeg-stats-output`).

- [ ] **Step 1: Write the failing test** — `tests/ffmpeg_parse_test.ts`

```ts
import { assertEquals } from "@std/assert";
import {
  flushStderr,
  newProgressState,
  newStderrState,
  parseProgress,
  splitStderr,
} from "../src/ffmpeg.ts";

Deno.test("parseProgress emits one event per progress block", () => {
  const state = newProgressState();
  const events = parseProgress(
    "frame=10\nout_time_us=1500000\nout_time_ms=1500000\nspeed=1.5x\nprogress=continue\n",
    state,
  );
  assertEquals(events, [{ outTimeSec: 1.5, speed: 1.5, ended: false }]);
});

Deno.test("parseProgress marks the final block as ended", () => {
  const state = newProgressState();
  const events = parseProgress("out_time_us=3000000\nspeed=26.3x\nprogress=end\n", state);
  assertEquals(events, [{ outTimeSec: 3, speed: 26.3, ended: true }]);
});

Deno.test("parseProgress ignores N/A values and keeps the previous time", () => {
  const state = newProgressState();
  parseProgress("out_time_us=2000000\nprogress=continue\n", state);
  const events = parseProgress("out_time_us=N/A\nspeed=N/A\nprogress=continue\n", state);
  assertEquals(events, [{ outTimeSec: 2, speed: null, ended: false }]);
});

Deno.test("parseProgress falls back to out_time_ms (microseconds)", () => {
  const state = newProgressState();
  const events = parseProgress("out_time_ms=500000\nprogress=continue\n", state);
  assertEquals(events, [{ outTimeSec: 0.5, speed: null, ended: false }]);
});

Deno.test("parseProgress prefers out_time_us over out_time_ms within a block", () => {
  const usFirst = newProgressState();
  assertEquals(
    parseProgress("out_time_us=2000000\nout_time_ms=1000000\nprogress=continue\n", usFirst),
    [{ outTimeSec: 2, speed: null, ended: false }],
  );
  const msFirst = newProgressState();
  assertEquals(
    parseProgress("out_time_ms=1000000\nout_time_us=2000000\nprogress=continue\n", msFirst),
    [{ outTimeSec: 2, speed: null, ended: false }],
  );
  // The next block without out_time_us falls back to out_time_ms.
  assertEquals(
    parseProgress("out_time_ms=3000000\nprogress=continue\n", msFirst),
    [{ outTimeSec: 3, speed: null, ended: false }],
  );
});

Deno.test("parseProgress joins lines split across chunks", () => {
  const state = newProgressState();
  assertEquals(parseProgress("out_time_us=25", state), []);
  assertEquals(parseProgress("00000\nspeed=2x\nprog", state), []);
  assertEquals(parseProgress("ress=end\n", state), [{ outTimeSec: 2.5, speed: 2, ended: true }]);
});

Deno.test("splitStderr marks \\r-terminated segments as transient", () => {
  const state = newStderrState();
  assertEquals(
    splitStderr("Input #0\nframe=  1 time=00:00:00.10    \rframe=  2 time=00:00:00.20    \r", state),
    [
      { segment: "Input #0", transient: false },
      { segment: "frame=  1 time=00:00:00.10", transient: true },
    ],
  );
  // The second \r is only resolved once the next character arrives.
  assertEquals(splitStderr("x", state), [{ segment: "frame=  2 time=00:00:00.20", transient: true }]);
});

Deno.test("splitStderr treats \\n-terminated segments as permanent", () => {
  const state = newStderrState();
  assertEquals(splitStderr("frame= 90 time=00:00:02.93   \n", state), [
    { segment: "frame= 90 time=00:00:02.93", transient: false },
  ]);
});

Deno.test("splitStderr treats \\r\\n as a single newline", () => {
  const state = newStderrState();
  assertEquals(splitStderr("warning one\r\nwarning two\r", state), [
    { segment: "warning one", transient: false },
  ]);
  assertEquals(splitStderr("\n", state), [{ segment: "warning two", transient: false }]);
});

Deno.test("splitStderr reassembles segments split across chunks", () => {
  const state = newStderrState();
  assertEquals(splitStderr("[mp4 @ 0x1] some ", state), []);
  assertEquals(splitStderr("warning\n", state), [{ segment: "[mp4 @ 0x1] some warning", transient: false }]);
});

Deno.test("splitStderr skips empty and whitespace-only segments", () => {
  const state = newStderrState();
  assertEquals(splitStderr("\n\n   \n\r\rtext\n", state), [{ segment: "text", transient: false }]);
});

Deno.test("flushStderr emits an unterminated final line as permanent", () => {
  const state = newStderrState();
  assertEquals(splitStderr("fatal-error", state), []);
  assertEquals(flushStderr(state), [{ segment: "fatal-error", transient: false }]);
  assertEquals(flushStderr(state), []);
});

Deno.test("flushStderr keeps a trailing lone \\r transient", () => {
  const state = newStderrState();
  assertEquals(splitStderr("frame=  1 time=00:00:00.10    \r", state), []);
  assertEquals(flushStderr(state), [{ segment: "frame=  1 time=00:00:00.10", transient: true }]);
});
```

- [ ] **Step 2: Create the skeleton** — `src/ffmpeg.ts`

```ts
export interface ProgressState {
  buffer: string;
  outTimeSec: number;
  speed: number | null;
  /** out_time_us / out_time_ms seen in the current block (microseconds). */
  blockUs: number | null;
  blockMs: number | null;
}

export interface ProgressEvent {
  outTimeSec: number;
  speed: number | null;
  ended: boolean;
}

export interface StderrState {
  buffer: string;
  pendingCR: boolean;
}

export interface StderrSegment {
  segment: string;
  transient: boolean;
}

export function newProgressState(): ProgressState {
  return { buffer: "", outTimeSec: 0, speed: null, blockUs: null, blockMs: null };
}

export function newStderrState(): StderrState {
  return { buffer: "", pendingCR: false };
}

export function parseProgress(_chunk: string, _state: ProgressState): ProgressEvent[] {
  throw new Error("not implemented");
}

export function splitStderr(_chunk: string, _state: StderrState): StderrSegment[] {
  throw new Error("not implemented");
}

export function flushStderr(_state: StderrState): StderrSegment[] {
  throw new Error("not implemented");
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `deno task test tests/ffmpeg_parse_test.ts`
Expected: 13 tests FAIL with `Error: not implemented`.

- [ ] **Step 4: Implement** — replace the three skeleton function bodies in `src/ffmpeg.ts`

```ts
/**
 * Parses `-progress pipe:1` key=value output; one event per `progress=` line.
 * Within a block out_time_us wins; out_time_ms (also microseconds in ffmpeg)
 * is only a fallback when the block has no usable out_time_us.
 */
export function parseProgress(chunk: string, state: ProgressState): ProgressEvent[] {
  const events: ProgressEvent[] = [];
  const lines = (state.buffer + chunk).split("\n");
  state.buffer = lines.pop() ?? "";
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1).trim();
    if (key === "out_time_us" || key === "out_time_ms") {
      if (value === "N/A") continue;
      const micros = Number(value);
      if (!Number.isFinite(micros) || micros < 0) continue;
      if (key === "out_time_us") state.blockUs = micros;
      else state.blockMs = micros;
    } else if (key === "speed") {
      const match = /^([\d.]+)x$/.exec(value);
      state.speed = match ? Number(match[1]) : null;
    } else if (key === "progress") {
      const micros = state.blockUs ?? state.blockMs;
      if (micros !== null) state.outTimeSec = micros / 1_000_000;
      state.blockUs = null;
      state.blockMs = null;
      events.push({ outTimeSec: state.outTimeSec, speed: state.speed, ended: value === "end" });
    }
  }
  return events;
}

/**
 * Splits stderr on \r and \n. Segments ended by a lone \r are ffmpeg's
 * in-place stats updates (transient); \n and \r\n end permanent lines.
 */
export function splitStderr(chunk: string, state: StderrState): StderrSegment[] {
  const segments: StderrSegment[] = [];
  const push = (text: string, transient: boolean) => {
    const segment = text.trim();
    if (segment !== "") segments.push({ segment, transient });
  };
  let buffer = state.buffer;
  for (const ch of chunk) {
    if (state.pendingCR) {
      state.pendingCR = false;
      if (ch === "\n") {
        push(buffer, false);
        buffer = "";
        continue;
      }
      push(buffer, true);
      buffer = "";
    }
    if (ch === "\r") {
      state.pendingCR = true;
    } else if (ch === "\n") {
      push(buffer, false);
      buffer = "";
    } else {
      buffer += ch;
    }
  }
  state.buffer = buffer;
  return segments;
}

/**
 * Emits whatever is still buffered at EOF. A pending lone \r keeps its
 * transient classification; an unterminated line counts as permanent so a
 * final error message still reaches the stderr tail.
 */
export function flushStderr(state: StderrState): StderrSegment[] {
  const segment = state.buffer.trim();
  const transient = state.pendingCR;
  state.buffer = "";
  state.pendingCR = false;
  return segment === "" ? [] : [{ segment, transient }];
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `deno task test tests/ffmpeg_parse_test.ts`
Expected: `ok | 13 passed | 0 failed`.

- [ ] **Step 6: Verification gate** — `deno task check && deno task lint && deno fmt && deno fmt --check`

- [ ] **Step 7: Commit** — git-master: `src/ffmpeg.ts`, `tests/ffmpeg_parse_test.ts`; message `feat: parse ffmpeg progress and stderr output`.

---

### Task 8: Test fixtures and ffmpeg child processes

**Files:**
- Create: `tests/helpers/fixtures.ts`
- Modify: `src/ffmpeg.ts` (append process management below the parsers)
- Test: `tests/ffmpeg_process_test.ts`

**Scope note — process trees:** timeouts, cancellation and `killAllChildren()` act on the directly spawned process. A configured wrapper script that starts the real tool *without* `exec` can leave a descendant holding stdout/stderr open, delaying EOF. The user adjudicated this as an accepted limitation (spec §10 "wrapper script 的子孫行程"): tool paths must point at the executables or at `exec`-style wrappers, which is why every fake executable in these tests uses `exec`. No process-group handling or stream-read timeout is implemented.

- [ ] **Step 1: Create shared test fixtures** — `tests/helpers/fixtures.ts`

```ts
import { join } from "@std/path";

/** True when a working ffmpeg is on PATH; ffmpeg-dependent tests use `ignore: !FFMPEG`. */
export const FFMPEG: boolean = await (async () => {
  try {
    const out = await new Deno.Command("ffmpeg", { args: ["-version"], stdout: "null", stderr: "null" })
      .output();
    return out.success;
  } catch {
    return false;
  }
})();

export function makeTempDir(prefix = "tabripper-test-"): Promise<string> {
  return Deno.makeTempDir({ prefix });
}

/** Writes an executable /bin/sh script and returns its path. */
export async function makeExecutable(dir: string, name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await Deno.writeTextFile(path, `#!/bin/sh\n${body}\n`);
  await Deno.chmod(path, 0o755);
  return path;
}

/** Generates a small H.264 MP4 test video with ffmpeg's lavfi testsrc. */
export async function makeTestVideo(dir: string, seconds = 3): Promise<string> {
  const path = join(dir, "source.mp4");
  const out = await new Deno.Command("ffmpeg", {
    args: [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc=duration=${seconds}:size=320x240:rate=10`,
      "-pix_fmt",
      "yuv420p",
      path,
    ],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  return path;
}

/** Polls `predicate` every 25 ms until it is true or the timeout elapses. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

export async function listDir(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  return names.sort();
}
```

- [ ] **Step 2: Write the failing test** — `tests/ffmpeg_process_test.ts`

```ts
import { assert, assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  activeChildCount,
  checkTool,
  killAllChildren,
  newProgressState,
  parseProgress,
  probeDuration,
  type ProgressEvent,
  type ProgressUpdateCallback,
  runFfmpeg,
} from "../src/ffmpeg.ts";
import type { ProgressUpdate } from "../src/types.ts";
import { FFMPEG, makeExecutable, makeTempDir, makeTestVideo, pathExists, waitFor } from "./helpers/fixtures.ts";

Deno.test({
  name: "parseProgress sees the terminal progress=end event in real ffmpeg output",
  ignore: !FFMPEG,
  fn: async () => {
    const dir = await makeTempDir();
    try {
      const video = await makeTestVideo(dir, 3);
      const out = await new Deno.Command("ffmpeg", {
        args: ["-hide_banner", "-progress", "pipe:1", "-y", "-i", video, "-c", "copy", join(dir, "out.mp4")],
        stdout: "piped",
        stderr: "null",
      }).output();
      assert(out.success);
      const events: ProgressEvent[] = parseProgress(new TextDecoder().decode(out.stdout), newProgressState());
      assert(events.length > 0);
      const last = events[events.length - 1];
      assertEquals(last.ended, true);
      assert(events.slice(0, -1).every((event) => !event.ended));
      assert(last.outTimeSec > 2.5, `outTimeSec ${last.outTimeSec}`);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "checkTool reports the ffmpeg version line",
  ignore: !FFMPEG,
  fn: async () => {
    const result = await checkTool("ffmpeg");
    assertEquals(result.ok, true);
    assertStringIncludes(result.version ?? "", "ffmpeg version");
  },
});

Deno.test("checkTool reports a missing executable", async () => {
  const result = await checkTool("/nonexistent/ffmpeg-for-tab-ripper");
  assertEquals(result.ok, false);
  assertExists(result.error);
});

Deno.test("checkTool times out, kills the child and unregisters it", async () => {
  const dir = await makeTempDir();
  try {
    const hang = await makeExecutable(dir, "hang", "exec sleep 30");
    const start = Date.now();
    const result = await checkTool(hang, 300);
    assertEquals(result.ok, false);
    assertStringIncludes(result.error ?? "", "逾時");
    assert(Date.now() - start < 5000);
    assertEquals(activeChildCount(), 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("killAllChildren terminates registered children", async () => {
  const dir = await makeTempDir();
  try {
    const hang = await makeExecutable(dir, "hang", "exec sleep 30");
    const pending = checkTool(hang, 60_000);
    await waitFor(() => activeChildCount() === 1, "child registration");
    killAllChildren();
    const result = await pending;
    assertEquals(result.ok, false);
    assertEquals(activeChildCount(), 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "probeDuration reads the container duration",
  ignore: !FFMPEG,
  fn: async () => {
    const dir = await makeTempDir();
    try {
      const video = await makeTestVideo(dir, 3);
      const duration = await probeDuration("ffprobe", video, new AbortController().signal);
      assertExists(duration);
      assert(duration > 2.5 && duration < 3.5, `unexpected duration ${duration}`);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("probeDuration returns null after its timeout and leaves no child", async () => {
  const dir = await makeTempDir();
  try {
    const hang = await makeExecutable(dir, "ffprobe-hang", "exec sleep 30");
    const result = await probeDuration(hang, "/dev/null", new AbortController().signal, 300);
    assertEquals(result, null);
    assertEquals(activeChildCount(), 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("probeDuration returns null when aborted and leaves no child", async () => {
  const dir = await makeTempDir();
  try {
    const hang = await makeExecutable(dir, "ffprobe-hang", "exec sleep 30");
    const controller = new AbortController();
    const pending = probeDuration(hang, "/dev/null", controller.signal, 60_000);
    await waitFor(() => activeChildCount() === 1, "ffprobe start");
    controller.abort();
    assertEquals(await pending, null);
    assertEquals(activeChildCount(), 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("probeDuration returns null for a missing executable", async () => {
  assertEquals(await probeDuration("/nonexistent/ffprobe", "/dev/null", new AbortController().signal), null);
});

function collector(): { updates: ProgressUpdate[]; onProgress: ProgressUpdateCallback } {
  const updates: ProgressUpdate[] = [];
  return { updates, onProgress: (update) => updates.push(update) };
}

Deno.test({
  name: "runFfmpeg completes, reports progress and writes the output",
  ignore: !FFMPEG,
  fn: async () => {
    const dir = await makeTempDir();
    try {
      const video = await makeTestVideo(dir, 3);
      const output = join(dir, "out.mp4");
      const { updates, onProgress } = collector();
      const run = runFfmpeg({
        ffmpegPath: "ffmpeg",
        args: ["-i", video, "-c", "copy", output],
        durationSec: 3,
        onProgress,
      });
      const { code } = await run.done;
      assertEquals(code, 0);
      assert(await pathExists(output));
      assert(updates.length > 0);
      const last = updates[updates.length - 1];
      assertEquals(last.durationSec, 3);
      assert(last.percent !== null && last.percent > 90, `percent ${last.percent}`);
      assertEquals(activeChildCount(), 0);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "runFfmpeg exposes the stats line as message and keeps it out of stderrTail",
  ignore: !FFMPEG,
  fn: async () => {
    const dir = await makeTempDir();
    try {
      const video = await makeTestVideo(dir, 3);
      const { updates, onProgress } = collector();
      const run = runFfmpeg({
        ffmpegPath: "ffmpeg",
        args: ["-re", "-i", video, "-c", "copy", join(dir, "out.mp4")],
        durationSec: null,
        onProgress,
      });
      const { code, stderrTail } = await run.done;
      assertEquals(code, 0);
      assert(
        updates.some((u) => u.message?.startsWith("frame=")),
        "expected a frame= status message",
      );
      assert(updates.every((u) => u.percent === null));
      // Only the final, \n-terminated stats line may appear in the tail.
      assert(stderrTail.filter((line) => line.startsWith("frame=")).length <= 1);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "runFfmpeg reports a non-zero exit code with a stderr tail",
  ignore: !FFMPEG,
  fn: async () => {
    const dir = await makeTempDir();
    try {
      const run = runFfmpeg({
        ffmpegPath: "ffmpeg",
        args: ["-i", join(dir, "missing.mp4"), join(dir, "out.mp4")],
        durationSec: null,
        onProgress: () => {},
      });
      const { code, stderrTail } = await run.done;
      assert(code !== 0);
      assert(stderrTail.some((line) => line.includes("No such file")), stderrTail.join("\n"));
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "runFfmpeg cancel stops a running ffmpeg",
  ignore: !FFMPEG,
  fn: async () => {
    const dir = await makeTempDir();
    try {
      const { updates, onProgress } = collector();
      const run = runFfmpeg({
        ffmpegPath: "ffmpeg",
        args: ["-re", "-f", "lavfi", "-i", "testsrc=duration=60:size=320x240:rate=10", join(dir, "out.mp4")],
        durationSec: 60,
        onProgress,
      });
      await waitFor(() => updates.length > 0, "first progress update");
      const start = Date.now();
      run.cancel();
      const { code } = await run.done;
      assert(code !== 0);
      assert(Date.now() - start < 5000);
      assertEquals(activeChildCount(), 0);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("runFfmpeg keeps an unterminated final stderr line in the tail", async () => {
  const dir = await makeTempDir();
  try {
    const fatal = await makeExecutable(dir, "ffmpeg-fatal", "printf 'fatal-error' >&2\nexit 3");
    const { updates, onProgress } = collector();
    const run = runFfmpeg({ ffmpegPath: fatal, args: [], durationSec: null, onProgress });
    const { code, stderrTail } = await run.done;
    assertEquals(code, 3);
    assertEquals(stderrTail, ["fatal-error"]);
    assertEquals(updates[updates.length - 1].message, "fatal-error");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runFfmpeg calls onProgress for every stderr segment in a chunk", async () => {
  const dir = await makeTempDir();
  try {
    const multi = await makeExecutable(dir, "ffmpeg-multi", "printf 'one\\ntwo\\nthree\\n' >&2");
    const { updates, onProgress } = collector();
    const run = runFfmpeg({ ffmpegPath: multi, args: [], durationSec: null, onProgress });
    await run.done;
    assertEquals(updates.map((u) => u.message), ["one", "two", "three"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runFfmpeg cancel escalates to SIGKILL when SIGTERM is ignored", async () => {
  const dir = await makeTempDir();
  try {
    const ready = join(dir, "trap-installed");
    const stubborn = await makeExecutable(
      dir,
      "ffmpeg-stubborn",
      `trap '' TERM\ntouch "${ready}"\nexec sleep 30`,
    );
    const run = runFfmpeg({ ffmpegPath: stubborn, args: [], durationSec: null, onProgress: () => {} });
    // The child signals readiness only after the TERM trap is installed.
    await waitFor(() => pathExists(ready), "trap installed");
    const start = Date.now();
    run.cancel();
    await run.done;
    const elapsed = Date.now() - start;
    assert(elapsed >= 2500 && elapsed < 6000, `elapsed ${elapsed}`);
    assertEquals(activeChildCount(), 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
```

- [ ] **Step 3: Add the skeleton** — append to `src/ffmpeg.ts`

```ts
import type { ProgressUpdate, ToolCheck } from "./types.ts"; // move to the top of the file

export type ProgressUpdateCallback = (update: ProgressUpdate) => void;

export interface FfmpegRunOptions {
  ffmpegPath: string;
  args: string[];
  durationSec: number | null;
  onProgress: ProgressUpdateCallback;
}

export interface FfmpegRun {
  done: Promise<{ code: number; stderrTail: string[] }>;
  cancel(): void;
}

export function activeChildCount(): number {
  throw new Error("not implemented");
}

export function killAllChildren(): void {
  throw new Error("not implemented");
}

export function checkTool(_path: string, _timeoutMs = 5000): Promise<ToolCheck> {
  return Promise.reject(new Error("not implemented"));
}

export function probeDuration(
  _ffprobePath: string,
  _file: string,
  _signal: AbortSignal,
  _timeoutMs = 15_000,
): Promise<number | null> {
  return Promise.reject(new Error("not implemented"));
}

export function runFfmpeg(_opts: FfmpegRunOptions): FfmpegRun {
  throw new Error("not implemented");
}
```

Move the `import type` line to the top of the file (imports must precede other statements).

- [ ] **Step 4: Run test to verify it fails**

Run: `deno task test tests/ffmpeg_process_test.ts`
Expected: every test that calls this task's functions FAILs with `Error: not implemented` (ffmpeg tests are reported as `ignored` only if ffmpeg is missing; on this machine ffmpeg 8.0 is installed, so they run and fail). The one exception is `parseProgress sees the terminal progress=end event in real ffmpeg output`: it feeds real ffmpeg output to Task 7's already-implemented parser and passes here — it is an integration check of Task 7, not of this task's skeleton.

- [ ] **Step 5: Implement** — replace the skeleton functions in `src/ffmpeg.ts` with:

```ts
// Every child this module spawns is registered so shutdown paths can kill
// them synchronously: Deno.exit() does not terminate children.
const children = new Set<Deno.ChildProcess>();

function track(child: Deno.ChildProcess): void {
  children.add(child);
  const forget = () => children.delete(child);
  child.status.then(forget, forget);
}

function killQuietly(child: Deno.ChildProcess, signal: Deno.Signal): void {
  try {
    child.kill(signal);
  } catch {
    // Already exited.
  }
}

export function activeChildCount(): number {
  return children.size;
}

export function killAllChildren(): void {
  for (const child of children) killQuietly(child, "SIGKILL");
}

export async function checkTool(path: string, timeoutMs = 5000): Promise<ToolCheck> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(path, {
      args: ["-version"],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).spawn();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  track(child);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killQuietly(child, "SIGKILL");
  }, timeoutMs);
  const [status, stdout] = await Promise.all([child.status, new Response(child.stdout).text()]);
  clearTimeout(timer);
  if (timedOut) {
    return { ok: false, error: `執行逾時（${timeoutMs / 1000} 秒），請確認路徑是否正確` };
  }
  if (!status.success) return { ok: false, error: `執行失敗（結束碼 ${status.code}）` };
  return { ok: true, version: stdout.split("\n")[0].trim() };
}

export async function probeDuration(
  ffprobePath: string,
  file: string,
  signal: AbortSignal,
  timeoutMs = 15_000,
): Promise<number | null> {
  if (signal.aborted) return null;
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(ffprobePath, {
      args: [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        file,
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).spawn();
  } catch {
    return null;
  }
  track(child);
  const kill = () => killQuietly(child, "SIGKILL");
  const timer = setTimeout(kill, timeoutMs);
  signal.addEventListener("abort", kill, { once: true });
  try {
    const [status, stdout] = await Promise.all([child.status, new Response(child.stdout).text()]);
    if (!status.success || signal.aborted) return null;
    const seconds = Number(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", kill);
  }
}

const GLOBAL_ARGS = ["-hide_banner", "-stats", "-progress", "pipe:1", "-y"];
const STDERR_TAIL_LINES = 200;

export function runFfmpeg(opts: FfmpegRunOptions): FfmpegRun {
  const child = new Deno.Command(opts.ffmpegPath, {
    args: [...GLOBAL_ARGS, ...opts.args],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  track(child);

  const progress = newProgressState();
  const stderrState = newStderrState();
  const stderrTail: string[] = [];
  let message: string | null = null;

  const emit = () => {
    const percent = opts.durationSec
      ? Math.min(100, (progress.outTimeSec / opts.durationSec) * 100)
      : null;
    opts.onProgress({
      percent,
      outTimeSec: progress.outTimeSec,
      durationSec: opts.durationSec,
      speed: progress.speed,
      message,
    });
  };

  const readStdout = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      if (parseProgress(decoder.decode(chunk, { stream: true }), progress).length > 0) emit();
    }
  })();

  // Every message update triggers onProgress; transient stats lines never
  // enter the error tail.
  const handleSegments = (segments: StderrSegment[]) => {
    for (const { segment, transient } of segments) {
      message = segment;
      if (!transient) {
        stderrTail.push(segment);
        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
      }
      emit();
    }
  };

  const readStderr = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) {
      handleSegments(splitStderr(decoder.decode(chunk, { stream: true }), stderrState));
    }
    handleSegments(splitStderr(decoder.decode(), stderrState));
    handleSegments(flushStderr(stderrState));
  })();

  let killTimer: number | undefined;
  const done = (async () => {
    const [status] = await Promise.all([child.status, readStdout, readStderr]);
    clearTimeout(killTimer);
    return { code: status.code, stderrTail };
  })();

  return {
    done,
    cancel() {
      if (killTimer !== undefined) return;
      killQuietly(child, "SIGTERM");
      killTimer = setTimeout(() => killQuietly(child, "SIGKILL"), 3000);
    },
  };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `deno task test tests/ffmpeg_process_test.ts`
Expected: `ok | 16 passed | 0 failed`.

- [ ] **Step 7: Verification gate** — `deno task check && deno task lint && deno fmt && deno fmt --check`

- [ ] **Step 8: Commit** — git-master: `tests/helpers/fixtures.ts`, `src/ffmpeg.ts`, `tests/ffmpeg_process_test.ts`; message `feat: manage ffmpeg/ffprobe child processes with progress reporting`.

---

### Task 9: Output publishing

**Files:**
- Create: `src/publish.ts`
- Test: `tests/publish_test.ts`

- [ ] **Step 1: Write the failing test** — `tests/publish_test.ts`

```ts
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { copyThenRename, isCrossDeviceError, publishOutput } from "../src/publish.ts";
import { listDir, makeTempDir, pathExists } from "./helpers/fixtures.ts";

async function withDirs(fn: (src: string, dest: string) => Promise<void>): Promise<void> {
  const src = await makeTempDir();
  const dest = await makeTempDir();
  try {
    await fn(src, dest);
  } finally {
    await Deno.remove(src, { recursive: true });
    await Deno.remove(dest, { recursive: true });
  }
}

Deno.test("publishOutput moves the file into place", async () => {
  await withDirs(async (src, dest) => {
    const from = join(src, "out.mp4");
    await Deno.writeTextFile(from, "new");
    await publishOutput(from, join(dest, "final.mp4"));
    assertEquals(await Deno.readTextFile(join(dest, "final.mp4")), "new");
    assertEquals(await pathExists(from), false);
  });
});

Deno.test("publishOutput replaces an existing destination", async () => {
  await withDirs(async (src, dest) => {
    const from = join(src, "out.mp4");
    await Deno.writeTextFile(from, "new");
    await Deno.writeTextFile(join(dest, "final.mp4"), "old");
    await publishOutput(from, join(dest, "final.mp4"));
    assertEquals(await Deno.readTextFile(join(dest, "final.mp4")), "new");
  });
});

Deno.test("isCrossDeviceError recognises only EXDEV", () => {
  // Deno reports a cross-volume rename as a plain Error with code "EXDEV"
  // (verified with a RAM disk on Deno 2.9.7).
  const exdev = Object.assign(new Error("Cross-device link (os error 18)"), { code: "EXDEV" });
  const eacces = Object.assign(new Error("Permission denied (os error 13)"), { code: "EACCES" });
  assertEquals(isCrossDeviceError(exdev), true);
  assertEquals(isCrossDeviceError(eacces), false);
  assertEquals(isCrossDeviceError(new Deno.errors.NotFound("x")), false);
  assertEquals(isCrossDeviceError("EXDEV"), false);
});

Deno.test("publishOutput propagates a non-cross-device rename failure without copying", async () => {
  await withDirs(async (src, dest) => {
    const from = join(src, "out.mp4");
    await Deno.writeTextFile(from, "new");
    await Deno.chmod(dest, 0o500);
    try {
      await assertRejects(() => publishOutput(from, join(dest, "final.mp4")));
    } finally {
      await Deno.chmod(dest, 0o755);
    }
    assertEquals(await listDir(dest), []);
    assert(await pathExists(from));
  });
});

Deno.test("copyThenRename copies through a staging file and leaves no .part", async () => {
  await withDirs(async (src, dest) => {
    const from = join(src, "out.mp4");
    await Deno.writeTextFile(from, "payload");
    await copyThenRename(from, join(dest, "final.mp4"));
    assertEquals(await Deno.readTextFile(join(dest, "final.mp4")), "payload");
    assertEquals(await listDir(dest), ["final.mp4"]);
  });
});

Deno.test("copyThenRename replaces an existing destination", async () => {
  await withDirs(async (src, dest) => {
    const from = join(src, "out.mp4");
    await Deno.writeTextFile(from, "new");
    await Deno.writeTextFile(join(dest, "final.mp4"), "old");
    await copyThenRename(from, join(dest, "final.mp4"));
    assertEquals(await Deno.readTextFile(join(dest, "final.mp4")), "new");
    assertEquals(await listDir(dest), ["final.mp4"]);
  });
});

Deno.test("copyThenRename works for a 250-byte final filename", async () => {
  await withDirs(async (src, dest) => {
    const from = join(src, "out.mp4");
    await Deno.writeTextFile(from, "payload");
    const longName = `${"a".repeat(246)}.mp4`;
    assertEquals(new TextEncoder().encode(longName).length, 250);
    await copyThenRename(from, join(dest, longName));
    assertEquals(await listDir(dest), [longName]);
  });
});

Deno.test("copyThenRename failure leaves the existing destination and no .part", async () => {
  await withDirs(async (src, dest) => {
    await Deno.writeTextFile(join(dest, "final.mp4"), "old");
    await assertRejects(() => copyThenRename(join(src, "vanished.mp4"), join(dest, "final.mp4")));
    assertEquals(await Deno.readTextFile(join(dest, "final.mp4")), "old");
    assertEquals(await listDir(dest), ["final.mp4"]);
  });
});

Deno.test("copyThenRename removes the staging file when the final rename fails", async () => {
  await withDirs(async (src, dest) => {
    const from = join(src, "out.mp4");
    await Deno.writeTextFile(from, "x");
    // Make the final rename fail by occupying the target with a non-empty directory.
    await Deno.mkdir(join(dest, "final.mp4"));
    await Deno.writeTextFile(join(dest, "final.mp4", "keep"), "k");
    await assertRejects(() => copyThenRename(from, join(dest, "final.mp4")));
    const names = await listDir(dest);
    assertEquals(names, ["final.mp4"]);
    assert(await pathExists(join(dest, "final.mp4", "keep")));
  });
});
```

- [ ] **Step 2: Create the skeleton** — `src/publish.ts`

The skeleton resolves without doing anything, so every test fails on its own assertion (missing file, or "Expected function to reject") rather than on a thrown placeholder.

```ts
export function isCrossDeviceError(_error: unknown): boolean {
  return false;
}

export function publishOutput(_src: string, _finalPath: string): Promise<void> {
  return Promise.resolve();
}

export function copyThenRename(_src: string, _finalPath: string): Promise<void> {
  return Promise.resolve();
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `deno task test tests/publish_test.ts`
Expected: all 9 tests FAIL — `isCrossDeviceError` returns false for EXDEV, the success-path tests hit `NotFound` / content mismatches on the destination, and the failure-path tests report `Expected function to reject`.

- [ ] **Step 4: Implement** — replace `src/publish.ts`

```ts
import { dirname, join } from "@std/path";
import { SESSION_ID } from "./session.ts";

/** Deno reports a cross-volume rename as an Error whose `code` is "EXDEV". */
export function isCrossDeviceError(error: unknown): boolean {
  return error instanceof Error && (error as Error & { code?: unknown }).code === "EXDEV";
}

/**
 * Moves the finished output into place. A same-volume rename is atomic.
 * Only a cross-device rename falls back to a staged copy; any other rename
 * error propagates so the caller can report a destination failure.
 */
export async function publishOutput(src: string, finalPath: string): Promise<void> {
  try {
    await Deno.rename(src, finalPath);
  } catch (error) {
    if (!isCrossDeviceError(error)) throw error;
    await copyThenRename(src, finalPath);
  }
}

/**
 * Copies into a fixed-length, session-tagged staging file in the destination
 * directory, verifies its size, then renames it over `finalPath` atomically.
 * On failure the staging file is removed and `finalPath` is left untouched.
 */
export async function copyThenRename(src: string, finalPath: string): Promise<void> {
  const part = join(dirname(finalPath), `.ffdl-${SESSION_ID}-${crypto.randomUUID()}.part`);
  try {
    await Deno.copyFile(src, part);
    const [source, staged] = await Promise.all([Deno.stat(src), Deno.stat(part)]);
    if (source.size !== staged.size) throw new Error("複製後檔案大小不一致");
    await Deno.rename(part, finalPath);
  } catch (error) {
    await Deno.remove(part).catch(() => {});
    throw error;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `deno task test tests/publish_test.ts`
Expected: `ok | 9 passed | 0 failed`.

- [ ] **Step 6: Verification gate** — `deno task check && deno task lint && deno fmt && deno fmt --check`

- [ ] **Step 7: Commit** — git-master: `src/publish.ts`, `tests/publish_test.ts`; message `feat: publish outputs atomically with cross-device copy fallback`.

---

### Task 10: Startup cleanup of stale artifacts

**Files:**
- Create: `src/cleanup.ts`
- Test: `tests/cleanup_test.ts`

- [ ] **Step 1: Write the failing test** — `tests/cleanup_test.ts`

```ts
import { assert, assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import { cleanupStaleArtifacts, systemTempRoot } from "../src/cleanup.ts";
import { SESSION_ID } from "../src/session.ts";
import { listDir, makeTempDir, pathExists } from "./helpers/fixtures.ts";

const OTHER = "11111111-2222-3333-4444-555555555555";

async function seed(tempRoot: string, outputDir: string): Promise<void> {
  await Deno.mkdir(join(tempRoot, `ffdl-${OTHER}-abc`));
  await Deno.writeTextFile(join(tempRoot, `ffdl-${OTHER}-abc`, "main.bin"), "x");
  await Deno.mkdir(join(tempRoot, `ffdl-${SESSION_ID}-mine`));
  await Deno.mkdir(join(tempRoot, "unrelated"));
  await Deno.writeTextFile(join(outputDir, `.ffdl-${OTHER}-abc.part`), "x");
  await Deno.writeTextFile(join(outputDir, `.ffdl-${SESSION_ID}-mine.part`), "x");
  await Deno.writeTextFile(join(outputDir, "video.mp4"), "x");
}

Deno.test("cleanupStaleArtifacts removes only other sessions' artifacts", async () => {
  const tempRoot = await makeTempDir();
  const outputDir = await makeTempDir();
  try {
    await seed(tempRoot, outputDir);
    await cleanupStaleArtifacts(tempRoot, outputDir);
    assertEquals(await listDir(tempRoot), [`ffdl-${SESSION_ID}-mine`, "unrelated"]);
    assertEquals(await listDir(outputDir), [`.ffdl-${SESSION_ID}-mine.part`, "video.mp4"]);
  } finally {
    await Deno.remove(tempRoot, { recursive: true });
    await Deno.remove(outputDir, { recursive: true });
  }
});

Deno.test("cleanupStaleArtifacts tolerates a missing output directory", async () => {
  const tempRoot = await makeTempDir();
  try {
    await Deno.mkdir(join(tempRoot, `ffdl-${OTHER}-abc`));
    await cleanupStaleArtifacts(tempRoot, join(tempRoot, "does-not-exist"));
    assertEquals(await listDir(tempRoot), []);
  } finally {
    await Deno.remove(tempRoot, { recursive: true });
  }
});

Deno.test("cleanupStaleArtifacts tolerates an unreadable output directory", async () => {
  const tempRoot = await makeTempDir();
  const outputDir = await makeTempDir();
  try {
    await Deno.mkdir(join(tempRoot, `ffdl-${OTHER}-abc`));
    await Deno.writeTextFile(join(outputDir, `.ffdl-${OTHER}-abc.part`), "x");
    await Deno.chmod(outputDir, 0o000);
    await cleanupStaleArtifacts(tempRoot, outputDir);
    assertEquals(await listDir(tempRoot), []);
  } finally {
    await Deno.chmod(outputDir, 0o755);
    await Deno.remove(tempRoot, { recursive: true });
    await Deno.remove(outputDir, { recursive: true });
  }
});

Deno.test("systemTempRoot is the parent of new temp dirs and leaves nothing behind", async () => {
  const root = await systemTempRoot();
  const probe = await Deno.makeTempDir();
  try {
    assertEquals(dirname(probe), root);
  } finally {
    await Deno.remove(probe);
  }
  const leftovers = (await listDir(root)).filter((name) => name.startsWith("tabripper-root-"));
  assertEquals(leftovers, []);
  assert(await pathExists(root));
});
```

- [ ] **Step 2: Create the skeleton** — `src/cleanup.ts`

```ts
export function systemTempRoot(): Promise<string> {
  return Promise.reject(new Error("not implemented"));
}

export function cleanupStaleArtifacts(_tempRoot: string, _outputDir: string): Promise<void> {
  return Promise.reject(new Error("not implemented"));
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `deno task test tests/cleanup_test.ts`
Expected: 4 tests FAIL with `Error: not implemented`.

- [ ] **Step 4: Implement** — replace `src/cleanup.ts`

```ts
import { dirname, join } from "@std/path";
import { SESSION_ID } from "./session.ts";

/** The OS temp root: parent of a freshly created temp dir. */
export async function systemTempRoot(): Promise<string> {
  const probe = await Deno.makeTempDir({ prefix: "tabripper-root-" });
  await Deno.remove(probe);
  return dirname(probe);
}

/**
 * Best-effort removal of artifacts left by earlier runs: `ffdl-*` temp dirs
 * and `.ffdl-*.part` staging files. Anything carrying the current SESSION_ID
 * is skipped. Never throws; failures are only logged.
 */
export async function cleanupStaleArtifacts(tempRoot: string, outputDir: string): Promise<void> {
  await removeMatching(
    tempRoot,
    (entry) => entry.isDirectory && entry.name.startsWith("ffdl-") && !entry.name.includes(SESSION_ID),
  );
  await removeMatching(
    outputDir,
    (entry) =>
      entry.isFile && entry.name.startsWith(".ffdl-") && entry.name.endsWith(".part") &&
      !entry.name.includes(SESSION_ID),
  );
}

async function removeMatching(dir: string, matches: (entry: Deno.DirEntry) => boolean): Promise<void> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!matches(entry)) continue;
      const path = join(dir, entry.name);
      try {
        await Deno.remove(path, { recursive: true });
      } catch (error) {
        console.warn(`[tab-ripper] cleanup could not remove ${path}: ${String(error)}`);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      console.warn(`[tab-ripper] cleanup could not read ${dir}: ${String(error)}`);
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `deno task test tests/cleanup_test.ts`
Expected: `ok | 4 passed | 0 failed` (warnings for the unreadable directory are printed and expected).

- [ ] **Step 6: Verification gate** — `deno task check && deno task lint && deno fmt && deno fmt --check`

- [ ] **Step 7: Commit** — git-master: `src/cleanup.ts`, `tests/cleanup_test.ts`; message `feat: clean up stale temp artifacts from earlier runs`.

---

### Task 11: Fake CDP server and CDP client

**Files:**
- Create: `tests/helpers/fake_cdp.ts`
- Create: `src/cdp/client.ts`
- Test: `tests/cdp_client_test.ts`

- [ ] **Step 1: Create the fake server helper** — `tests/helpers/fake_cdp.ts`

```ts
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

export type FakeHandler = (request: CdpRequest, connection: FakeConnection) => void;

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

  constructor(options: FakeCdpOptions = {}) {
    this.#server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen: () => {} },
      async (request) => {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return new Response("Not Found", { status: 404 });
        }
        this.upgradeRequests++;
        if (options.upgradeDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.upgradeDelayMs));
        }
        const { socket, response } = Deno.upgradeWebSocket(request);
        const connection: FakeConnection = {
          socket,
          send: (message) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
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
    await this.#server.shutdown();
  }
}

export function reply(connection: FakeConnection, request: CdpRequest, result: unknown): void {
  connection.send({ id: request.id, result, ...(request.sessionId ? { sessionId: request.sessionId } : {}) });
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
export function replyException(connection: FakeConnection, request: CdpRequest, message: string): void {
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
```

- [ ] **Step 2: Write the failing test** — `tests/cdp_client_test.ts`

```ts
import { assert, assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import {
  CdpClient,
  CdpClosedError,
  CdpConnectError,
  CdpError,
  CdpSessionClosedError,
  CdpTimeoutError,
} from "../src/cdp/client.ts";
import { type CdpRequest, FakeCdpServer, reply, replyError } from "./helpers/fake_cdp.ts";
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
      const [a, b] = await Promise.all([client.send("A.one"), client.send("A.two")]);
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
        connection.send({ method: "Page.ping", params: { n: 1 }, sessionId: "S1" });
      },
    });
    const client = await CdpClient.connect(server.wsUrl);
    try {
      const events: { params: unknown; sessionId?: string }[] = [];
      const off = client.on("Page.ping", (params, sessionId) => events.push({ params, sessionId }));
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
      handler: (request, connection) => replyError(connection, request, -32000, "No target"),
    });
    const client = await CdpClient.connect(server.wsUrl);
    try {
      const error = await assertRejects(() => client.send("Target.attachToTarget"), CdpError, "No target");
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
      handler: (request, connection) => pending.push(() => reply(connection, request, { late: true })),
    });
    const client = await CdpClient.connect(server.wsUrl);
    try {
      await assertRejects(() => client.send("Slow.call", {}, undefined, { timeoutMs: 100 }), CdpTimeoutError);
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
  name: "CdpClient fails a session's pending requests on Target.detachedFromTarget",
  ...opts,
  fn: async () => {
    const server = new FakeCdpServer({
      handler: (request, connection) => {
        if (request.method === "Other.call") reply(connection, request, { ok: true });
      },
    });
    const client = await CdpClient.connect(server.wsUrl);
    try {
      const doomed = client.send("Runtime.evaluate", {}, "S-dead", { timeoutMs: 60_000 });
      await waitFor(() => server.requests.length === 1, "request");
      const start = Date.now();
      server.connections[0].send({ method: "Target.detachedFromTarget", params: { sessionId: "S-dead" } });
      const error = await assertRejects(() => doomed, CdpSessionClosedError);
      assertInstanceOf(error, CdpSessionClosedError);
      assert(Date.now() - start < 1000);
      await assertRejects(() => client.send("Runtime.evaluate", {}, "S-dead"), CdpSessionClosedError);
      assertEquals(await client.send("Other.call", {}, "S-alive"), { ok: true });
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
      await assertRejects(() => CdpClient.connect(server.wsUrl, { timeoutMs: 200 }), CdpConnectError, "逾時");
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
    await assertRejects(() => CdpClient.connect(`ws://127.0.0.1:${port}/devtools/browser`), CdpConnectError);
  },
});
```

`sanitizeOps`/`sanitizeResources` are disabled in WebSocket tests because socket close handshakes complete asynchronously after the test body.

- [ ] **Step 3: Create the skeleton** — `src/cdp/client.ts`

```ts
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

export class CdpClient {
  readonly closed: Promise<void> = Promise.resolve();

  static connect(_url: string, _opts: { timeoutMs?: number } = {}): Promise<CdpClient> {
    return Promise.reject(new Error("not implemented"));
  }

  send<T = unknown>(
    _method: string,
    _params: Record<string, unknown> = {},
    _sessionId?: string,
    _opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    return Promise.reject(new Error("not implemented"));
  }

  on(_method: string, _handler: CdpEventHandler): () => void {
    throw new Error("not implemented");
  }

  close(): void {
    throw new Error("not implemented");
  }
}
```

- [ ] **Step 4: Run test to verify it fails**

Run: `deno task test tests/cdp_client_test.ts`
Expected: 9 tests FAIL — `connect` rejects with `not implemented` (and the error-class assertions fail because the error is not a `CdpConnectError`).

- [ ] **Step 5: Implement** — replace the `CdpClient` class (keep the error classes and `CdpEventHandler`)

```ts
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: number;
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
  static connect(url: string, opts: { timeoutMs?: number } = {}): Promise<CdpClient> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (error) {
        reject(new CdpConnectError(error instanceof Error ? error.message : String(error)));
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
        settle(() => reject(new CdpConnectError((event as ErrorEvent).message || "WebSocket 連線失敗")));
      ws.onclose = (event) => settle(() => reject(new CdpConnectError(`連線被關閉（${event.code}）`)));
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
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, sessionId });
      try {
        this.#ws.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }));
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
        pending.reject(new CdpError(message.error.code ?? 0, message.error.message ?? "CDP error"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string") return;
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
    if (message.method === "Target.detachedFromTarget") {
      const detached = (message.params as { sessionId?: unknown } | undefined)?.sessionId;
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
```

- [ ] **Step 6: Run test to verify it passes**

Run: `deno task test tests/cdp_client_test.ts`
Expected: `ok | 9 passed | 0 failed`.

- [ ] **Step 7: Verification gate** — `deno task check && deno task lint && deno fmt && deno fmt --check`

- [ ] **Step 8: Commit** — git-master: `tests/helpers/fake_cdp.ts`, `src/cdp/client.ts`, `tests/cdp_client_test.ts`; message `feat: add minimal CDP client with session-aware failure handling`.

---

### Task 12: Tab listing and stateless URL pattern

**Files:**
- Create: `src/tabs.ts`
- Test: `tests/tabs_test.ts`

- [ ] **Step 1: Write the failing test** — `tests/tabs_test.ts`

```ts
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
  assertEquals([re.test("example"), re.test("example"), re.test("example")], [true, true, true]);
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
            { targetId: "1", type: "page", title: "A", url: "https://example.com/a", attached: false },
            { targetId: "2", type: "service_worker", title: "SW", url: "https://example.com/sw.js" },
            { targetId: "3", type: "page", title: "Other", url: "https://other.com/" },
            { targetId: "4", type: "page", title: "B", url: "https://example.com/b" },
            { targetId: "5", type: "iframe", title: "F", url: "https://example.com/frame" },
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
```

- [ ] **Step 2: Create the skeleton** — `src/tabs.ts`

```ts
import type { CdpClient } from "./cdp/client.ts";
import type { TabInfo } from "./types.ts";

export function statelessPattern(_pattern: RegExp): RegExp {
  throw new Error("not implemented");
}

export function listTabs(_client: CdpClient, _pattern: RegExp): Promise<TabInfo[]> {
  return Promise.reject(new Error("not implemented"));
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `deno task test tests/tabs_test.ts`
Expected: 3 tests FAIL with `Error: not implemented`.

- [ ] **Step 4: Implement** — replace `src/tabs.ts`

```ts
import type { CdpClient } from "./cdp/client.ts";
import type { TabInfo } from "./types.ts";

/** A copy without g/y so `test()` never depends on lastIndex. */
export function statelessPattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.replace("g", "").replace("y", ""));
}

interface RawTargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
}

/** Page targets whose URL matches `pattern`, in CDP order. */
export async function listTabs(client: CdpClient, pattern: RegExp): Promise<TabInfo[]> {
  const re = statelessPattern(pattern);
  const { targetInfos } = await client.send<{ targetInfos: RawTargetInfo[] }>("Target.getTargets");
  return targetInfos
    .filter((target) => target.type === "page" && re.test(target.url))
    .map(({ targetId, title, url }) => ({ targetId, title, url }));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `deno task test tests/tabs_test.ts`
Expected: `ok | 3 passed | 0 failed`.

- [ ] **Step 6: Verification gate** — `deno task check && deno task lint && deno fmt && deno fmt --check`

- [ ] **Step 7: Commit** — git-master: `src/tabs.ts`, `tests/tabs_test.ts`; message `feat: list page tabs filtered by URL pattern`.

---

### Task 13: Page-side expressions (wrapper and chunk reader)

**Files:**
- Create: `src/extract.ts`
- Test: `tests/extract_expressions_test.ts`

The expressions are executed in tests by binding `window` and `location` as parameters of `new Function` (verified locally: `deno lint` accepts `new Function`, and Deno provides `Uint8Array.prototype.toBase64`, `Blob` and `FileReader`).

- [ ] **Step 1: Write the failing test** — `tests/extract_expressions_test.ts`

```ts
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { decodeBase64 } from "../src/base64.ts";
import { buildReadExpression, buildWrapperExpression } from "../src/extract.ts";

interface PageEntry {
  main: Uint8Array;
  aux: Uint8Array;
}
type FakeWindow = Record<string, unknown> & { __ffdl?: Record<string, PageEntry> };

function evaluateInPage(expression: string, window: FakeWindow, href: string): Promise<unknown> {
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
  assertStringIncludes(expression, 'new RegExp(' + JSON.stringify(PATTERN.source) + ', "i")');
});

Deno.test("wrapper stores the buffers under its token on a fresh page", async () => {
  const window: FakeWindow = {};
  const result = await evaluateInPage(buildWrapperExpression("T", PATTERN, SCRIPT), window, HREF);
  assertEquals(result, { info: { title: "Clip", n: 1, ok: true }, sizes: { main: 3, aux: 1 } });
  assertEquals(window.__ffdl?.T.main, new Uint8Array([1, 2, 3]));
  assertEquals(window.__ffdl?.T.aux, new Uint8Array([9]));
});

Deno.test("wrapper refuses to run the script when the URL no longer matches", async () => {
  const window: FakeWindow = {};
  await assertRejects(
    () => evaluateInPage(buildWrapperExpression("T", PATTERN, SCRIPT), window, "https://other.com/"),
    Error,
    "分頁網址已變更為 https://other.com/，不符合網址規則，請重新選擇分頁",
  );
  assertEquals(window.calls, undefined);
  assertEquals(window.__ffdl, undefined);
});

Deno.test("two extractions on one page keep separate token slots", async () => {
  const window: FakeWindow = {};
  const second = `async () => ({ main: new Uint8Array([7]), aux: new Uint8Array([8]), info: {} })`;
  await evaluateInPage(buildWrapperExpression("A", PATTERN, SCRIPT), window, HREF);
  await evaluateInPage(buildWrapperExpression("B", PATTERN, second), window, HREF);
  assertEquals(window.__ffdl?.A.main, new Uint8Array([1, 2, 3]));
  assertEquals(window.__ffdl?.B.main, new Uint8Array([7]));
});

Deno.test("wrapper accepts ArrayBufferView with a byte offset", async () => {
  const window: FakeWindow = {};
  const script = `async () => {
    const buffer = new Uint8Array([0, 0, 5, 6, 7, 0]).buffer;
    return { main: new Uint8Array(buffer, 2, 3), aux: new DataView(buffer, 0, 2), info: {} };
  }`;
  const result = await evaluateInPage(buildWrapperExpression("T", PATTERN, script), window, HREF);
  assertEquals(result, { info: {}, sizes: { main: 3, aux: 2 } });
  assertEquals(window.__ffdl?.T.main, new Uint8Array([5, 6, 7]));
});

Deno.test("wrapper validates the script result", async () => {
  const cases: [string, string][] = [
    [`async () => ({ main: "x", aux: new Uint8Array(), info: {} })`, "main 必須是 ArrayBuffer 或 ArrayBufferView"],
    [`async () => ({ main: new Uint8Array(), aux: null, info: {} })`, "aux 必須是 ArrayBuffer 或 ArrayBufferView"],
    [`async () => ({ main: new Uint8Array(), aux: new Uint8Array(), info: [] })`, "info 必須是純物件"],
    [`async () => ({ main: new Uint8Array(), aux: new Uint8Array(), info: { x: {} } })`, "info.x 的值只能是"],
    [`async () => null`, "頁面腳本必須回傳 { main, aux, info } 物件"],
  ];
  for (const [script, message] of cases) {
    await assertRejects(
      () => evaluateInPage(buildWrapperExpression("T", PATTERN, script), {}, HREF),
      Error,
      message,
    );
  }
});

Deno.test("read expression returns the requested slice as base64", async () => {
  const window: FakeWindow = {};
  await evaluateInPage(buildWrapperExpression("T", PATTERN, SCRIPT), window, HREF);
  const expression = buildReadExpression("T", "main", 1, 2);
  assert(expression.startsWith('/*ffdl-read:{"token":"T","name":"main","offset":1,"length":2}*/'));
  const encoded = await evaluateInPage(expression, window, HREF);
  assertEquals(decodeBase64(encoded as string), new Uint8Array([2, 3]));
});

Deno.test("read expression only reads its own token", async () => {
  const window: FakeWindow = {};
  await evaluateInPage(buildWrapperExpression("A", PATTERN, SCRIPT), window, HREF);
  await assertRejects(
    () => evaluateInPage(buildReadExpression("B", "main", 0, 1), window, HREF),
    Error,
    "FFDL_MISSING",
  );
});

Deno.test("read expression falls back to FileReader without toBase64", async () => {
  const window: FakeWindow = {};
  await evaluateInPage(buildWrapperExpression("T", PATTERN, SCRIPT), window, HREF);
  const proto = Uint8Array.prototype as unknown as Record<string, unknown>;
  const original = proto.toBase64;
  delete proto.toBase64;
  try {
    const encoded = await evaluateInPage(buildReadExpression("T", "main", 0, 3), window, HREF);
    assertEquals(decodeBase64(encoded as string), new Uint8Array([1, 2, 3]));
  } finally {
    proto.toBase64 = original;
  }
});
```

- [ ] **Step 2: Create the skeleton** — `src/extract.ts`

The skeleton returns empty expressions, so `return ;` evaluates to `undefined` and every test fails on its assertions.

```ts
export function buildWrapperExpression(_token: string, _pattern: RegExp, _scriptSource: string): string {
  return "";
}

export function buildReadExpression(
  _token: string,
  _name: "main" | "aux",
  _offset: number,
  _length: number,
): string {
  return "";
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `deno task test tests/extract_expressions_test.ts`
Expected: 9 tests FAIL on assertions (marker missing, result `undefined`, `Expected function to reject`).

- [ ] **Step 4: Implement** — replace `src/extract.ts`

```ts
import { statelessPattern } from "./tabs.ts";

/**
 * Expression evaluated in the tab. It checks the page URL
 * against the URL pattern BEFORE running the user script, validates the
 * result, stores both buffers under `window.__ffdl[token]` and returns only
 * the info and sizes. The leading comment carries metadata for test fakes.
 */
export function buildWrapperExpression(token: string, pattern: RegExp, scriptSource: string): string {
  const re = statelessPattern(pattern);
  return `/*ffdl-wrapper:${JSON.stringify({ token })}*/(async () => {
  const token = ${JSON.stringify(token)};
  const pattern = new RegExp(${JSON.stringify(re.source)}, ${JSON.stringify(re.flags)});
  if (!pattern.test(location.href)) {
    throw new Error("分頁網址已變更為 " + location.href + "，不符合網址規則，請重新選擇分頁");
  }
  window.__ffdl ??= {};
  const result = await (${scriptSource})();
  if (result === null || typeof result !== "object") {
    throw new Error("頁面腳本必須回傳 { main, aux, info } 物件");
  }
  const toBytes = (value, name) => {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new Error(name + " 必須是 ArrayBuffer 或 ArrayBufferView");
  };
  const main = toBytes(result.main, "main");
  const aux = toBytes(result.aux, "aux");
  const info = result.info;
  if (info === null || typeof info !== "object" || Array.isArray(info) ||
      Object.getPrototypeOf(info) !== Object.prototype) {
    throw new Error("info 必須是純物件");
  }
  for (const [key, value] of Object.entries(info)) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error("info." + key + " 的值只能是 string、number 或 boolean");
    }
  }
  window.__ffdl[token] = { main, aux };
  return { info, sizes: { main: main.byteLength, aux: aux.byteLength } };
})()`;
}

/** Returns `[offset, offset + length)` of a stored buffer as base64. */
export function buildReadExpression(
  token: string,
  name: "main" | "aux",
  offset: number,
  length: number,
): string {
  const meta = JSON.stringify({ token, name, offset, length });
  return `/*ffdl-read:${meta}*/(async () => {
  const entry = window.__ffdl?.[${JSON.stringify(token)}];
  if (!entry) throw new Error("FFDL_MISSING");
  const slice = entry[${JSON.stringify(name)}].subarray(${offset}, ${offset + length});
  if (typeof slice.toBase64 === "function") return slice.toBase64();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([slice]));
  });
})()`;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `deno task test tests/extract_expressions_test.ts`
Expected: `ok | 9 passed | 0 failed`.

- [ ] **Step 6: Verification gate** — `deno task check && deno task lint && deno fmt && deno fmt --check`

- [ ] **Step 7: Commit** — git-master: `src/extract.ts`, `tests/extract_expressions_test.ts`; message `feat: build page-side wrapper and chunk-read expressions`.

---

### Task 14: `extractFromTab` with a fake page

**Files:**
- Create: `tests/helpers/fake_page.ts`
- Modify: `src/extract.ts` (add imports at the top and `extractFromTab` + helpers at the bottom)
- Test: `tests/extract_test.ts`

- [ ] **Step 1: Create the fake page helper** — `tests/helpers/fake_page.ts`

```ts
import { encodeBase64 } from "../../src/base64.ts";
import { type CdpRequest, type FakeConnection, reply, replyException } from "./fake_cdp.ts";

export interface FakeTarget {
  targetId: string;
  type: string;
  title: string;
  url: string;
}

export interface FakePageOptions {
  main?: Uint8Array;
  aux?: Uint8Array;
  info?: Record<string, unknown>;
  targets?: FakeTarget[];
  /** Never answer Runtime.evaluate (a discarded tab). */
  dormant?: boolean;
  /** Answer the wrapper with a page exception carrying this message. */
  wrapperException?: string;
  /** Never answer the wrapper. */
  hangWrapper?: boolean;
  /** Emit Target.detachedFromTarget instead of answering the wrapper. */
  detachDuringWrapper?: boolean;
  /** Close the socket when the wrapper arrives. */
  closeDuringWrapper?: boolean;
  /** Answer the wrapper but lose the stored data (page reloaded). */
  dropDataAfterWrapper?: boolean;
  /** Emit Target.detachedFromTarget right after answering the last chunk read. */
  detachAfterLastRead?: boolean;
  /** Close the socket right after answering the last chunk read. */
  closeAfterLastRead?: boolean;
  /** Close the socket instead of answering Target.detachFromTarget. */
  closeOnDetach?: boolean;
}

export interface FakePage {
  handler: (request: CdpRequest, connection: FakeConnection) => void;
  wrapperTokens: string[];
  readTokens: string[];
}

export const DEFAULT_TARGETS: FakeTarget[] = [
  { targetId: "T1", type: "page", title: "Clip page", url: "https://example.com/watch/1" },
  { targetId: "T2", type: "page", title: "Elsewhere", url: "https://other.com/" },
];

export function fakePage(options: FakePageOptions = {}): FakePage {
  const main = options.main ?? new Uint8Array([1, 2, 3]);
  const aux = options.aux ?? new Uint8Array([9]);
  const info = options.info ?? { title: "Clip" };
  const store = new Map<string, { main: Uint8Array; aux: Uint8Array }>();
  const page: FakePage = { wrapperTokens: [], readTokens: [], handler: () => {} };
  let attachCount = 0;

  page.handler = (request, connection) => {
    switch (request.method) {
      case "Target.getTargets":
        reply(connection, request, { targetInfos: options.targets ?? DEFAULT_TARGETS });
        return;
      case "Target.attachToTarget":
        // A fresh session per attach, like a real browser.
        attachCount++;
        reply(connection, request, { sessionId: `session-${String(request.params.targetId)}-${attachCount}` });
        return;
      case "Target.detachFromTarget":
        if (options.closeOnDetach) {
          connection.close();
          return;
        }
        reply(connection, request, {});
        connection.send({ method: "Target.detachedFromTarget", params: { sessionId: request.params.sessionId } });
        return;
      case "Runtime.evaluate":
        break;
      default:
        reply(connection, request, {});
        return;
    }
    if (options.dormant) return;
    const expression = String(request.params.expression);
    if (expression === "1") {
      reply(connection, request, { result: { type: "number", value: 1, description: "1" } });
      return;
    }
    const wrapper = /^\/\*ffdl-wrapper:(.*?)\*\//.exec(expression);
    if (wrapper) {
      const { token } = JSON.parse(wrapper[1]) as { token: string };
      page.wrapperTokens.push(token);
      if (options.hangWrapper) return;
      if (options.closeDuringWrapper) {
        connection.close();
        return;
      }
      if (options.detachDuringWrapper) {
        connection.send({ method: "Target.detachedFromTarget", params: { sessionId: request.sessionId } });
        return;
      }
      if (options.wrapperException) {
        replyException(connection, request, options.wrapperException);
        return;
      }
      if (!options.dropDataAfterWrapper) store.set(token, { main, aux });
      reply(connection, request, {
        result: { type: "object", value: { info, sizes: { main: main.length, aux: aux.length } } },
      });
      return;
    }
    const read = /^\/\*ffdl-read:(.*?)\*\//.exec(expression);
    if (read) {
      const { token, name, offset, length } = JSON.parse(read[1]) as {
        token: string;
        name: "main" | "aux";
        offset: number;
        length: number;
      };
      page.readTokens.push(token);
      const entry = store.get(token);
      if (!entry) {
        replyException(connection, request, "FFDL_MISSING");
        return;
      }
      reply(connection, request, {
        result: { type: "string", value: encodeBase64(entry[name].subarray(offset, offset + length)) },
      });
      const isLastRead = name === "aux"
        ? offset + length >= aux.length
        : (aux.length === 0 && offset + length >= main.length);
      if (isLastRead && options.detachAfterLastRead) {
        connection.send({ method: "Target.detachedFromTarget", params: { sessionId: request.sessionId } });
      }
      if (isLastRead && options.closeAfterLastRead) connection.close();
      return;
    }
    reply(connection, request, { result: { type: "undefined" } });
  };
  return page;
}
```

- [ ] **Step 2: Write the failing test** — `tests/extract_test.ts`

```ts
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { CdpClient } from "../src/cdp/client.ts";
import { CHUNK_SIZE, ExtractError, extractFromTab } from "../src/extract.ts";
import { FakeCdpServer } from "./helpers/fake_cdp.ts";
import { type FakePage, fakePage, type FakePageOptions } from "./helpers/fake_page.ts";
import { makeTempDir } from "./helpers/fixtures.ts";

const opts = { sanitizeOps: false, sanitizeResources: false };

interface Harness {
  page: FakePage;
  server: FakeCdpServer;
  client: CdpClient;
  dir: string;
  dispose(): Promise<void>;
}

async function harness(options: FakePageOptions = {}): Promise<Harness> {
  const page = fakePage(options);
  const server = new FakeCdpServer({ handler: page.handler });
  const client = await CdpClient.connect(server.wsUrl);
  const dir = await makeTempDir();
  return {
    page,
    server,
    client,
    dir,
    async dispose() {
      client.close();
      await server.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

function patternBytes(length: number): Uint8Array {
  return new Uint8Array(length).map((_, i) => (i * 7) & 255);
}

Deno.test({
  name: "extractFromTab writes multi-chunk and empty files and reports progress",
  ...opts,
  fn: async () => {
    const main = patternBytes(CHUNK_SIZE * 2 + 123);
    const h = await harness({ main, aux: new Uint8Array(), info: { title: "Clip", n: 2 } });
    try {
      const progress: [number, number][] = [];
      const result = await extractFromTab(h.client, "T1", h.dir, (r, t) => progress.push([r, t]));
      assertEquals(result, {
        info: { title: "Clip", n: 2 },
        mainPath: join(h.dir, "main.bin"),
        auxPath: join(h.dir, "aux.bin"),
        mainSize: main.length,
        auxSize: 0,
      });
      assertEquals(await Deno.readFile(result.mainPath), main);
      assertEquals(await Deno.readFile(result.auxPath), new Uint8Array());
      assertEquals(progress[progress.length - 1], [main.length, main.length]);
      assertEquals(h.page.readTokens.length, 3);
    } finally {
      await h.dispose();
    }
  },
});

Deno.test({
  name: "extractFromTab surfaces a page exception message",
  ...opts,
  fn: async () => {
    const h = await harness({ wrapperException: "boom" });
    try {
      await assertRejects(() => extractFromTab(h.client, "T1", h.dir, () => {}), ExtractError, "boom");
    } finally {
      await h.dispose();
    }
  },
});

Deno.test({
  name: "extractFromTab reports the exception description unchanged",
  ...opts,
  fn: async () => {
    const h = await harness({ wrapperException: "line one\nline two" });
    try {
      const error = await assertRejects(() => extractFromTab(h.client, "T1", h.dir, () => {}), ExtractError);
      assertEquals((error as Error).message, "Error: line one\nline two\n    at <anonymous>:1:1");
    } finally {
      await h.dispose();
    }
  },
});

Deno.test({
  name: "extractFromTab fails when the tab detaches after the last chunk",
  ...opts,
  fn: async () => {
    const h = await harness({ detachAfterLastRead: true });
    try {
      await assertRejects(
        () => extractFromTab(h.client, "T1", h.dir, () => {}),
        ExtractError,
        "分頁已關閉或已中斷偵錯連線",
      );
    } finally {
      await h.dispose();
    }
  },
});

Deno.test({
  name: "extractFromTab fails when the connection drops after the last chunk",
  ...opts,
  fn: async () => {
    const h = await harness({ closeAfterLastRead: true });
    try {
      await assertRejects(
        () => extractFromTab(h.client, "T1", h.dir, () => {}),
        ExtractError,
        "與瀏覽器的連線已中斷",
      );
    } finally {
      await h.dispose();
    }
  },
});

Deno.test({
  name: "extractFromTab fails when the connection drops while detaching",
  ...opts,
  fn: async () => {
    const h = await harness({ closeOnDetach: true });
    try {
      await assertRejects(
        () => extractFromTab(h.client, "T1", h.dir, () => {}),
        ExtractError,
        "與瀏覽器的連線已中斷",
      );
    } finally {
      await h.dispose();
    }
  },
});

Deno.test({
  name: "extractFromTab reports a changed page URL",
  ...opts,
  fn: async () => {
    const h = await harness({
      wrapperException: "分頁網址已變更為 https://other.com/，不符合網址規則，請重新選擇分頁",
    });
    try {
      await assertRejects(
        () => extractFromTab(h.client, "T1", h.dir, () => {}),
        ExtractError,
        "分頁網址已變更為 https://other.com/",
      );
    } finally {
      await h.dispose();
    }
  },
});

Deno.test({
  name: "extractFromTab fails fast on a dormant tab without sending the script",
  ...opts,
  fn: async () => {
    const h = await harness({ dormant: true });
    try {
      const start = Date.now();
      await assertRejects(
        () => extractFromTab(h.client, "T1", h.dir, () => {}),
        ExtractError,
        "分頁尚未載入（可能被瀏覽器休眠），請先在瀏覽器點開該分頁後再試一次",
      );
      assert(Date.now() - start < 7000);
      assertEquals(h.page.wrapperTokens.length, 0);
    } finally {
      await h.dispose();
    }
  },
});

Deno.test({
  name: "extractFromTab ends within 1s when the tab detaches during the script",
  ...opts,
  fn: async () => {
    const h = await harness({ detachDuringWrapper: true });
    try {
      const start = Date.now();
      await assertRejects(
        () => extractFromTab(h.client, "T1", h.dir, () => {}),
        ExtractError,
        "分頁已關閉或已中斷偵錯連線",
      );
      assert(Date.now() - start < 1000);
      assertEquals(h.server.requests.some((r) => r.method === "Target.detachFromTarget"), false);
    } finally {
      await h.dispose();
    }
  },
});

Deno.test({
  name: "extractFromTab reports lost page data",
  ...opts,
  fn: async () => {
    const h = await harness({ dropDataAfterWrapper: true });
    try {
      await assertRejects(
        () => extractFromTab(h.client, "T1", h.dir, () => {}),
        ExtractError,
        "頁面資料遺失，分頁可能已重新載入",
      );
    } finally {
      await h.dispose();
    }
  },
});

Deno.test({
  name: "extractFromTab reports a dropped browser connection",
  ...opts,
  fn: async () => {
    const h = await harness({ closeDuringWrapper: true });
    try {
      await assertRejects(
        () => extractFromTab(h.client, "T1", h.dir, () => {}),
        ExtractError,
        "與瀏覽器的連線已中斷",
      );
    } finally {
      await h.dispose();
    }
  },
});

Deno.test({
  name: "extractFromTab uses a fresh token per run and sends no page cleanup",
  ...opts,
  fn: async () => {
    const h = await harness();
    try {
      await extractFromTab(h.client, "T1", h.dir, () => {});
      await extractFromTab(h.client, "T1", h.dir, () => {});
      const [first, second] = h.page.wrapperTokens;
      assert(first !== second);
      assertEquals(h.page.readTokens, [first, first, second, second]);
      const evaluates = h.server.requests.filter((r) => r.method === "Runtime.evaluate");
      for (const request of evaluates) {
        const expression = String(request.params.expression);
        assert(
          expression === "1" || expression.startsWith("/*ffdl-wrapper:") || expression.startsWith("/*ffdl-read:"),
          `unexpected page expression: ${expression.slice(0, 40)}`,
        );
      }
      assertEquals(h.server.requests[h.server.requests.length - 1].method, "Target.detachFromTarget");
    } finally {
      await h.dispose();
    }
  },
});
```

- [ ] **Step 3: Add the skeleton** — in `src/extract.ts` add these imports at the top and this code at the bottom

```ts
import type { CdpClient } from "./cdp/client.ts";
import type { ExtractResult } from "./types.ts";
```

```ts
export const CHUNK_SIZE = 4 * 1024 * 1024;

export class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractError";
  }
}

export function extractFromTab(
  _client: CdpClient,
  _targetId: string,
  _tempDir: string,
  _onProgress: (received: number, total: number) => void,
): Promise<ExtractResult> {
  return Promise.reject(new Error("not implemented"));
}
```

- [ ] **Step 4: Run test to verify it fails**

Run: `deno task test tests/extract_test.ts`
Expected: 12 tests FAIL — the success test with `not implemented`, the others because the rejection is an `Error`, not an `ExtractError` with the expected message.

- [ ] **Step 5: Implement** — replace the `src/extract.ts` import block with:

```ts
import { join } from "@std/path";
import { URL_PATTERN } from "../user/config.ts";
import pageScript from "../user/page-script.js";
import { decodeBase64 } from "./base64.ts";
import { type CdpClient, CdpClosedError, CdpSessionClosedError, CdpTimeoutError } from "./cdp/client.ts";
import { statelessPattern } from "./tabs.ts";
import type { ExtractResult, Info } from "./types.ts";
```

and replace the skeleton `extractFromTab` (keep `CHUNK_SIZE` and `ExtractError`) with:

```ts
const LIVENESS_TIMEOUT_MS = 3_000;
const SCRIPT_TIMEOUT_MS = 300_000;
const READ_TIMEOUT_MS = 60_000;
const DETACH_TIMEOUT_MS = 3_000;
const MISSING_DATA = "FFDL_MISSING";

/** An exception thrown inside the page; message is its full CDP description. */
class PageException extends Error {}

interface EvaluateResponse {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

interface WrapperResult {
  info: Info;
  sizes: { main: number; aux: number };
}

async function evaluate(
  client: CdpClient,
  sessionId: string,
  expression: string,
  timeoutMs: number,
): Promise<unknown> {
  const response = await client.send<EvaluateResponse>(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
    { timeoutMs },
  );
  const details = response.exceptionDetails;
  if (details) {
    // The exception description as-is (message and stack), falling back to text.
    throw new PageException(details.exception?.description ?? details.text ?? "頁面腳本發生錯誤");
  }
  return response.result?.value;
}

function isWrapperResult(value: unknown): value is WrapperResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { info?: unknown; sizes?: { main?: unknown; aux?: unknown } };
  const info = candidate.info;
  if (typeof info !== "object" || info === null || Array.isArray(info)) return false;
  const leafOk = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
  if (!Object.values(info).every(leafOk)) return false;
  const sizeOk = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0;
  return typeof candidate.sizes === "object" && candidate.sizes !== null &&
    sizeOk(candidate.sizes.main) && sizeOk(candidate.sizes.aux);
}

async function writeAll(file: Deno.FsFile, bytes: Uint8Array): Promise<void> {
  let written = 0;
  while (written < bytes.length) written += await file.write(bytes.subarray(written));
}

function toExtractError(error: unknown, detached: boolean): ExtractError {
  if (error instanceof ExtractError) return error;
  if (detached || error instanceof CdpSessionClosedError) return new ExtractError("分頁已關閉或已中斷偵錯連線");
  if (error instanceof CdpClosedError) return new ExtractError("與瀏覽器的連線已中斷");
  return new ExtractError(error instanceof Error ? error.message : String(error));
}

/** Attach, liveness check, run the wrapper, pull both files in 4 MiB chunks. */
export async function extractFromTab(
  client: CdpClient,
  targetId: string,
  tempDir: string,
  onProgress: (received: number, total: number) => void,
): Promise<ExtractResult> {
  let sessionId: string;
  try {
    ({ sessionId } = await client.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }));
  } catch (error) {
    throw toExtractError(error, false);
  }
  let detached = false;
  let connectionLost = false;
  const stopListening = client.on("Target.detachedFromTarget", (params) => {
    if ((params as { sessionId?: string } | undefined)?.sessionId === sessionId) detached = true;
  });
  void client.closed.then(() => {
    connectionLost = true;
  });
  let result!: ExtractResult;
  try {
    try {
      await evaluate(client, sessionId, "1", LIVENESS_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof CdpTimeoutError) {
        throw new ExtractError("分頁尚未載入（可能被瀏覽器休眠），請先在瀏覽器點開該分頁後再試一次");
      }
      throw error;
    }

    const token = crypto.randomUUID();
    const head = await evaluate(
      client,
      sessionId,
      buildWrapperExpression(token, URL_PATTERN, pageScript.toString()),
      SCRIPT_TIMEOUT_MS,
    );
    if (!isWrapperResult(head)) throw new ExtractError("頁面腳本回傳的資料格式不正確");

    const mainPath = join(tempDir, "main.bin");
    const auxPath = join(tempDir, "aux.bin");
    const total = head.sizes.main + head.sizes.aux;
    let received = 0;
    onProgress(0, total);
    const parts = [["main", mainPath, head.sizes.main], ["aux", auxPath, head.sizes.aux]] as const;
    for (const [name, path, size] of parts) {
      const file = await Deno.open(path, { write: true, create: true, truncate: true });
      try {
        for (let offset = 0; offset < size; offset += CHUNK_SIZE) {
          const length = Math.min(CHUNK_SIZE, size - offset);
          let encoded: unknown;
          try {
            encoded = await evaluate(
              client,
              sessionId,
              buildReadExpression(token, name, offset, length),
              READ_TIMEOUT_MS,
            );
          } catch (error) {
            if (error instanceof PageException && error.message.includes(MISSING_DATA)) {
              throw new ExtractError("頁面資料遺失，分頁可能已重新載入");
            }
            throw error;
          }
          if (typeof encoded !== "string") throw new ExtractError("讀取資料失敗：回傳格式不正確");
          const bytes = decodeBase64(encoded);
          if (bytes.length !== length) throw new ExtractError("讀取資料失敗：區塊大小不符");
          await writeAll(file, bytes);
          received += bytes.length;
          onProgress(received, total);
        }
      } finally {
        file.close();
      }
      if ((await Deno.stat(path)).size !== size) throw new ExtractError(`${name} 檔案大小不符`);
    }
    // An interruption during the final local writes must still fail the job.
    if (detached) throw new ExtractError("分頁已關閉或已中斷偵錯連線");
    if (connectionLost) throw new ExtractError("與瀏覽器的連線已中斷");
    result = { info: head.info, mainPath, auxPath, mainSize: head.sizes.main, auxSize: head.sizes.aux };
  } catch (error) {
    throw toExtractError(error, detached);
  } finally {
    stopListening();
    // No page-side cleanup by design; only detach, bounded to 3 s.
    if (!detached) {
      await client.send("Target.detachFromTarget", { sessionId }, undefined, { timeoutMs: DETACH_TIMEOUT_MS })
        .catch((error) => {
          if (error instanceof CdpClosedError) connectionLost = true;
        });
    }
  }
  // Re-checked after the detach await: a disconnect during it still fails.
  if (connectionLost) throw new ExtractError("與瀏覽器的連線已中斷");
  return result;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `deno task test tests/extract_test.ts tests/extract_expressions_test.ts`
Expected: `ok | 21 passed | 0 failed`.

- [ ] **Step 7: Verification gate** — `deno task check && deno task lint && deno fmt && deno fmt --check`

- [ ] **Step 8: Commit** — git-master: `tests/helpers/fake_page.ts`, `src/extract.ts`, `tests/extract_test.ts`; message `feat: extract files from a tab in base64 chunks`.

---

### Task 15: `JobManager` — settings, status and the browser connection

**Files:**
- Create: `src/job.ts`
- Test: `tests/job_connection_test.ts`

- [ ] **Step 1: Write the failing test** — `tests/job_connection_test.ts`

```ts
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { ADDRESS_CHANGED_MESSAGE, JobManager, NOT_CONNECTED_MESSAGE } from "../src/job.ts";
import type { Settings } from "../src/types.ts";
import { FakeCdpServer } from "./helpers/fake_cdp.ts";
import { fakePage } from "./helpers/fake_page.ts";
import { waitFor } from "./helpers/fixtures.ts";

const opts = { sanitizeOps: false, sanitizeResources: false };

function settingsFor(cdpAddress: string): Settings {
  return { cdpAddress, outputDir: "/tmp/tab-ripper-unused", ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" };
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
  name: "connect opens one browser connection and listTabs filters by URL_PATTERN",
  ...opts,
  fn: async () => {
    const server = new FakeCdpServer({ handler: fakePage().handler });
    const job = new JobManager(settingsFor(server.address));
    try {
      await job.connect();
      assertEquals(job.isConnected(), true);
      assertEquals(await job.listTabs(), [
        { targetId: "T1", title: "Clip page", url: "https://example.com/watch/1" },
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
    const server = new FakeCdpServer({ handler: fakePage().handler, upgradeDelayMs: 300 });
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
    const error = await assertRejects(() => job.connect(), Error, `無法連線到 ${address}`);
    assertStringIncludes((error as Error).message, "chrome://inspect/#remote-debugging");
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
      await waitFor(() => server.connections[0].socket.readyState === WebSocket.CLOSED, "old socket closed");
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
  name: "a connection attempt to the old address is rejected after an address change",
  ...opts,
  fn: async () => {
    const server = new FakeCdpServer({ handler: fakePage().handler, upgradeDelayMs: 300 });
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
  job.assertSettingsChangeAllowed({ ...settingsFor("127.0.0.1:9222"), outputDir: "/tmp/elsewhere" });
});

Deno.test({
  name: "a dropped connection is detected and a stale close does not affect the next one",
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
```

- [ ] **Step 2: Create the skeleton** — `src/job.ts`

```ts
import type { JobStatus, Settings, TabInfo } from "./types.ts";

export const BUSY_MESSAGE = "目前有工作進行中";
export const SHUTTING_DOWN_MESSAGE = "程式正在結束";
export const NOT_CONNECTED_MESSAGE = "尚未連線到瀏覽器";
export const ADDRESS_LOCKED_MESSAGE = "擷取中無法變更 CDP 位址";
export const ADDRESS_CHANGED_MESSAGE = "CDP 位址已變更，請重新連線";

export class JobManager {
  constructor(_settings: Settings) {}

  assertSettingsChangeAllowed(_settings: Settings): void {
    throw new Error("not implemented");
  }

  updateSettings(_settings: Settings): void {
    throw new Error("not implemented");
  }

  get isShuttingDown(): boolean {
    throw new Error("not implemented");
  }

  getStatus(): JobStatus {
    throw new Error("not implemented");
  }

  isConnected(): boolean {
    throw new Error("not implemented");
  }

  connect(): Promise<void> {
    return Promise.reject(new Error("not implemented"));
  }

  listTabs(): Promise<TabInfo[]> {
    return Promise.reject(new Error("not implemented"));
  }
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `deno task test tests/job_connection_test.ts`
Expected: 9 tests FAIL (`not implemented`, or message mismatch for the connect-failure tests).

- [ ] **Step 4: Implement** — replace `src/job.ts`

```ts
import { browserWsUrl } from "./cdp/address.ts";
import { CdpClient, CdpClosedError } from "./cdp/client.ts";
import { listTabs } from "./tabs.ts";
import type { JobStatus, Settings, TabInfo } from "./types.ts";
import { URL_PATTERN } from "../user/config.ts";

export const BUSY_MESSAGE = "目前有工作進行中";
export const SHUTTING_DOWN_MESSAGE = "程式正在結束";
export const NOT_CONNECTED_MESSAGE = "尚未連線到瀏覽器";
export const ADDRESS_LOCKED_MESSAGE = "擷取中無法變更 CDP 位址";
export const ADDRESS_CHANGED_MESSAGE = "CDP 位址已變更，請重新連線";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Owns the single browser connection, the single job's state machine, its
 * temp files, ffmpeg children and the shutdown protocol.
 */
export class JobManager {
  #settings: Settings;
  #status: JobStatus = { state: "idle" };
  #client: CdpClient | null = null;
  #connecting: Promise<void> | null = null;
  #shuttingDown = false;

  constructor(settings: Settings) {
    this.#settings = { ...settings };
  }

  /** Throws when `settings` may not be applied right now (call before saving to disk). */
  assertSettingsChangeAllowed(settings: Settings): void {
    if (settings.cdpAddress !== this.#settings.cdpAddress && this.#status.state === "extracting") {
      throw new Error(ADDRESS_LOCKED_MESSAGE);
    }
  }

  /**
   * Applies new settings. A changed CDP address drops the current browser
   * connection; a pending connection attempt to the old address is rejected
   * when it completes. The user then reconnects explicitly.
   */
  updateSettings(settings: Settings): void {
    this.assertSettingsChangeAllowed(settings);
    const addressChanged = settings.cdpAddress !== this.#settings.cdpAddress;
    this.#settings = { ...settings };
    if (addressChanged) {
      this.#client?.close();
      this.#client = null;
    }
  }

  get isShuttingDown(): boolean {
    return this.#shuttingDown;
  }

  getStatus(): JobStatus {
    return structuredClone(this.#status);
  }

  isConnected(): boolean {
    return this.#client !== null;
  }

  /** One connection for the whole app run, so the permission dialog appears once. */
  connect(): Promise<void> {
    if (this.#shuttingDown) return Promise.reject(new Error(SHUTTING_DOWN_MESSAGE));
    if (this.#client) return Promise.resolve();
    if (this.#connecting) return this.#connecting;
    const address = this.#settings.cdpAddress;
    const attempt = (async () => {
      let client: CdpClient;
      try {
        client = await CdpClient.connect(browserWsUrl(address));
      } catch (error) {
        throw new Error(
          `無法連線到 ${address}：${errorMessage(error)}。請確認 chrome://inspect/#remote-debugging 頁面上的位址與設定一致，並在瀏覽器的對話框按允許`,
        );
      }
      if (this.#shuttingDown) {
        client.close();
        throw new Error(SHUTTING_DOWN_MESSAGE);
      }
      if (this.#settings.cdpAddress !== address) {
        client.close();
        throw new Error(ADDRESS_CHANGED_MESSAGE);
      }
      this.#client = client;
      // Bound to this client: a stale close must not clear a newer connection.
      void client.closed.then(() => {
        if (this.#client === client) this.#client = null;
      });
    })();
    const connecting: Promise<void> = attempt.finally(() => {
      if (this.#connecting === connecting) this.#connecting = null;
    });
    this.#connecting = connecting;
    return connecting;
  }

  async listTabs(): Promise<TabInfo[]> {
    const client = this.#client;
    if (!client) throw new Error(NOT_CONNECTED_MESSAGE);
    try {
      return await listTabs(client, URL_PATTERN);
    } catch (error) {
      if (error instanceof CdpClosedError) throw new Error(NOT_CONNECTED_MESSAGE);
      throw error;
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `deno task test tests/job_connection_test.ts`
Expected: `ok | 9 passed | 0 failed`.

- [ ] **Step 6: Verification gate** — `deno task check && deno task lint && deno fmt && deno fmt --check`

- [ ] **Step 7: Commit** — git-master: `src/job.ts`, `tests/job_connection_test.ts`; message `feat: manage the single browser connection in JobManager`.

---

### Task 16: `JobManager` — extract, discard, reset

**Files:**
- Modify: `tests/helpers/fixtures.ts` (add `sessionTempDirs`)
- Create: `tests/helpers/job_fixture.ts`
- Modify: `src/job.ts`
- Test: `tests/job_extract_test.ts`

- [ ] **Step 1: Add `sessionTempDirs` to `tests/helpers/fixtures.ts`**

Add these imports at the top of the file:

```ts
import { systemTempRoot } from "../../src/cleanup.ts";
import { SESSION_ID } from "../../src/session.ts";
```

and append:

```ts
/** Temp dirs created by JobManager in this process (prefix `ffdl-<SESSION_ID>-`). */
export async function sessionTempDirs(): Promise<string[]> {
  const root = await systemTempRoot();
  return (await listDir(root))
    .filter((name) => name.startsWith(`ffdl-${SESSION_ID}-`))
    .map((name) => join(root, name));
}

/** Session temp dirs that did not exist in `before`. */
export async function newSessionTempDirs(before: string[]): Promise<string[]> {
  return (await sessionTempDirs()).filter((dir) => !before.includes(dir));
}
```

- [ ] **Step 2: Create the job fixture** — `tests/helpers/job_fixture.ts`

```ts
import { join } from "@std/path";
import { killAllChildren } from "../../src/ffmpeg.ts";
import { JobManager } from "../../src/job.ts";
import type { JobStatus, Settings } from "../../src/types.ts";
import { FakeCdpServer } from "./fake_cdp.ts";
import { type FakePage, fakePage, type FakePageOptions } from "./fake_page.ts";
import { makeTempDir, waitFor } from "./fixtures.ts";

export interface JobFixture {
  job: JobManager;
  server: FakeCdpServer;
  page: FakePage;
  workDir: string;
  outputDir: string;
  settings: Settings;
  dispose(): Promise<void>;
}

export async function connectedJob(
  pageOptions: FakePageOptions = {},
  overrides: Partial<Settings> = {},
): Promise<JobFixture> {
  const page = fakePage(pageOptions);
  const server = new FakeCdpServer({ handler: page.handler });
  const workDir = await makeTempDir();
  const outputDir = join(workDir, "output");
  const settings: Settings = {
    cdpAddress: server.address,
    outputDir,
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    ...overrides,
  };
  const job = new JobManager(settings);
  await job.connect();
  return {
    job,
    server,
    page,
    workDir,
    outputDir,
    settings,
    async dispose() {
      killAllChildren();
      await server.close();
      await Deno.chmod(workDir, 0o755).catch(() => {});
      await Deno.remove(workDir, { recursive: true });
    },
  };
}

export async function waitForState(
  job: JobManager,
  states: JobStatus["state"][],
  timeoutMs = 20_000,
): Promise<JobStatus> {
  let status = job.getStatus();
  await waitFor(() => {
    status = job.getStatus();
    return states.includes(status.state);
  }, `job state ${states.join("/")}`, timeoutMs);
  return status;
}

/** A connected job that has finished extracting tab "T1". */
export async function readyJob(
  pageOptions: FakePageOptions = {},
  overrides: Partial<Settings> = {},
): Promise<JobFixture> {
  const fixture = await connectedJob(pageOptions, overrides);
  fixture.job.extract("T1");
  const status = await waitForState(fixture.job, ["ready", "failed"]);
  if (status.state !== "ready") throw new Error(`extraction failed: ${JSON.stringify(status)}`);
  return fixture;
}
```

- [ ] **Step 3: Write the failing test** — `tests/job_extract_test.ts`

```ts
import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { ADDRESS_LOCKED_MESSAGE, BUSY_MESSAGE, JobManager, NOT_CONNECTED_MESSAGE } from "../src/job.ts";
import { INFO_COLUMNS } from "../user/info.ts";
import { listDir, newSessionTempDirs, pathExists, sessionTempDirs, waitFor } from "./helpers/fixtures.ts";
import { connectedJob, readyJob, waitForState } from "./helpers/job_fixture.ts";

const opts = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  name: "extract reaches ready with info, sizes and a session temp dir",
  ...opts,
  fn: async () => {
    const before = await sessionTempDirs();
    const f = await readyJob({ main: new Uint8Array([1, 2, 3, 4]), aux: new Uint8Array([5]) });
    try {
      assertEquals(f.job.getStatus(), {
        state: "ready",
        info: { title: "Clip" },
        columns: INFO_COLUMNS,
        mainSize: 4,
        auxSize: 1,
        defaultFilename: "Clip.mp4",
      });
      const created = await newSessionTempDirs(before);
      assertEquals(created.length, 1);
      assertEquals(await listDir(created[0]), ["aux.bin", "main.bin"]);
      assertEquals(await Deno.readFile(join(created[0], "main.bin")), new Uint8Array([1, 2, 3, 4]));
    } finally {
      f.job.discard();
      await f.dispose();
    }
  },
});

Deno.test("extract requires a connection", () => {
  const job = new JobManager({ cdpAddress: "127.0.0.1:9", outputDir: "/tmp", ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" });
  assertThrows(() => job.extract("T1"), Error, NOT_CONNECTED_MESSAGE);
  assertEquals(job.getStatus(), { state: "idle" });
});

Deno.test({
  name: "extract rejects a second job and fails when the connection drops",
  ...opts,
  fn: async () => {
    const before = await sessionTempDirs();
    const f = await connectedJob({ hangWrapper: true });
    try {
      f.job.extract("T1");
      await waitFor(() => f.page.wrapperTokens.length === 1, "wrapper sent");
      assertEquals(f.job.getStatus().state, "extracting");
      assertThrows(() => f.job.extract("T1"), Error, BUSY_MESSAGE);
      f.server.connections[0].close();
      const status = await waitForState(f.job, ["failed"]);
      assertEquals(status, { state: "failed", stage: "extract", message: "與瀏覽器的連線已中斷" });
      assertEquals(f.job.isConnected(), false);
      assertEquals(await newSessionTempDirs(before), []);
    } finally {
      await f.dispose();
    }
  },
});

Deno.test({
  name: "a failed extraction cleans up and can be reset and retried",
  ...opts,
  fn: async () => {
    const before = await sessionTempDirs();
    const f = await connectedJob({ wrapperException: "boom" });
    try {
      f.job.extract("T1");
      const status = await waitForState(f.job, ["failed"]);
      assertEquals(status, {
        state: "failed",
        stage: "extract",
        message: "Error: boom\n    at <anonymous>:1:1",
      });
      assertEquals(await newSessionTempDirs(before), []);
      f.job.extract("T1"); // allowed straight from failed
      await waitForState(f.job, ["failed"]);
      f.job.reset();
      assertEquals(f.job.getStatus(), { state: "idle" });
      assertThrows(() => f.job.reset(), Error, BUSY_MESSAGE);
    } finally {
      await f.dispose();
    }
  },
});

Deno.test({
  name: "the CDP address cannot change while extracting",
  ...opts,
  fn: async () => {
    const f = await connectedJob({ hangWrapper: true });
    try {
      f.job.extract("T1");
      await waitFor(() => f.page.wrapperTokens.length === 1, "wrapper sent");
      const changed = { ...f.settings, cdpAddress: "127.0.0.1:9" };
      assertThrows(() => f.job.assertSettingsChangeAllowed(changed), Error, ADDRESS_LOCKED_MESSAGE);
      assertThrows(() => f.job.updateSettings(changed), Error, ADDRESS_LOCKED_MESSAGE);
      assertEquals(f.job.isConnected(), true);
      assertEquals(f.job.getStatus().state, "extracting");
      // Other settings may still change while extracting.
      f.job.updateSettings({ ...f.settings, outputDir: f.outputDir + "-2" });
      assertEquals(f.job.isConnected(), true);
    } finally {
      await f.dispose();
    }
  },
});

Deno.test({
  name: "discard returns to idle and removes the temp dir",
  ...opts,
  fn: async () => {
    const before = await sessionTempDirs();
    const f = await readyJob();
    try {
      const [dir] = await newSessionTempDirs(before);
      assert(await pathExists(dir));
      f.job.discard();
      assertEquals(f.job.getStatus(), { state: "idle" });
      await waitFor(async () => !(await pathExists(dir)), "temp dir removal");
      assertThrows(() => f.job.discard(), Error, BUSY_MESSAGE);
    } finally {
      await f.dispose();
    }
  },
});
```

- [ ] **Step 4: Add the skeleton** — in `src/job.ts`, add inside the class (after `listTabs`)

```ts
  extract(_targetId: string): void {
    throw new Error("not implemented");
  }

  discard(): void {
    throw new Error("not implemented");
  }

  reset(): void {
    throw new Error("not implemented");
  }
```

- [ ] **Step 5: Run test to verify it fails**

Run: `deno task test tests/job_extract_test.ts`
Expected: 6 tests FAIL — `readyJob`/`extract` throw `not implemented`; the connection test fails because `not implemented` is thrown instead of `尚未連線到瀏覽器`.

- [ ] **Step 6: Implement** — in `src/job.ts`:

Replace the import block with:

```ts
import { browserWsUrl } from "./cdp/address.ts";
import { CdpClient, CdpClosedError } from "./cdp/client.ts";
import { extractFromTab } from "./extract.ts";
import { SESSION_ID } from "./session.ts";
import { listTabs } from "./tabs.ts";
import type { ExtractResult, JobStatus, Settings, TabInfo } from "./types.ts";
import { URL_PATTERN } from "../user/config.ts";
import { defaultFilename, INFO_COLUMNS } from "../user/info.ts";
```

Add these fields after `#shuttingDown = false;`:

```ts
  #tempDir: string | null = null;
  #extracted: ExtractResult | null = null;
  /** Last filename the user submitted; reused when returning to ready. */
  #lastFilename: string | null = null;
  /** The running extract/process work, awaited by shutdown. */
  #work: Promise<void> | null = null;
```

Replace the three skeleton methods with:

```ts
  extract(targetId: string): void {
    if (this.#shuttingDown) throw new Error(SHUTTING_DOWN_MESSAGE);
    const state = this.#status.state;
    if (state !== "idle" && state !== "done" && state !== "failed" && state !== "cancelled") {
      throw new Error(BUSY_MESSAGE);
    }
    const client = this.#client;
    if (!client) throw new Error(NOT_CONNECTED_MESSAGE);
    // Synchronous state switch: overlapping calls see "extracting".
    this.#status = { state: "extracting", received: 0, total: 0 };
    this.#track(this.#runExtract(client, targetId));
  }

  discard(): void {
    if (this.#shuttingDown) throw new Error(SHUTTING_DOWN_MESSAGE);
    if (this.#status.state !== "ready") throw new Error(BUSY_MESSAGE);
    const dir = this.#detachReadyFiles();
    if (dir) {
      Deno.remove(dir, { recursive: true }).catch((error) =>
        console.warn(`[tab-ripper] could not remove ${dir}: ${errorMessage(error)}`)
      );
    }
  }

  reset(): void {
    if (this.#shuttingDown) throw new Error(SHUTTING_DOWN_MESSAGE);
    const state = this.#status.state;
    if (state !== "done" && state !== "failed" && state !== "cancelled") throw new Error(BUSY_MESSAGE);
    this.#status = { state: "idle" };
  }

  async #runExtract(client: CdpClient, targetId: string): Promise<void> {
    let tempDir: string | null = null;
    try {
      tempDir = await Deno.makeTempDir({ prefix: `ffdl-${SESSION_ID}-` });
      this.#tempDir = tempDir;
      const result = await extractFromTab(client, targetId, tempDir, (received, total) => {
        if (this.#status.state === "extracting") this.#status = { state: "extracting", received, total };
      });
      this.#extracted = result;
      this.#lastFilename = null;
      this.#status = this.#readyStatus();
    } catch (error) {
      const warning = tempDir ? await this.#removeTempDir(tempDir) : undefined;
      this.#tempDir = null;
      this.#extracted = null;
      this.#status = {
        state: "failed",
        stage: "extract",
        message: errorMessage(error),
        ...(warning ? { cleanupWarning: warning } : {}),
      };
    }
  }

  #readyStatus(lastError?: string): JobStatus {
    const extracted = this.#extracted;
    if (!extracted) throw new Error("internal error: no extracted files");
    return {
      state: "ready",
      info: extracted.info,
      columns: INFO_COLUMNS,
      mainSize: extracted.mainSize,
      auxSize: extracted.auxSize,
      defaultFilename: this.#lastFilename ?? defaultFilename(extracted.info),
      ...(lastError ? { lastError } : {}),
    };
  }

  /** Clears ready-state files from the job and returns the temp dir to delete. */
  #detachReadyFiles(): string | null {
    const dir = this.#tempDir;
    this.#tempDir = null;
    this.#extracted = null;
    this.#lastFilename = null;
    this.#status = { state: "idle" };
    return dir;
  }

  /** Returns a cleanup warning instead of throwing. */
  async #removeTempDir(dir: string): Promise<string | undefined> {
    try {
      await Deno.remove(dir, { recursive: true });
      return undefined;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      return `暫存檔未能刪除：${dir}（${errorMessage(error)}）`;
    }
  }

  #track(work: Promise<void>): void {
    const tracked: Promise<void> = work.finally(() => {
      if (this.#work === tracked) this.#work = null;
    });
    this.#work = tracked;
  }
```

- [ ] **Step 7: Run test to verify it passes**

Run: `deno task test tests/job_extract_test.ts tests/job_connection_test.ts`
Expected: `ok | 15 passed | 0 failed`.

- [ ] **Step 8: Verification gate** — `deno task check && deno task lint && deno fmt && deno fmt --check`

- [ ] **Step 9: Commit** — git-master: `tests/helpers/fixtures.ts`, `tests/helpers/job_fixture.ts`, `src/job.ts`, `tests/job_extract_test.ts`; message `feat: run extraction jobs with temp dir lifecycle`.

---

### Task 17: `JobManager` — startProcess and cancel

**Files:**
- Modify: `src/job.ts`
- Test: `tests/job_process_test.ts`

- [ ] **Step 1: Write the failing test** — `tests/job_process_test.ts`

```ts
import { assert, assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { isAbsolute, join } from "@std/path";
import { activeChildCount } from "../src/ffmpeg.ts";
import { BUSY_MESSAGE } from "../src/job.ts";
import type { Settings } from "../src/types.ts";
import { URL_PATTERN } from "../user/config.ts";
import {
  FFMPEG,
  listDir,
  makeExecutable,
  makeTempDir,
  makeTestVideo,
  newSessionTempDirs,
  pathExists,
  sessionTempDirs,
  waitFor,
} from "./helpers/fixtures.ts";
import { type JobFixture, readyJob, waitForState } from "./helpers/job_fixture.ts";

// A real 3-second H.264 MP4 served as the page's main file.
const VIDEO: Uint8Array = FFMPEG
  ? await (async () => {
    const dir = await makeTempDir();
    try {
      return await Deno.readFile(await makeTestVideo(dir, 3));
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  })()
  : new Uint8Array();

const base = { sanitizeOps: false, sanitizeResources: false, ignore: !FFMPEG };

// Fake tool scripts for this file live in one dir, removed when the module unloads.
const TOOL_DIR = await makeTempDir();
globalThis.addEventListener("unload", () => Deno.removeSync(TOOL_DIR, { recursive: true }));

async function videoJob(overrides: Partial<Settings> = {}): Promise<{ f: JobFixture; tempDir: string }> {
  const before = await sessionTempDirs();
  const f = await readyJob({ main: VIDEO, aux: new Uint8Array([1]) }, overrides);
  const [tempDir] = await newSessionTempDirs(before);
  return { f, tempDir };
}

/** Scripts that stand in for ffmpeg; they receive the real argument list (output path last). */
async function fakeTools() {
  const dir = TOOL_DIR;
  return {
    hang: await makeExecutable(dir, "hang", "exec sleep 30"),
    slowWriter: await makeExecutable(dir, "slow-writer", 'for last; do :; done\nsleep 1\nprintf fake > "$last"'),
    /** Writes its output immediately, then lingers 1 s before exiting 0. */
    writeThenWait: await makeExecutable(
      dir,
      "write-then-wait",
      'for last; do :; done\nprintf fake > "$last"\nsleep 1\nexit 0',
    ),
    failing: await makeExecutable(dir, "failing", 'echo "boom from ffmpeg" >&2\nexit 3'),
    silent: await makeExecutable(dir, "silent", "exit 0"),
    /** Real ffmpeg slowed to real time, so a job stays in "running" for ~3 s. */
    realtime: await makeExecutable(dir, "realtime-ffmpeg", 'exec ffmpeg -re "$@"'),
    /** Ignores SIGTERM, writes its output and exits 0 about 1 s later. */
    stubbornWriter: (ready: string) =>
      makeExecutable(
        dir,
        "stubborn-writer",
        `trap '' TERM\ntouch "${ready}"\nfor last; do :; done\nsleep 1\nprintf fake > "$last"\nexit 0`,
      ),
    marker: (path: string) => makeExecutable(dir, "marker", `touch "${path}"\nexit 1`),
  };
}

Deno.test({
  name: "startProcess runs ffmpeg, publishes, and cleans up before reporting done",
  ...base,
  fn: async () => {
    const { f, tempDir } = await videoJob();
    try {
      const finalPath = join(f.outputDir, "My Clip.mp4");
      assertEquals(await f.job.startProcess("My Clip.mp4", null), { needsConfirm: false, finalPath });
      const status = await waitForState(f.job, ["done", "failed"]);
      assertEquals(status, { state: "done", outputPath: finalPath });
      assertEquals(await pathExists(tempDir), false);
      assert((await Deno.stat(finalPath)).size > 1000);
    } finally {
      await f.dispose();
    }
  },
});

Deno.test({
  name: "startProcess rejects an invalid filename and stays ready",
  ...base,
  fn: async () => {
    const { f } = await videoJob();
    try {
      await assertRejects(() => f.job.startProcess(" ... ", null), Error, "檔名無效");
      assertEquals(f.job.getStatus().state, "ready");
    } finally {
      f.job.discard();
      await f.dispose();
    }
  },
});

Deno.test({
  name: "an existing file needs confirmation bound to its exact path",
  ...base,
  fn: async () => {
    const { f, tempDir } = await videoJob();
    try {
      await Deno.mkdir(f.outputDir, { recursive: true });
      const finalPath = join(f.outputDir, "out.mp4");
      await Deno.writeTextFile(finalPath, "old");
      const first = await f.job.startProcess("out.mp4", null);
      assertEquals(first, { needsConfirm: true, finalPath });
      assertEquals(f.job.getStatus().state, "ready");
      assert(await pathExists(join(tempDir, "main.bin")));
      assert(await pathExists(join(tempDir, "aux.bin")));
      const second = await f.job.startProcess("out.mp4", first.finalPath);
      assertEquals(second, { needsConfirm: false, finalPath });
      await waitForState(f.job, ["done"]);
      assert((await Deno.stat(finalPath)).size > 1000);
    } finally {
      await f.dispose();
    }
  },
});

Deno.test({
  name: "declining overwrite and choosing another name still uses the extracted files",
  ...base,
  fn: async () => {
    const { f } = await videoJob();
    try {
      await Deno.mkdir(f.outputDir, { recursive: true });
      await Deno.writeTextFile(join(f.outputDir, "out.mp4"), "old");
      assertEquals((await f.job.startProcess("out.mp4", null)).needsConfirm, true);
      assertEquals((await f.job.startProcess("other.mp4", null)).needsConfirm, false);
      await waitForState(f.job, ["done"]);
      assertEquals(await Deno.readTextFile(join(f.outputDir, "out.mp4")), "old");
      assert(await pathExists(join(f.outputDir, "other.mp4")));
    } finally {
      await f.dispose();
    }
  },
});

Deno.test({
  name: "changing outputDir between calls invalidates the overwrite confirmation",
  ...base,
  fn: async () => {
    const { f } = await videoJob();
    try {
      const otherDir = join(f.workDir, "other");
      await Deno.mkdir(f.outputDir, { recursive: true });
      await Deno.mkdir(otherDir);
      await Deno.writeTextFile(join(f.outputDir, "out.mp4"), "old");
      await Deno.writeTextFile(join(otherDir, "out.mp4"), "old2");
      const first = await f.job.startProcess("out.mp4", null);
      f.job.updateSettings({ ...f.settings, outputDir: otherDir });
      const second = await f.job.startProcess("out.mp4", first.finalPath);
      assertEquals(second, { needsConfirm: true, finalPath: join(otherDir, "out.mp4") });
      assertEquals(await Deno.readTextFile(join(otherDir, "out.mp4")), "old2");
    } finally {
      f.job.discard();
      await f.dispose();
    }
  },
});

Deno.test({
  name: "settings changed during processing do not affect the running job",
  ...base,
  fn: async () => {
    const { f } = await videoJob();
    try {
      const otherDir = join(f.workDir, "other");
      const pending = f.job.startProcess("snap.mp4", null);
      f.job.updateSettings({ ...f.settings, outputDir: otherDir });
      await pending;
      await waitForState(f.job, ["done"]);
      assert(await pathExists(join(f.outputDir, "snap.mp4")));
      assertEquals(await pathExists(otherDir), false);
    } finally {
      await f.dispose();
    }
  },
});

Deno.test({
  name: "an output directory that cannot be created returns to ready and allows a retry",
  ...base,
  fn: async () => {
    const { f, tempDir } = await videoJob();
    try {
      const blocker = join(f.workDir, "blocker");
      await Deno.writeTextFile(blocker, "not a directory");
      f.job.updateSettings({ ...f.settings, outputDir: join(blocker, "sub") });
      assertEquals((await f.job.startProcess("a.mp4", null)).needsConfirm, false);
      const status = f.job.getStatus();
      assert(status.state === "ready");
      assertStringIncludes(status.lastError ?? "", "輸出失敗：");
      assertEquals(status.defaultFilename, "a.mp4");
      assert(await pathExists(join(tempDir, "main.bin")));
      assert(await pathExists(join(tempDir, "aux.bin")));
      assertEquals(await pathExists(join(tempDir, "out")), false);
      f.job.updateSettings(f.settings);
      await f.job.startProcess("a.mp4", null);
      await waitForState(f.job, ["done"]);
      assert(await pathExists(join(f.outputDir, "a.mp4")));
    } finally {
      await f.dispose();
    }
  },
});

Deno.test({
  name: "a destination inspection error (name too long) returns to ready",
  ...base,
  fn: async () => {
    const { f, tempDir } = await videoJob();
    try {
      await f.job.startProcess(`${"a".repeat(300)}.mp4`, null);
      const status = f.job.getStatus();
      assert(status.state === "ready");
      assertStringIncludes(status.lastError ?? "", "輸出失敗：");
      assert(await pathExists(join(tempDir, "main.bin")));
      assert(await pathExists(join(tempDir, "aux.bin")));
    } finally {
      f.job.discard();
      await f.dispose();
    }
  },
});

Deno.test({
  name: "a publish failure returns to ready, drops out/, and a retry succeeds",
  ...base,
  fn: async () => {
    const tools = await fakeTools();
    const { f, tempDir } = await videoJob({ ffmpegPath: tools.slowWriter });
    try {
      await f.job.startProcess("pub.mp4", null);
      await Deno.chmod(f.outputDir, 0o500);
      const status = await waitForState(f.job, ["ready", "done", "failed"]);
      assert(status.state === "ready", JSON.stringify(status));
      assertStringIncludes(status.lastError ?? "", "輸出失敗：");
      assert(await pathExists(join(tempDir, "main.bin")));
      assert(await pathExists(join(tempDir, "aux.bin")));
      assertEquals(await pathExists(join(tempDir, "out")), false);
      await Deno.chmod(f.outputDir, 0o755);
      await f.job.startProcess("pub.mp4", null);
      await waitForState(f.job, ["done"]);
      assertEquals(await Deno.readTextFile(join(f.outputDir, "pub.mp4")), "fake");
    } finally {
      await Deno.chmod(f.outputDir, 0o755).catch(() => {});
      await f.dispose();
    }
  },
});

Deno.test({
  name: "cancel while running stops a real ffmpeg and leaves no output",
  ...base,
  fn: async () => {
    const tools = await fakeTools();
    const { f, tempDir } = await videoJob({ ffmpegPath: tools.realtime });
    try {
      await f.job.startProcess("c.mp4", null);
      await waitFor(() => {
        const s = f.job.getStatus();
        return s.state === "processing" && s.phase === "running" && (s.message ?? "").startsWith("frame=");
      }, "real ffmpeg reporting progress");
      f.job.cancel();
      assertEquals(await waitForState(f.job, ["cancelled"]), { state: "cancelled" });
      assertEquals(await pathExists(tempDir), false);
      assertEquals(await listDir(f.outputDir), []);
      assertEquals(activeChildCount(), 0);
    } finally {
      await f.dispose();
    }
  },
});

Deno.test({
  name: "cancel while preparing never starts ffmpeg",
  ...base,
  fn: async () => {
    const tools = await fakeTools();
    const markerPath = join(TOOL_DIR, "ffmpeg-ran-preparing");
    const { f } = await videoJob({ ffprobePath: tools.hang, ffmpegPath: await tools.marker(markerPath) });
    try {
      await f.job.startProcess("p.mp4", null);
      await waitFor(() => activeChildCount() === 1, "ffprobe running");
      const status = f.job.getStatus();
      assert(status.state === "processing" && status.phase === "preparing");
      f.job.cancel();
      await waitForState(f.job, ["cancelled"]);
      assertEquals(await pathExists(markerPath), false);
      assertEquals(activeChildCount(), 0);
    } finally {
      await f.dispose();
    }
  },
});

Deno.test({
  name: "a temp dir that cannot be removed yields a terminal state with cleanupWarning",
  ...base,
  fn: async () => {
    const { f, tempDir } = await videoJob();
    try {
      await Deno.chmod(tempDir, 0o500);
      await f.job.startProcess("w.mp4", null);
      const status = await waitForState(f.job, ["failed", "done", "cancelled"]);
      assert(status.state === "failed", JSON.stringify(status));
      assertStringIncludes(status.cleanupWarning ?? "", "暫存檔未能刪除");
      assertStringIncludes(status.cleanupWarning ?? "", tempDir);
    } finally {
      await Deno.chmod(tempDir, 0o755).catch(() => {});
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
      await f.dispose();
    }
  },
});

Deno.test({
  name: "a non-zero ffmpeg exit fails with the stderr tail",
  ...base,
  fn: async () => {
    const tools = await fakeTools();
    const { f, tempDir } = await videoJob({ ffmpegPath: tools.failing });
    try {
      await f.job.startProcess("x.mp4", null);
      const status = await waitForState(f.job, ["failed"]);
      assert(status.state === "failed");
      assertEquals(status.stage, "process");
      assertEquals(status.message, "ffmpeg 執行失敗（結束碼 3）");
      assert(status.detail?.includes("boom from ffmpeg"));
      assertEquals(await pathExists(tempDir), false);
    } finally {
      await f.dispose();
    }
  },
});

Deno.test({
  name: "ffmpeg exiting 0 without output fails with a hint",
  ...base,
  fn: async () => {
    const tools = await fakeTools();
    const { f } = await videoJob({ ffmpegPath: tools.silent });
    try {
      await f.job.startProcess("x.mp4", null);
      const status = await waitForState(f.job, ["failed"]);
      assert(status.state === "failed");
      assertEquals(status.message, "ffmpeg 未產生輸出檔，請檢查 buildFfmpegArgs 是否寫入 outputPath");
    } finally {
      await f.dispose();
    }
  },
});

Deno.test({
  name: "only the first of overlapping startProcess calls wins and discard is refused",
  ...base,
  fn: async () => {
    const tools = await fakeTools();
    const { f } = await videoJob({ ffmpegPath: tools.hang });
    try {
      const results = await Promise.allSettled([
        f.job.startProcess("a.mp4", null),
        f.job.startProcess("b.mp4", null),
      ]);
      assertEquals(results.filter((r) => r.status === "fulfilled").length, 1);
      const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      assertEquals((rejected.reason as Error).message, BUSY_MESSAGE);
      assertThrows(() => f.job.discard(), Error, BUSY_MESSAGE);
      f.job.cancel();
      await waitForState(f.job, ["cancelled"]);
      assertThrows(() => f.job.cancel(), Error, "目前沒有進行中的處理");
    } finally {
      await f.dispose();
    }
  },
});

Deno.test({
  name: "cancel that lands while ffmpeg is finishing still prevents publishing",
  ...base,
  fn: async () => {
    const tools = await fakeTools();
    const ready = join(TOOL_DIR, "stubborn-writer-ready");
    await Deno.remove(ready).catch(() => {});
    const { f, tempDir } = await videoJob({ ffmpegPath: await tools.stubbornWriter(ready) });
    try {
      await f.job.startProcess("late.mp4", null);
      await waitFor(() => pathExists(ready), "writer started");
      // SIGTERM is ignored: the writer still produces its output and exits 0.
      f.job.cancel();
      assertEquals(await waitForState(f.job, ["cancelled", "done", "failed"]), { state: "cancelled" });
      assertEquals(await listDir(f.outputDir), []);
      assertEquals(await pathExists(tempDir), false);
    } finally {
      await f.dispose();
    }
  },
});

Deno.test({
  name: "an undeletable out/ is reported and its stale output is never published on retry",
  ...base,
  fn: async () => {
    const tools = await fakeTools();
    const { f, tempDir } = await videoJob({ ffmpegPath: tools.writeThenWait });
    const outDir = join(tempDir, "out");
    try {
      await f.job.startProcess("stale.mp4", null);
      // The fake has written its output and is still running for ~1 s.
      await waitFor(() => pathExists(join(outDir, "stale.mp4")), "output written");
      // Publishing will fail (read-only destination) and out/ cannot be emptied.
      await Deno.chmod(f.outputDir, 0o500);
      await Deno.chmod(outDir, 0o500);
      const status = await waitForState(f.job, ["ready", "done", "failed"]);
      assert(status.state === "ready", JSON.stringify(status));
      assertStringIncludes(status.lastError ?? "", "輸出失敗：");
      assertStringIncludes(status.lastError ?? "", "暫存輸出未能刪除");
      await Deno.chmod(outDir, 0o755);
      await Deno.chmod(f.outputDir, 0o755);
      // A tool that writes nothing must not let the stale out/stale.mp4 be published.
      f.job.updateSettings({ ...f.settings, ffmpegPath: tools.silent });
      await f.job.startProcess("stale.mp4", null);
      const retry = await waitForState(f.job, ["done", "failed"]);
      assert(retry.state === "failed", JSON.stringify(retry));
      assertEquals(retry.message, "ffmpeg 未產生輸出檔，請檢查 buildFfmpegArgs 是否寫入 outputPath");
      assertEquals(await pathExists(join(f.outputDir, "stale.mp4")), false);
    } finally {
      await Deno.chmod(outDir, 0o755).catch(() => {});
      await Deno.chmod(f.outputDir, 0o755).catch(() => {});
      await f.dispose();
    }
  },
});

Deno.test({
  name: "a cancel issued right after startProcess with an unusable destination cancels and cleans up",
  ...base,
  fn: async () => {
    const { f, tempDir } = await videoJob();
    try {
      const blocker = join(f.workDir, "blocker");
      await Deno.writeTextFile(blocker, "not a directory");
      f.job.updateSettings({ ...f.settings, outputDir: join(blocker, "sub") });
      const pending = f.job.startProcess("x.mp4", null);
      f.job.cancel(); // Still processing/preparing: accepted before the destination check fails.
      await pending;
      assertEquals(f.job.getStatus(), { state: "cancelled" });
      assertEquals(await pathExists(tempDir), false);
    } finally {
      await f.dispose();
    }
  },
});

Deno.test({
  name: "a failed duration probe sets probeWarning and processing still completes",
  ...base,
  fn: async () => {
    const tools = await fakeTools();
    const { f } = await videoJob({ ffprobePath: tools.failing });
    try {
      assertEquals(f.job.probeWarning, null);
      await f.job.startProcess("np.mp4", null);
      assertEquals(await waitForState(f.job, ["done", "failed"]), {
        state: "done",
        outputPath: join(f.outputDir, "np.mp4"),
      });
      assertStringIncludes(f.job.probeWarning ?? "", "無法以 ffprobe 取得長度");
    } finally {
      await f.dispose();
    }
  },
});

Deno.test({
  name: "urlPattern exposes the configured pattern as text",
  ...base,
  fn: async () => {
    const { f } = await videoJob();
    try {
      assertEquals(f.job.urlPattern, String(URL_PATTERN));
    } finally {
      f.job.discard();
      await f.dispose();
    }
  },
});

Deno.test({
  name: "a relative outputDir is resolved to an absolute path at startProcess",
  ...base,
  fn: async () => {
    const { f } = await videoJob();
    const previousCwd = Deno.cwd();
    Deno.chdir(f.workDir);
    try {
      f.job.updateSettings({ ...f.settings, outputDir: "relative-out" });
      const { finalPath } = await f.job.startProcess("rel.mp4", null);
      assert(isAbsolute(finalPath), finalPath);
      assertEquals(finalPath, join(Deno.cwd(), "relative-out", "rel.mp4"));
      const status = await waitForState(f.job, ["done", "failed"]);
      assertEquals(status, { state: "done", outputPath: finalPath });
      assert(await pathExists(finalPath));
    } finally {
      Deno.chdir(previousCwd);
      await f.dispose();
    }
  },
});
```

- [ ] **Step 2: Add the skeleton** — in `src/job.ts`, add inside the class (after `reset`)

```ts
  get probeWarning(): string | null {
    return null;
  }

  get urlPattern(): string {
    return "";
  }

  startProcess(
    _filename: string,
    _confirmedOverwritePath: string | null,
  ): Promise<{ needsConfirm: boolean; finalPath: string }> {
    return Promise.reject(new Error("not implemented"));
  }

  cancel(): void {
    throw new Error("not implemented");
  }
```

- [ ] **Step 3: Run test to verify it fails**

Run: `deno task test tests/job_process_test.ts`
Expected: 21 tests FAIL — `startProcess` rejects with `not implemented` (the filename test fails because the message is not `檔名無效`), and the `urlPattern` test fails because the skeleton getter returns `""`.

- [ ] **Step 4: Implement** — in `src/job.ts`:

Replace the import block with:

```ts
import { join, resolve } from "@std/path";
import { browserWsUrl } from "./cdp/address.ts";
import { CdpClient, CdpClosedError } from "./cdp/client.ts";
import { extractFromTab } from "./extract.ts";
import { type FfmpegRun, probeDuration, runFfmpeg } from "./ffmpeg.ts";
import { sanitizeFilename } from "./filename.ts";
import { publishOutput } from "./publish.ts";
import { SESSION_ID } from "./session.ts";
import { listTabs } from "./tabs.ts";
import type { ExtractResult, JobStatus, Settings, TabInfo } from "./types.ts";
import { PROBE_DURATION, URL_PATTERN } from "../user/config.ts";
import { buildFfmpegArgs } from "../user/ffmpeg-args.ts";
import { defaultFilename, INFO_COLUMNS } from "../user/info.ts";
```

Add below the `errorMessage` function (module level):

```ts
interface ProcessContext {
  settings: Settings;
  name: string;
  finalPath: string;
  confirmedOverwritePath: string | null;
  tempDir: string;
  extracted: ExtractResult;
  readyStatus: JobStatus;
  abort: AbortController;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
```

Add these fields after `#work`:

```ts
  #cancelRequested = false;
  #abort: AbortController | null = null;
  #run: FfmpegRun | null = null;
  /** Set when the last duration probe failed; shown on the settings page. */
  #probeWarning: string | null = null;
```

Delete the two skeleton getters (`probeWarning`, `urlPattern`) and add these next to `isShuttingDown`:

```ts
  /** Warning from the most recent failed ffprobe duration probe, if any. */
  get probeWarning(): string | null {
    return this.#probeWarning;
  }

  /** The URL pattern as text, for the tab list's empty state. */
  get urlPattern(): string {
    return String(URL_PATTERN);
  }
```

Replace the two skeleton methods with:

```ts
  /**
   * Everything before the first await is synchronous
   * (state switch + settings snapshot). Resolves once the destination checks
   * are done; processing then continues in the background.
   */
  async startProcess(
    filename: string,
    confirmedOverwritePath: string | null,
  ): Promise<{ needsConfirm: boolean; finalPath: string }> {
    if (this.#shuttingDown) throw new Error(SHUTTING_DOWN_MESSAGE);
    if (this.#status.state !== "ready" || this.#tempDir === null || this.#extracted === null) {
      throw new Error(BUSY_MESSAGE);
    }
    const name = sanitizeFilename(filename);
    // Snapshot with an absolute output dir: confirmation, publishing and the
    // result all use this exact path even if settings or cwd change later.
    const settings = { ...this.#settings, outputDir: resolve(this.#settings.outputDir) };
    const ctx: ProcessContext = {
      settings,
      name,
      finalPath: join(settings.outputDir, name),
      confirmedOverwritePath,
      tempDir: this.#tempDir,
      extracted: this.#extracted,
      readyStatus: this.#status,
      abort: new AbortController(),
    };
    this.#lastFilename = name;
    this.#cancelRequested = false;
    this.#abort = ctx.abort;
    this.#status = {
      state: "processing",
      phase: "preparing",
      percent: null,
      outTimeSec: 0,
      durationSec: null,
      speed: null,
      message: null,
    };
    let signalPrepared!: (needsConfirm: boolean) => void;
    const prepared = new Promise<boolean>((resolve) => {
      signalPrepared = resolve;
    });
    this.#track(this.#runProcess(ctx, signalPrepared));
    return { needsConfirm: await prepared, finalPath: ctx.finalPath };
  }

  cancel(): void {
    const status = this.#status;
    if (status.state !== "processing") throw new Error("目前沒有進行中的處理");
    if (status.phase === "publishing") return; // Publishing is never interrupted.
    this.#cancelRequested = true;
    this.#abort?.abort();
    this.#run?.cancel();
  }

  async #runProcess(ctx: ProcessContext, signalPrepared: (needsConfirm: boolean) => void): Promise<void> {
    const outDir = join(ctx.tempDir, "out");
    const tempOutput = join(outDir, ctx.name);
    // remove-all: terminal outcome. keep-inputs: destination failure, keep
    // main/aux for a retry. keep-all: overwrite confirmation pending.
    let cleanup: "remove-all" | "keep-inputs" | "keep-all" = "remove-all";
    let next: JobStatus = { state: "cancelled" };
    let destinationError = "";
    try {
      try {
        await Deno.mkdir(ctx.settings.outputDir, { recursive: true });
        if (this.#cancelRequested) return;
        const exists = await pathExists(ctx.finalPath);
        if (this.#cancelRequested) return;
        if (exists && ctx.confirmedOverwritePath !== ctx.finalPath) {
          cleanup = "keep-all";
          next = ctx.readyStatus;
          return;
        }
      } catch (error) {
        if (!this.#cancelRequested) {
          cleanup = "keep-inputs";
          destinationError = `輸出失敗：${errorMessage(error)}`;
          next = this.#readyStatus(destinationError);
        }
        return;
      }
      signalPrepared(false);
      if (this.#cancelRequested) return;

      const durationSec = PROBE_DURATION
        ? await probeDuration(ctx.settings.ffprobePath, ctx.extracted.mainPath, ctx.abort.signal)
        : null;
      if (this.#cancelRequested) return;
      // The duration probe is authoritative for the progress mode; a failure
      // is surfaced as a settings warning and processing continues.
      if (PROBE_DURATION) {
        this.#probeWarning = durationSec === null ? "無法以 ffprobe 取得長度，進度改為不確定顯示；請檢查 ffprobe 路徑" : null;
      }
      // Start from an empty out/: a leftover from an earlier failed attempt
      // must never be mistaken for this run's output.
      await Deno.remove(outDir, { recursive: true }).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
      await Deno.mkdir(outDir, { recursive: true });
      if (this.#cancelRequested) return;

      this.#status = {
        state: "processing",
        phase: "running",
        percent: durationSec === null ? null : 0,
        outTimeSec: 0,
        durationSec,
        speed: null,
        message: null,
      };
      const run = runFfmpeg({
        ffmpegPath: ctx.settings.ffmpegPath,
        args: buildFfmpegArgs({
          mainPath: ctx.extracted.mainPath,
          auxPath: ctx.extracted.auxPath,
          info: ctx.extracted.info,
          outputPath: tempOutput,
        }),
        durationSec,
        onProgress: (update) => {
          const status = this.#status;
          if (status.state === "processing" && status.phase === "running") {
            this.#status = { state: "processing", phase: "running", ...update };
          }
        },
      });
      this.#run = run;
      const { code, stderrTail } = await run.done;
      this.#run = null;
      if (this.#cancelRequested) return;
      if (code !== 0) {
        next = {
          state: "failed",
          stage: "process",
          message: `ffmpeg 執行失敗（結束碼 ${code}）`,
          detail: stderrTail.slice(-20),
        };
        return;
      }
      const produced = await pathExists(tempOutput);
      // Cancellation (user or shutdown) during the check must still win.
      if (this.#cancelRequested) return;
      if (!produced) {
        next = {
          state: "failed",
          stage: "process",
          message: "ffmpeg 未產生輸出檔，請檢查 buildFfmpegArgs 是否寫入 outputPath",
        };
        return;
      }
      const running = this.#status;
      if (running.state === "processing") this.#status = { ...running, phase: "publishing" };
      try {
        await publishOutput(tempOutput, ctx.finalPath);
      } catch (error) {
        cleanup = "keep-inputs";
        destinationError = `輸出失敗：${errorMessage(error)}`;
        next = this.#readyStatus(destinationError);
        return;
      }
      next = { state: "done", outputPath: ctx.finalPath };
    } catch (error) {
      cleanup = "remove-all";
      next = this.#cancelRequested
        ? { state: "cancelled" }
        : { state: "failed", stage: "process", message: errorMessage(error) };
    } finally {
      this.#run = null;
      this.#abort = null;
      if (cleanup === "keep-inputs") {
        try {
          await Deno.remove(outDir, { recursive: true });
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) {
            // Report the leftover; the next run clears out/ before starting ffmpeg.
            next = this.#readyStatus(
              `${destinationError}；暫存輸出未能刪除：${outDir}（${errorMessage(error)}）`,
            );
          }
        }
        // A cancel accepted during that await wins: clean everything up.
        if (this.#cancelRequested) {
          cleanup = "remove-all";
          next = { state: "cancelled" };
        }
      }
      if (cleanup === "remove-all") {
        const warning = await this.#removeTempDir(ctx.tempDir);
        this.#tempDir = null;
        this.#extracted = null;
        this.#lastFilename = null;
        // A cancel accepted while cleaning up after a failure is honoured.
        if (this.#cancelRequested && next.state === "failed") next = { state: "cancelled" };
        if (warning && (next.state === "done" || next.state === "failed" || next.state === "cancelled")) {
          next = { ...next, cleanupWarning: warning };
        }
      }
      // Status first, then release startProcess: callers never see a stale state.
      this.#status = next;
      signalPrepared(cleanup === "keep-all");
    }
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `deno task test tests/job_process_test.ts`
Expected: `ok | 21 passed | 0 failed`.

- [ ] **Step 6: Run the whole suite** — `deno task test` → all tests pass.

- [ ] **Step 7: Verification gate** — `deno task check && deno task lint && deno fmt && deno fmt --check`

- [ ] **Step 8: Commit** — git-master: `src/job.ts`, `tests/job_process_test.ts`; message `feat: process extracted files with ffmpeg and publish results`.

---

### Task 18: `JobManager` — shutdown and abortSync

**Files:**
- Modify: `src/job.ts`
- Test: `tests/job_shutdown_test.ts`

- [ ] **Step 1: Write the failing test** — `tests/job_shutdown_test.ts`

```ts
import { assert, assertEquals, assertRejects, assertStrictEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { activeChildCount } from "../src/ffmpeg.ts";
import { JobManager, SHUTTING_DOWN_MESSAGE } from "../src/job.ts";
import { FakeCdpServer } from "./helpers/fake_cdp.ts";
import { fakePage } from "./helpers/fake_page.ts";
import {
  FFMPEG,
  listDir,
  makeExecutable,
  makeTempDir,
  makeTestVideo,
  newSessionTempDirs,
  pathExists,
  sessionTempDirs,
  waitFor,
} from "./helpers/fixtures.ts";
import { connectedJob, readyJob, waitForState } from "./helpers/job_fixture.ts";

const opts = { sanitizeOps: false, sanitizeResources: false };

const VIDEO: Uint8Array = FFMPEG
  ? await (async () => {
    const dir = await makeTempDir();
    try {
      return await Deno.readFile(await makeTestVideo(dir, 3));
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  })()
  : new Uint8Array();

Deno.test({
  name: "shutdown when idle blocks later state-changing calls",
  ...opts,
  fn: async () => {
    const f = await connectedJob();
    try {
      const first = f.job.shutdown();
      assertStrictEquals(f.job.shutdown(), first);
      await first;
      assertEquals(f.job.isShuttingDown, true);
      assertEquals(f.job.isConnected(), false);
      await assertRejects(() => f.job.connect(), Error, SHUTTING_DOWN_MESSAGE);
      assertThrows(() => f.job.extract("T1"), Error, SHUTTING_DOWN_MESSAGE);
    } finally {
      await f.dispose();
    }
  },
});

Deno.test({
  name: "shutdown in ready discards the temp dir and refuses startProcess",
  ...opts,
  fn: async () => {
    const before = await sessionTempDirs();
    const f = await readyJob();
    try {
      const [tempDir] = await newSessionTempDirs(before);
      const shutdown = f.job.shutdown();
      await assertRejects(() => f.job.startProcess("x.mp4", null), Error, SHUTTING_DOWN_MESSAGE);
      await shutdown;
      assertEquals(f.job.getStatus(), { state: "idle" });
      assertEquals(await pathExists(tempDir), false);
    } finally {
      await f.dispose();
    }
  },
});

Deno.test({
  name: "shutdown while extracting fails the extraction promptly",
  ...opts,
  fn: async () => {
    const before = await sessionTempDirs();
    const f = await connectedJob({ hangWrapper: true });
    try {
      f.job.extract("T1");
      await waitFor(() => f.page.wrapperTokens.length === 1, "wrapper sent");
      const start = Date.now();
      await f.job.shutdown();
      assert(Date.now() - start < 3000);
      const status = f.job.getStatus();
      assertEquals(status.state, "failed");
      assertEquals(await newSessionTempDirs(before), []);
    } finally {
      await f.dispose();
    }
  },
});

Deno.test({
  name: "shutdown while preparing never starts ffmpeg",
  ...opts,
  ignore: !FFMPEG,
  fn: async () => {
    const toolDir = await makeTempDir();
    const hang = await makeExecutable(toolDir, "hang", "exec sleep 30");
    const markerPath = join(toolDir, "ffmpeg-ran");
    const marker = await makeExecutable(toolDir, "marker", `touch "${markerPath}"\nexit 1`);
    const f = await readyJob({ main: VIDEO }, { ffprobePath: hang, ffmpegPath: marker });
    try {
      await f.job.startProcess("p.mp4", null);
      await waitFor(() => activeChildCount() === 1, "ffprobe running");
      await f.job.shutdown();
      assertEquals(f.job.getStatus(), { state: "cancelled" });
      assertEquals(await pathExists(markerPath), false);
      assertEquals(await listDir(f.outputDir), []);
      assertEquals(activeChildCount(), 0);
    } finally {
      await f.dispose();
      await Deno.remove(toolDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "shutdown while a real ffmpeg is running cancels it and cleans up",
  ...opts,
  ignore: !FFMPEG,
  fn: async () => {
    const toolDir = await makeTempDir();
    // Real ffmpeg slowed to real time so the job is still running at shutdown.
    const realtime = await makeExecutable(toolDir, "realtime-ffmpeg", 'exec ffmpeg -re "$@"');
    const before = await sessionTempDirs();
    const f = await readyJob({ main: VIDEO }, { ffmpegPath: realtime });
    try {
      const [tempDir] = await newSessionTempDirs(before);
      await f.job.startProcess("r.mp4", null);
      await waitFor(() => {
        const s = f.job.getStatus();
        return s.state === "processing" && s.phase === "running" && (s.message ?? "").startsWith("frame=");
      }, "real ffmpeg reporting progress");
      await f.job.shutdown();
      assertEquals(f.job.getStatus(), { state: "cancelled" });
      assertEquals(activeChildCount(), 0);
      assertEquals(await pathExists(tempDir), false);
      assertEquals(await listDir(f.outputDir), []);
    } finally {
      await f.dispose();
      await Deno.remove(toolDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "shutdown honours its deadline and SIGKILLs a child that ignores SIGTERM",
  ...opts,
  ignore: !FFMPEG,
  fn: async () => {
    const toolDir = await makeTempDir();
    const ready = join(toolDir, "trap-installed");
    const stubborn = await makeExecutable(
      toolDir,
      "stubborn",
      `trap '' TERM\ntouch "${ready}"\nexec sleep 30`,
    );
    const f = await readyJob({ main: VIDEO }, { ffmpegPath: stubborn });
    try {
      await f.job.startProcess("s.mp4", null);
      // Only after the child has installed its TERM trap does SIGTERM become ineffective.
      await waitFor(() => pathExists(ready), "trap installed");
      const start = Date.now();
      await f.job.shutdown({ deadlineMs: 800 });
      const elapsed = Date.now() - start;
      // The child ignored SIGTERM, so shutdown had to wait for its deadline.
      assert(elapsed >= 700 && elapsed < 2000, `elapsed ${elapsed}`);
      await waitFor(() => activeChildCount() === 0, "children killed", 3000);
      await waitForState(f.job, ["cancelled"]);
    } finally {
      await f.dispose();
      await Deno.remove(toolDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "a connection that completes during shutdown is closed and rejected",
  ...opts,
  fn: async () => {
    const server = new FakeCdpServer({ handler: fakePage().handler, upgradeDelayMs: 500 });
    const job = new JobManager({
      cdpAddress: server.address,
      outputDir: "/tmp/tab-ripper-unused",
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe",
    });
    try {
      const connecting = job.connect();
      connecting.catch(() => {});
      await job.shutdown();
      await assertRejects(() => connecting, Error, SHUTTING_DOWN_MESSAGE);
      assertEquals(job.isConnected(), false);
      await waitFor(
        () => server.connections[0]?.socket.readyState === WebSocket.CLOSED,
        "server side close",
      );
    } finally {
      await server.close();
    }
  },
});

Deno.test({
  name: "abortSync kills running children and removes the temp dir synchronously",
  ...opts,
  ignore: !FFMPEG,
  fn: async () => {
    const toolDir = await makeTempDir();
    const hang = await makeExecutable(toolDir, "hang", "exec sleep 30");
    const before = await sessionTempDirs();
    const f = await readyJob({ main: VIDEO }, { ffmpegPath: hang });
    try {
      const [tempDir] = await newSessionTempDirs(before);
      await f.job.startProcess("a.mp4", null);
      await waitFor(() => {
        const s = f.job.getStatus();
        return s.state === "processing" && s.phase === "running" && activeChildCount() === 1;
      }, "ffmpeg running");
      f.job.abortSync();
      // The directory is gone as soon as abortSync returns.
      assertEquals(await pathExists(tempDir), false);
      await waitFor(() => activeChildCount() === 0, "child killed", 3000);
    } finally {
      await f.dispose();
      await Deno.remove(toolDir, { recursive: true });
    }
  },
});
```

- [ ] **Step 2: Add the skeleton** — in `src/job.ts`, add inside the class (after `cancel`)

```ts
  shutdown(_opts: { deadlineMs?: number } = {}): Promise<void> {
    return Promise.reject(new Error("not implemented"));
  }

  abortSync(): void {
    throw new Error("not implemented");
  }
```

- [ ] **Step 3: Run test to verify it fails**

Run: `deno task test tests/job_shutdown_test.ts`
Expected: 8 tests FAIL with `Error: not implemented`.

- [ ] **Step 4: Implement** — in `src/job.ts`:

Change the ffmpeg import line to:

```ts
import { type FfmpegRun, killAllChildren, probeDuration, runFfmpeg } from "./ffmpeg.ts";
```

Add this field after `#run`:

```ts
  #shutdownPromise: Promise<void> | null = null;
```

Replace the two skeleton methods with:

```ts
  /**
   * Graceful shutdown for the Cmd+Q path. Blocks new
   * state-changing calls, winds down the current job, closes the CDP
   * connection, and always ends with killAllChildren() because Deno.exit()
   * does not terminate child processes.
   */
  shutdown(opts: { deadlineMs?: number } = {}): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shuttingDown = true;
    this.#shutdownPromise = this.#runShutdown(opts.deadlineMs ?? 10_000);
    return this.#shutdownPromise;
  }

  async #runShutdown(deadlineMs: number): Promise<void> {
    const graceful = (async () => {
      const status = this.#status;
      if (status.state === "extracting") {
        this.#client?.close(); // Pending CDP requests reject immediately.
      } else if (status.state === "processing" && status.phase !== "publishing") {
        this.cancel();
      }
      // Publishing is awaited, never interrupted.
      await this.#work?.catch(() => {});
      // Ready-state files are cleaned after the work settles: the job may have
      // been ready from the start, or returned to ready after a publish failure.
      if (this.#status.state === "ready") {
        const dir = this.#detachReadyFiles();
        if (dir) await Deno.remove(dir, { recursive: true }).catch(() => {});
      }
      await this.#connecting?.catch(() => {});
      this.#client?.close();
      this.#client = null;
    })();
    let timer: number | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, deadlineMs);
    });
    await Promise.race([graceful, deadline]);
    clearTimeout(timer);
    killAllChildren();
  }

  /**
   * Close-button path: the process dies right after the close
   * event, so only synchronous, best-effort cleanup is possible.
   */
  abortSync(): void {
    killAllChildren();
    const dir = this.#tempDir;
    if (!dir) return;
    try {
      Deno.removeSync(dir, { recursive: true });
    } catch {
      // Startup cleanup retries leftovers on the next launch.
    }
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `deno task test tests/job_shutdown_test.ts`
Expected: `ok | 8 passed | 0 failed`.

- [ ] **Step 6: Update the job fixture to shut jobs down** — in `tests/helpers/job_fixture.ts`, replace the first two lines of `dispose()` (`killAllChildren();` and `await server.close();`) with:

```ts
      await job.shutdown({ deadlineMs: 3000 });
      await server.close();
```

and remove the now-unused `import { killAllChildren } from "../../src/ffmpeg.ts";`.

- [ ] **Step 7: Run the whole suite** — `deno task test` → all tests pass.

- [ ] **Step 8: Verification gate** — `deno task check && deno task lint && deno fmt && deno fmt --check`

- [ ] **Step 9: Commit** — git-master: `src/job.ts`, `tests/job_shutdown_test.ts`, `tests/helpers/job_fixture.ts`; message `feat: add graceful shutdown and synchronous abort to JobManager`.

---

### Task 19: UI files and the UI asset server

**Files:**
- Create: `ui/index.html`
- Create: `ui/style.css`
- Create: `ui/app.js`
- Create: `src/ui-assets.ts`
- Test: `tests/ui_assets_test.ts`

The UI is plain JS run by WKWebView; it talks to the backend only through the `bindings` global (spec §6.10, §6.12). `getSettings` additionally returns `urlPattern` (from `JobManager.urlPattern`, keeping `user/` imports inside the modules the spec §4 allows) so the tab list can show it in its empty state (spec §6.12 item 2), and `probeWarning` (from `JobManager.probeWarning`) so a failed duration probe is shown on the settings page (spec §8).

- [ ] **Step 1: Write the failing test** — `tests/ui_assets_test.ts`

```ts
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
  for (const path of ["/settings.json", "/constructor", "/toString", "/__proto__", "/hasOwnProperty"]) {
    const response = serveUi(new Request(`http://127.0.0.1${path}`));
    assertEquals(response.status, 404, path);
    await response.body?.cancel();
  }
});

Deno.test("every element id used by app.js exists in index.html", () => {
  const html = UI_ASSETS.get("/")!.body;
  const js = UI_ASSETS.get("/app.js")!.body;
  const ids = [...js.matchAll(/(?:\$|setText|setHidden|showError)\("([\w-]+)"/g)].map((match) => match[1]);
  assert(new Set(ids).size > 30, "expected app.js to reference many elements");
  for (const id of new Set(ids)) assertStringIncludes(html, `id="${id}"`, `missing #${id}`);
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
  const used = new Set([...js.matchAll(/bindings\.(\w+)\(/g)].map((match) => match[1]));
  assertEquals(used.size, registered.length, `app.js uses ${[...used].join(", ")}`);
  for (const name of used) assert(registered.includes(name), `unregistered binding ${name}`);
});
```

- [ ] **Step 2: Create empty UI files and the skeleton**

Create `ui/index.html`, `ui/style.css` and `ui/app.js` as **empty files**, and `src/ui-assets.ts`:

```ts
import indexHtml from "../ui/index.html" with { type: "text" };
import appJs from "../ui/app.js" with { type: "text" };
import styleCss from "../ui/style.css" with { type: "text" };

// A Map, not a plain object: paths like /constructor must not resolve to
// inherited properties.
export const UI_ASSETS = new Map<string, { body: string; contentType: string }>([
  ["/", { body: indexHtml, contentType: "text/html; charset=utf-8" }],
  ["/app.js", { body: appJs, contentType: "text/javascript; charset=utf-8" }],
  ["/style.css", { body: styleCss, contentType: "text/css; charset=utf-8" }],
]);

export function serveUi(_request: Request): Response {
  return new Response("");
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `deno task test tests/ui_assets_test.ts`
Expected: 4 tests FAIL — content type is `text/plain;charset=UTF-8`, the unknown path returns 200, no element ids are found, no bindings are used.

- [ ] **Step 4: Write `ui/index.html`**

```html
<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8">
    <title>Tab Ripper</title>
    <link rel="stylesheet" href="/style.css">
  </head>
  <body>
    <header class="topbar">
      <h1>Tab Ripper</h1>
      <button id="open-settings" type="button">設定</button>
    </header>

    <main>
      <section id="screen-connect" class="screen" hidden>
        <h2>連線到瀏覽器</h2>
        <div id="connect-closed">
          <p>
            請在瀏覽器網址列開啟 <code>chrome://inspect/#remote-debugging</code>
            並打開遠端偵錯開關（Brave 也可直接使用此網址）。
          </p>
          <p class="muted">探測位址：<code id="probe-address"></code>（每 2 秒自動重試）</p>
          <button id="probe-retry" type="button">重試</button>
        </div>
        <div id="connect-open" hidden>
          <p>偵測到瀏覽器偵錯埠：<code id="probe-address-open"></code></p>
          <button id="connect-button" type="button" class="primary">連線</button>
          <p id="connect-hint" class="muted" hidden>請在瀏覽器跳出的對話框按允許…</p>
        </div>
        <p id="connect-error" class="error" hidden></p>
      </section>

      <section id="screen-tabs" class="screen" hidden>
        <div class="row">
          <h2>選擇分頁</h2>
          <button id="tabs-refresh" type="button">重新整理</button>
        </div>
        <ul id="tab-list" class="tab-list"></ul>
        <p id="tabs-empty" class="muted" hidden>沒有符合網址規則的分頁：<code id="tabs-pattern"></code></p>
        <p id="tabs-error" class="error" hidden></p>
      </section>

      <section id="screen-extracting" class="screen" hidden>
        <h2>擷取中</h2>
        <progress id="extract-progress" max="1" value="0"></progress>
        <p id="extract-bytes"></p>
        <p class="warning">關閉視窗會中斷目前工作；請用 Cmd+Q 安全結束</p>
      </section>

      <section id="screen-preview" class="screen" hidden>
        <h2>確認資訊</h2>
        <p id="preview-error" class="error banner" hidden></p>
        <table id="info-table" class="info-table"><tbody></tbody></table>
        <label class="field">輸出檔名 <input id="filename" type="text" spellcheck="false"></label>
        <p id="tool-warning" class="error" hidden>ffmpeg 無法執行，請到設定修正 ffmpeg 路徑。</p>
        <div class="actions">
          <button id="discard-button" type="button">取消</button>
          <button id="start-button" type="button" class="primary">開始處理</button>
        </div>
      </section>

      <section id="screen-processing" class="screen" hidden>
        <h2 id="processing-title">處理中</h2>
        <progress id="process-progress" max="100"></progress>
        <p id="process-detail"></p>
        <p id="process-message" class="mono ellipsis"></p>
        <p id="process-error" class="error" hidden></p>
        <p class="warning">關閉視窗會中斷目前工作；請用 Cmd+Q 安全結束</p>
        <div class="actions">
          <button id="cancel-button" type="button">取消</button>
        </div>
      </section>

      <section id="screen-result" class="screen" hidden>
        <h2 id="result-title"></h2>
        <p id="result-message"></p>
        <pre id="result-detail" class="mono" hidden></pre>
        <p id="result-cleanup" class="warning" hidden></p>
        <p id="result-error" class="error" hidden></p>
        <div class="actions">
          <button id="reveal-button" type="button" hidden>在 Finder 中顯示</button>
          <button id="again-button" type="button" class="primary">再一次</button>
        </div>
      </section>
    </main>

    <dialog id="settings-dialog">
      <form id="settings-form" method="dialog">
        <h2>設定</h2>
        <p id="settings-warning" class="warning" hidden></p>
        <label class="field">CDP 位址 <input name="cdpAddress" type="text" spellcheck="false"></label>
        <label class="field">輸出資料夾 <input name="outputDir" type="text" spellcheck="false"></label>
        <label class="field">ffmpeg 路徑 <input name="ffmpegPath" type="text" spellcheck="false"></label>
        <p id="tool-ffmpeg" class="muted"></p>
        <label class="field">ffprobe 路徑 <input name="ffprobePath" type="text" spellcheck="false"></label>
        <p id="tool-ffprobe" class="muted"></p>
        <p id="probe-warning" class="warning" hidden></p>
        <p id="settings-error" class="error" hidden></p>
        <div class="actions">
          <button id="settings-close" type="button">關閉</button>
          <button id="settings-save" type="button" class="primary">儲存</button>
        </div>
      </form>
    </dialog>

    <div id="shutdown-overlay" class="overlay" hidden>正在結束…</div>
    <script src="/app.js"></script>
  </body>
</html>
```

- [ ] **Step 5: Write `ui/style.css`**

```css
:root {
  color-scheme: light dark;
  --bg: #f6f6f7;
  --fg: #1d1d1f;
  --muted: #6e6e73;
  --accent: #0a66d8;
  --error: #c42b1c;
  --warning: #9a6700;
  --panel: #ffffff;
  --border: #d2d2d7;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang TC", sans-serif;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1c1c1e;
    --fg: #f2f2f7;
    --muted: #a1a1a6;
    --accent: #4c9bff;
    --error: #ff6b5e;
    --warning: #e3b341;
    --panel: #2c2c2e;
    --border: #3a3a3c;
  }
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
}

.topbar h1 {
  margin: 0;
  font-size: 18px;
}

main {
  padding: 20px;
}

.screen {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px 20px;
}

.screen[hidden],
.overlay[hidden] {
  display: none;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.muted {
  color: var(--muted);
}

.error {
  color: var(--error);
}

.warning {
  color: var(--warning);
}

.banner {
  padding: 8px 12px;
  border: 1px solid var(--error);
  border-radius: 6px;
}

.mono {
  font-family: ui-monospace, Menlo, monospace;
  font-size: 12px;
}

.ellipsis {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

pre.mono {
  white-space: pre-wrap;
  max-height: 240px;
  overflow: auto;
}

button {
  font: inherit;
  padding: 6px 14px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--fg);
}

button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #ffffff;
}

button:disabled {
  opacity: 0.5;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

.tab-list {
  list-style: none;
  padding: 0;
}

.tab-list .tab {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  margin-bottom: 8px;
  text-align: left;
}

.info-table {
  border-collapse: collapse;
  margin-bottom: 12px;
}

.info-table th,
.info-table td {
  border-bottom: 1px solid var(--border);
  padding: 4px 12px 4px 0;
  text-align: left;
  vertical-align: top;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 10px 0;
}

.field input {
  font: inherit;
  padding: 6px 8px;
}

progress {
  width: 100%;
}

dialog {
  min-width: 480px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  color: var(--fg);
}

.overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.6);
  color: #ffffff;
  font-size: 28px;
}
```

- [ ] **Step 6: Write `ui/app.js`**

```js
// Tab Ripper UI. The backend owns all state; this file renders it and calls
// the deno desktop `bindings` global for every action.

const bindings = globalThis.bindings;
const POLL_MS = 250;
const PROBE_MS = 2000;
const SETTING_KEYS = ["cdpAddress", "outputDir", "ffmpegPath", "ffprobePath"];

const ui = {
  screen: null,
  connected: false,
  shuttingDown: false,
  settings: null,
  tools: null,
  urlPattern: "",
  pollTimer: null,
  polling: false,
  refreshQueued: false,
  startPending: false,
  probeTimer: null,
  resultPath: null,
};

const $ = (id) => document.getElementById(id);

function errorText(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const pad = (n) => String(n).padStart(2, "0");
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function setText(id, text) {
  $(id).textContent = text;
}

function setHidden(id, hidden) {
  $(id).hidden = hidden;
}

function showError(id, error) {
  const element = $(id);
  if (error === null || error === undefined) {
    element.hidden = true;
    element.textContent = "";
  } else {
    element.hidden = false;
    element.textContent = errorText(error);
  }
}

function showScreen(name) {
  for (const section of document.querySelectorAll(".screen")) {
    section.hidden = section.id !== `screen-${name}`;
  }
  ui.screen = name;
}

// ---- status polling (only while extracting/processing) ----

function startPolling() {
  if (ui.pollTimer === null) ui.pollTimer = setInterval(() => void refresh(), POLL_MS);
}

function stopPolling() {
  if (ui.pollTimer !== null) {
    clearInterval(ui.pollTimer);
    ui.pollTimer = null;
  }
}

async function refresh() {
  if (ui.shuttingDown) return;
  if (ui.polling) {
    // A refresh requested mid-flight must not be dropped: the in-flight one
    // may hold a stale snapshot taken before the caller's action.
    ui.refreshQueued = true;
    return;
  }
  ui.polling = true;
  try {
    const [status, connection] = await Promise.all([bindings.getStatus(), bindings.getConnection()]);
    // Shutdown may have started while the request was in flight.
    if (ui.shuttingDown) return;
    ui.connected = connection.connected;
    render(status);
  } catch (error) {
    console.error(error);
  } finally {
    ui.polling = false;
  }
  if (ui.refreshQueued && !ui.shuttingDown) {
    ui.refreshQueued = false;
    await refresh();
  }
}

// Screen = f(job state, connected); the job state wins.
function render(status) {
  switch (status.state) {
    case "extracting":
      stopProbing();
      showScreen("extracting");
      renderExtracting(status);
      startPolling();
      break;
    case "ready":
      stopProbing();
      // While a start request is pending, a stale "ready" snapshot must not
      // stop polling: the backend may already be preparing.
      if (!ui.startPending) stopPolling();
      renderPreview(status);
      break;
    case "processing":
      stopProbing();
      if (ui.screen !== "processing") showError("process-error", null);
      showScreen("processing");
      renderProcessing(status);
      startPolling();
      break;
    case "done":
    case "failed":
    case "cancelled":
      stopProbing();
      stopPolling();
      renderResult(status);
      break;
    default:
      stopPolling();
      if (ui.connected) {
        stopProbing();
        if (ui.screen !== "tabs") {
          showScreen("tabs");
          void loadTabs();
        }
      } else if (ui.screen !== "connect") {
        showScreen("connect");
        startProbing();
      }
  }
}

// ---- 1. connect ----

function startProbing() {
  stopProbing();
  void probeOnce();
}

function stopProbing() {
  if (ui.probeTimer !== null) {
    clearTimeout(ui.probeTimer);
    ui.probeTimer = null;
  }
}

async function probeOnce() {
  ui.probeTimer = null;
  if (ui.screen !== "connect" || ui.shuttingDown) return;
  try {
    const result = await bindings.probe();
    setText("probe-address", result.address);
    setText("probe-address-open", result.address);
    setHidden("connect-closed", result.open);
    setHidden("connect-open", !result.open);
    if (!result.open && ui.screen === "connect") {
      ui.probeTimer = setTimeout(() => void probeOnce(), PROBE_MS);
    }
  } catch (error) {
    showError("connect-error", error);
    ui.probeTimer = setTimeout(() => void probeOnce(), PROBE_MS);
  }
}

async function connect() {
  showError("connect-error", null);
  setHidden("connect-hint", false);
  $("connect-button").disabled = true;
  try {
    await bindings.connect();
  } catch (error) {
    showError("connect-error", error);
  } finally {
    setHidden("connect-hint", true);
    $("connect-button").disabled = false;
  }
  await refresh();
  if (ui.screen === "connect") startProbing();
}

// ---- 2. tabs ----

async function loadTabs() {
  showError("tabs-error", null);
  try {
    const tabs = await bindings.listTabs();
    const list = $("tab-list");
    list.replaceChildren();
    for (const tab of tabs) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tab";
      const title = document.createElement("strong");
      title.textContent = tab.title || "（無標題）";
      const url = document.createElement("span");
      url.className = "muted";
      url.textContent = tab.url;
      button.append(title, url);
      button.addEventListener("click", () => void startExtract(tab.targetId));
      item.append(button);
      list.append(item);
    }
    setText("tabs-pattern", ui.urlPattern);
    setHidden("tabs-empty", tabs.length > 0);
  } catch (error) {
    showError("tabs-error", error);
    await refresh(); // Falls back to the connect screen if the connection dropped.
  }
}

async function startExtract(targetId) {
  try {
    await bindings.extract(targetId);
  } catch (error) {
    showError("tabs-error", error);
  }
  // Also after a failure: a dropped connection must lead back to the connect screen.
  await refresh();
}

// ---- 3. extracting ----

function renderExtracting(status) {
  const bar = $("extract-progress");
  if (status.total > 0) {
    bar.max = status.total;
    bar.value = status.received;
  } else {
    bar.removeAttribute("value");
  }
  setText("extract-bytes", `${formatBytes(status.received)} / ${formatBytes(status.total)}`);
}

// ---- 4. preview ----

function renderPreview(status) {
  const entering = ui.screen !== "preview";
  // Back from the processing screen (overwrite confirmation or destination
  // failure): keep the filename the user typed.
  const fromProcessing = ui.screen === "processing";
  showScreen("preview");
  // Do not wipe an error shown by an action while staying on this screen.
  if (entering || status.lastError) showError("preview-error", status.lastError ?? null);
  const body = $("info-table").querySelector("tbody");
  body.replaceChildren();
  const addRow = (label, value) => {
    const row = document.createElement("tr");
    const head = document.createElement("th");
    head.textContent = label;
    const cell = document.createElement("td");
    cell.textContent = value;
    row.append(head, cell);
    body.append(row);
  };
  for (const column of status.columns) {
    const value = status.info[column.key];
    addRow(column.label, value === undefined ? "" : String(value));
  }
  addRow("主檔大小", formatBytes(status.mainSize));
  addRow("輔助檔大小", formatBytes(status.auxSize));
  // Keep what the user typed when re-rendering or returning from processing.
  if (entering && !fromProcessing) $("filename").value = status.defaultFilename;
  const ffmpegOk = ui.tools ? ui.tools.ffmpeg.ok : true;
  $("start-button").disabled = !ffmpegOk;
  setHidden("tool-warning", ffmpegOk);
}

async function startProcessing() {
  const filename = $("filename").value;
  showError("preview-error", null);
  try {
    let confirmed = null;
    for (;;) {
      // Poll while the binding is pending: destination checks can be slow,
      // and the processing screen (with its cancel button) must show at once.
      ui.startPending = true;
      startPolling();
      let result;
      try {
        result = await bindings.startProcess(filename, confirmed);
      } finally {
        ui.startPending = false;
      }
      if (!result.needsConfirm) break;
      await refresh(); // Back to the preview behind the confirmation dialog.
      if (!confirm(`檔案已存在，要覆蓋嗎？\n${result.finalPath}`)) return;
      confirmed = result.finalPath;
    }
  } catch (error) {
    await refresh();
    showError("preview-error", error);
    return;
  }
  await refresh();
}

async function discard() {
  try {
    await bindings.discard();
  } catch (error) {
    showError("preview-error", error);
    return;
  }
  await refresh();
}

// ---- 5. processing ----

function renderProcessing(status) {
  const bar = $("process-progress");
  if (status.phase === "preparing") {
    setText("processing-title", "準備中");
    bar.removeAttribute("value");
    setText("process-detail", "");
  } else if (status.phase === "publishing") {
    setText("processing-title", "輸出檔案中");
    bar.removeAttribute("value");
    setText("process-detail", "");
  } else {
    setText("processing-title", "處理中");
    const speed = status.speed === null ? "" : `，速度 ${status.speed}x`;
    if (status.percent !== null && status.durationSec !== null) {
      bar.value = status.percent;
      setText(
        "process-detail",
        `${status.percent.toFixed(1)}%（${formatTime(status.outTimeSec)} / ${formatTime(status.durationSec)}）${speed}`,
      );
    } else {
      bar.removeAttribute("value");
      setText("process-detail", `已處理 ${formatTime(status.outTimeSec)}${speed}`);
    }
  }
  const message = status.phase === "running" ? (status.message ?? "") : "";
  setText("process-message", message);
  $("process-message").title = message;
  $("cancel-button").disabled = status.phase === "publishing";
}

async function cancelProcessing() {
  showError("process-error", null);
  try {
    await bindings.cancel();
  } catch (error) {
    showError("process-error", error);
  }
  await refresh();
}

// ---- 6. result ----

function renderResult(status) {
  if (ui.screen !== "result") showError("result-error", null);
  showScreen("result");
  const detail = $("result-detail");
  detail.hidden = true;
  detail.textContent = "";
  setHidden("reveal-button", true);
  ui.resultPath = null;
  if (status.state === "done") {
    setText("result-title", "完成");
    setText("result-message", `已輸出：${status.outputPath}`);
    ui.resultPath = status.outputPath;
    setHidden("reveal-button", false);
  } else if (status.state === "failed") {
    setText("result-title", status.stage === "extract" ? "擷取失敗" : "處理失敗");
    setText("result-message", status.message);
    if (status.detail && status.detail.length > 0) {
      detail.textContent = status.detail.join("\n");
      detail.hidden = false;
    }
  } else {
    setText("result-title", "已取消");
    setText("result-message", "工作已取消。");
  }
  setHidden("result-cleanup", !status.cleanupWarning);
  setText("result-cleanup", status.cleanupWarning ?? "");
}

async function again() {
  showError("result-error", null);
  try {
    await bindings.reset();
  } catch (error) {
    showError("result-error", error);
  }
  await refresh();
}

async function reveal() {
  if (ui.resultPath === null) return;
  showError("result-error", null);
  try {
    await bindings.revealInFinder(ui.resultPath);
  } catch (error) {
    showError("result-error", error);
  }
}

// ---- settings ----

async function loadSettings() {
  const data = await bindings.getSettings();
  ui.settings = data.settings;
  ui.tools = data.tools;
  ui.urlPattern = data.urlPattern;
  setHidden("settings-warning", !data.warning);
  setText("settings-warning", data.warning ?? "");
  setHidden("probe-warning", !data.probeWarning);
  setText("probe-warning", data.probeWarning ?? "");
  renderTools();
}

function renderTools() {
  if (!ui.tools) return;
  const describe = (check) => check.ok ? `可用：${check.version ?? ""}` : `無法執行：${check.error ?? ""}`;
  setText("tool-ffmpeg", describe(ui.tools.ffmpeg));
  setText("tool-ffprobe", describe(ui.tools.ffprobe));
  $("tool-ffmpeg").className = ui.tools.ffmpeg.ok ? "muted" : "error";
  $("tool-ffprobe").className = ui.tools.ffprobe.ok ? "muted" : "warning";
}

async function openSettings() {
  // Reload so tool checks and the latest ffprobe warning are current.
  try {
    await loadSettings();
  } catch (error) {
    console.error(error);
  }
  if (ui.shuttingDown) return;
  const form = $("settings-form");
  for (const key of SETTING_KEYS) form.elements.namedItem(key).value = ui.settings ? ui.settings[key] : "";
  showError("settings-error", null);
  renderTools();
  $("settings-dialog").showModal();
}

async function saveSettingsFromForm() {
  const form = $("settings-form");
  const next = {};
  for (const key of SETTING_KEYS) next[key] = form.elements.namedItem(key).value.trim();
  try {
    const result = await bindings.saveSettings(next);
    // The settings are in effect even if writing the file failed.
    ui.settings = next;
    ui.tools = result.tools;
    renderTools();
    if (result.persistError) {
      // Keep the dialog open so the write failure stays visible.
      showError("settings-error", result.persistError);
    } else {
      showError("settings-error", null);
      $("settings-dialog").close();
    }
  } catch (error) {
    // Rejected before anything was applied (validation, or a CDP address
    // change while extracting): settings are unchanged.
    showError("settings-error", error);
    return;
  }
  if (ui.screen === "connect") startProbing();
  // Reconcile with the backend after any settings change (e.g. a dropped
  // connection while the dialog was open, or ffmpeg becoming usable).
  await refresh();
}

// ---- shutdown overlay (called by the backend via executeJs) ----

globalThis.__showShuttingDown = () => {
  ui.shuttingDown = true;
  stopPolling();
  stopProbing();
  // A modal dialog sits in the top layer above the overlay, so close it first.
  const dialog = $("settings-dialog");
  if (dialog.open) dialog.close();
  setHidden("shutdown-overlay", false);
};

// ---- wiring ----

function wire() {
  $("open-settings").addEventListener("click", () => void openSettings());
  $("settings-close").addEventListener("click", () => $("settings-dialog").close());
  // Closing settings by any means (button, Escape, save) reconciles the
  // current screen, e.g. the start button after a tool re-check.
  $("settings-dialog").addEventListener("close", () => void refresh());
  $("settings-save").addEventListener("click", () => void saveSettingsFromForm());
  $("probe-retry").addEventListener("click", () => startProbing());
  $("connect-button").addEventListener("click", () => void connect());
  $("tabs-refresh").addEventListener("click", () => void loadTabs());
  $("start-button").addEventListener("click", () => void startProcessing());
  $("discard-button").addEventListener("click", () => void discard());
  $("cancel-button").addEventListener("click", () => void cancelProcessing());
  $("again-button").addEventListener("click", () => void again());
  $("reveal-button").addEventListener("click", () => void reveal());
}

async function init() {
  wire();
  try {
    await loadSettings();
  } catch (error) {
    console.error(error);
  }
  await refresh();
}

void init();
```

- [ ] **Step 7: Run the consistency tests** — `deno task test tests/ui_assets_test.ts`
Expected: the two consistency tests (element ids, bindings) now PASS; the two `serveUi` tests still FAIL against the skeleton.

- [ ] **Step 8: Implement** — replace `serveUi` in `src/ui-assets.ts`

```ts
/** Serves `/`, `/app.js`, `/style.css`; everything else is 404. */
export function serveUi(request: Request): Response {
  const asset = UI_ASSETS.get(new URL(request.url).pathname);
  if (!asset) return new Response("Not Found", { status: 404 });
  return new Response(asset.body, { headers: { "content-type": asset.contentType } });
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `deno task test tests/ui_assets_test.ts`
Expected: `ok | 4 passed | 0 failed`.

- [ ] **Step 10: Verification gate** — `deno task check && deno task lint && deno fmt && deno fmt --check` (`deno lint`/`deno fmt` also cover `ui/app.js`; `deno check` does not type-check it, spec §7).

- [ ] **Step 11: Commit** — git-master, two commits: (1) `ui/index.html`, `ui/style.css`, `ui/app.js` with message `feat: add Tab Ripper UI`; (2) `src/ui-assets.ts`, `tests/ui_assets_test.ts` with message `feat: serve embedded UI assets`.

---

### Task 20: Desktop entry point (`main.ts`)

**Files:**
- Create: `main.ts`
- Modify: `deno.json` (`check` task)

`main.ts` only wires already-tested units to `deno desktop` APIs (`Deno.BrowserWindow`, `bind`, `setApplicationMenu`, `executeJs`, `close`/`menuclick` events), which exist only in `deno desktop` builds; its gate is type check, lint, the full test suite and a successful build. Its behaviour is verified manually in Task 21.

- [ ] **Step 1: Create `main.ts`**

```ts
// Tab Ripper desktop entry: window, menu, bindings, close handling, UI server.
import { cleanupStaleArtifacts, systemTempRoot } from "./src/cleanup.ts";
import { probeCdpPort } from "./src/cdp/probe.ts";
import { checkTool, killAllChildren } from "./src/ffmpeg.ts";
import { JobManager, SHUTTING_DOWN_MESSAGE } from "./src/job.ts";
import { loadSettings, saveSettings, validateSettings } from "./src/settings.ts";
import type { Settings, ToolCheck } from "./src/types.ts";
import { serveUi } from "./src/ui-assets.ts";

const loaded = await loadSettings();
let settings: Settings = loaded.settings;
const job = new JobManager(settings);

const win = new Deno.BrowserWindow({ title: "Tab Ripper", width: 960, height: 720 });

/** Runs `fn` and turns synchronous throws into rejections for bindings. */
function run<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error);
  }
}

async function checkTools(current: Settings): Promise<{ ffmpeg: ToolCheck; ffprobe: ToolCheck }> {
  // No new child processes once shutdown has started: they could outlive
  // the final killAllChildren() before Deno.exit().
  if (job.isShuttingDown) {
    const skipped: ToolCheck = { ok: false, error: SHUTTING_DOWN_MESSAGE };
    return { ffmpeg: skipped, ffprobe: skipped };
  }
  const [ffmpeg, ffprobe] = await Promise.all([checkTool(current.ffmpegPath), checkTool(current.ffprobePath)]);
  return { ffmpeg, ffprobe };
}

win.bind("getSettings", async () => ({
  settings,
  warning: loaded.warning ?? null,
  tools: await checkTools(settings),
  urlPattern: job.urlPattern,
  probeWarning: job.probeWarning,
}));

win.bind("saveSettings", async (next: Settings) => {
  if (job.isShuttingDown) throw new Error(SHUTTING_DOWN_MESSAGE);
  const candidate: Settings = {
    cdpAddress: String(next.cdpAddress).trim(),
    outputDir: String(next.outputDir).trim(),
    ffmpegPath: String(next.ffmpegPath).trim(),
    ffprobePath: String(next.ffprobePath).trim(),
  };
  // Validate and commit synchronously, before any await, so no job can be
  // admitted between the check and the change. updateSettings refuses a CDP
  // address change while extracting and drops the connection otherwise.
  validateSettings(candidate);
  job.updateSettings(candidate);
  settings = candidate;
  // A failed write is a partial success: the new settings are already in
  // effect, so return the fresh tool checks together with the error.
  let persistError: string | null = null;
  try {
    await saveSettings(candidate);
  } catch (error) {
    persistError = `設定已套用但未能寫入設定檔：${error instanceof Error ? error.message : String(error)}`;
  }
  return { tools: await checkTools(candidate), persistError };
});

win.bind("probe", async () => ({ open: await probeCdpPort(settings.cdpAddress), address: settings.cdpAddress }));
win.bind("connect", () => run(() => job.connect()));
win.bind("getConnection", () => run(() => ({ connected: job.isConnected() })));
win.bind("listTabs", () => run(() => job.listTabs()));
win.bind("extract", (targetId: string) => run(() => job.extract(String(targetId))));
win.bind("getStatus", () => run(() => job.getStatus()));
win.bind("discard", () => run(() => job.discard()));
win.bind(
  "startProcess",
  (filename: string, confirmedOverwritePath: string | null) =>
    run(() =>
      job.startProcess(
        String(filename),
        confirmedOverwritePath === null ? null : String(confirmedOverwritePath),
      )
    ),
);
win.bind("cancel", () => run(() => job.cancel()));
win.bind("reset", () => run(() => job.reset()));
win.bind("revealInFinder", async (path: string) => {
  await new Deno.Command("open", { args: ["-R", String(path)], stdout: "null", stderr: "null" }).output();
});

// A custom quit item instead of role "quit": the OS handles role items
// without telling JS, which would skip the graceful shutdown.
win.setApplicationMenu([
  {
    submenu: {
      label: "Tab Ripper",
      items: [{ item: { label: "結束 Tab Ripper", id: "quit", accelerator: "CmdOrCtrl+Q", enabled: true } }],
    },
  },
  {
    submenu: {
      label: "編輯",
      items: [
        { role: { role: "undo" } },
        { role: { role: "redo" } },
        { role: { role: "cut" } },
        { role: { role: "copy" } },
        { role: { role: "paste" } },
        { role: { role: "selectAll" } },
      ],
    },
  },
]);

let quitting = false;
let shutdownDone = false;

/** Graceful quit for Cmd+Q / the menu quit item. */
async function requestShutdown(): Promise<void> {
  if (quitting) return;
  quitting = true;
  // Start shutdown before any await so state-changing bindings are refused
  // immediately; the overlay is shown while it runs.
  const shutdown = job.shutdown({ deadlineMs: 10_000 });
  let overlayTimer: number | undefined;
  await Promise.race([
    win.executeJs("window.__showShuttingDown?.()").catch(() => null),
    new Promise((resolve) => {
      overlayTimer = setTimeout(resolve, 1000);
    }),
  ]);
  clearTimeout(overlayTimer);
  await shutdown;
  shutdownDone = true;
  // No await between this kill and exit: nothing can spawn in between.
  killAllChildren();
  win.close();
  Deno.exit(0);
}

win.addEventListener("menuclick", (event) => {
  if (event.detail.id === "quit") void requestShutdown();
});

// The close event cannot be cancelled in Deno 2.9.7 and the
// process dies right after it, so only synchronous cleanup runs here.
win.addEventListener("close", () => {
  if (shutdownDone) return;
  job.abortSync();
});

Deno.serve(serveUi);

// Best-effort cleanup of earlier runs; never blocks the UI.
void systemTempRoot()
  .then((root) => cleanupStaleArtifacts(root, settings.outputDir))
  .catch((error) => console.warn(`[tab-ripper] startup cleanup skipped: ${String(error)}`));
```

- [ ] **Step 2: Add `main.ts` to the check task** — in `deno.json`, change `"check": "deno check src/ user/ tests/"` to:

```json
    "check": "deno check main.ts src/ user/ tests/",
```

- [ ] **Step 3: Verify**

Run: `deno task check && deno task lint && deno fmt && deno fmt --check && deno task test`
Expected: type check passes (the `deno.desktop` lib provides `Deno.BrowserWindow`; spec §3.1), lint/fmt clean, all tests pass.

- [ ] **Step 4: Build**

Run: `deno task build`
Expected: ends with `Bundle dist/TabRipper.app`; `ls -d dist/TabRipper.app` prints the bundle path (not `TabRipper.app.app`).

- [ ] **Step 5: Commit** — git-master: `main.ts`, `deno.json`; message `feat: wire Tab Ripper desktop entry point`. (`dist/` is gitignored.)

---

### Task 21: Manual acceptance with the user (Brave)

**Files:** none committed. Acceptance uses a temporary `user/` configuration that is reverted afterwards.

The automated suite cannot drive the desktop window or the real browser (spec §9 manual list). The user performs the UI actions; the implementer runs commands, reads logs and records results.

- [ ] **Step 1: Back up and install the temporary acceptance configuration** — first back up the current files (they may contain the user's own work) into a fresh, uniquely named directory: run `mktemp -d "$TMPDIR/tab-ripper-user-backup.XXXXXX"`, record the printed path as `BACKUP` (it is needed in Step 4 and in any restarted session), then `cp user/config.ts user/page-script.js user/info.ts user/ffmpeg-args.ts "$BACKUP"/`. If acceptance is ever restarted, reuse the recorded `BACKUP` and **skip this backup** — never back up the acceptance fixtures over it. Then overwrite these files (restored in Step 4):

`user/config.ts`:

```ts
export const URL_PATTERN: RegExp = /^https:\/\//;
export const PROBE_DURATION: boolean = true;
```

`user/page-script.js` (waits 5 s so the tab can be closed mid-extraction, then generates a 20-second 440 Hz WAV in the page, so `-re` encoding lasts ~20 s):

```js
export default async function pageScript() {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const rate = 8000;
  const seconds = 20;
  const samples = rate * seconds;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    view.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), true);
  }
  return {
    main: buffer,
    aux: new TextEncoder().encode("aux"),
    info: { title: document.title || "untitled", url: location.href },
  };
}
```

`user/info.ts`:

```ts
import type { Info, InfoColumn } from "../src/types.ts";

export const INFO_COLUMNS: InfoColumn[] = [
  { key: "title", label: "標題" },
  { key: "url", label: "網址" },
];

export function defaultFilename(info: Info): string {
  return `${info.title ?? "output"}.m4a`;
}
```

`user/ffmpeg-args.ts`:

```ts
import type { FfmpegArgsContext } from "../src/types.ts";

export function buildFfmpegArgs(ctx: FfmpegArgsContext): string[] {
  return ["-re", "-i", ctx.mainPath, "-c:a", "aac", ctx.outputPath];
}
```

Then run `deno task build`.

- [ ] **Step 2: Walk the user through spec §9 manual checklist** with `open dist/TabRipper.app`, recording PASS/FAIL for each:
  1. Remote debugging toggle OFF in Brave → connect screen shows the `chrome://inspect/#remote-debugging` guidance; turning it ON switches to "偵測到" within 2 s and Brave shows **no** permission dialog.
  2. Still on the connect screen (not yet connected): set 設定 › CDP 位址 to `127.0.0.1:9223` → the probe shows not detected; set it back to `127.0.0.1:9222` → detected again. Then click 連線 → exactly one Brave permission dialog; after Allow the tab list appears.
  3. Finish one job, click 再一次 → no new permission dialog.
  4. Start an extraction and close that tab within the script's 5-second delay → "分頁已關閉或已中斷偵錯連線".
  5. Pick a never-opened (dormant) tab → about 3 s later "分頁尚未載入"; open that tab in Brave and retry → success.
  6. During processing click 取消 → no file in the output folder; `ls "$TMPDIR" | grep ffdl-` shows no dir for this job.
  7. Quit the app with Cmd+Q, set `PROBE_DURATION = false` in `user/config.ts`, run `deno task build`, relaunch with `open dist/TabRipper.app`, connect and process → indeterminate progress bar with elapsed time; the ffmpeg status line (`frame=`/`size=`…) is shown under the bar. Quit with Cmd+Q, set it back to `true`, run `deno task build`, relaunch for the remaining items.
  8. During processing, first run `pgrep -fl ffdl-` and record the app's ffmpeg PID (its command line contains the `ffdl-<session>` temp path, so unrelated ffmpeg jobs are not matched). Press Cmd+Q → "正在結束…" overlay, app quits within a few seconds; `ps -p <PID>` reports no such process; `ls "$TMPDIR" | grep ffdl-` shows no dir from this run.
  9. During processing, record the ffmpeg PID the same way, then click the window close button → app quits immediately; `ps -p <PID>` reports no such process; relaunch the app, then `ls "$TMPDIR" | grep ffdl-` shows the leftover is gone.
  10. All of the above were run from `dist/TabRipper.app` built by `deno task build`.
  11. During processing, open 設定 and press Cmd+Q while the settings dialog is open → the dialog closes and the full-screen "正在結束…" overlay is visible before the app quits.
  12. While connected on the tab list, change 設定 › CDP 位址 to `127.0.0.1:9223` and save → the app shows the connect screen (connection dropped); set it back to `127.0.0.1:9222`, click 連線 → Brave asks for permission again and the tab list returns.

  Use a distinct output filename for each item, and before each cancellation/quit check note the job's temp dir (`ls -d "$TMPDIR"/ffdl-*`) so earlier runs do not confuse the cleanup checks.

- [ ] **Step 3: Record results** — report each item's PASS/FAIL with observations to the user. Any FAIL is handled with root-cause analysis before changing code (project rules), then the affected task's tests are extended first.

- [ ] **Step 4: Restore the user files** — with the `BACKUP` path recorded in Step 1, copy back exactly the four backed-up files: `for f in config.ts page-script.js info.ts ffmpeg-args.ts; do cp "$BACKUP/$f" "user/$f"; done`. Verify each one: `for f in config.ts page-script.js info.ts ffmpeg-args.ts; do cmp "$BACKUP/$f" "user/$f"; done` prints nothing (other files the user may keep in `user/` were never touched). Only then remove the backup with `rm -r "$BACKUP"`.

- [ ] **Step 5: Final gate** — the automated suite assumes the committed default `user/` files (example.com pattern, `Clip.mp4` default name, duration probing on). Run it against those defaults even if the restored `user/` tree is customised:
  1. Record the stash count: `git stash list | wc -l` → `N_BEFORE`.
  2. If `git status --short --untracked-files=all user/` prints anything, run `git stash push --include-untracked -m tab-ripper-final-gate -- user/` (version-control operation; it parks tracked and untracked customisations under `user/`).
  3. Record `git stash list | wc -l` → `N_AFTER`. A stash was created by this step only if `N_AFTER` is `N_BEFORE + 1` and `git stash list -1` shows `tab-ripper-final-gate`.
  4. Run `deno task check && deno task lint && deno fmt --check && deno task test` — all must pass.
  5. Only if step 3 confirmed the stash: `git stash pop --index` (restores staged and unstaged state), then `git status --short --untracked-files=all user/` shows the user's changes again. Never pop a stash this task did not create.
  6. Run `deno task check && deno task build` on the user's configuration — both must succeed.
