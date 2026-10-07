/**
 * Runs INSIDE the selected browser tab. Must be self-contained:
 * it is serialized with Function.prototype.toString(), so it cannot
 * reference imports or variables outside its own body.
 * @returns {Promise<{ main: ArrayBuffer | ArrayBufferView,
 *                     aux: ArrayBuffer | ArrayBufferView,
 *                     info: Record<string, string | number | boolean> }>}
 */
// deno-lint-ignore require-await
export default async function pageScript() {
  throw new Error("TODO: implement user/page-script.js");
}
