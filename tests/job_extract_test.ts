import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  ADDRESS_LOCKED_MESSAGE,
  BUSY_MESSAGE,
  JobManager,
  NOT_CONNECTED_MESSAGE,
} from "../src/job.ts";
import { INFO_COLUMNS } from "../user/info.ts";
import {
  listDir,
  newSessionTempDirs,
  pathExists,
  sessionTempDirs,
  waitFor,
} from "./helpers/fixtures.ts";
import { connectedJob, readyJob, waitForState } from "./helpers/job_fixture.ts";

const opts = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  name: "extract reaches ready with info, sizes and a session temp dir",
  ...opts,
  fn: async () => {
    const before = await sessionTempDirs();
    const f = await readyJob({
      main: new Uint8Array([1, 2, 3, 4]),
      aux: new Uint8Array([5]),
    });
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
      assertEquals(
        await Deno.readFile(join(created[0], "main.bin")),
        new Uint8Array([1, 2, 3, 4]),
      );
    } finally {
      f.job.discard();
      await f.dispose();
    }
  },
});

Deno.test("extract requires a connection", () => {
  const job = new JobManager({
    cdpAddress: "127.0.0.1:9",
    outputDir: "/tmp",
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
  });
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
      assertEquals(status, {
        state: "failed",
        stage: "extract",
        message: "與瀏覽器的連線已中斷",
      });
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
      assertThrows(
        () => f.job.assertSettingsChangeAllowed(changed),
        Error,
        ADDRESS_LOCKED_MESSAGE,
      );
      assertThrows(
        () => f.job.updateSettings(changed),
        Error,
        ADDRESS_LOCKED_MESSAGE,
      );
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
