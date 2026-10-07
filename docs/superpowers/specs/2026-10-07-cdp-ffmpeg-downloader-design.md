# CDP 擷取 + ffmpeg 處理桌面程式 設計規格

- 日期：2026-10-07
- 狀態：設計已與使用者確認，待 spec review
- 執行環境：Deno 2.9.7（`deno desktop`）、macOS（arm64）、Google Chrome 154、ffmpeg 8.0

## 1. 目的

一支以 `deno desktop` 打包的桌面程式，透過 Chrome DevTools Protocol（CDP）連上使用者**正在使用的** Chrome，讓使用者從符合指定網址規則的分頁中挑一個，在該分頁內執行使用者自寫的 JS 腳本，取回兩個檔案（ArrayBuffer）與一組資訊；資訊以表格呈現並讓使用者確認輸出檔名，接著用 ffmpeg 處理主檔並顯示進度，成品輸出到指定資料夾。

網址規則、頁面腳本、資訊欄位、ffmpeg 參數**由使用者之後自行撰寫**，本專案只提供留位（`user/` 目錄）與明確的介面約定。

## 2. 名詞

| 名詞 | 意義 |
| --- | --- |
| 主檔（main） | 頁面腳本回傳、要交給 ffmpeg 處理的檔案 |
| 輔助檔（aux） | 頁面腳本回傳的第二個檔案，供 ffmpeg 參數使用（例如金鑰、字幕），處理結束後與暫存一起刪除，不輸出 |
| info | 頁面腳本回傳的資訊物件，顯示於表格並傳給檔名與 ffmpeg 參數函式 |
| 工作（job） | 從「擷取」到「完成/失敗/取消」的一次完整流程 |
| 暫存目錄 | 單一工作專用、名稱前綴 `ffdl-` 的系統暫存目錄 |

## 3. 已確認的外部行為（研究結論）

以下行為已經過 research 驗證（詳見專案 MEMORY）：

1. **`deno desktop`**：單一行程；UI 由入口程式的 `Deno.serve()` 提供，啟動視窗自動導向該位址；`new Deno.BrowserWindow(opts)` 首次建構時接管啟動視窗；`win.bind(name, fn)` 註冊後，頁面端以 `await bindings.name(...)` 呼叫，參數與回傳值以 JSON 編碼（允許 null/boolean/number/string/Uint8Array/純物件/陣列）。權限旗標在建置時寫入執行檔。沒有原生檔案/資料夾選擇器；`alert`/`confirm`/`prompt` 為原生對話框。預設 backend 為 OS webview（macOS：WKWebView）。
2. **Chrome `chrome://inspect/#remote-debugging`（M144+）**：使用者在此頁開啟開關後，Chrome 會在 user data dir 根目錄寫入 `DevToolsActivePort`（第一行為 port、第二行為 path，例如 `/devtools/browser/<id>`），browser WebSocket 位址為 `ws://127.0.0.1:${port}${path}`（依 ChromeDevTools/chrome-devtools-mcp 的 `src/BrowserManager.ts`）。每次建立新的偵錯連線，Chrome 會跳出授權對話框。
3. **CDP 方法**：`Target.getTargets` → `{ targetInfos: [{ targetId, type, title, url, ... }] }`；`Target.attachToTarget { targetId, flatten: true }` → `{ sessionId }`；之後的指令在訊息頂層帶 `sessionId`；`Runtime.evaluate { expression, awaitPromise: true, returnByValue: true }` 結果在 `result.value`，例外在 `exceptionDetails`；`Target.detachFromTarget { sessionId }`；分頁關閉時 browser 端會收到 `Target.detachedFromTarget { sessionId }` 事件。
4. **Deno 2.9.7**：原生支援 `Uint8Array.fromBase64()` / `Uint8Array.prototype.toBase64()`；支援 `import x from "./a.html" with { type: "text" }`（不需 unstable 旗標），可用來把 UI 檔案編入模組圖；從 `.js` 模組匯出的函式，其 `toString()` 會回傳原始碼。
5. **測試用套件**：`jsr:@std/assert@1.0.19`（`assertEquals`、`assertThrows`、`assertRejects`）、`jsr:@std/path@1.1.6`（`join`、`dirname`、`basename`）。

