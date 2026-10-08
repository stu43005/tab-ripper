import { join, resolve } from "@std/path";
import { browserWsUrl } from "./cdp/address.ts";
import { CdpClient, CdpClosedError } from "./cdp/client.ts";
import { extractFromTab } from "./extract.ts";
import {
  type FfmpegRun,
  killAllChildren,
  probeDuration,
  runFfmpeg,
} from "./ffmpeg.ts";
import { sanitizeFilename } from "./filename.ts";
import { publishOutput } from "./publish.ts";
import { SESSION_ID } from "./session.ts";
import { listTabs } from "./tabs.ts";
import type { ExtractResult, JobStatus, Settings, TabInfo } from "./types.ts";
import { PROBE_DURATION, URL_PATTERN } from "../user/config.ts";
import { buildFfmpegArgs } from "../user/ffmpeg-args.ts";
import { defaultFilename, INFO_COLUMNS } from "../user/info.ts";

export const BUSY_MESSAGE = "目前有工作進行中";
export const SHUTTING_DOWN_MESSAGE = "程式正在結束";
export const NOT_CONNECTED_MESSAGE = "尚未連線到瀏覽器";
export const ADDRESS_LOCKED_MESSAGE = "擷取中無法變更 CDP 位址";
export const ADDRESS_CHANGED_MESSAGE = "CDP 位址已變更，請重新連線";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ProcessContext {
  settings: Settings;
  name: string;
  finalPath: string;
  confirmedOverwritePath: string | null;
  tempDir: string;
  extracted: ExtractResult;
  readyStatus: JobStatus;
  abort: AbortController;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/**
 * Owns the single browser connection, the single job's state machine, its
 * temp files, ffmpeg children and the shutdown protocol.
 */
export class JobManager {
  #settings: Settings;
  #status: JobStatus = { state: "idle" };
  #client: CdpClient | null = null;
  #connecting: Promise<void> | null = null;
  #shuttingDown = false;
  #tempDir: string | null = null;
  #extracted: ExtractResult | null = null;
  /** Last filename the user submitted; reused when returning to ready. */
  #lastFilename: string | null = null;
  /** The running extract/process work, awaited by shutdown. */
  #work: Promise<void> | null = null;
  #cancelRequested = false;
  #abort: AbortController | null = null;
  #run: FfmpegRun | null = null;
  #shutdownPromise: Promise<void> | null = null;
  /** Set when the last duration probe failed; shown on the settings page. */
  #probeWarning: string | null = null;

  constructor(settings: Settings) {
    this.#settings = { ...settings };
  }

  /** Throws when `settings` may not be applied right now (call before saving to disk). */
  assertSettingsChangeAllowed(settings: Settings): void {
    if (
      settings.cdpAddress !== this.#settings.cdpAddress &&
      this.#status.state === "extracting"
    ) {
      throw new Error(ADDRESS_LOCKED_MESSAGE);
    }
  }

  /**
   * Applies new settings. A changed CDP address drops the current browser
   * connection; a pending connection attempt to the old address is rejected
   * when it completes. The user then reconnects explicitly.
   */
  updateSettings(settings: Settings): void {
    this.assertSettingsChangeAllowed(settings);
    const addressChanged = settings.cdpAddress !== this.#settings.cdpAddress;
    this.#settings = { ...settings };
    if (addressChanged) {
      this.#client?.close();
      this.#client = null;
    }
  }

  get isShuttingDown(): boolean {
    return this.#shuttingDown;
  }

  /** Warning from the most recent failed ffprobe duration probe, if any. */
  get probeWarning(): string | null {
    return this.#probeWarning;
  }

  /** The URL pattern as text, for the tab list's empty state. */
  get urlPattern(): string {
    return String(URL_PATTERN);
  }

  getStatus(): JobStatus {
    return structuredClone(this.#status);
  }

  isConnected(): boolean {
    return this.#client !== null;
  }

  /** One connection for the whole app run, so the permission dialog appears once. */
  connect(): Promise<void> {
    if (this.#shuttingDown) {
      return Promise.reject(new Error(SHUTTING_DOWN_MESSAGE));
    }
    if (this.#client) return Promise.resolve();
    if (this.#connecting) return this.#connecting;
    const address = this.#settings.cdpAddress;
    const attempt = (async () => {
      let client: CdpClient;
      try {
        client = await CdpClient.connect(browserWsUrl(address));
      } catch (error) {
        throw new Error(
          `無法連線到 ${address}：${
            errorMessage(error)
          }。請確認 chrome://inspect/#remote-debugging 頁面上的位址與設定一致，並在瀏覽器的對話框按允許`,
        );
      }
      if (this.#shuttingDown) {
        client.close();
        throw new Error(SHUTTING_DOWN_MESSAGE);
      }
      if (this.#settings.cdpAddress !== address) {
        client.close();
        throw new Error(ADDRESS_CHANGED_MESSAGE);
      }
      this.#client = client;
      // Bound to this client: a stale close must not clear a newer connection.
      void client.closed.then(() => {
        if (this.#client === client) this.#client = null;
      });
    })();
    const connecting: Promise<void> = attempt.finally(() => {
      if (this.#connecting === connecting) this.#connecting = null;
    });
    this.#connecting = connecting;
    return connecting;
  }

  async listTabs(): Promise<TabInfo[]> {
    const client = this.#client;
    if (!client) throw new Error(NOT_CONNECTED_MESSAGE);
    try {
      return await listTabs(client, URL_PATTERN);
    } catch (error) {
      if (error instanceof CdpClosedError) {
        throw new Error(NOT_CONNECTED_MESSAGE);
      }
      throw error;
    }
  }

  extract(targetId: string): void {
    if (this.#shuttingDown) throw new Error(SHUTTING_DOWN_MESSAGE);
    const state = this.#status.state;
    if (
      state !== "idle" && state !== "done" && state !== "failed" &&
      state !== "cancelled"
    ) {
      throw new Error(BUSY_MESSAGE);
    }
    const client = this.#client;
    if (!client) throw new Error(NOT_CONNECTED_MESSAGE);
    // Synchronous state switch: overlapping calls see "extracting".
    this.#status = { state: "extracting", received: 0, total: 0 };
    this.#track(this.#runExtract(client, targetId));
  }

  discard(): void {
    if (this.#shuttingDown) throw new Error(SHUTTING_DOWN_MESSAGE);
    if (this.#status.state !== "ready") throw new Error(BUSY_MESSAGE);
    const dir = this.#detachReadyFiles();
    if (dir) {
      Deno.remove(dir, { recursive: true }).catch((error) =>
        console.warn(
          `[tab-ripper] could not remove ${dir}: ${errorMessage(error)}`,
        )
      );
    }
  }

  reset(): void {
    if (this.#shuttingDown) throw new Error(SHUTTING_DOWN_MESSAGE);
    const state = this.#status.state;
    if (state !== "done" && state !== "failed" && state !== "cancelled") {
      throw new Error(BUSY_MESSAGE);
    }
    this.#status = { state: "idle" };
  }

  /**
   * Everything before the first await is synchronous
   * (state switch + settings snapshot). Resolves once the destination checks
   * are done; processing then continues in the background.
   */
  async startProcess(
    filename: string,
    confirmedOverwritePath: string | null,
  ): Promise<{ needsConfirm: boolean; finalPath: string }> {
    if (this.#shuttingDown) throw new Error(SHUTTING_DOWN_MESSAGE);
    if (
      this.#status.state !== "ready" || this.#tempDir === null ||
      this.#extracted === null
    ) {
      throw new Error(BUSY_MESSAGE);
    }
    const name = sanitizeFilename(filename);
    // Snapshot with an absolute output dir: confirmation, publishing and the
    // result all use this exact path even if settings or cwd change later.
    const settings = {
      ...this.#settings,
      outputDir: resolve(this.#settings.outputDir),
    };
    const ctx: ProcessContext = {
      settings,
      name,
      finalPath: join(settings.outputDir, name),
      confirmedOverwritePath,
      tempDir: this.#tempDir,
      extracted: this.#extracted,
      readyStatus: this.#status,
      abort: new AbortController(),
    };
    this.#lastFilename = name;
    this.#cancelRequested = false;
    this.#abort = ctx.abort;
    this.#status = {
      state: "processing",
      phase: "preparing",
      percent: null,
      outTimeSec: 0,
      durationSec: null,
      speed: null,
      message: null,
    };
    let signalPrepared!: (needsConfirm: boolean) => void;
    const prepared = new Promise<boolean>((resolve) => {
      signalPrepared = resolve;
    });
    this.#track(this.#runProcess(ctx, signalPrepared));
    return { needsConfirm: await prepared, finalPath: ctx.finalPath };
  }

  cancel(): void {
    const status = this.#status;
    if (status.state !== "processing") throw new Error("目前沒有進行中的處理");
    if (status.phase === "publishing") return; // Publishing is never interrupted.
    this.#cancelRequested = true;
    this.#abort?.abort();
    this.#run?.cancel();
  }

  /**
   * Graceful shutdown for the Cmd+Q path. Blocks new
   * state-changing calls, winds down the current job, closes the CDP
   * connection, and always ends with killAllChildren() because Deno.exit()
   * does not terminate child processes.
   */
  shutdown(opts: { deadlineMs?: number } = {}): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shuttingDown = true;
    this.#shutdownPromise = this.#runShutdown(opts.deadlineMs ?? 10_000);
    return this.#shutdownPromise;
  }

  async #runShutdown(deadlineMs: number): Promise<void> {
    const graceful = (async () => {
      const status = this.#status;
      if (status.state === "extracting") {
        this.#client?.close(); // Pending CDP requests reject immediately.
      } else if (
        status.state === "processing" && status.phase !== "publishing"
      ) {
        this.cancel();
      }
      // Publishing is awaited, never interrupted.
      await this.#work?.catch(() => {});
      // Ready-state files are cleaned after the work settles: the job may have
      // been ready from the start, or returned to ready after a publish failure.
      if (this.#status.state === "ready") {
        const dir = this.#detachReadyFiles();
        if (dir) await Deno.remove(dir, { recursive: true }).catch(() => {});
      }
      await this.#connecting?.catch(() => {});
      this.#client?.close();
      this.#client = null;
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, deadlineMs);
    });
    await Promise.race([graceful, deadline]);
    clearTimeout(timer);
    killAllChildren();
  }

  /**
   * Close-button path: the process dies right after the close
   * event, so only synchronous, best-effort cleanup is possible.
   */
  abortSync(): void {
    killAllChildren();
    const dir = this.#tempDir;
    if (!dir) return;
    try {
      Deno.removeSync(dir, { recursive: true });
    } catch {
      // Startup cleanup retries leftovers on the next launch.
    }
  }

  async #runProcess(
    ctx: ProcessContext,
    signalPrepared: (needsConfirm: boolean) => void,
  ): Promise<void> {
    const outDir = join(ctx.tempDir, "out");
    const tempOutput = join(outDir, ctx.name);
    // remove-all: terminal outcome. keep-inputs: destination failure, keep
    // main/aux for a retry. keep-all: overwrite confirmation pending.
    let cleanup: "remove-all" | "keep-inputs" | "keep-all" = "remove-all";
    let next: JobStatus = { state: "cancelled" };
    let destinationError = "";
    try {
      try {
        await Deno.mkdir(ctx.settings.outputDir, { recursive: true });
        if (this.#cancelRequested) return;
        const exists = await pathExists(ctx.finalPath);
        if (this.#cancelRequested) return;
        if (exists && ctx.confirmedOverwritePath !== ctx.finalPath) {
          cleanup = "keep-all";
          next = ctx.readyStatus;
          return;
        }
      } catch (error) {
        if (!this.#cancelRequested) {
          cleanup = "keep-inputs";
          destinationError = `輸出失敗：${errorMessage(error)}`;
          next = this.#readyStatus(destinationError);
        }
        return;
      }
      signalPrepared(false);
      if (this.#cancelRequested) return;

      const durationSec = PROBE_DURATION
        ? await probeDuration(
          ctx.settings.ffprobePath,
          ctx.extracted.mainPath,
          ctx.abort.signal,
        )
        : null;
      if (this.#cancelRequested) return;
      // The duration probe is authoritative for the progress mode; a failure
      // is surfaced as a settings warning and processing continues.
      if (PROBE_DURATION) {
        this.#probeWarning = durationSec === null
          ? "無法以 ffprobe 取得長度，進度改為不確定顯示；請檢查 ffprobe 路徑"
          : null;
      }
      // Start from an empty out/: a leftover from an earlier failed attempt
      // must never be mistaken for this run's output.
      await Deno.remove(outDir, { recursive: true }).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
      await Deno.mkdir(outDir, { recursive: true });
      if (this.#cancelRequested) return;

      this.#status = {
        state: "processing",
        phase: "running",
        percent: durationSec === null ? null : 0,
        outTimeSec: 0,
        durationSec,
        speed: null,
        message: null,
      };
      const run = runFfmpeg({
        ffmpegPath: ctx.settings.ffmpegPath,
        args: buildFfmpegArgs({
          mainPath: ctx.extracted.mainPath,
          auxPath: ctx.extracted.auxPath,
          info: ctx.extracted.info,
          outputPath: tempOutput,
        }),
        durationSec,
        onProgress: (update) => {
          const status = this.#status;
          if (status.state === "processing" && status.phase === "running") {
            this.#status = { state: "processing", phase: "running", ...update };
          }
        },
      });
      this.#run = run;
      const { code, stderrTail } = await run.done;
      this.#run = null;
      if (this.#cancelRequested) return;
      if (code !== 0) {
        next = {
          state: "failed",
          stage: "process",
          message: `ffmpeg 執行失敗（結束碼 ${code}）`,
          detail: stderrTail.slice(-20),
        };
        return;
      }
      const produced = await pathExists(tempOutput);
      // Cancellation (user or shutdown) during the check must still win.
      if (this.#cancelRequested) return;
      if (!produced) {
        next = {
          state: "failed",
          stage: "process",
          message:
            "ffmpeg 未產生輸出檔，請檢查 buildFfmpegArgs 是否寫入 outputPath",
        };
        return;
      }
      const running = this.#status;
      if (running.state === "processing") {
        this.#status = { ...running, phase: "publishing" };
      }
      try {
        await publishOutput(tempOutput, ctx.finalPath);
      } catch (error) {
        cleanup = "keep-inputs";
        destinationError = `輸出失敗：${errorMessage(error)}`;
        next = this.#readyStatus(destinationError);
        return;
      }
      next = { state: "done", outputPath: ctx.finalPath };
    } catch (error) {
      cleanup = "remove-all";
      next = this.#cancelRequested
        ? { state: "cancelled" }
        : { state: "failed", stage: "process", message: errorMessage(error) };
    } finally {
      this.#run = null;
      this.#abort = null;
      if (cleanup === "keep-inputs") {
        try {
          await Deno.remove(outDir, { recursive: true });
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) {
            // Report the leftover; the next run clears out/ before starting ffmpeg.
            next = this.#readyStatus(
              `${destinationError}；暫存輸出未能刪除：${outDir}（${
                errorMessage(error)
              }）`,
            );
          }
        }
        // A cancel accepted during that await wins: clean everything up.
        if (this.#cancelRequested) {
          cleanup = "remove-all";
          next = { state: "cancelled" };
        }
      }
      if (cleanup === "remove-all") {
        const warning = await this.#removeTempDir(ctx.tempDir);
        this.#tempDir = null;
        this.#extracted = null;
        this.#lastFilename = null;
        // A cancel accepted while cleaning up after a failure is honoured.
        if (this.#cancelRequested && next.state === "failed") {
          next = { state: "cancelled" };
        }
        if (
          warning &&
          (next.state === "done" || next.state === "failed" ||
            next.state === "cancelled")
        ) {
          next = { ...next, cleanupWarning: warning };
        }
      }
      // Status first, then release startProcess: callers never see a stale state.
      this.#status = next;
      signalPrepared(cleanup === "keep-all");
    }
  }

  async #runExtract(client: CdpClient, targetId: string): Promise<void> {
    let tempDir: string | null = null;
    try {
      tempDir = await Deno.makeTempDir({ prefix: `ffdl-${SESSION_ID}-` });
      this.#tempDir = tempDir;
      const result = await extractFromTab(
        client,
        targetId,
        tempDir,
        (received, total) => {
          if (this.#status.state === "extracting") {
            this.#status = { state: "extracting", received, total };
          }
        },
      );
      this.#extracted = result;
      this.#lastFilename = null;
      this.#status = this.#readyStatus();
    } catch (error) {
      const warning = tempDir ? await this.#removeTempDir(tempDir) : undefined;
      this.#tempDir = null;
      this.#extracted = null;
      this.#status = {
        state: "failed",
        stage: "extract",
        message: errorMessage(error),
        ...(warning ? { cleanupWarning: warning } : {}),
      };
    }
  }

  #readyStatus(lastError?: string): JobStatus {
    const extracted = this.#extracted;
    if (!extracted) throw new Error("internal error: no extracted files");
    return {
      state: "ready",
      info: extracted.info,
      columns: INFO_COLUMNS,
      mainSize: extracted.mainSize,
      auxSize: extracted.auxSize,
      defaultFilename: this.#lastFilename ?? defaultFilename(extracted.info),
      ...(lastError ? { lastError } : {}),
    };
  }

  /** Clears ready-state files from the job and returns the temp dir to delete. */
  #detachReadyFiles(): string | null {
    const dir = this.#tempDir;
    this.#tempDir = null;
    this.#extracted = null;
    this.#lastFilename = null;
    this.#status = { state: "idle" };
    return dir;
  }

  /** Returns a cleanup warning instead of throwing. */
  async #removeTempDir(dir: string): Promise<string | undefined> {
    try {
      await Deno.remove(dir, { recursive: true });
      return undefined;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      return `暫存檔未能刪除：${dir}（${errorMessage(error)}）`;
    }
  }

  #track(work: Promise<void>): void {
    const tracked: Promise<void> = work.finally(() => {
      if (this.#work === tracked) this.#work = null;
    });
    this.#work = tracked;
  }
}
