import { assert, assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import { cleanupStaleArtifacts, systemTempRoot } from "../src/cleanup.ts";
import { SESSION_ID } from "../src/session.ts";
import { listDir, makeTempDir, pathExists } from "./helpers/fixtures.ts";

const OTHER = "11111111-2222-3333-4444-555555555555";

async function seed(tempRoot: string, outputDir: string): Promise<void> {
  await Deno.mkdir(join(tempRoot, `ffdl-${OTHER}-abc`));
  await Deno.writeTextFile(
    join(tempRoot, `ffdl-${OTHER}-abc`, "main.bin"),
    "x",
  );
  await Deno.mkdir(join(tempRoot, `ffdl-${SESSION_ID}-mine`));
  await Deno.mkdir(join(tempRoot, "unrelated"));
  await Deno.writeTextFile(join(outputDir, `.ffdl-${OTHER}-abc.part`), "x");
  await Deno.writeTextFile(
    join(outputDir, `.ffdl-${SESSION_ID}-mine.part`),
    "x",
  );
  await Deno.writeTextFile(join(outputDir, "video.mp4"), "x");
}

Deno.test("cleanupStaleArtifacts removes only other sessions' artifacts", async () => {
  const tempRoot = await makeTempDir();
  const outputDir = await makeTempDir();
  try {
    await seed(tempRoot, outputDir);
    await cleanupStaleArtifacts(tempRoot, outputDir);
    assertEquals(await listDir(tempRoot), [
      `ffdl-${SESSION_ID}-mine`,
      "unrelated",
    ]);
    assertEquals(await listDir(outputDir), [
      `.ffdl-${SESSION_ID}-mine.part`,
      "video.mp4",
    ]);
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
  const leftovers = (await listDir(root)).filter((name) =>
    name.startsWith("tabripper-root-")
  );
  assertEquals(leftovers, []);
  assert(await pathExists(root));
});
