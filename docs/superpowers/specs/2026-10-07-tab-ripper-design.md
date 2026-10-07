# Tab Ripper 設計規格

> 專案名稱：**Tab Ripper**（識別名稱 `tab-ripper`，App 名稱
> `TabRipper.app`）——從瀏覽器分頁擷取（rip）檔案並以 ffmpeg 處理的桌面程式。

- 日期：2026-10-07
- 狀態：設計已與使用者確認，待 spec review
- 執行環境：Deno 2.9.7（`deno desktop`）、macOS（arm64）、Chromium
  系瀏覽器（使用者實際使用 Brave 154.1.96.59；Chrome 154 同樣支援）、ffmpeg 8.0

## 1. 目的

一支以 `deno desktop` 打包的桌面程式，透過 Chrome DevTools
Protocol（CDP）連上使用者**正在使用的** Chromium 系瀏覽器（Brave、Chrome
等，下文統稱「瀏覽器」），讓使用者從符合指定網址規則的分頁中挑一個，在該分頁內執行使用者自寫的
JS
腳本，取回兩個檔案（ArrayBuffer）與一組資訊；資訊以表格呈現並讓使用者確認輸出檔名，接著用
ffmpeg 處理主檔並顯示進度，成品輸出到指定資料夾。

網址規則、頁面腳本、資訊欄位、ffmpeg
參數**由使用者之後自行撰寫**，本專案只提供留位（`user/` 目錄）與明確的介面約定。

## 2. 名詞

| 名詞          | 意義                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------ |
| 主檔（main）  | 頁面腳本回傳、要交給 ffmpeg 處理的檔案                                                           |
| 輔助檔（aux） | 頁面腳本回傳的第二個檔案，供 ffmpeg 參數使用（例如金鑰、字幕），處理結束後與暫存一起刪除，不輸出 |
| info          | 頁面腳本回傳的資訊物件，顯示於表格並傳給檔名與 ffmpeg 參數函式                                   |
| 工作（job）   | 從「擷取」到「完成/失敗/取消」的一次完整流程                                                     |
| 暫存目錄      | 單一工作專用、名稱前綴 `ffdl-` 的系統暫存目錄                                                    |

## 3. 已確認的外部行為（研究結論）

以下行為已經過 research 驗證（詳見專案 MEMORY）：

1. **`deno desktop`**：單一行程；UI 由入口程式的 `Deno.serve()`
   提供，啟動視窗自動導向該位址；`new Deno.BrowserWindow(opts)`
   首次建構時接管啟動視窗；`win.bind(name, fn)` 註冊後，頁面端以
   `await bindings.name(...)` 呼叫，參數與回傳值以 JSON
   編碼。權限旗標在建置時寫入執行檔。沒有原生檔案/資料夾選擇器；`alert`/`confirm`/`prompt`
   為原生對話框。預設 backend 為 OS webview（macOS：WKWebView）。
2. **`chrome://inspect/#remote-debugging`（Chrome M144+；Brave 同樣支援，且
   Brave 也能開啟 `chrome://`
   網址）**：使用者在此頁開啟開關後，頁面會顯示偵錯伺服器位址（預設
   `127.0.0.1:9222`）。此模式下 `/json/version` 等 HTTP 探索端點回 404；browser
   WebSocket 端點為 `ws://<位址>/devtools/browser`（§3.1 實測不需
   uuid）。瀏覽器另會在 user data dir 寫入
   `DevToolsActivePort`，但本程式**不讀取**（macOS 讀取其他 App
   資料夾需額外權限）。每次建立新的偵錯連線，瀏覽器會跳出授權對話框。
3. **CDP 方法**：`Target.getTargets` →
   `{ targetInfos: [{ targetId, type, title, url, ... }] }`；`Target.attachToTarget { targetId, flatten: true }`
   → `{ sessionId }`；之後的指令在訊息頂層帶
   `sessionId`；`Runtime.evaluate { expression, awaitPromise: true, returnByValue: true }`
   結果在 `result.value`，例外在
   `exceptionDetails`；`Target.detachFromTarget { sessionId }`；分頁關閉時
   browser 端會收到 `Target.detachedFromTarget { sessionId }` 事件。
4. **Deno 2.9.7**：原生支援 `Uint8Array.fromBase64()` /
   `Uint8Array.prototype.toBase64()`；支援
   `import x from "./a.html" with { type: "text" }`（不需 unstable
   旗標），可用來把 UI 檔案編入模組圖；從 `.js` 模組匯出的函式，其 `toString()`
   會回傳原始碼。
5. **測試用套件**：`jsr:@std/assert@1.0.19`（`assertEquals`、`assertThrows`、`assertRejects`）、`jsr:@std/path@1.1.6`（`join`、`dirname`、`basename`）。

### 3.1 實機驗證結果（2026-10-07，Brave 154 + Deno 2.9.7）

原本列為待驗證的假設已全部實測，結果如下（實驗腳本放在 session
scratchpad，結論記錄於專案 MEMORY）：

| 假設                                                                   | 結果                                                                                                                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1：只做 TCP 連線不會觸發授權對話框                                    | ✅ 成立（使用者目視確認）                                                                                                                                    |
| A2：toggle 模式埠為 `127.0.0.1:9222`，與 `DevToolsActivePort` 一致     | ✅ 成立（Brave；瀏覽器未帶 `--remote-debugging-port` 啟動參數）                                                                                              |
| A3：Deno 原生 `WebSocket`（不設 Origin）可連線                         | ✅ 成立（含使用者按允許約 1.5 秒）                                                                                                                           |
| A7：不需 uuid 即可連 browser endpoint                                  | ✅ 成立：`/devtools/browser`、`/devtools/browser/`、任意 uuid 皆可連線，`Browser.getVersion` 回應 `Chrome/154.0.8037.58`；`/` 回 HTTP 403                    |
| A4：`bindings` 與 text import 的 UI 在 `--hmr` 與建置產物中正常        | ✅ 成立                                                                                                                                                      |
| A5：`getTargets` / `attachToTarget`(flatten) / `Runtime.evaluate` 可用 | ✅ 成立；頁面端有 `Uint8Array.prototype.toBase64`，4 MiB base64 往返約 415 ms                                                                                |
| A6a：視窗 `close` 事件可 `preventDefault()`                            | ❌ **不成立**。`e.cancelable === false`，視窗立即關閉。v2.9.7 原始碼 `cli/rt_desktop/lib.rs:223-227` 明寫 close 事件只是通知、不可取消（官方文件與實作不符） |
| A6b：自訂選單 `CmdOrCtrl+Q` 觸發 `menuclick` 並可非同步收尾            | ✅ 成立（`executeJs` 遮罩 → 2 秒收尾 → `Deno.exit(0)`）                                                                                                      |

實測額外發現（影響設計）：

- **最後一個視窗關閉時行程立即結束**，進行中的計時器與子行程等待都不會延長行程壽命；此路徑下子行程會一起被終止（以
  `sleep` 觀察）。close 事件處理函式中的**同步**程式碼會執行。
- **`Deno.exit()` 不會終止子行程**：以 Cmd+Q 路徑結束後，`sleep 123`
  成為孤兒行程繼續執行。因此正常結束前必須自行終止所有子行程。
- **休眠/尚未載入的分頁**（Brave 記憶體節省、啟動時延遲還原的分頁）仍會出現在
  `getTargets` 且可以 attach，但 `Runtime.evaluate`
  **永遠不回應也不報錯**；使用者點開該分頁後，同一個 targetId
  恢復回應（`document.wasDiscarded === true`）。
- `deno desktop -o Name` 會產出 `Name.app`（若寫成 `-o Name.app` 會變成
  `Name.app.app`）。
- 一般的 `deno check` 不含桌面 API 型別；需在 `deno.json` 設定
  `compilerOptions.lib = ["deno.desktop", "deno.unstable", "dom"]`（取自 v2.9.7
  `libs/resolver/deno_json.rs`），實測可通過。
- binding 回傳的 `Uint8Array` 到頁面端會變成普通物件（`{"0":1,...}`）；本設計的
  binding 回傳值都不含二進位資料，不受影響。