### 3.1 尚待實作時實測的假設

以下假設無法僅靠文件確認，**實作第一個任務必須實際開啟 Chrome 開關做驗證**；任一項不成立時，回頭修改本 spec 再繼續：

- A1：對 CDP 埠只做 TCP 連線（不做 WebSocket handshake）**不會**觸發 Chrome 的授權對話框。
- A2：以 toggle 方式開啟時，CDP 埠為 `127.0.0.1:9222`，且 `DevToolsActivePort` 的 port 與之相同。
- A3：Deno 原生 `WebSocket` 客戶端（不自訂 Origin header）可以成功連上 toggle 模式的 browser endpoint。
- A4：`deno desktop` 預設 webview backend 下，`bindings` 與以 `with { type: "text" }` 匯入的 UI 檔案在 `--hmr` 開發模式與 `-o` 建置產物中都能正常運作。
- A5：toggle 模式下 `Target.getTargets`、`Target.attachToTarget`（flatten）、`Runtime.evaluate` 不受限制。

## 4. 架構

```
ffmpeg-downloader/
├─ deno.json              # imports、tasks（dev / build / test / check / lint / fmt）
├─ main.ts                # 入口：建立 BrowserWindow、註冊 bindings、Deno.serve 提供 UI
├─ src/
│  ├─ types.ts            # 共用型別：Settings、TabInfo、JobStatus、ExtractResult 等
│  ├─ settings.ts         # 設定檔讀寫與預設值
│  ├─ cdp/probe.ts        # TCP 探測 CDP 埠是否開啟
│  ├─ cdp/discovery.ts    # 解析 DevToolsActivePort、決定 browser WS URL
│  ├─ cdp/client.ts       # 精簡 CDP client
│  ├─ tabs.ts             # 列出並過濾分頁
│  ├─ extract.ts          # 在分頁執行頁面腳本、分塊取回檔案寫入暫存目錄
│  ├─ ffmpeg.ts           # 工具檢查、ffprobe 取長度、執行 ffmpeg 與進度解析
│  ├─ filename.ts         # 檔名清理
│  ├─ job.ts              # 工作狀態機與暫存目錄生命週期
│  └─ ui-assets.ts        # 以 text import 匯入 ui/ 檔案
├─ ui/
│  ├─ index.html
│  ├─ app.js              # 原生 JS（不 bundle）
│  └─ style.css
├─ user/                  # ★ 使用者自行撰寫的部分
│  ├─ config.ts
│  ├─ page-script.js
│  ├─ info.ts
│  └─ ffmpeg-args.ts
└─ tests/                 # deno test
```

依賴方向：`main.ts` → `job.ts` → (`extract.ts`, `ffmpeg.ts`, `tabs.ts`) → `cdp/*`；`user/*` 只被 `tabs.ts`、`extract.ts`、`job.ts`、`ffmpeg.ts` 讀取，不反向依賴 `src/`（`user/` 只可 import `src/types.ts` 的型別）。

## 5. 使用者擴充點（`user/`）

所有留位檔案都提供可編譯的預設內容與註解說明。

### 5.1 `user/config.ts`

```ts
/** Only tabs whose URL matches are listed. */
export const URL_PATTERN: RegExp = /^https:\/\/example\.com\//;

/** true: run ffprobe on the main file to get total duration (percentage progress).
 *  false: skip ffprobe; UI shows indeterminate progress with elapsed media time. */
export const PROBE_DURATION: boolean = true;
```

- 比對時以 `new RegExp(URL_PATTERN.source, URL_PATTERN.flags.replace("g", "").replace("y", ""))` 建立無狀態副本再 `test`，避免 `g`/`y` 旗標的 `lastIndex` 造成結果不穩定。

