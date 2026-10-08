import { join } from "@std/path";
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
      await job.shutdown({ deadlineMs: 3000 });
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
  await waitFor(
    () => {
      status = job.getStatus();
      return states.includes(status.state);
    },
    `job state ${states.join("/")}`,
    timeoutMs,
  );
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
  if (status.state !== "ready") {
    throw new Error(`extraction failed: ${JSON.stringify(status)}`);
  }
  return fixture;
}