## 4. 架構

```
tab-ripper/               # repo 根目錄（目前本機資料夾名稱仍為 ffmpeg-downloader，是否更名由使用者決定）
├─ deno.json              # imports、tasks（dev / build / test / check / lint / fmt）
├─ main.ts                # 入口：建立 BrowserWindow、註冊 bindings、Deno.serve 提供 UI
├─ src/
│  ├─ types.ts            # 共用型別：Settings、TabInfo、JobStatus、ExtractResult 等
│  ├─ settings.ts         # 設定檔讀寫與預設值
│  ├─ cdp/probe.ts        # TCP 探測 CDP 埠是否開啟
│  ├─ cdp/address.ts      # 解析 CDP 位址、組 browser WS URL
│  ├─ cdp/client.ts       # 精簡 CDP client
│  ├─ tabs.ts             # 列出並過濾分頁
│  ├─ extract.ts          # 在分頁執行頁面腳本、分塊取回檔案寫入暫存目錄
│  ├─ ffmpeg.ts           # 工具檢查、ffprobe 取長度、執行 ffmpeg 與進度解析
│  ├─ filename.ts         # 檔名清理
│  ├─ publish.ts          # 將成品安全地發佈到輸出資料夾
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

依賴方向：`main.ts` → `job.ts` → (`extract.ts`, `ffmpeg.ts`, `tabs.ts`) →
`cdp/*`；`user/*` 只被 `tabs.ts`、`extract.ts`、`job.ts`、`ffmpeg.ts`
讀取，不反向依賴 `src/`（`user/` 只可 import `src/types.ts` 的型別）。

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

- 比對時以
  `new RegExp(URL_PATTERN.source, URL_PATTERN.flags.replace("g", "").replace("y", ""))`
  建立無狀態副本再 `test`，避免 `g`/`y` 旗標的 `lastIndex` 造成結果不穩定。

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
- 表格除 `INFO_COLUMNS`
  外，固定附加「主檔大小」「輔助檔大小」兩列（以人類可讀單位顯示）。

### 5.4 `user/ffmpeg-args.ts`

```ts
import type { FfmpegArgsContext } from "../src/types.ts";

/** Return ffmpeg arguments WITHOUT the leading global options the app adds
 *  (-hide_banner -stats -progress pipe:1 -y). Must write to ctx.outputPath.
 *  Do not add -nostats: the live status message relies on ffmpeg's stats line. */
export function buildFfmpegArgs(ctx: FfmpegArgsContext): string[] {
  return ["-i", ctx.mainPath, "-c", "copy", ctx.outputPath];
}
```

- `FfmpegArgsContext = { mainPath: string; auxPath: string; info: Info; outputPath: string }`，皆為絕對路徑。

## 6. 元件設計

### 6.1 `settings.ts`

- 檔案位置：`$HOME/Library/Application Support/tab-ripper/settings.json`。
- 欄位與預設值：

| 欄位          | 預設              | 說明                                                                                                                            |
| ------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `cdpAddress`  | `127.0.0.1:9222`  | CDP 主機:埠（即 `chrome://inspect/#remote-debugging` 頁面上顯示的位址），用於 TCP 探測與組 WS URL；與頁面顯示不同時由使用者修改 |
| `outputDir`   | `$HOME/Downloads` | 成品輸出資料夾                                                                                                                  |
| `ffmpegPath`  | `ffmpeg`          | 可為 PATH 中的名稱或絕對路徑                                                                                                    |
| `ffprobePath` | `ffprobe`         | 同上                                                                                                                            |

- `loadSettings(): Promise<{ settings: Settings; warning?: string }>`：檔案不存在
  → 全部預設值；JSON 損毀 → 預設值並回傳
  warning（設定頁顯示）；部分欄位缺漏或型別不符 → 該欄位用預設值。
- `saveSettings(s: Settings): Promise<void>`：以 §6.3 `parseCdpAddress` 驗證
  `cdpAddress`；不合法時丟出錯誤、不寫檔。寫入前確保目錄存在。CDP
  位址變更對既有連線的影響見 §6.9「變更 CDP 位址」。

### 6.2 `cdp/probe.ts`

- `probeCdpPort(address: string, timeoutMs = 1000): Promise<boolean>`：以
  `Deno.connect({ hostname, port })` 建立 TCP 連線，成功即立刻 `close()` 並回傳
  `true`；連線被拒或逾時回傳 `false`。**不送出任何資料、不做 WebSocket
  handshake**（§3.1 A1 實測：不會觸發授權對話框）。
- `probe` binding 與 `connect()` 都使用同一個
  `cdpAddress`，因此探測結果與實際連線目標一致。

### 6.3 `cdp/address.ts`

**不讀取瀏覽器的資料夾**（例如 `DevToolsActivePort`；macOS 讀取其他 App 的
Application Support 需要額外權限），只依使用者設定的 `cdpAddress` 連線。

- `parseCdpAddress(address: string): { host: string; port: number }`：trim
  後須為 `host:port`，host 非空、不含 `/` 與空白，port 為 1–65535
  整數；否則丟出錯誤「CDP 位址格式應為 主機:埠，例如 127.0.0.1:9222」。
- `browserWsUrl(address: string): string`：回傳
  `ws://${host}:${port}/devtools/browser`。§3.1 實測：toggle 模式下 browser
  endpoint 不需要 `DevToolsActivePort` 中的 uuid，`/devtools/browser`
  即可建立瀏覽器層級的連線（`/` 會回 403）。

### 6.4 `cdp/client.ts`

```ts
class CdpClient {
  static connect(
    url: string,
    opts?: { timeoutMs?: number },
  ): Promise<CdpClient>;
  send<T = unknown>(
    method: string,
    params?: object,
    sessionId?: string,
    opts?: { timeoutMs?: number },
  ): Promise<T>;
  on(
    method: string,
    handler: (params: unknown, sessionId?: string) => void,
  ): () => void;
  readonly closed: Promise<void>; // resolves when the socket closes for any reason
  close(): void;
}
```

- 每個請求帶遞增 `id`，回應以 `id` 對應；回應含 `error` → 以
  `CdpError { code, message }` reject。
- 無 `id` 的訊息視為事件，依 `method` 分派給 `on` 註冊的 handler（同時傳入訊息的
  `sessionId`）。
- 每個請求預設逾時 60 秒，可由 `send` 的第四個參數
  `opts?: { timeoutMs?: number }` 覆寫；逾時以 `CdpTimeoutError` reject 並移除
  pending（之後才到達的回應直接丟棄）。
- 連線建立逾時（預設 60 秒，涵蓋使用者在瀏覽器授權對話框的等待）以
  `CdpConnectError` reject。
- socket 關閉或錯誤 → 所有 pending 以 `CdpClosedError` reject，`closed`
  resolve，之後的 `send` 立即 reject。
- 收到 `Target.detachedFromTarget { sessionId }` 事件時，client 內部立即以
  `CdpSessionClosedError` reject 所有帶該 `sessionId` 的 pending 請求，之後對該
  `sessionId` 的 `send` 也立即 reject（分頁關閉或休眠被卸載時，不必等到逾時）。
- **整個 App 生命週期只建立一條 browser 連線**（由 `job.ts`
  持有），避免重複觸發授權對話框；連線關閉後必須由使用者再次按「連線」才會重建。

### 6.5 `tabs.ts`

- `listTabs(client: CdpClient, pattern: RegExp): Promise<TabInfo[]>`：`Target.getTargets`
  → 只保留 `type === "page"` 且 URL 符合 pattern（依 §5.1 的無狀態比對）→ 回傳
  `{ targetId, title, url }[]`，順序沿用 CDP 回傳順序。

### 6.6 `extract.ts`

```ts
extractFromTab(client: CdpClient, targetId: string, tempDir: string,
  onProgress: (received: number, total: number) => void,
): Promise<ExtractResult>
// ExtractResult = { info: Info; mainPath: string; auxPath: string; mainSize: number; auxSize: number }
```

流程：