### 5.2 `user/page-script.js`

```js
/**
 * Runs INSIDE the selected browser tab. Must be self-contained:
 * it is serialized with Function.prototype.toString(), so it cannot
 * reference imports or variables outside its own body.
 * @returns {Promise<{ main: ArrayBuffer | ArrayBufferView,
 *                     aux: ArrayBuffer | ArrayBufferView,
 *                     info: Record<string, string | number | boolean> }>}
 */
export default async function pageScript() {
  throw new Error("TODO: implement user/page-script.js");
}
```

### 5.3 `user/info.ts`

```ts
import type { Info } from "../src/types.ts";

/** Table columns, in display order. Keys missing from info show as empty. */
export const INFO_COLUMNS: { key: string; label: string }[] = [
  { key: "title", label: "標題" },
];

/** Default output filename (including extension) shown for confirmation. */
export function defaultFilename(info: Info): string {
  return `${info.title ?? "output"}.mp4`;
}
```

- `Info` 型別為 `Record<string, string | number | boolean>`。
- 表格除 `INFO_COLUMNS` 外，固定附加「主檔大小」「輔助檔大小」兩列（以人類可讀單位顯示）。

### 5.4 `user/ffmpeg-args.ts`

```ts
import type { FfmpegArgsContext } from "../src/types.ts";

/** Return ffmpeg arguments WITHOUT the leading global options the app adds
 *  (-hide_banner -nostats -progress pipe:1 -y). Must write to ctx.outputPath. */
export function buildFfmpegArgs(ctx: FfmpegArgsContext): string[] {
  return ["-i", ctx.mainPath, "-c", "copy", ctx.outputPath];
}
```

- `FfmpegArgsContext = { mainPath: string; auxPath: string; info: Info; outputPath: string }`，皆為絕對路徑。

## 6. 元件設計

### 6.1 `settings.ts`

- 檔案位置：`$HOME/Library/Application Support/ffmpeg-downloader/settings.json`。
- 欄位與預設值：

| 欄位 | 預設 | 說明 |
| --- | --- | --- |
| `cdpAddress` | `127.0.0.1:9222` | CDP 主機:埠，用於 TCP 探測與組 WS URL |
| `cdpWsUrl` | `""` | 完整 browser WS URL；非空時直接使用，忽略 `DevToolsActivePort` |
| `chromeUserDataDir` | `$HOME/Library/Application Support/Google/Chrome` | 讀取 `DevToolsActivePort` 的位置 |
| `outputDir` | `$HOME/Downloads` | 成品輸出資料夾 |
| `ffmpegPath` | `ffmpeg` | 可為 PATH 中的名稱或絕對路徑 |
| `ffprobePath` | `ffprobe` | 同上 |

- `loadSettings(): Promise<{ settings: Settings; warning?: string }>`：檔案不存在 → 全部預設值；JSON 損毀 → 預設值並回傳 warning（設定頁顯示）；部分欄位缺漏或型別不符 → 該欄位用預設值。
- `saveSettings(s: Settings): Promise<void>`：驗證 `cdpAddress` 格式為 `host:port`（port 1–65535）、`cdpWsUrl` 為空或以 `ws://`/`wss://` 開頭；不合法時丟出錯誤、不寫檔。寫入前確保目錄存在。

### 6.2 `cdp/probe.ts`

- `probeCdpPort(address: string, timeoutMs = 1000): Promise<boolean>`：以 `Deno.connect({ hostname, port })` 建立 TCP 連線，成功即立刻 `close()` 並回傳 `true`；連線被拒或逾時回傳 `false`。**不送出任何資料、不做 WebSocket handshake**（假設 A1）。

### 6.3 `cdp/discovery.ts`

