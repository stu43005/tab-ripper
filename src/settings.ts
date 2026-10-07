import { dirname, join } from "@std/path";
import { parseCdpAddress } from "./cdp/address.ts";
import type { Settings } from "./types.ts";

const CORRUPT_WARNING = "設定檔格式損毀，已使用預設值";
const KEYS = ["cdpAddress", "outputDir", "ffmpegPath", "ffprobePath"] as const;

function home(): string {
  const value = Deno.env.get("HOME");
  if (!value) throw new Error("HOME is not set");
  return value;
}

export function settingsPath(): string {
  return join(
    home(),
    "Library",
    "Application Support",
    "tab-ripper",
    "settings.json",
  );
}

export function defaultSettings(): Settings {
  return {
    cdpAddress: "127.0.0.1:9222",
    outputDir: join(home(), "Downloads"),
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
  };
}

export async function loadSettings(): Promise<
  { settings: Settings; warning?: string }
> {
  const defaults = defaultSettings();
  let text: string;
  try {
    text = await Deno.readTextFile(settingsPath());
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { settings: defaults };
    return {
      settings: defaults,
      warning: `無法讀取設定檔：${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { settings: defaults, warning: CORRUPT_WARNING };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { settings: defaults, warning: CORRUPT_WARNING };
  }
  const record = raw as Record<string, unknown>;
  const settings = { ...defaults };
  for (const key of KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") settings[key] = value;
  }
  return { settings };
}

/** Synchronous validation, usable before any await (e.g. by the save binding). */
export function validateSettings(settings: Settings): void {
  for (const key of KEYS) {
    if (typeof settings[key] !== "string" || settings[key].trim() === "") {
      throw new Error("設定欄位不可為空");
    }
  }
  parseCdpAddress(settings.cdpAddress);
}

export async function saveSettings(settings: Settings): Promise<void> {
  validateSettings(settings);
  const path = settingsPath();
  await Deno.mkdir(dirname(path), { recursive: true });
  const clean: Settings = {
    cdpAddress: settings.cdpAddress.trim(),
    outputDir: settings.outputDir.trim(),
    ffmpegPath: settings.ffmpegPath.trim(),
    ffprobePath: settings.ffprobePath.trim(),
  };
  await Deno.writeTextFile(path, JSON.stringify(clean, null, 2) + "\n");
}
