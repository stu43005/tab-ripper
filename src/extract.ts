import { join } from "@std/path";
import { URL_PATTERN } from "../user/config.ts";
import pageScript from "../user/page-script.js";
import { decodeBase64 } from "./base64.ts";
import {
  type CdpClient,
  CdpClosedError,
  CdpSessionClosedError,
  CdpTimeoutError,
} from "./cdp/client.ts";
import { statelessPattern } from "./tabs.ts";
import type { ExtractResult, Info } from "./types.ts";

/**
 * Expression evaluated in the tab. It checks the page URL
 * against the URL pattern BEFORE running the user script, validates the
 * result, stores both buffers under `window.__ffdl[token]` and returns only
 * the info and sizes. The leading comment carries metadata for test fakes.
 */
export function buildWrapperExpression(
  token: string,
  pattern: RegExp,
  scriptSource: string,
): string {
  const re = statelessPattern(pattern);
  return `/*ffdl-wrapper:${JSON.stringify({ token })}*/(async () => {
  const token = ${JSON.stringify(token)};
  const pattern = new RegExp(${JSON.stringify(re.source)}, ${
    JSON.stringify(re.flags)
  });
  if (!pattern.test(location.href)) {
    throw new Error("分頁網址已變更為 " + location.href + "，不符合網址規則，請重新選擇分頁");
  }
  window.__ffdl ??= {};
  const result = await (${scriptSource})();
  if (result === null || typeof result !== "object") {
    throw new Error("頁面腳本必須回傳 { main, aux, info } 物件");
  }
  const toBytes = (value, name) => {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new Error(name + " 必須是 ArrayBuffer 或 ArrayBufferView");
  };
  const main = toBytes(result.main, "main");
  const aux = toBytes(result.aux, "aux");
  const info = result.info;
  if (info === null || typeof info !== "object" || Array.isArray(info) ||
      Object.getPrototypeOf(info) !== Object.prototype) {
    throw new Error("info 必須是純物件");
  }
  for (const [key, value] of Object.entries(info)) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error("info." + key + " 的值只能是 string、number 或 boolean");
    }
  }
  window.__ffdl[token] = { main, aux };
  return { info, sizes: { main: main.byteLength, aux: aux.byteLength } };
})()`;
}

/** Returns `[offset, offset + length)` of a stored buffer as base64. */
export function buildReadExpression(
  token: string,
  name: "main" | "aux",
  offset: number,
  length: number,
): string {
  const meta = JSON.stringify({ token, name, offset, length });
  return `/*ffdl-read:${meta}*/(async () => {
  const entry = window.__ffdl?.[${JSON.stringify(token)}];
  if (!entry) throw new Error("FFDL_MISSING");
  const slice = entry[${JSON.stringify(name)}].subarray(${offset}, ${
    offset + length
  });
  if (typeof slice.toBase64 === "function") return slice.toBase64();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([slice]));
  });
})()`;
}

export const CHUNK_SIZE = 4 * 1024 * 1024;

export class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractError";
  }
}

const LIVENESS_TIMEOUT_MS = 3_000;
const SCRIPT_TIMEOUT_MS = 300_000;
const READ_TIMEOUT_MS = 60_000;
const DETACH_TIMEOUT_MS = 3_000;
const MISSING_DATA = "FFDL_MISSING";

/** An exception thrown inside the page; message is its full CDP description. */
class PageException extends Error {}

interface EvaluateResponse {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

interface WrapperResult {
  info: Info;
  sizes: { main: number; aux: number };
}

async function evaluate(
  client: CdpClient,
  sessionId: string,
  expression: string,
  timeoutMs: number,
): Promise<unknown> {
  const response = await client.send<EvaluateResponse>(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
    { timeoutMs },
  );
  const details = response.exceptionDetails;
  if (details) {
    // The exception description as-is (message and stack), falling back to text.
    throw new PageException(
      details.exception?.description ?? details.text ?? "頁面腳本發生錯誤",
    );
  }
  return response.result?.value;
}

function isWrapperResult(value: unknown): value is WrapperResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    info?: unknown;
    sizes?: { main?: unknown; aux?: unknown };
  };
  const info = candidate.info;
  if (typeof info !== "object" || info === null || Array.isArray(info)) {
    return false;
  }
  const leafOk = (v: unknown) =>
    typeof v === "string" || typeof v === "number" || typeof v === "boolean";
  if (!Object.values(info).every(leafOk)) return false;
  const sizeOk = (n: unknown) =>
    typeof n === "number" && Number.isInteger(n) && n >= 0;
  return typeof candidate.sizes === "object" && candidate.sizes !== null &&
    sizeOk(candidate.sizes.main) && sizeOk(candidate.sizes.aux);
}