- `parseDevToolsActivePort(content: string): { port: number; path: string }`：以 `\n` 分行、trim、去除空行；需同時有 port 與 path，port 為 1–65535 整數，path 以 `/` 開頭，否則丟出 `DiscoveryError`。
- `resolveBrowserWsUrl(settings: Settings): Promise<string>`：
  1. `cdpWsUrl` 非空 → 直接回傳。
  2. 讀取 `<chromeUserDataDir>/DevToolsActivePort`；檔案不存在 → `DiscoveryError("找不到 DevToolsActivePort，請確認已在 chrome://inspect/#remote-debugging 開啟遠端偵錯，或在設定填寫 CDP WebSocket URL")`。
  3. 檔案中的 port 與 `cdpAddress` 的 port 不同 → `DiscoveryError`，訊息包含兩個 port，並建議修正 `cdpAddress` 或直接填寫 `cdpWsUrl`。
  4. 回傳 `ws://${cdpAddress 的 host}:${port}${path}`。

### 6.4 `cdp/client.ts`

```ts
class CdpClient {
  static connect(url: string, opts?: { timeoutMs?: number }): Promise<CdpClient>;
  send<T = unknown>(method: string, params?: object, sessionId?: string): Promise<T>;
  on(method: string, handler: (params: unknown, sessionId?: string) => void): () => void;
  readonly closed: Promise<void>;   // resolves when the socket closes for any reason
  close(): void;
}
```

- 每個請求帶遞增 `id`，回應以 `id` 對應；回應含 `error` → 以 `CdpError { code, message }` reject。
- 無 `id` 的訊息視為事件，依 `method` 分派給 `on` 註冊的 handler（同時傳入訊息的 `sessionId`）。
- 每個請求預設逾時 60 秒，逾時以 `CdpTimeoutError` reject 並移除 pending。
- 連線建立逾時（預設 10 秒，涵蓋使用者在 Chrome 授權對話框的等待）以 `CdpConnectError` reject。
- socket 關閉或錯誤 → 所有 pending 以 `CdpClosedError` reject，`closed` resolve，之後的 `send` 立即 reject。
- **整個 App 生命週期只建立一條 browser 連線**（由 `job.ts` 持有），避免重複觸發授權對話框；連線關閉後必須由使用者再次按「連線」才會重建。

### 6.5 `tabs.ts`

- `listTabs(client: CdpClient, pattern: RegExp): Promise<TabInfo[]>`：`Target.getTargets` → 只保留 `type === "page"` 且 URL 符合 pattern（依 §5.1 的無狀態比對）→ 回傳 `{ targetId, title, url }[]`，順序沿用 CDP 回傳順序。

### 6.6 `extract.ts`

```ts
extractFromTab(client: CdpClient, targetId: string, tempDir: string,
  onProgress: (received: number, total: number) => void,
): Promise<ExtractResult>
// ExtractResult = { info: Info; mainPath: string; auxPath: string; mainSize: number; auxSize: number }
```

流程：

1. `Target.attachToTarget { targetId, flatten: true }` 取得 `sessionId`；同時以 `client.on("Target.detachedFromTarget", ...)` 監聽，若收到相同 `sessionId` 的事件，標記中止，後續步驟以 `ExtractError("分頁已關閉或已中斷偵錯連線")` 結束。
2. 以 `Runtime.evaluate`（`awaitPromise: true, returnByValue: true`，帶 `sessionId`）執行 wrapper 運算式：
   - 以 `(${pageScript.toString()})()` 呼叫使用者腳本。
   - 驗證 `main`、`aux` 為 `ArrayBuffer` 或 `ArrayBufferView`，轉成 `Uint8Array` 存入 `window.__ffdl = { bufs: { main, aux }, read(name, offset, length) }`。
   - 驗證 `info` 為純物件、值只能是 string/number/boolean，否則丟出例外。
   - 回傳 `{ info, sizes: { main, aux } }`。
