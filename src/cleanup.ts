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
export async function cleanupStaleArtifacts(
  tempRoot: string,
  outputDir: string,
): Promise<void> {
  await removeMatching(
    tempRoot,
    (entry) =>
      entry.isDirectory && entry.name.startsWith("ffdl-") &&
      !entry.name.includes(SESSION_ID),
  );
  await removeMatching(
    outputDir,
    (entry) =>
      entry.isFile && entry.name.startsWith(".ffdl-") &&
      entry.name.endsWith(".part") &&
      !entry.name.includes(SESSION_ID),
  );
}

async function removeMatching(
  dir: string,
  matches: (entry: Deno.DirEntry) => boolean,
): Promise<void> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!matches(entry)) continue;
      const path = join(dir, entry.name);
      try {
        await Deno.remove(path, { recursive: true });
      } catch (error) {
        console.warn(
          `[tab-ripper] cleanup could not remove ${path}: ${String(error)}`,
        );
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      console.warn(
        `[tab-ripper] cleanup could not read ${dir}: ${String(error)}`,
      );
    }
  }
}