async function writeAll(file: Deno.FsFile, bytes: Uint8Array): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    written += await file.write(bytes.subarray(written));
  }
}

function toExtractError(error: unknown, detached: boolean): ExtractError {
  if (error instanceof ExtractError) return error;
  if (detached || error instanceof CdpSessionClosedError) {
    return new ExtractError("分頁已關閉或已中斷偵錯連線");
  }
  if (error instanceof CdpClosedError) {
    return new ExtractError("與瀏覽器的連線已中斷");
  }
  return new ExtractError(
    error instanceof Error ? error.message : String(error),
  );
}

/** Attach, liveness check, run the wrapper, pull both files in 4 MiB chunks. */
export async function extractFromTab(
  client: CdpClient,
  targetId: string,
  tempDir: string,
  onProgress: (received: number, total: number) => void,
): Promise<ExtractResult> {
  let sessionId: string;
  try {
    ({ sessionId } = await client.send<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId, flatten: true },
    ));
  } catch (error) {
    throw toExtractError(error, false);
  }
  let detached = false;
  let connectionLost = false;
  const stopListening = client.on("Target.detachedFromTarget", (params) => {
    if (
      (params as { sessionId?: string } | undefined)?.sessionId === sessionId
    ) detached = true;
  });
  void client.closed.then(() => {
    connectionLost = true;
  });
  let result!: ExtractResult;
  try {
    try {
      await evaluate(client, sessionId, "1", LIVENESS_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof CdpTimeoutError) {
        throw new ExtractError(
          "分頁尚未載入（可能被瀏覽器休眠），請先在瀏覽器點開該分頁後再試一次",
        );
      }
      throw error;
    }

    const token = crypto.randomUUID();
    const head = await evaluate(
      client,
      sessionId,
      buildWrapperExpression(token, URL_PATTERN, pageScript.toString()),
      SCRIPT_TIMEOUT_MS,
    );
    if (!isWrapperResult(head)) {
      throw new ExtractError("頁面腳本回傳的資料格式不正確");
    }

    const mainPath = join(tempDir, "main.bin");
    const auxPath = join(tempDir, "aux.bin");
    const total = head.sizes.main + head.sizes.aux;
    let received = 0;
    onProgress(0, total);
    const parts = [["main", mainPath, head.sizes.main], [
      "aux",
      auxPath,
      head.sizes.aux,
    ]] as const;
    for (const [name, path, size] of parts) {
      const file = await Deno.open(path, {
        write: true,
        create: true,
        truncate: true,
      });
      try {
        for (let offset = 0; offset < size; offset += CHUNK_SIZE) {
          const length = Math.min(CHUNK_SIZE, size - offset);
          let encoded: unknown;
          try {
            encoded = await evaluate(
              client,
              sessionId,
              buildReadExpression(token, name, offset, length),
              READ_TIMEOUT_MS,
            );
          } catch (error) {
            if (
              error instanceof PageException &&
              error.message.includes(MISSING_DATA)
            ) {
              throw new ExtractError("頁面資料遺失，分頁可能已重新載入");
            }
            throw error;
          }
          if (typeof encoded !== "string") {
            throw new ExtractError("讀取資料失敗：回傳格式不正確");
          }
          const bytes = decodeBase64(encoded);
          if (bytes.length !== length) {
            throw new ExtractError("讀取資料失敗：區塊大小不符");
          }
          await writeAll(file, bytes);
          received += bytes.length;
          onProgress(received, total);
        }
      } finally {
        file.close();
      }
      if ((await Deno.stat(path)).size !== size) {
        throw new ExtractError(`${name} 檔案大小不符`);
      }
    }
    // An interruption during the final local writes must still fail the job.
    if (detached) throw new ExtractError("分頁已關閉或已中斷偵錯連線");
    if (connectionLost) throw new ExtractError("與瀏覽器的連線已中斷");
    result = {
      info: head.info,
      mainPath,
      auxPath,
      mainSize: head.sizes.main,
      auxSize: head.sizes.aux,
    };
  } catch (error) {
    throw toExtractError(error, detached);
  } finally {
    stopListening();
    // No page-side cleanup by design; only detach, bounded to 3 s.
    if (!detached) {
      await client.send("Target.detachFromTarget", { sessionId }, undefined, {
        timeoutMs: DETACH_TIMEOUT_MS,
      })
        .catch((error) => {
          if (error instanceof CdpClosedError) connectionLost = true;
        });
    }
  }
  // Re-checked after the detach await: a disconnect during it still fails.
  if (connectionLost) throw new ExtractError("與瀏覽器的連線已中斷");
  return result;
}
