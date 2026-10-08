import type { Info, InfoColumn } from "../src/types.ts";

/** Table columns, in display order. Keys missing from info show as empty. */
export const INFO_COLUMNS: InfoColumn[] = [
  { key: "title", label: "標題" },
  { key: "playlistUrl", label: "播放清單網址" },
  { key: "aesKey", label: "AES 金鑰" },
  { key: "resolution", label: "解析度" },
  { key: "bitrate", label: "位元率" },
  { key: "frameRate", label: "幀率" },
  { key: "videoCodec", label: "影片編碼" },
  { key: "audioCodec", label: "音訊編碼" },
];

/** Default output filename (including extension) shown for confirmation. */
export function defaultFilename(info: Info): string {
  return `${info.title ?? "output"}.mp4`;
}
