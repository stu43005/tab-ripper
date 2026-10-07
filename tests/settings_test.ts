import {
  assertEquals,
  assertExists,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { dirname, join } from "@std/path";
import {
  defaultSettings,
  loadSettings,
  saveSettings,
  settingsPath,
  validateSettings,
} from "../src/settings.ts";

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await Deno.makeTempDir({ prefix: "tabripper-home-" });
  const previous = Deno.env.get("HOME");
  Deno.env.set("HOME", home);
  try {
    await fn(home);
  } finally {
    if (previous === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", previous);
    await Deno.remove(home, { recursive: true });
  }
}

Deno.test("settingsPath lives under Application Support/tab-ripper", async () => {
  await withHome((home) => {
    assertEquals(
      settingsPath(),
      join(
        home,
        "Library",
        "Application Support",
        "tab-ripper",
        "settings.json",
      ),
    );
    return Promise.resolve();
  });
});

Deno.test("defaultSettings returns the expected application defaults", async () => {
  await withHome((home) => {
    assertEquals(defaultSettings(), {
      cdpAddress: "127.0.0.1:9222",
      outputDir: join(home, "Downloads"),
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe",
    });
    return Promise.resolve();
  });
});

Deno.test("loadSettings returns defaults without warning when the file is missing", async () => {
  await withHome(async () => {
    const { settings, warning } = await loadSettings();
    assertEquals(settings, defaultSettings());
    assertEquals(warning, undefined);
  });
});

Deno.test("loadSettings returns defaults with a warning for corrupt JSON", async () => {
  await withHome(async () => {
    await Deno.mkdir(dirname(settingsPath()), { recursive: true });
    await Deno.writeTextFile(settingsPath(), "{ not json");
    const { settings, warning } = await loadSettings();
    assertEquals(settings, defaultSettings());
    assertExists(warning);
  });
});

Deno.test("loadSettings fills missing or mistyped fields with defaults", async () => {
  await withHome(async () => {
    await Deno.mkdir(dirname(settingsPath()), { recursive: true });
    await Deno.writeTextFile(
      settingsPath(),
      JSON.stringify({
        cdpAddress: "127.0.0.1:9333",
        ffmpegPath: 42,
        outputDir: "",
      }),
    );
    const { settings, warning } = await loadSettings();
    assertEquals(settings, {
      ...defaultSettings(),
      cdpAddress: "127.0.0.1:9333",
    });
    assertEquals(warning, undefined);
  });
});

Deno.test("saveSettings then loadSettings round-trips", async () => {
  await withHome(async (home) => {
    const next = {
      cdpAddress: "localhost:9444",
      outputDir: join(home, "out"),
      ffmpegPath: "/opt/homebrew/bin/ffmpeg",
      ffprobePath: "/opt/homebrew/bin/ffprobe",
    };
    await saveSettings(next);
    assertEquals((await loadSettings()).settings, next);
  });
});

Deno.test("saveSettings rejects an invalid CDP address and writes nothing", async () => {
  await withHome(async () => {
    await assertRejects(
      () => saveSettings({ ...defaultSettings(), cdpAddress: "bad" }),
      Error,
      "CDP 位址格式應為",
    );
    await assertRejects(() => Deno.stat(settingsPath()), Deno.errors.NotFound);
  });
});

Deno.test("validateSettings checks synchronously without touching the disk", async () => {
  await withHome(async () => {
    assertThrows(
      () => validateSettings({ ...defaultSettings(), cdpAddress: "bad" }),
      Error,
      "CDP 位址格式應為",
    );
    assertThrows(
      () => validateSettings({ ...defaultSettings(), ffmpegPath: "" }),
      Error,
      "設定欄位不可為空",
    );
    validateSettings(defaultSettings());
    await assertRejects(() => Deno.stat(settingsPath()), Deno.errors.NotFound);
  });
});

Deno.test("saveSettings rejects empty fields", async () => {
  await withHome(async () => {
    await assertRejects(
      () => saveSettings({ ...defaultSettings(), outputDir: "  " }),
      Error,
      "設定欄位不可為空",
    );
  });
});