1. `Target.attachToTarget { targetId, flatten: true }` 取得 `sessionId`；同時以
   `client.on("Target.detachedFromTarget", ...)` 監聽，若收到相同 `sessionId`
   的事件，標記中止，後續步驟以 `ExtractError("分頁已關閉或已中斷偵錯連線")`
   結束。
   - **存活檢查**：attach 後先以
     `Runtime.evaluate { expression: "1", returnByValue: true }`、逾時 **3
     秒**確認分頁有可執行 JS 的 renderer。逾時 →
     `ExtractError("分頁尚未載入（可能被瀏覽器休眠），請先在瀏覽器點開該分頁後再試一次")`，不執行使用者腳本（見
     §3.1 實測：休眠分頁的 evaluate 永不回應）。
2. 每次擷取產生唯一的 `token`（`crypto.randomUUID()`）。頁面端資料放在
   `window.__ffdl[token]`（wrapper 開頭以 `window.__ffdl ??= {}`
   初始化），不同擷取之間互不覆寫、分塊讀取不會讀到別次擷取的資料。**不做頁面端清理**：資料保留在分頁中直到重新整理（見
   §10）。
3. 以 `Runtime.evaluate`（`awaitPromise: true, returnByValue: true`，帶
   `sessionId`，逾時 **300 秒**，因為使用者腳本可能需要下載資料）執行 wrapper
   運算式：
   - **頁面身分檢查**：呼叫使用者腳本**之前**，在同一個運算式中以 `URL_PATTERN`
     的 `source` 與（去除 `g`/`y` 的）`flags` 重建 RegExp，檢查目前的
     `location.href`；不符合時丟出例外「分頁網址已變更為
     <href>，不符合網址規則，請重新選擇分頁」，不執行使用者腳本。只比對
     `URL_PATTERN` 而不要求與列表時的網址完全相同，因為 SPA 常改變 hash 或 query
     而仍是同一個目標頁。之後的分塊讀取以 token
     綁定頁面狀態，若頁面在腳本執行後導頁，`window.__ffdl[token]` 會消失而依步驟
     5 失敗。
   - 以 `(${pageScript.toString()})()` 呼叫使用者腳本。
   - 驗證 `main`、`aux` 為 `ArrayBuffer` 或 `ArrayBufferView`，轉成 `Uint8Array`
     存入 `window.__ffdl[token] = { main, aux }`。
   - 驗證 `info` 為純物件、值只能是 string/number/boolean，否則丟出例外。
   - 回傳 `{ info, sizes: { main, aux } }`。
4. 回應含 `exceptionDetails` → `ExtractError`，訊息取
   `exceptionDetails.exception.description`，沒有時用 `exceptionDetails.text`。
5. 依序取回 main、aux：每塊 **4 MiB**，以 `Runtime.evaluate`
   執行讀取運算式，取得 `window.__ffdl[token][name]` 中
   `[offset, offset+length)` 區段的 base64 字串：
   - 頁面端：`Uint8Array.prototype.toBase64` 存在就直接用；不存在則以
     `FileReader.readAsDataURL(new Blob([slice]))` 轉換並去掉 `data:...;base64,`
     前綴。
   - 若 `window.__ffdl?.[token]` 不存在（頁面重新載入或導頁）→
     `ExtractError("頁面資料遺失，分頁可能已重新載入")`。
   - Deno 端以 `Uint8Array.fromBase64()` 解碼後，依序寫入
     `<tempDir>/main.bin`、`<tempDir>/aux.bin`，每寫完一塊呼叫
     `onProgress(累計位元組, main+aux 總位元組)`。
6. 寫完後比對檔案大小與 `sizes`，不符 → `ExtractError`。
7. `finally`（有時間上限，不讓失敗路徑拖長）：
   - session 尚未 detach 時送出 `Target.detachFromTarget`（錯誤忽略、逾時 **3
     秒**），最後取消事件監聽。不送任何頁面端清理運算式。
   - 因此任何擷取失敗從觸發原因到進入 failed(extract) 最多再延遲約 3
     秒；分頁關閉時進行中的請求由 §6.4 的 session reject 立即結束，不需等待 300
     秒逾時。

- 大小為 0 的檔案合法（寫出空檔、不發 read 請求）。

### 6.7 `filename.ts`

- `sanitizeFilename(name: string): string`：移除 `/ \ : * ? " < > |`
  與控制字元（U+0000–U+001F、U+007F），trim 前後空白，去除開頭的 `.`；結果為空 →
  丟出錯誤「檔名無效」。不自動補副檔名。

### 6.8 `ffmpeg.ts`

- **子行程登記**：`ffmpeg.ts`
  啟動的所有子行程（`checkTool`、`probeDuration`、`runFfmpeg`）都登記在模組內的集合中，結束時移除；提供
  `killAllChildren(): void`（同步對所有登記中的子行程送 SIGKILL），供 §6.11
  的兩條結束路徑使用。
- `checkTool(path: string, timeoutMs = 5000): Promise<{ ok: boolean; version?: string; error?: string }>`：執行
  `<path> -version`，取第一行為版本。逾時 → SIGKILL 子行程並等它結束，回傳
  `{ ok: false, error: "執行逾時（5 秒），請確認路徑是否正確" }`；因此
  `getSettings` / `saveSettings` 最多等待約 5 秒（兩個工具並行檢查）。
- `probeDuration(ffprobePath: string, file: string, signal: AbortSignal, timeoutMs = 15000): Promise<number | null>`：執行
  `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 <file>`，解析為正數秒；失敗、非數字或逾時
  → `null`（不視為錯誤）。逾時或 `signal` 觸發時 kill 子行程並等待它結束後才
  resolve（`signal` 觸發時同樣回傳 `null`，由呼叫端依 `cancelRequested`
  判斷結果）。
- `parseProgress(chunk: string, state: ProgressState): ProgressEvent[]`：純函式，逐行解析
  `key=value`；以 `out_time_us`（缺少時用 `out_time_ms`，ffmpeg
  中兩者單位皆為微秒）換算秒數，值為 `N/A` 時忽略；解析 `speed`（如
  `1.5x`，`N/A` → `null`）；遇到 `progress=continue|end` 發出一筆事件
  `{ outTimeSec, speed, ended }`。需處理跨 chunk 被截斷的行（`state`
  保留殘餘字串）。
- `runFfmpeg(opts): FfmpegRun`：
  - `opts = { ffmpegPath, args, durationSec: number | null, onProgress }`。
  - 實際參數：`["-hide_banner", "-stats", "-progress", "pipe:1", "-y", ...args]`。`-stats`
    是必要的：實測 ffmpeg 8.0 在 stderr 非 TTY 且使用 `-progress` 時，不加
    `-stats` 就完全不輸出 `frame=… time=… speed=…` 狀態行。
  - stdout 交給
    `parseProgress`；`onProgress({ percent, outTimeSec, durationSec, speed, message })`，其中
    `percent = durationSec ? min(100, outTimeSec / durationSec * 100) : null`，`message`
    見下。
  - stderr 交給純函式
    `splitStderr(chunk: string, state: StderrState): { segment: string; transient: boolean }[]`：以
    `\r` 與 `\n` 切段（處理跨 chunk 截斷、`\r\n` 視為一個
    `\n`），去除前後空白、略過空段；以 `\r` 結尾的段標為
    `transient: true`（實測：處理中的狀態行以 `\r` 分隔、最後一行以 `\n`
    結尾）。
    - **目前狀態訊息** `message`：最後一個段（不論是否 transient），即「ffmpeg
      輸出的最後一行」，通常是
      `frame=… size=… time=… bitrate=… speed=… elapsed=…`，出現警告時則是警告內容。每次更新都觸發一次
      `onProgress`（沿用最新的進度數值）。
    - **錯誤摘要**：只有非 transient 的段才放進最後 200
      行的環狀緩衝區（`stderrTail`），避免每 0.5
      秒一行的狀態行把真正的錯誤訊息擠掉。
  - 回傳
    `{ done: Promise<{ code: number; stderrTail: string[] }>, cancel(): void }`；`cancel()`
    送 `SIGTERM`，3 秒內未結束再送 `SIGKILL`。