3. 回應含 `exceptionDetails` → `ExtractError`，訊息取 `exceptionDetails.exception.description`，沒有時用 `exceptionDetails.text`。
4. 依序取回 main、aux：每塊 **4 MiB**，以 `Runtime.evaluate` 呼叫 `window.__ffdl.read(name, offset, length)`，取得該區段的 base64 字串：
   - 頁面端：`Uint8Array.prototype.toBase64` 存在就直接用；不存在則以 `FileReader.readAsDataURL(new Blob([slice]))` 轉換並去掉 `data:...;base64,` 前綴。
   - 若 `window.__ffdl` 不存在（頁面重新載入或導頁）→ `ExtractError("頁面資料遺失，分頁可能已重新載入")`。
   - Deno 端以 `Uint8Array.fromBase64()` 解碼後，依序寫入 `<tempDir>/main.bin`、`<tempDir>/aux.bin`，每寫完一塊呼叫 `onProgress(累計位元組, main+aux 總位元組)`。
5. 寫完後比對檔案大小與 `sizes`，不符 → `ExtractError`。
6. `finally`：盡力執行 `delete window.__ffdl` 與 `Target.detachFromTarget`（錯誤忽略），並取消事件監聽。
- 大小為 0 的檔案合法（寫出空檔、不發 read 請求）。

### 6.7 `filename.ts`

- `sanitizeFilename(name: string): string`：移除 `/ \ : * ? " < > |` 與控制字元（U+0000–U+001F、U+007F），trim 前後空白，去除開頭的 `.`；結果為空 → 丟出錯誤「檔名無效」。不自動補副檔名。

### 6.8 `ffmpeg.ts`

- `checkTool(path: string): Promise<{ ok: boolean; version?: string; error?: string }>`：執行 `<path> -version`，取第一行為版本。
- `probeDuration(ffprobePath: string, file: string): Promise<number | null>`：執行 `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 <file>`，解析為正數秒；失敗或非數字 → `null`（不視為錯誤）。
- `parseProgress(chunk: string, state: ProgressState): ProgressEvent[]`：純函式，逐行解析 `key=value`；以 `out_time_us`（缺少時用 `out_time_ms`，ffmpeg 中兩者單位皆為微秒）換算秒數，值為 `N/A` 時忽略；解析 `speed`（如 `1.5x`，`N/A` → `null`）；遇到 `progress=continue|end` 發出一筆事件 `{ outTimeSec, speed, ended }`。需處理跨 chunk 被截斷的行（`state` 保留殘餘字串）。
- `runFfmpeg(opts): FfmpegRun`：
  - `opts = { ffmpegPath, args, durationSec: number | null, onProgress }`。
  - 實際參數：`["-hide_banner", "-nostats", "-progress", "pipe:1", "-y", ...args]`。
  - stdout 交給 `parseProgress`；`onProgress({ percent, outTimeSec, durationSec, speed })`，其中 `percent = durationSec ? min(100, outTimeSec / durationSec * 100) : null`。
  - stderr 保留最後 200 行的環狀緩衝區。
  - 回傳 `{ done: Promise<{ code: number; stderrTail: string[] }>, cancel(): void }`；`cancel()` 送 `SIGTERM`，3 秒內未結束再送 `SIGKILL`。

### 6.9 `job.ts`（狀態機）

`JobStatus`（`getStatus()` 回傳值）：

```ts
type JobStatus =
  | { state: "idle" }
  | { state: "extracting"; received: number; total: number }
  | { state: "ready"; info: Info; columns: { key: string; label: string }[];
      mainSize: number; auxSize: number; defaultFilename: string }
  | { state: "processing"; percent: number | null; outTimeSec: number;
      durationSec: number | null; speed: number | null }
  | { state: "done"; outputPath: string }
  | { state: "failed"; stage: "extract" | "process"; message: string; detail?: string[] }
  | { state: "cancelled" };
```

轉移規則：

| 動作 | 允許的前狀態 | 結果 |
| --- | --- | --- |
| `extract(targetId)` | idle / done / failed / cancelled | → extracting；建立暫存目錄 `Deno.makeTempDir({ prefix: "ffdl-" })`；成功 → ready；失敗 → failed(extract) 並刪除暫存目錄 |
| `discard()` | ready | 刪除暫存目錄 → idle |
| `startProcess(filename, overwrite)` | ready | 見下方 |
| `cancel()` | processing | 呼叫 `FfmpegRun.cancel()`；結束後 → cancelled |
| `reset()` | done / failed / cancelled | → idle |

