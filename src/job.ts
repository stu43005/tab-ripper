import { browserWsUrl } from "./cdp/address.ts";
import { CdpClient, CdpClosedError } from "./cdp/client.ts";
import { listTabs } from "./tabs.ts";
import type { JobStatus, Settings, TabInfo } from "./types.ts";
import { URL_PATTERN } from "../user/config.ts";

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
}
