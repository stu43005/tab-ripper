import { browserWsUrl } from "./cdp/address.ts";
import { CdpClient, CdpClosedError } from "./cdp/client.ts";
import { extractFromTab } from "./extract.ts";
import { SESSION_ID } from "./session.ts";
import { listTabs } from "./tabs.ts";
import type { ExtractResult, JobStatus, Settings, TabInfo } from "./types.ts";
import { URL_PATTERN } from "../user/config.ts";
import { defaultFilename, INFO_COLUMNS } from "../user/info.ts";

export const BUSY_MESSAGE = "目前有工作進行中";
export const SHUTTING_DOWN_MESSAGE = "程式正在結束";
export const NOT_CONNECTED_MESSAGE = "尚未連線到瀏覽器";
export const ADDRESS_LOCKED_MESSAGE = "擷取中無法變更 CDP 位址";
export const ADDRESS_CHANGED_MESSAGE = "CDP 位址已變更，請重新連線";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