其他狀態下呼叫上述動作 → 丟出錯誤「目前有工作進行中」（同一時間只允許一個工作）。

`startProcess(filename, overwrite)`：

1. `sanitizeFilename(filename)`；`outputDir` 不存在時遞迴建立。
2. 目標 `<outputDir>/<filename>` 已存在且 `overwrite === false` → 回傳 `{ needsConfirm: true }`，狀態維持 ready（UI 以 `confirm()` 詢問後帶 `overwrite: true` 重呼叫）。
3. 進入 processing。`PROBE_DURATION` 為 true 時以 `probeDuration` 取得長度（失敗 → `null`），否則 `null`。
4. ffmpeg 輸出先寫到 `<tempDir>/out/<filename>`（`buildFfmpegArgs` 收到的 `outputPath`），避免取消或失敗時在輸出資料夾留下殘檔。
5. 結束碼 0 且輸出檔存在 → 以 `Deno.rename` 移到 `<outputDir>/<filename>`；`rename` 因跨裝置失敗時改用 `copyFile` + `remove` → done。結束碼 0 但輸出檔不存在 → failed(process,「ffmpeg 未產生輸出檔，請檢查 buildFfmpegArgs 是否寫入 outputPath」)。
6. 結束碼非 0 → failed(process)，`detail` 為 stderr 最後 20 行；已呼叫 cancel → cancelled。
7. `finally`：刪除整個暫存目錄。

暫存清理：

- App 啟動時刪除系統暫存目錄下所有 `ffdl-` 開頭的目錄（上次異常結束的殘留）；系統暫存目錄以「建立一個新暫存目錄、取其上層、再刪掉它」的方式取得。
- 視窗 `close` 事件時，若有進行中的 ffmpeg 先 cancel，並以同步方式刪除目前的暫存目錄（盡力而為）。

CDP 連線狀態（與 job 分開管理，同樣由 `job.ts` 模組持有）：`connected: boolean`。`connect()` 已連線時直接回傳；連線關閉時 `connected` 變 false，若當下為 extracting，該次擷取以失敗結束。

### 6.10 `main.ts` 與 bindings

- `new Deno.BrowserWindow({ title: "FFmpeg Downloader", width: 960, height: 720 })`。
- `Deno.serve` 路由：`/` → `index.html`、`/app.js`、`/style.css`（內容來自 `src/ui-assets.ts` 的 text import，設定正確的 `content-type`），其他路徑 404。
- Bindings（頁面端 `await bindings.x(...)`）：

| 名稱 | 簽名 | 說明 |
| --- | --- | --- |
| `getSettings` | `() => { settings, warning?, tools }` | `tools` 為 ffmpeg/ffprobe 的 `checkTool` 結果 |
| `saveSettings` | `(s: Settings) => { tools }` | 驗證並儲存，重新檢查工具 |
| `probe` | `() => { open: boolean; address: string }` | TCP 探測 |
| `connect` | `() => void` | 解析 WS URL 並建立連線；失敗丟出含訊息的錯誤 |
| `getConnection` | `() => { connected: boolean }` | |
| `listTabs` | `() => TabInfo[]` | 需已連線 |
| `extract` | `(targetId: string) => void` | 非同步啟動，進度以 `getStatus` 取得 |
| `getStatus` | `() => JobStatus` | |
| `discard` | `() => void` | |
| `startProcess` | `(filename: string, overwrite: boolean) => { needsConfirm: boolean }` | 檢查通過後非同步啟動處理 |
| `cancel` | `() => void` | |
| `reset` | `() => void` | |
| `revealInFinder` | `(path: string) => void` | 執行 `open -R <path>` |

- bindings 內丟出的錯誤以訊息字串傳回頁面端，由 UI 顯示。

