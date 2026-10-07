import type { Info, InfoColumn } from "../src/types.ts";

/** Table columns, in display order. Keys missing from info show as empty. */
export const INFO_COLUMNS: InfoColumn[] = [
  { key: "title", label: "標題" },
];

/** Default output filename (including extension) shown for confirmation. */
export function defaultFilename(info: Info): string {
  return `${info.title ?? "output"}.mp4`;
}
