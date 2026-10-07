import { assertEquals, assertThrows } from "@std/assert";
import { sanitizeFilename } from "../src/filename.ts";

Deno.test("sanitizeFilename keeps ordinary names unchanged", () => {
  assertEquals(sanitizeFilename("My Clip 01.mp4"), "My Clip 01.mp4");
  assertEquals(sanitizeFilename("影片（完整版）.mkv"), "影片（完整版）.mkv");
});

Deno.test("sanitizeFilename removes forbidden characters", () => {
  assertEquals(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j.mp4'), "abcdefghij.mp4");
});

Deno.test("sanitizeFilename removes control characters", () => {
  assertEquals(sanitizeFilename("a\u0000b\u001fc\u007fd.mp4"), "abcd.mp4");
  assertEquals(sanitizeFilename("line\nbreak\t.mp4"), "linebreak.mp4");
});

Deno.test("sanitizeFilename trims whitespace and leading dots", () => {
  assertEquals(sanitizeFilename("  clip.mp4  "), "clip.mp4");
  assertEquals(sanitizeFilename("...hidden.mp4"), "hidden.mp4");
  assertEquals(sanitizeFilename(" .  clip.mp4"), "clip.mp4");
});

Deno.test("sanitizeFilename does not add an extension", () => {
  assertEquals(sanitizeFilename("noext"), "noext");
});

Deno.test("sanitizeFilename rejects names that become empty", () => {
  for (const bad of ["", "   ", "...", "/:*?", ". ."]) {
    assertThrows(() => sanitizeFilename(bad), Error, "檔名無效");
  }
});