### 6.11 UI（`ui/`）

單頁，依狀態切換畫面：

1. **連線**：進入時呼叫 `probe()`，埠未開啟時每 2 秒自動重探。
   - 未開啟：引導文字「請在 Chrome 網址列開啟 `chrome://inspect/#remote-debugging` 並打開遠端偵錯開關」＋目前探測位址＋「重試」與「設定」。
   - 已開啟：顯示「偵測到 Chrome 偵錯埠」與「連線」按鈕；按下才呼叫 `connect()`，並提示「請在 Chrome 跳出的對話框按允許」。連線失敗顯示錯誤訊息並留在此畫面。
2. **分頁清單**：`listTabs()` 結果（標題、URL），可「重新整理」；無符合分頁時顯示空狀態與目前的 `URL_PATTERN`。點選分頁 → `extract()`。
3. **擷取中**：每 250 ms 呼叫 `getStatus()`，顯示已傳輸/總位元組。
4. **預覽**：info 表格 + 檔案大小；檔名輸入框預填 `defaultFilename`；「開始處理」與「取消」（`discard()`）。`startProcess` 回傳 `needsConfirm` 時以原生 `confirm()` 詢問是否覆蓋。工具檢查未通過時停用「開始處理」並提示到設定頁修正。
5. **處理中**：每 250 ms 輪詢；`percent` 非 null 顯示百分比進度條與「目前時間 / 總長度」，否則顯示不確定進度條與已處理時間；顯示速度；「取消」按鈕。
6. **結果**：done → 輸出路徑 +「在 Finder 中顯示」；failed → 訊息與 `detail`（等寬字型）；cancelled → 已取消。皆有「再一次」（`reset()` 後回到分頁清單；若連線已斷則回到連線畫面）。
- **設定**（任何畫面可開啟）：§6.1 的欄位、ffmpeg/ffprobe 檢查結果、載入時的 warning。
- 任何 binding 呼叫若回報連線已關閉，UI 回到連線畫面。

## 7. 建置與執行

- `deno.json` tasks：
  - `dev`：`deno desktop --hmr --allow-net --allow-read --allow-write --allow-run --allow-env main.ts`
  - `build`：`deno desktop --allow-net --allow-read --allow-write --allow-run --allow-env -o dist/FFmpegDownloader.app main.ts`
  - `test`：`deno test --allow-net --allow-read --allow-write --allow-run --allow-env`
  - `check`：`deno check main.ts src/ user/ tests/`；`lint`：`deno lint`；`fmt`：`deno fmt`
- `--allow-net` 與 `--allow-run` 不限定目標，因為 CDP 位址與 ffmpeg 路徑皆可由使用者修改。
- `deno.json` `compilerOptions.lib` 需包含 `"deno.ns"` 與 `"dom"`，使 `user/page-script.js` 的 JSDoc 與 `ui/app.js` 不影響型別檢查（`ui/app.js` 不納入 `deno check`）。

## 8. 錯誤處理總表

| 情境 | 行為 |
| --- | --- |
| CDP 埠未開啟 | 連線畫面引導 + 自動重探 |
| `DevToolsActivePort` 不存在 / 格式錯誤 / port 不符 | `connect()` 失敗，顯示 §6.3 的訊息 |
| 使用者在 Chrome 拒絕授權或逾時 | `connect()` 失敗，提示可再試 |
| 連線中途斷開 | `connected=false`；進行中的擷取失敗；UI 回到連線畫面（ffmpeg 處理不受影響） |
| 頁面腳本例外 / 回傳格式不符 | failed(extract)，顯示例外訊息 |
| 擷取中分頁關閉或重新載入 | failed(extract)，訊息見 §6.6 |
| ffmpeg/ffprobe 無法執行 | 設定頁顯示錯誤，停用「開始處理」；ffprobe 失敗只影響進度顯示（`PROBE_DURATION=true` 時仍可處理，進度改為不確定） |
| ffmpeg 結束碼非 0 | failed(process) + stderr 最後 20 行 |
| 輸出檔已存在 | 原生 `confirm()` 詢問覆蓋 |
| 輸出資料夾無法建立 / 移動失敗 | failed(process)，顯示系統錯誤訊息 |
| 任一結束路徑 | 暫存目錄刪除 |

