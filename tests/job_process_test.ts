import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
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
import {
  type JobFixture,
  readyJob,
  waitForState,
} from "./helpers/job_fixture.ts";

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
globalThis.addEventListener(
  "unload",
  () => Deno.removeSync(TOOL_DIR, { recursive: true }),
);

async function videoJob(
  overrides: Partial<Settings> = {},
): Promise<{ f: JobFixture; tempDir: string }> {
  const before = await sessionTempDirs();
  const f = await readyJob(
    { main: VIDEO, aux: new Uint8Array([1]) },
    overrides,
  );
  const [tempDir] = await newSessionTempDirs(before);
  return { f, tempDir };
}

/** Scripts that stand in for ffmpeg; they receive the real argument list (output path last). */
async function fakeTools() {
  const dir = TOOL_DIR;
  return {
    hang: await makeExecutable(dir, "hang", "exec sleep 30"),
    slowWriter: await makeExecutable(
      dir,
      "slow-writer",
      'for last; do :; done\nsleep 1\nprintf fake > "$last"',
    ),
    /** Writes its output immediately, then lingers 1 s before exiting 0. */
    writeThenWait: await makeExecutable(
      dir,
      "write-then-wait",
      'for last; do :; done\nprintf fake > "$last"\nsleep 1\nexit 0',
    ),
    failing: await makeExecutable(
      dir,
      "failing",
      'echo "boom from ffmpeg" >&2\nexit 3',
    ),
    silent: await makeExecutable(dir, "silent", "exit 0"),
    /** Real ffmpeg slowed to real time, so a job stays in "running" for ~3 s. */
    realtime: await makeExecutable(
      dir,
      "realtime-ffmpeg",
      'exec ffmpeg -re "$@"',
    ),
    /** Ignores SIGTERM, writes its output and exits 0 about 1 s later. */
    stubbornWriter: (ready: string) =>
      makeExecutable(
        dir,
        "stubborn-writer",
        `trap '' TERM\ntouch "${ready}"\nfor last; do :; done\nsleep 1\nprintf fake > "$last"\nexit 0`,
      ),
    marker: (path: string) =>
      makeExecutable(dir, "marker", `touch "${path}"\nexit 1`),
  };
}

Deno.test({
  name:
    "startProcess runs ffmpeg, publishes, and cleans up before reporting done",
  ...base,
  fn: async () => {
    const { f, tempDir } = await videoJob();
    try {
      const finalPath = join(f.outputDir, "My Clip.mp4");
      assertEquals(await f.job.startProcess("My Clip.mp4", null), {
        needsConfirm: false,
        finalPath,
      });
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
      await assertRejects(
        () => f.job.startProcess(" ... ", null),
        Error,
        "檔名無效",
      );
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
  name:
    "declining overwrite and choosing another name still uses the extracted files",
  ...base,
  fn: async () => {
    const { f } = await videoJob();
    try {
      await Deno.mkdir(f.outputDir, { recursive: true });
      await Deno.writeTextFile(join(f.outputDir, "out.mp4"), "old");
      assertEquals(
        (await f.job.startProcess("out.mp4", null)).needsConfirm,
        true,
      );
      assertEquals(
        (await f.job.startProcess("other.mp4", null)).needsConfirm,
        false,
      );
      await waitForState(f.job, ["done"]);
      assertEquals(
        await Deno.readTextFile(join(f.outputDir, "out.mp4")),
        "old",
      );
      assert(await pathExists(join(f.outputDir, "other.mp4")));
    } finally {
      await f.dispose();
    }
  },
});

Deno.test({
  name:
    "changing outputDir between calls invalidates the overwrite confirmation",
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
      assertEquals(second, {
        needsConfirm: true,
        finalPath: join(otherDir, "out.mp4"),
      });
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
  name:
    "an output directory that cannot be created returns to ready and allows a retry",
  ...base,
  fn: async () => {
    const { f, tempDir } = await videoJob();
    try {
      const blocker = join(f.workDir, "blocker");
      await Deno.writeTextFile(blocker, "not a directory");
      f.job.updateSettings({ ...f.settings, outputDir: join(blocker, "sub") });
      assertEquals(
        (await f.job.startProcess("a.mp4", null)).needsConfirm,
        false,
      );
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
      assertEquals(
        await Deno.readTextFile(join(f.outputDir, "pub.mp4")),
        "fake",
      );
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
        return s.state === "processing" && s.phase === "running" &&
          (s.message ?? "").startsWith("frame=");
      }, "real ffmpeg reporting progress");
      f.job.cancel();
      assertEquals(await waitForState(f.job, ["cancelled"]), {
        state: "cancelled",
      });
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
    const { f } = await videoJob({
      ffprobePath: tools.hang,
      ffmpegPath: await tools.marker(markerPath),
    });
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
  name:
    "a temp dir that cannot be removed yields a terminal state with cleanupWarning",
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
      assertEquals(
        status.message,
        "ffmpeg 未產生輸出檔，請檢查 buildFfmpegArgs 是否寫入 outputPath",
      );
    } finally {
      await f.dispose();
    }
  },
});

Deno.test({
  name:
    "only the first of overlapping startProcess calls wins and discard is refused",
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
      const rejected = results.find((r) =>
        r.status === "rejected"
      ) as PromiseRejectedResult;
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
    const { f, tempDir } = await videoJob({
      ffmpegPath: await tools.stubbornWriter(ready),
    });
    try {
      await f.job.startProcess("late.mp4", null);
      await waitFor(() => pathExists(ready), "writer started");
      // SIGTERM is ignored: the writer still produces its output and exits 0.
      f.job.cancel();
      assertEquals(await waitForState(f.job, ["cancelled", "done", "failed"]), {
        state: "cancelled",
      });
      assertEquals(await listDir(f.outputDir), []);
      assertEquals(await pathExists(tempDir), false);
    } finally {
      await f.dispose();
    }
  },
});

Deno.test({
  name:
    "an undeletable out/ is reported and its stale output is never published on retry",
  ...base,
  fn: async () => {
    const tools = await fakeTools();
    const { f, tempDir } = await videoJob({ ffmpegPath: tools.writeThenWait });
    const outDir = join(tempDir, "out");
    try {
      await f.job.startProcess("stale.mp4", null);
      // The fake has written its output and is still running for ~1 s.
      await waitFor(
        () => pathExists(join(outDir, "stale.mp4")),
        "output written",
      );
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
      assertEquals(
        retry.message,
        "ffmpeg 未產生輸出檔，請檢查 buildFfmpegArgs 是否寫入 outputPath",
      );
      assertEquals(await pathExists(join(f.outputDir, "stale.mp4")), false);
    } finally {
      await Deno.chmod(outDir, 0o755).catch(() => {});
      await Deno.chmod(f.outputDir, 0o755).catch(() => {});
      await f.dispose();
    }
  },
});

Deno.test({
  name:
    "a cancel issued right after startProcess with an unusable destination cancels and cleans up",
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
  name:
    "a failed duration probe sets probeWarning and processing still completes",
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
