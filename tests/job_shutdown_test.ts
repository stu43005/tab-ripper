import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
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
      await assertRejects(
        () => f.job.startProcess("x.mp4", null),
        Error,
        SHUTTING_DOWN_MESSAGE,
      );
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
    const marker = await makeExecutable(
      toolDir,
      "marker",
      `touch "${markerPath}"\nexit 1`,
    );
    const before = await sessionTempDirs();
    const f = await readyJob({ main: VIDEO }, {
      ffprobePath: hang,
      ffmpegPath: marker,
    });
    try {
      const [tempDir] = await newSessionTempDirs(before);
      await f.job.startProcess("p.mp4", null);
      await waitFor(() => activeChildCount() === 1, "ffprobe running");
      await f.job.shutdown();
      assertEquals(f.job.getStatus(), { state: "cancelled" });
      assertEquals(await pathExists(tempDir), false);
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
    const realtime = await makeExecutable(
      toolDir,
      "realtime-ffmpeg",
      'exec ffmpeg -re "$@"',
    );
    const before = await sessionTempDirs();
    const f = await readyJob({ main: VIDEO }, { ffmpegPath: realtime });
    try {
      const [tempDir] = await newSessionTempDirs(before);
      await f.job.startProcess("r.mp4", null);
      await waitFor(() => {
        const s = f.job.getStatus();
        return s.state === "processing" && s.phase === "running" &&
          (s.message ?? "").startsWith("frame=");
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
  name:
    "shutdown honours its deadline and SIGKILLs a child that ignores SIGTERM",
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
    const server = new FakeCdpServer({
      handler: fakePage().handler,
      upgradeDelayMs: 500,
    });
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
  name:
    "abortSync kills running children and removes the temp dir synchronously",
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
        return s.state === "processing" && s.phase === "running" &&
          activeChildCount() === 1;
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
