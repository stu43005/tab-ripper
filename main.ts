// Tab Ripper desktop entry: window, menu, bindings, close handling, UI server.
import { cleanupStaleArtifacts, systemTempRoot } from "./src/cleanup.ts";
import { probeCdpPort } from "./src/cdp/probe.ts";
import { checkTool, killAllChildren } from "./src/ffmpeg.ts";
import { JobManager, SHUTTING_DOWN_MESSAGE } from "./src/job.ts";
import {
  loadSettings,
  saveSettings,
  validateSettings,
} from "./src/settings.ts";
import type { Settings, ToolCheck } from "./src/types.ts";
import { serveUi } from "./src/ui-assets.ts";

const loaded = await loadSettings();
let settings: Settings = loaded.settings;
const job = new JobManager(settings);

const win = new Deno.BrowserWindow({
  title: "Tab Ripper",
  width: 960,
  height: 720,
});

/** Runs `fn` and turns synchronous throws into rejections for bindings. */
function run<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error);
  }
}

async function checkTools(
  current: Settings,
): Promise<{ ffmpeg: ToolCheck; ffprobe: ToolCheck }> {
  // No new child processes once shutdown has started: they could outlive
  // the final killAllChildren() before Deno.exit().
  if (job.isShuttingDown) {
    const skipped: ToolCheck = { ok: false, error: SHUTTING_DOWN_MESSAGE };
    return { ffmpeg: skipped, ffprobe: skipped };
  }
  const [ffmpeg, ffprobe] = await Promise.all([
    checkTool(current.ffmpegPath),
    checkTool(current.ffprobePath),
  ]);
  return { ffmpeg, ffprobe };
}

win.bind("getSettings", async () => ({
  settings,
  warning: loaded.warning ?? null,
  tools: await checkTools(settings),
  urlPattern: job.urlPattern,
  probeWarning: job.probeWarning,
}));

win.bind("saveSettings", async (next: Settings) => {
  if (job.isShuttingDown) throw new Error(SHUTTING_DOWN_MESSAGE);
  const candidate: Settings = {
    cdpAddress: String(next.cdpAddress).trim(),
    outputDir: String(next.outputDir).trim(),
    ffmpegPath: String(next.ffmpegPath).trim(),
    ffprobePath: String(next.ffprobePath).trim(),
  };
  // Validate and commit synchronously, before any await, so no job can be
  // admitted between the check and the change. updateSettings refuses a CDP
  // address change while extracting and drops the connection otherwise.
  validateSettings(candidate);
  job.updateSettings(candidate);
  settings = candidate;
  // A failed write is a partial success: the new settings are already in
  // effect, so return the fresh tool checks together with the error.
  let persistError: string | null = null;
  try {
    await saveSettings(candidate);
  } catch (error) {
    persistError = `設定已套用但未能寫入設定檔：${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  return { tools: await checkTools(candidate), persistError };
});

win.bind("probe", async () => {
  // Read the address once: the result must describe the address actually probed,
  // even if settings change while the probe is in flight.
  const address = settings.cdpAddress;
  return { open: await probeCdpPort(address), address };
});
win.bind("connect", () => run(() => job.connect()));
win.bind("getConnection", () => run(() => ({ connected: job.isConnected() })));
win.bind("listTabs", () => run(() => job.listTabs()));
win.bind(
  "extract",
  (targetId: string) => run(() => job.extract(String(targetId))),
);
win.bind("getStatus", () => run(() => job.getStatus()));
win.bind("discard", () => run(() => job.discard()));
win.bind(
  "startProcess",
  (filename: string, confirmedOverwritePath: string | null) =>
    run(() =>
      job.startProcess(
        String(filename),
        confirmedOverwritePath === null ? null : String(confirmedOverwritePath),
      )
    ),
);
win.bind("cancel", () => run(() => job.cancel()));
win.bind("reset", () => run(() => job.reset()));
win.bind("revealInFinder", async (path: string) => {
  await new Deno.Command("open", {
    args: ["-R", String(path)],
    stdout: "null",
    stderr: "null",
  }).output();
});

// A custom quit item instead of role "quit": the OS handles role items
// without telling JS, which would skip the graceful shutdown.
win.setApplicationMenu([
  {
    submenu: {
      label: "Tab Ripper",
      items: [{
        item: {
          label: "結束 Tab Ripper",
          id: "quit",
          accelerator: "CmdOrCtrl+Q",
          enabled: true,
        },
      }],
    },
  },
  {
    submenu: {
      label: "編輯",
      items: [
        { role: { role: "undo" } },
        { role: { role: "redo" } },
        { role: { role: "cut" } },
        { role: { role: "copy" } },
        { role: { role: "paste" } },
        { role: { role: "selectAll" } },
      ],
    },
  },
]);

let quitting = false;
let shutdownDone = false;

/** Graceful quit for Cmd+Q / the menu quit item. */
async function requestShutdown(): Promise<void> {
  if (quitting) return;
  quitting = true;
  // Start shutdown before any await so state-changing bindings are refused
  // immediately; the overlay is shown while it runs.
  const shutdown = job.shutdown({ deadlineMs: 10_000 });
  let overlayTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    win.executeJs("window.__showShuttingDown?.()").catch(() => null),
    new Promise((resolve) => {
      overlayTimer = setTimeout(resolve, 1000);
    }),
  ]);
  clearTimeout(overlayTimer);
  await shutdown;
  shutdownDone = true;
  // No await between this kill and exit: nothing can spawn in between.
  killAllChildren();
  win.close();
  Deno.exit(0);
}

win.addEventListener("menuclick", (event) => {
  if (event.detail.id === "quit") void requestShutdown();
});

// The close event cannot be cancelled in Deno 2.9.7 and the
// process dies right after it, so only synchronous cleanup runs here.
win.addEventListener("close", () => {
  if (shutdownDone) return;
  job.abortSync();
});

Deno.serve(serveUi);

// Best-effort cleanup of earlier runs; never blocks the UI.
void systemTempRoot()
  .then((root) => cleanupStaleArtifacts(root, settings.outputDir))
  .catch((error) =>
    console.warn(`[tab-ripper] startup cleanup skipped: ${String(error)}`)
  );
