// deno-lint-ignore no-control-regex
const FORBIDDEN = /[/\\:*?"<>|\u0000-\u001f\u007f]/g;

/** Strips forbidden/control chars, trims, and drops leading dots. */
export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(FORBIDDEN, "").trim().replace(/^[.\s]+/, "")
    .trim();
  if (cleaned === "") throw new Error("檔名無效");
  return cleaned;
}
