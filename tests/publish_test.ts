import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  copyThenRename,
  isCrossDeviceError,
  publishOutput,
} from "../src/publish.ts";
import { listDir, makeTempDir, pathExists } from "./helpers/fixtures.ts";

async function withDirs(
  fn: (src: string, dest: string) => Promise<void>,
): Promise<void> {
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
  const exdev = Object.assign(new Error("Cross-device link (os error 18)"), {
    code: "EXDEV",
  });
  const eacces = Object.assign(new Error("Permission denied (os error 13)"), {
    code: "EACCES",
  });
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
    await assertRejects(() =>
      copyThenRename(join(src, "vanished.mp4"), join(dest, "final.mp4"))
    );
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
