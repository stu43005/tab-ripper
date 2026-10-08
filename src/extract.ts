import { statelessPattern } from "./tabs.ts";

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