## 9. 測試策略

使用 `deno test` 與 `jsr:@std/assert`。

- **純函式單元測試**：`parseDevToolsActivePort`（正常、缺第二行、port 非法、path 非 `/` 開頭、多餘空行）、`resolveBrowserWsUrl`（`cdpWsUrl` 優先、檔案不存在、port 不符；使用測試建立的暫存目錄放 `DevToolsActivePort`）、URL 過濾（含 `g` 旗標的 regex 連續比對結果一致）、`sanitizeFilename`、`parseProgress`（`out_time_us`、`N/A`、`speed`、`progress=end`、跨 chunk 截斷）、設定檔載入（不存在、損毀、部分欄位）。
- **TCP 探測**：對測試中以 `Deno.listen` 開啟的埠回傳 true；對已關閉的埠回傳 false。
- **CDP client 與擷取**：測試內以 `Deno.serve` + `Deno.upgradeWebSocket` 建立本機假 CDP server，驗證：`id` 對應與亂序回應、`sessionId` 路由、錯誤回應轉成 `CdpError`、逾時、socket 關閉時 pending 全部 reject；`extractFromTab` 在假 server 模擬 `Runtime.evaluate` 回應下正確寫出檔案（含 0 位元組與跨多塊的檔案）、處理 `exceptionDetails`、處理 `Target.detachedFromTarget` 中止。
- **ffmpeg 整合測試**：以 `ffmpeg -f lavfi -i testsrc=duration=3:size=320x240:rate=10` 產生測試影片，驗證 `probeDuration`、`runFfmpeg` 的進度事件與 `ended`、非 0 結束碼與 stderr tail、`cancel()`。系統找不到 ffmpeg 時這些測試以 `ignore` 跳過。
- **job 狀態機**：以假 CDP server + 真 ffmpeg 驗證完整成功流程、`needsConfirm`、取消、失敗時暫存目錄都被刪除、忙碌時拒絕新工作。
- **手動驗收清單**（`deno desktop` 視窗與真 Chrome 無法自動化）：
  1. Chrome 未開開關 → 連線畫面顯示引導；開啟開關後 2 秒內變成「偵測到」，且 Chrome **未**跳出授權對話框（A1）。
  2. 按連線 → Chrome 跳出授權對話框一次；允許後看到分頁清單。
  3. 完成一次工作後按「再一次」→ 不再跳出授權對話框。
  4. 擷取中關閉該分頁 → 顯示分頁已關閉的錯誤。
  5. 處理中按取消 → 輸出資料夾無殘檔、暫存目錄已刪除。
  6. `PROBE_DURATION=false` → 顯示不確定進度條。
  7. `deno task build` 產出的 `.app` 能開啟並完成上述流程（A4）。

## 10. Non-goals / Accepted limitations

- 只支援 macOS（`open -R`、預設路徑皆為 macOS）；不處理 Windows/Linux。
- 只支援 Google Chrome stable 的預設 user data dir 作為預設值；其他 Chromium 瀏覽器需使用者自行在設定中修改路徑或填寫 WS URL。
- 不提供原生資料夾選擇器（`deno desktop` 尚未提供），輸出資料夾以文字路徑設定。
- 同一時間只處理一個工作；不支援佇列或批次。
- 啟動時清理 `ffdl-` 暫存目錄不考慮同時執行多個 App 實例的情況。
- 不支援遠端（非本機）且需驗證的 CDP 端點。
- 檔案大小以「數十 MB 以內」為設計目標；未針對 GB 級檔案最佳化（仍以 4 MiB 分塊、串流寫檔，不會整檔載入 Deno 記憶體，但頁面端需同時持有兩個 buffer）。
- UI 只提供繁體中文。
