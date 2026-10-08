import { join } from "@std/path";
import { systemTempRoot } from "../../src/cleanup.ts";
import { SESSION_ID } from "../../src/session.ts";

/** True when a working ffmpeg is on PATH; ffmpeg-dependent tests use `ignore: !FFMPEG`. */
export const FFMPEG: boolean = await (async () => {
  try {
    const out = await new Deno.Command("ffmpeg", {
      args: ["-version"],
      stdout: "null",
      stderr: "null",
    })
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
export async function makeExecutable(
  dir: string,
  name: string,
  body: string,
): Promise<string> {
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
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
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
