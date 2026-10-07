// The app never reads browser data dirs; it only needs host:port.
const FORMAT_ERROR = "CDP 位址格式應為 主機:埠，例如 127.0.0.1:9222";

export function parseCdpAddress(
  address: string,
): { host: string; port: number } {
  const trimmed = address.trim();
  const colon = trimmed.lastIndexOf(":");
  if (colon <= 0) throw new Error(FORMAT_ERROR);
  const host = trimmed.slice(0, colon);
  const portText = trimmed.slice(colon + 1);
  // URL delimiters in the host would make the WebSocket URL target a
  // different endpoint than the TCP probe.
  if (/[\s/?#@[\]\\:]/.test(host)) throw new Error(FORMAT_ERROR);
  if (!/^\d+$/.test(portText)) throw new Error(FORMAT_ERROR);
  const port = Number(portText);
  if (port < 1 || port > 65535) throw new Error(FORMAT_ERROR);
  return { host, port };
}

/** Toggle-mode endpoints accept `/devtools/browser` without the uuid. */
export function browserWsUrl(address: string): string {
  const { host, port } = parseCdpAddress(address);
  return `ws://${host}:${port}/devtools/browser`;
}