### 6.9 `job.ts`（狀態機）

`JobStatus`（`getStatus()` 回傳值）：

```ts
type JobStatus =
  | { state: "idle" }
  | { state: "extracting"; received: number; total: number }
  | {
    state: "ready";
    info: Info;
    columns: { key: string; label: string }[];
    mainSize: number;
    auxSize: number;
    defaultFilename: string;
    lastError?: string;
  } // set when returning to ready after a destination failure
  | {
    state: "processing";
    phase: "preparing" | "running" | "publishing";
    percent: number | null;
    outTimeSec: number;
    durationSec: number | null;
    speed: number | null;
    message: string | null;
  } // last stderr line from ffmpeg (running phase only)
  | { state: "done"; outputPath: string; cleanupWarning?: string }
  | {
    state: "failed";
    stage: "extract" | "process";
    message: string;
    detail?: string[];
    cleanupWarning?: string;
  }
  | { state: "cancelled"; cleanupWarning?: string };
```

轉移規則：

| 動作                                             | 允許的前狀態                                | 結果                                                                                                                                                                                                                                   |
| ------------------------------------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extract(targetId)`                              | idle / done / failed / cancelled            | → extracting；建立暫存目錄 `Deno.makeTempDir({ prefix: \`ffdl-${sessionId}-\` })`（見「暫存清理」的歸屬邊界）；成功 → ready；失敗 → failed(extract) 並刪除暫存目錄                                                                     |
| `discard()`                                      | ready                                       | 刪除暫存目錄 → idle                                                                                                                                                                                                                    |
| `startProcess(filename, confirmedOverwritePath)` | ready                                       | 見下方                                                                                                                                                                                                                                 |
| `cancel()`                                       | processing（phase 為 preparing 或 running） | 設定 `cancelRequested = true`；觸發本工作的 `AbortController`（中止進行中的 ffprobe）；若 ffmpeg 已啟動則呼叫 `FfmpegRun.cancel()`；清理完成後 → cancelled。phase 為 publishing 時呼叫則忽略（搬移不可中斷，以免輸出資料夾留下半成品） |
| `reset()`                                        | done / failed / cancelled                   | → idle                                                                                                                                                                                                                                 |

其他狀態下呼叫上述動作 →
丟出錯誤「目前有工作進行中」（同一時間只允許一個工作）。

**互斥保證**：所有動作在第一個 `await` 之前**同步**檢查並切換狀態（`extract` →
extracting、`startProcess` → processing/preparing），因此重疊的 binding
呼叫中只有第一個能通過檢查，其餘立即得到「目前有工作進行中」。`discard()`
同步地把狀態設為 idle 並把暫存目錄路徑從 job
上摘除，再於背景刪除該目錄；被摘除的目錄不再被任何工作引用（新的 `extract`
一定建立新的暫存目錄），所以不會與後續工作互相干擾。done / failed / cancelled
這些終止狀態**在所有子行程結束、暫存目錄清理嘗試完成後**才設定，所以終止狀態下可以安全接受新工作。

**清理失敗不阻擋狀態轉移**：工作結果（成功、失敗、取消）與清理結果分開處理。刪除暫存目錄失敗時，錯誤被捕捉，工作照樣進入它原本應得的終止狀態（例如發佈成功仍為
done），並在終止狀態附上 `cleanupWarning`（含殘留路徑），UI
在結果畫面顯示提醒。該目錄有 `ffdl-`
前綴，下次啟動時的清理會再嘗試刪除。`discard()` 的背景刪除失敗則只寫入
log，不影響狀態。

`startProcess(filename, confirmedOverwritePath: string | null)`：

1. 同步（第一個 `await` 之前）：檢查狀態為
   ready、`sanitizeFilename(filename)`（失敗則丟錯、狀態不變）；**快照**本次工作使用的設定（`outputDir`、`ffmpegPath`、`ffprobePath`）並算出絕對路徑
   `finalPath = <outputDir>/<filename>`，此後本工作的存在檢查、確認、發佈與結果回報都只使用這份快照，處理期間修改設定不影響進行中的工作；切到
   processing（phase=preparing）、`cancelRequested = false`。
2. `outputDir` 不存在時遞迴建立；失敗 → **目的地失敗**（見步驟 9）。
3. `finalPath` 已存在且 `confirmedOverwritePath !== finalPath` →
   狀態**還原為原本的 ready**，回傳 `{ needsConfirm: true, finalPath }`。UI 以
   `confirm()` 顯示該完整路徑詢問是否覆蓋，同意後以
   `startProcess(filename, finalPath)`
   重呼叫。覆蓋許可因此綁定在確切的路徑上：若兩次呼叫之間檔名或 `outputDir`
   改變，新的 `finalPath`
   與許可不符，會重新詢問。**此回傳不是終止結果**：暫存目錄（含
   main/aux）必須保留給後續的 `startProcess` 重呼叫使用。
4. `PROBE_DURATION` 為 true 時以 `probeDuration` 取得長度（失敗 → `null`），否則
   `null`。
5. 每個 `await` 之後檢查 `cancelRequested`；為 true 時**不啟動
   ffmpeg**，直接進入清理並以 cancelled 結束。
6. phase=running，啟動 ffmpeg。輸出先寫到
   `<tempDir>/out/<filename>`（`buildFfmpegArgs` 收到的
   `outputPath`），避免取消或失敗時在輸出資料夾留下殘檔。
7. 結束後依序判斷：已要求取消 → cancelled；結束碼非 0 →
   failed(process)，`detail` 為 stderr 最後 20 行；結束碼 0 但輸出檔不存在 →
   failed(process,「ffmpeg 未產生輸出檔，請檢查 buildFfmpegArgs 是否寫入
   outputPath」)。
8. 結束碼 0 且輸出檔存在 → phase=publishing，以 `src/publish.ts` 的
   `publishOutput(tempOutput, finalPath)` **發佈**到 `<outputDir>/<filename>`：
   - 先嘗試 `Deno.rename(tempOutput, finalPath)`（同一磁碟時為原子操作）。
   - 若因跨裝置失敗：先 `copyFile` 到輸出資料夾內的暫存名稱
     `<outputDir>/.ffdl-<sessionId>-<crypto.randomUUID()>.part`（固定長度、與最終檔名無關，避免接近
     255
     位元組上限的合法檔名因加上後綴而超長），確認大小與來源一致後，再以同資料夾內的
     `Deno.rename` 換成 `finalPath`（原子操作）。複製或確認失敗時刪除 `.part`
     檔、保留既有的 `finalPath` 不動。
   - 任何發佈失敗（rename 或複製失敗：磁碟已滿、資料夾消失、無寫入權限等）→
     **目的地失敗**（見步驟 9），訊息附系統錯誤。
   - 成功 → done。
9. **清理邊界**：步驟 2–8
   全部包在同一個錯誤與取消邊界內。有兩種**保留擷取檔**的非終止出口（以旗標標記，`finally`
   看到旗標就只做部分清理）：
   - 步驟 3 的明確 `needsConfirm` 結果：不刪任何東西，狀態還原為 ready。
   - **目的地失敗**（步驟 2 建立資料夾失敗、步驟 3 存在檢查丟出 NotFound
     以外的錯誤——例如檔名過長、無權限讀取目的地——以及步驟 8 發佈失敗）：只刪除
     `<tempDir>/out/`（ffmpeg 成品，避免佔用暫存空間），**保留**
     main/aux，狀態回到 ready 並在 `lastError`
     帶入錯誤訊息。使用者可修改檔名或設定中的 `outputDir`
     後再按「開始處理」重試（會重新執行 ffmpeg，但不需重新擷取，也不需要 CDP
     連線）。 其他所有出口——取消、ffmpeg
     失敗、成功、其他未預期錯誤——都會刪除整個暫存目錄，之後才設定終止狀態（未預期的錯誤設為
     failed(process)，訊息附系統錯誤）。ready 狀態的暫存目錄名稱含目前
     `sessionId`，啟動清理一律跳過（見「暫存清理」的歸屬邊界），因此不會誤刪進行中的重試。

暫存清理：

- App 啟動時（上次異常結束的殘留）：
  - 刪除系統暫存目錄下所有 `ffdl-`
    開頭的目錄；系統暫存目錄以「建立一個新暫存目錄、取其上層、再刪掉它」的方式取得。
  - 刪除目前 `outputDir` 中符合 `.ffdl-*.part` 的檔案（中斷的跨裝置發佈殘檔）。
  - **歸屬邊界**：App 啟動時產生
    `sessionId = crypto.randomUUID()`（模組層級常數）。本次執行建立的暫存目錄一律使用前綴
    `ffdl-<sessionId>-`（`Deno.makeTempDir({ prefix: \`ffdl-${sessionId}-\`
    })`），跨裝置發佈的暫存檔一律命名為`.ffdl-<sessionId>-<uuid>.part`（仍為固定長度）。啟動清理只刪除符合模式、但**名稱中不含目前`sessionId`**
    的項目，因此即使清理在背景延遲執行，也不會碰到本次執行的任何工作檔案。
  - 啟動清理**一律盡力而為、在背景執行，不阻擋 UI
    與設定頁開啟**：目錄不存在（含外接磁碟未掛載）直接略過；列舉或刪除失敗逐項捕捉，只寫入
    log，不中斷其他項目，也不讓啟動失敗。
- 正常結束時的收尾見 §6.11。

CDP 連線狀態（與 job 分開管理，同樣由 `job.ts` 模組持有）：

- 持有 `client: CdpClient | null` 與
  `connecting: Promise<void> | null`；`connected` 即 `client !== null`。
- `connect()`：已連線 → 直接回傳；`connecting` 非 null → 回傳同一個
  Promise（重疊呼叫共用同一次連線嘗試，不會重複觸發授權對話框）；否則**同步**設定
  `connecting` 後才以 `browserWsUrl(cdpAddress)` 呼叫
  `CdpClient.connect`，結束時（成功或失敗）清空 `connecting`。
- 連線成功時若 `shuttingDown` 已為 true，立即關閉該 client
  並以「程式正在結束」失敗。
- `client.closed` 的處理函式綁定該 client 實例：只有在
  `this.client === 該 client` 時才把 `client` 設為
  null，避免舊連線的關閉事件誤把新連線標成中斷。
- 連線關閉時，若當下為 extracting，該次擷取以失敗結束。
- **變更 CDP 位址**：儲存設定時若 `cdpAddress` 與目前不同：
  - 工作為 extracting 時拒絕儲存，錯誤「擷取中無法變更 CDP
    位址」（設定檔與記憶體中的設定都不變）。
  - 其他狀態下，儲存流程在任何 await 之前**同步**完成驗證並套用到
    JobManager（因此檢查與套用之間不可能有新工作插入），之後才寫入設定檔；寫檔失敗時新設定已生效，回報「設定已套用但未能寫入設定檔」（設定檔寫入的可靠性見
    §10）。套用時關閉現有的瀏覽器連線（`connected` 變
    false），並讓進行中的連線嘗試失效——該嘗試完成時發現位址已不同，就關閉該
    client 並以「CDP 位址已變更，請重新連線」失敗。ready / processing /
    結果畫面不受影響（§6.12），工作回到 idle
    後顯示連線畫面，使用者以新位址重新連線。
  - 位址未變更時，連線維持不變。

### 6.10 `main.ts` 與 bindings

- `new Deno.BrowserWindow({ title: "Tab Ripper", width: 960, height: 720 })`。
- `Deno.serve` 路由：`/` → `index.html`、`/app.js`、`/style.css`（內容來自
  `src/ui-assets.ts` 的 text import，設定正確的 `content-type`），其他路徑 404。
- Bindings（頁面端 `await bindings.x(...)`）：

| 名稱             | 簽名                                                                                                         | 說明                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| `getSettings`    | `() => { settings, warning?, tools }`                                                                        | `tools` 為 ffmpeg/ffprobe 的 `checkTool` 結果 |
| `saveSettings`   | `(s: Settings) => { tools }`                                                                                 | 驗證並儲存，重新檢查工具                      |
| `probe`          | `() => { open: boolean; address: string }`                                                                   | TCP 探測                                      |
| `connect`        | `() => void`                                                                                                 | 解析 WS URL 並建立連線；失敗丟出含訊息的錯誤  |
| `getConnection`  | `() => { connected: boolean }`                                                                               |                                               |
| `listTabs`       | `() => TabInfo[]`                                                                                            | 需已連線                                      |
| `extract`        | `(targetId: string) => void`                                                                                 | 非同步啟動，進度以 `getStatus` 取得           |
| `getStatus`      | `() => JobStatus`                                                                                            |                                               |
| `discard`        | `() => void`                                                                                                 |                                               |
| `startProcess`   | `(filename: string, confirmedOverwritePath: string \| null) => { needsConfirm: boolean; finalPath: string }` | 檢查通過後非同步啟動處理（§6.9）              |
| `cancel`         | `() => void`                                                                                                 |                                               |
| `reset`          | `() => void`                                                                                                 |                                               |
| `revealInFinder` | `(path: string) => void`                                                                                     | 執行 `open -R <path>`                         |

- bindings 內丟出的錯誤以訊息字串傳回頁面端，由 UI 顯示。
- 應用程式選單以 `win.setApplicationMenu()` 自訂（不使用 OS 處理、JS 攔截不到的
  `role: "quit"`）：
  - 第一個 submenu（macOS 應用程式選單）：自訂項目
    `{ item: { label: "結束 Tab Ripper", id: "quit", accelerator: "CmdOrCtrl+Q", enabled: true } }`。
  - 「編輯」submenu：`undo`、`redo`、`cut`、`copy`、`paste`、`selectAll`
    role，讓檔名與設定輸入框的快捷鍵正常運作。
  - `menuclick` 事件 `e.detail.id === "quit"` 時進入 §6.11 的結束流程。

### 6.11 結束流程（shutdown）

依 §3.1 實測，Deno 2.9.7 的視窗關閉**無法攔截**，因此分成兩條路徑：

**A. 優雅結束：自訂選單「結束」（Cmd+Q）**，呼叫 `requestShutdown()`：

1. 若已在結束流程中，忽略重複觸發。
2. `job.shutdown({ deadlineMs = 10000 })`：
   1. 同步設定 `shuttingDown = true`；之後所有會改變狀態的
      binding（`connect`、`extract`、`startProcess`、`discard`、`reset`、`saveSettings`）一律丟出「程式正在結束」。
   2. 以 `win.executeJs("window.__showShuttingDown?.()")` 讓 UI
      顯示「正在結束…」遮罩（失敗忽略）。
   3. 依目前狀態收尾：
      - extracting：關閉 CDP 連線，使進行中的 CDP 請求立即以 `CdpClosedError`
        reject，擷取流程進入 failed 並清理暫存目錄。
      - processing / preparing 或 running：呼叫與使用者按「取消」**完全相同**的
        `cancel()`（同步設定 `cancelRequested`、觸發 `AbortController`、若
        ffmpeg 已啟動則 SIGTERM，3 秒後 SIGKILL），然後等待整個 `startProcess`
        工作的 Promise 結束。因為 `cancelRequested` 已設定，之後任何 `await`
        返回時都不會啟動 ffmpeg，也不會發佈。
      - processing /
        publishing：**等待發佈完成**，不中斷，避免輸出資料夾出現半成品或毀掉既有檔案。
      - ready：與 `discard()` 相同，但等刪除完成。
      - 其他狀態：無需處理。
   4. 等上述工作的 `finally`（暫存目錄清理）完成。
   5. 關閉 CDP 連線（若仍開著）。
   6. **硬性期限**：整個 shutdown 超過 `deadlineMs` 時，對仍存活的子行程同步送
      SIGKILL，不再等待，直接進入下一步。此時若正在跨裝置發佈，可能留下 `.part`
      殘檔，由下次啟動的清理處理（§6.9）。
   7. 最後呼叫 `killAllChildren()`（§6.8），對仍存活的子行程（含工具檢查）同步
      SIGKILL。因為 `Deno.exit()` **不會**終止子行程（§3.1
      實測），這一步是避免孤兒行程的唯一保障。
3. 設定 `shutdownDone = true`，呼叫 `win.close()`，接著 `Deno.exit(0)`。

**B.
立即結束：視窗關閉鈕、Cmd+W**。視窗與行程會立即終止，無法等待任何非同步工作。`close`
事件處理函式只做**同步、盡力而為**的收尾（`shutdownDone` 為 true 時直接略過）：

1. 呼叫 `killAllChildren()`（§6.8）同步 SIGKILL
   所有子行程（實測此路徑子行程也會被一起終止，這是額外保險）。
2. 以 `Deno.removeSync(tempDir, { recursive: true })`
   嘗試刪除目前的暫存目錄（錯誤忽略；可能因行程終止而未完成）。
3. 不處理 CDP 連線、不等待發佈。正在發佈時：同磁碟 rename
   是原子操作，最終檔不會半成品；跨裝置複製被中斷只會留下 `.part`。

此路徑與其他無法攔截的結束方式（Dock
圖示右鍵的「結束」、強制結束、當機、斷電）的殘留，一律由下次啟動時的清理補救（§6.9；見
§10）。UI 在擷取中與處理中畫面顯示提示「關閉視窗會中斷目前工作；請用 Cmd+Q
安全結束」。

### 6.12 UI（`ui/`）

單頁。**畫面由 `(JobStatus.state, connected)` 決定**，job 狀態優先於連線狀態：

| job 狀態                  | connected | 畫面       |
| ------------------------- | --------- | ---------- |
| extracting                | –         | 3 擷取中   |
| ready                     | –         | 4 預覽     |
| processing                | –         | 5 處理中   |
| done / failed / cancelled | –         | 6 結果     |
| idle                      | false     | 1 連線     |
| idle                      | true      | 2 分頁清單 |

也就是說，連線中斷**不會**讓預覽、處理中、結果畫面消失：ready
的工作仍可開始處理（處理只用暫存檔，不需要
CDP），處理中的工作仍可取消，結果仍可查看；直到工作回到 idle（`discard()` 或
`reset()`）時，才依 `connected` 決定回到連線畫面或分頁清單。UI 在 extracting /
processing 期間每 250 ms 輪詢 `getStatus()`，其他畫面在每次操作後呼叫
`getStatus()` 與 `getConnection()` 重新決定畫面。

1. **連線**：進入時呼叫 `probe()`（探測 `cdpAddress`），埠未開啟時每 2
   秒自動重探。
   - 未開啟：引導文字「請在瀏覽器網址列開啟 `chrome://inspect/#remote-debugging`
     並打開遠端偵錯開關（Brave
     也可直接使用此網址）」＋目前探測位址＋「重試」與「設定」。
   - 已開啟：顯示「偵測到瀏覽器偵錯埠」與「連線」按鈕；按下才呼叫
     `connect()`，並提示「請在瀏覽器跳出的對話框按允許」。連線失敗顯示錯誤訊息並留在此畫面。
2. **分頁清單**：`listTabs()`
   結果（標題、URL），可「重新整理」；無符合分頁時顯示空狀態與目前的
   `URL_PATTERN`。點選分頁 → `extract()`。
3. **擷取中**：每 250 ms 呼叫
   `getStatus()`，顯示已傳輸/總位元組，並顯示提示「關閉視窗會中斷目前工作；請用
   Cmd+Q 安全結束」（§6.11 B）。
4. **預覽**：`lastError`
   存在時在頂端顯示錯誤橫幅（例如「輸出失敗：磁碟空間不足，可修改檔名或到設定更換輸出資料夾後重試」）；info
   表格 + 檔案大小；檔名輸入框預填
   `defaultFilename`（從目的地失敗回來時保留使用者上次輸入的檔名）；「開始處理」與「取消」（`discard()`）。第一次以
   `startProcess(filename, null)` 呼叫；回傳 `needsConfirm` 時以原生 `confirm()`
   顯示 `finalPath` 詢問是否覆蓋，同意則以 `startProcess(filename, finalPath)`
   重呼叫。按下「開始處理」後 UI **立即開始輪詢** `getStatus()`，不等
   `startProcess`
   回傳：準備階段（建立資料夾、檢查目的地）期間畫面即切到「處理中／準備中」並可按「取消」；若最後回傳
   `needsConfirm` 或目的地失敗，輪詢會看到 ready 而回到預覽。**只有 ffmpeg
   檢查未通過**時才停用「開始處理」並提示到設定頁修正；ffprobe
   檢查未通過只在設定頁顯示警告（`PROBE_DURATION=true`
   時處理仍可進行，進度改為不確定）。
5. **處理中**：phase=preparing 顯示「準備中」；running 時 `percent` 非 null
   顯示百分比進度條與「目前時間 /
   總長度」，否則顯示不確定進度條與已處理時間，並顯示速度；進度條下方以等寬字型單行顯示
   `message`（ffmpeg
   輸出的最後一行，過長時以省略號截斷、滑鼠移上顯示全文）；publishing
   顯示「輸出檔案中」。preparing / running 時有「取消」按鈕，publishing
   時停用。同樣顯示「關閉視窗會中斷目前工作；請用 Cmd+Q 安全結束」提示。
6. **結果**：done → 輸出路徑 +「在 Finder 中顯示」；failed → 訊息與
   `detail`（等寬字型）；cancelled → 已取消。有 `cleanupWarning`
   時額外顯示「暫存檔未能刪除：<路徑>」提醒。皆有「再一次」（`reset()`，之後依上表決定畫面）。

- **設定**（任何畫面可開啟）：§6.1 的欄位、ffmpeg/ffprobe 檢查結果、載入時的
  warning。
- `app.js` 定義
  `window.__showShuttingDown()`，顯示覆蓋全畫面的「正在結束…」遮罩並停止輪詢（§6.11）。
- 分頁清單畫面上的 binding 呼叫若回報連線已關閉，`connected` 變
  false，依上表回到連線畫面。

## 7. 建置與執行

- `deno.json` tasks：
  - `dev`：`deno desktop --hmr --allow-net --allow-read --allow-write --allow-run --allow-env main.ts`
  - `build`：`deno desktop --allow-net --allow-read --allow-write --allow-run --allow-env -o dist/TabRipper main.ts`（產出
    `dist/TabRipper.app`；`-o` 不可帶 `.app`，見 §3.1）
  - `test`：`deno test --allow-net --allow-read --allow-write --allow-run --allow-env`
  - `check`：`deno check main.ts src/ user/ tests/`；`lint`：`deno lint`；`fmt`：`deno fmt`
- `--allow-net` 與 `--allow-run` 不限定目標，因為 CDP 位址與 ffmpeg
  路徑皆可由使用者修改。
- `deno.json` 設定
  `"compilerOptions": { "lib": ["deno.desktop", "deno.unstable", "dom"] }`：`deno.desktop`
  提供 `Deno.BrowserWindow` 等型別（一般 `deno check` 預設不含），`dom` 讓
  `user/page-script.js` 的頁面端程式碼可型別檢查（§3.1
  已實測此組合可通過）。`ui/app.js` 不納入 `deno check`。

## 8. 錯誤處理總表

| 情境                                                | 行為                                                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| CDP 埠未開啟                                        | 連線畫面引導 + 自動重探                                                                                                        |
| `cdpAddress` 格式錯誤                               | `saveSettings` 拒絕儲存，顯示 §6.3 的訊息                                                                                      |
| 埠有開但 WebSocket 連線失敗（例如位址指向其他服務） | `connect()` 失敗，顯示錯誤並提示確認 `chrome://inspect/#remote-debugging` 頁面上的位址與設定一致                               |
| 使用者在瀏覽器拒絕授權或逾時                        | `connect()` 失敗，提示可再試                                                                                                   |
| 選到休眠或尚未載入的分頁                            | 3 秒存活檢查逾時 → failed(extract)，提示先在瀏覽器點開該分頁（§6.6）                                                           |
| 視窗關閉鈕 / Cmd+W                                  | 立即結束，只做同步盡力收尾（§6.11 B）                                                                                          |
| 連線中途斷開                                        | `connected=false`；進行中的擷取失敗；ready / processing / 結果畫面不受影響，工作回到 idle 後才顯示連線畫面（§6.12）            |
| 頁面腳本例外 / 回傳格式不符                         | failed(extract)，顯示例外訊息                                                                                                  |
| 擷取中分頁關閉或重新載入                            | failed(extract)，訊息見 §6.6                                                                                                   |
| ffmpeg 無法執行                                     | 設定頁顯示錯誤，停用「開始處理」                                                                                               |
| ffprobe 無法執行或取長度失敗                        | 設定頁顯示警告；不阻擋處理，進度改為不確定                                                                                     |
| ffmpeg 結束碼非 0                                   | failed(process) + stderr 最後 20 行                                                                                            |
| 輸出檔已存在                                        | 原生 `confirm()` 詢問覆蓋                                                                                                      |
| 輸出資料夾無法建立 / 發佈失敗                       | 回到預覽（ready + `lastError`），保留擷取檔，可改檔名或輸出資料夾後重試；既有的同名檔保持不動、`.part` 檔已刪除（§6.9 步驟 9） |
| 任一結束路徑                                        | 暫存目錄刪除                                                                                                                   |

## 9. 測試策略

使用 `deno test` 與 `jsr:@std/assert`。

- **純函式單元測試**：`parseCdpAddress`（正常、前後空白、缺 port、port
  非數字或超出範圍、host 為空或含 `/`）、`browserWsUrl`（回傳
  `ws://host:port/devtools/browser`）、URL 過濾（含 `g` 旗標的 regex
  連續比對結果一致）、`sanitizeFilename`、`parseProgress`（`out_time_us`、`N/A`、`speed`、`progress=end`、跨
  chunk 截斷）、`splitStderr`（`\r` 分隔的段標為 transient、`\n`
  結尾的段不是、`\r\n` 視為一個換行、跨 chunk
  截斷的段正確接回、空段與前後空白被略過）、設定檔載入（不存在、損毀、部分欄位）。
- **TCP 探測**：對測試中以 `Deno.listen` 開啟的埠回傳 true；對已關閉的埠回傳
  false。
- **CDP client 與擷取**：測試內以 `Deno.serve` + `Deno.upgradeWebSocket`
  建立本機假 CDP server，驗證：`id` 對應與亂序回應、`sessionId`
  路由、錯誤回應轉成 `CdpError`、逾時、socket 關閉時 pending 全部
  reject；`extractFromTab` 在假 server 模擬 `Runtime.evaluate`
  回應下正確寫出檔案（含 0 位元組與跨多塊的檔案）、處理 `exceptionDetails`、處理
  `Target.detachedFromTarget` 中止、頁面身分檢查（假 server 依送來的 wrapper
  運算式回傳「網址不符」的 `exceptionDetails` 時，`extractFromTab`
  以該訊息失敗；並以純函式單元測試驗證 wrapper 產生器把 `URL_PATTERN` 的
  source/flags 正確嵌入且去除 `g`/`y`；另在測試中以 Deno 直接 `eval` 產生的
  wrapper 檢查片段，對符合與不符合的 `location.href`
  樣本驗證行為）、存活檢查（假 server 對所有 evaluate
  都不回應時：不送出使用者腳本，且從 `extractFromTab` 呼叫到 reject 的總耗時小於
  7 秒——3 秒存活檢查 + 最多 3 秒 detach）、使用者腳本請求懸置中假 server 發出
  `Target.detachedFromTarget` 時，`extractFromTab` 在 1
  秒內以分頁已關閉的錯誤結束、client 對該 session 的 pending 請求以
  `CdpSessionClosedError` reject，以及每次擷取使用不同 token、讀取運算式只讀該
  token 的資料、`finally` 只送 `Target.detachFromTarget`
  而不送任何頁面端運算式。另以 Deno 直接 `eval` 實際產生的 wrapper（以一個模擬
  `window` 的全新空物件作為 `globalThis.window`）驗證：在全新頁面上不會因
  `window.__ffdl` 不存在而丟錯；連續兩次擷取分別存入各自的 token、互不覆寫。
- **ffmpeg 整合測試**：以
  `ffmpeg -f lavfi -i testsrc=duration=3:size=320x240:rate=10`
  產生測試影片，驗證 `probeDuration`、`runFfmpeg` 的進度事件與 `ended`、以 `-re`
  實速執行時至少收到一次以 `frame=` 開頭的 `message` 且 `stderrTail` 中沒有
  transient 的狀態行、非 0 結束碼與 stderr tail、`cancel()`。系統找不到 ffmpeg
  時這些測試以 `ignore` 跳過。
- **job 狀態機**：以假 CDP server + 真 ffmpeg
  驗證完整成功流程、`needsConfirm`（之後狀態還原為 ready，回傳的 `finalPath`
  正確）、`needsConfirm` 回傳後暫存的 main/aux 仍存在、目的地失敗（`outputDir`
  指向一個無法建立的路徑，例如其上層是一般檔案；檔名超過 255
  位元組導致存在檢查丟出非 NotFound
  錯誤；發佈時目標資料夾已被移除寫入權限）時狀態回到 ready 並帶
  `lastError`、main/aux 保留、`<tempDir>/out/` 已刪除，之後把 `outputDir`
  改成可寫入的資料夾再呼叫 `startProcess` 能成功完成、以
  `confirmedOverwritePath`
  重呼叫後覆蓋成功、拒絕覆蓋後改用另一個檔名仍能以原本擷取的檔案完成處理、兩次呼叫之間修改
  `outputDir` 時許可不符而重新要求確認、處理中修改 `outputDir`
  時成品仍輸出到開始時快照的資料夾、running 中取消、preparing
  中取消（以一個永不結束的假 ffprobe 腳本作為
  `ffprobePath`：取消後該行程被終止、ffmpeg 不會被啟動、狀態為
  cancelled）、暫存目錄刪除失敗時仍進入正確的終止狀態並帶
  `cleanupWarning`（以移除暫存目錄寫入權限的方式模擬）、失敗時暫存目錄都被刪除、同時發出兩個
  `startProcess`（或 `startProcess` +
  `discard`）時只有第一個成功、終止狀態只在清理嘗試完成後出現。
- **shutdown**：直接呼叫 `job.shutdown()`（不經視窗）分別在
  idle、ready、extracting（假 CDP server 讓請求懸置）、preparing（懸置的假
  ffprobe：shutdown 後 ffmpeg 從未啟動、輸出資料夾沒有任何新檔案）、running（真
  ffmpeg）狀態下觸發，驗證：子行程都已結束、暫存目錄已刪除、shutdown 期間呼叫
  `startProcess` 等動作被拒。publishing 階段「不中斷」由「shutdown 等待整個
  `startProcess` Promise」保證；同磁碟 rename
  瞬間完成，測試中難以穩定停在該階段，因此不做自動化測試。另以忽略 SIGTERM 的假
  ffmpeg 腳本搭配縮短的 `deadlineMs`，驗證期限到時子行程被 SIGKILL 且
  `shutdown()` 在期限內 resolve。
- **連線管理**：以延遲回應 WebSocket upgrade 的假 CDP server
  模擬「等待授權」：重疊呼叫兩次 `connect()` 時 server
  只收到一次連線；連線等待中呼叫 `shutdown()`，連線完成後立即被關閉、`connect()`
  以「程式正在結束」失敗；連線中斷後重新連線，新連線不會被舊連線之後才發生的事件標成中斷（透過公開
  API 無法讓舊 client 的 `closed` 處理在新 client
  建立之後才觸發，因為重新連線必須等舊連線被清除；`closed` 處理綁定 client
  實例屬於防禦性實作，以「中斷 → 重新連線 →
  等待一段時間後仍為已連線」驗證可觀察的行為）；變更 CDP
  位址：已連線時套用新位址會關閉舊連線；連線嘗試進行中套用新位址，該嘗試完成後被關閉並以「CDP
  位址已變更，請重新連線」失敗；extracting
  時變更位址被拒絕且設定不變；位址不變的設定更新不影響連線。
- **啟動殘留清理**：在測試建立的暫存位置放入其他 session 的 `ffdl-<別的id>-*`
  目錄與 `.ffdl-<別的id>-abc.part` 檔，以及帶目前 `sessionId` 的目錄與 `.part`
  檔，驗證只有前者被刪除、後者與其他檔案不受影響；`outputDir` 不存在、以及
  `outputDir` 被移除讀取權限時，清理函式正常
  resolve、不丟錯，且暫存目錄部分仍完成清理。
- **工具檢查逾時**：以 `-version` 永不結束的假執行檔腳本呼叫 `checkTool`（縮短
  `timeoutMs`），驗證回傳
  `ok: false`、子行程已結束且已從登記集合移除；`killAllChildren()`
  能終止登記中的懸置子行程。
- **ffprobe 逾時**：在 `ffmpeg.ts` 的測試中直接呼叫
  `probeDuration`，以永不結束的假 ffprobe 腳本與縮短的 `timeoutMs` 驗證回傳
  `null` 且子行程已結束；`signal` 中止時同樣驗證。
- **發佈**（`src/publish.ts`，見 §6.9 步驟 8）：`publishOutput(src, finalPath)`
  測試同一磁碟 rename
  成功（含覆蓋既有檔）。跨裝置情境在測試環境無法重現，因此把複製分支匯出為
  `copyThenRename(src, finalPath)` 直接測試：正常時 `finalPath`
  內容等於來源且沒有殘留 `.part`；最終檔名長度為 250
  位元組（接近上限的合法檔名）時同樣成功；來源在呼叫前被刪除（模擬複製失敗）時丟出錯誤、沒有殘留
  `.part`、既有的 `finalPath` 內容不變。
- **手動驗收清單**（`deno desktop` 視窗與真實瀏覽器無法自動化；以 Brave 執行）：
  1. 瀏覽器未開開關 → 連線畫面顯示引導；開啟開關後 2
     秒內變成「偵測到」，且瀏覽器**未**跳出授權對話框。
  2. 按連線 → 瀏覽器跳出授權對話框一次；允許後看到分頁清單（使用預設
     `cdpAddress` 即可連上 Brave）。把 `cdpAddress` 改成錯誤的埠 →
     連線畫面顯示未偵測到；改回後恢復。
  3. 完成一次工作後按「再一次」→ 不再跳出授權對話框。
  4. 擷取中關閉該分頁 → 顯示分頁已關閉的錯誤。
  5. 選一個休眠中（未點開過）的分頁 → 約 3
     秒後顯示「分頁尚未載入」；點開該分頁後重試成功。
  6. 處理中按取消 → 輸出資料夾無殘檔、暫存目錄已刪除。
  7. `PROBE_DURATION=false` → 顯示不確定進度條。
  8. 處理中按 Cmd+Q → 顯示「正在結束…」，數秒內關閉；之後 `ps` 中沒有殘留的
     ffmpeg，暫存目錄已刪除。
  9. 處理中按視窗關閉鈕 → 立即關閉；之後 `ps` 中沒有殘留的
     ffmpeg；下次啟動後暫存目錄殘留被清掉。
  10. `deno task build` 產出的 `dist/TabRipper.app` 能開啟並完成上述流程。

## 10. Non-goals / Accepted limitations

- 只支援 macOS（`open -R`、預設路徑皆為 macOS）；不處理 Windows/Linux。
- 不讀取瀏覽器資料夾、不自動偵測位址；`chrome://inspect/#remote-debugging`
  顯示的位址與預設 `127.0.0.1:9222` 不同時，由使用者在設定中修改 `cdpAddress`。
- **視窗關閉鈕（Cmd+W）無法優雅收尾**
  - Concern：處理中按關閉鈕時無法取消 ffmpeg、等待發佈或清理暫存。
  - Decision：接受立即結束；只做同步盡力收尾（SIGKILL 子行程、`removeSync`
    暫存目錄），殘留由下次啟動清理；優雅收尾只提供給 Cmd+Q。
  - Rationale：Deno 2.9.7 的 close
    事件不可取消，最後一個視窗關閉時行程立即結束（§3.1
    實測與原始碼）；以隱藏保活視窗繞過的實驗不穩定且依賴未公開行為。使用者裁決採用此方案。
- 不提供原生資料夾選擇器（`deno desktop` 尚未提供），輸出資料夾以文字路徑設定。
- 同一時間只處理一個工作；不支援佇列或批次。
- 啟動時清理 `ffdl-` 暫存目錄不考慮同時執行多個 App 實例的情況。
- 不支援遠端（非本機）且需驗證的 CDP 端點。
- 檔案大小以「數十 MB 以內」為設計目標；未針對 GB 級檔案最佳化（仍以 4 MiB
  分塊、串流寫檔，不會整檔載入 Deno 記憶體，但頁面端需同時持有兩個 buffer）。
- UI 只提供繁體中文。
- 無法攔截的結束方式（視窗關閉鈕、Dock
  右鍵「結束」、強制結束、當機、斷電）不保證收尾：可能殘留暫存目錄與 `.part`
  檔，由下次啟動清理；若期間修改過 `outputDir`，舊資料夾中的 `.part`
  不會被清理。
- **不做頁面端清理**
  - Concern：擷取完成（或失敗、逾時後腳本才完成）時，`window.__ffdl[token]` 中的
    main/aux buffer（各可能數十 MB）會留在分頁記憶體中；同一分頁多次擷取會累積。
  - Decision：不清理（不送 delete 運算式、不使用取消標記）。
  - Rationale：使用者裁決；通常每個網頁只擷取一次，即使累積，重新整理分頁即可釋放，不值得為此維護清理與取消標記的生命週期。
- **目的地 I/O 卡住**
  - Concern：輸出資料夾位於外接或網路磁碟且建立資料夾、檢查目的地的檔案操作卡住不回應時，工作會一直停在「準備中」，取消也要等該
    I/O 回應後才會完成。
  - Decision：不為這些檔案操作加上逾時與放棄機制。
  - Rationale：使用者裁決；屬罕見環境問題，使用者仍可用 Cmd+Q 結束（結束流程有
    10 秒硬性期限，§6.11），成本與風險不成比例。
- **wrapper script 的子孫行程**
  - Concern：`ffmpegPath` / `ffprobePath` 若設成 wrapper script，且 script
    不是以 `exec` 啟動真正的工具，取消、逾時與結束流程只會終止 script
    本身；子孫行程可能存活並持有 stdout/stderr，使讀取等不到 EOF。
  - Decision：不實作行程群組（process tree）終止與串流讀取逾時。
  - Rationale：使用者裁決；路徑應直接指向 ffmpeg/ffprobe 執行檔（或以 `exec`
    轉交的 wrapper），`Deno.Command` 也沒有直接的行程群組
    API，成本與風險不成比例。
- **設定檔非原子寫入**
  - Concern：`saveSettings` 直接覆寫
    `settings.json`；磁碟已滿或寫入途中程式被終止時，舊的有效設定可能毀損；重疊的儲存呼叫沒有定義順序。
  - Decision：不實作暫存檔 + rename 的原子寫入與儲存排隊。
  - Rationale：使用者裁決；設定只有 4
    個欄位，毀損時下次啟動會退回預設值並顯示警告（§6.1），使用者可立即重新設定。
- **輸出檔撞名競態**
  - Concern：使用者選擇不覆蓋（或確認時檔案不存在）之後，若 ffmpeg
    處理期間有其他程式在輸出資料夾建立同名檔，最後發佈時的 rename
    會靜默取代該檔。
  - Decision：不實作（不使用「不取代」的原子發佈、不在撞名時保留成品重新詢問）。
  - Rationale：使用者裁決；單人使用的本機工具中，處理期間外部程式剛好建立同名檔幾乎不可能發生，成本（新狀態、UI
    分支、測試）與風險不成比例。
