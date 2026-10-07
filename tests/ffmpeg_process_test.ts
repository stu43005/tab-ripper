import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "@std/assert";
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
import {
  FFMPEG,
  makeExecutable,
  makeTempDir,
  makeTestVideo,
  pathExists,
  waitFor,
} from "./helpers/fixtures.ts";

Deno.test({
  name:
    "parseProgress sees the terminal progress=end event in real ffmpeg output",
  ignore: !FFMPEG,
  fn: async () => {
    const dir = await makeTempDir();
    try {
      const video = await makeTestVideo(dir, 3);
      const out = await new Deno.Command("ffmpeg", {
        args: [
          "-hide_banner",
          "-progress",
          "pipe:1",
          "-y",
          "-i",
          video,
          "-c",
          "copy",
          join(dir, "out.mp4"),
        ],
        stdout: "piped",
        stderr: "null",
      }).output();
      assert(out.success);
      const events: ProgressEvent[] = parseProgress(
        new TextDecoder().decode(out.stdout),
        newProgressState(),
      );
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
      const duration = await probeDuration(
        "ffprobe",
        video,
        new AbortController().signal,
      );
      assertExists(duration);
      assert(
        duration > 2.5 && duration < 3.5,
        `unexpected duration ${duration}`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("probeDuration returns null after its timeout and leaves no child", async () => {
  const dir = await makeTempDir();
  try {
    const hang = await makeExecutable(dir, "ffprobe-hang", "exec sleep 30");
    const result = await probeDuration(
      hang,
      "/dev/null",
      new AbortController().signal,
      300,
    );
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
  assertEquals(
    await probeDuration(
      "/nonexistent/ffprobe",
      "/dev/null",
      new AbortController().signal,
    ),
    null,
  );
});

function collector(): {
  updates: ProgressUpdate[];
  onProgress: ProgressUpdateCallback;
} {
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
      assert(
        last.percent !== null && last.percent > 90,
        `percent ${last.percent}`,
      );
      assertEquals(activeChildCount(), 0);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "runFfmpeg exposes the stats line as message and keeps it out of stderrTail",
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
      assert(
        stderrTail.filter((line) => line.startsWith("frame=")).length <= 1,
      );
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
      assert(
        stderrTail.some((line) => line.includes("No such file")),
        stderrTail.join("\n"),
      );
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
        args: [
          "-re",
          "-f",
          "lavfi",
          "-i",
          "testsrc=duration=60:size=320x240:rate=10",
          join(dir, "out.mp4"),
        ],
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
    const fatal = await makeExecutable(
      dir,
      "ffmpeg-fatal",
      "printf 'fatal-error' >&2\nexit 3",
    );
    const { updates, onProgress } = collector();
    const run = runFfmpeg({
      ffmpegPath: fatal,
      args: [],
      durationSec: null,
      onProgress,
    });
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
    const multi = await makeExecutable(
      dir,
      "ffmpeg-multi",
      "printf 'one\\ntwo\\nthree\\n' >&2",
    );
    const { updates, onProgress } = collector();
    const run = runFfmpeg({
      ffmpegPath: multi,
      args: [],
      durationSec: null,
      onProgress,
    });
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
    const run = runFfmpeg({
      ffmpegPath: stubborn,
      args: [],
      durationSec: null,
      onProgress: () => {},
    });
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
