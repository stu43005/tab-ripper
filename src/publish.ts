import { dirname, join } from "@std/path";
import { SESSION_ID } from "./session.ts";

/** Deno reports a cross-volume rename as an Error whose `code` is "EXDEV". */
export function isCrossDeviceError(error: unknown): boolean {
  return error instanceof Error &&
    (error as Error & { code?: unknown }).code === "EXDEV";
}

/**
 * Moves the finished output into place. A same-volume rename is atomic.
 * Only a cross-device rename falls back to a staged copy; any other rename
 * error propagates so the caller can report a destination failure.
 */
export async function publishOutput(
  src: string,
  finalPath: string,
): Promise<void> {
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
export async function copyThenRename(
  src: string,
  finalPath: string,
): Promise<void> {
  const part = join(
    dirname(finalPath),
    `.ffdl-${SESSION_ID}-${crypto.randomUUID()}.part`,
  );
  try {
    await Deno.copyFile(src, part);
    const [source, staged] = await Promise.all([
      Deno.stat(src),
      Deno.stat(part),
    ]);
    if (source.size !== staged.size) throw new Error("複製後檔案大小不一致");
    await Deno.rename(part, finalPath);
  } catch (error) {
    await Deno.remove(part).catch(() => {});
    throw error;
  }
}
