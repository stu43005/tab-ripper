import { parseCdpAddress } from "./address.ts";

/**
 * TCP connect + immediate close. No bytes are sent and no WebSocket
 * handshake happens, so the browser's permission dialog is not triggered.
 */
export async function probeCdpPort(
  address: string,
  timeoutMs = 1000,
): Promise<boolean> {
  let host: string;
  let port: number;
  try {
    ({ host, port } = parseCdpAddress(address));
  } catch {
    return false;
  }
  const attempt = Deno.connect({ hostname: host, port }).then(
    (conn) => conn,
    () => null,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const outcome = await Promise.race([attempt, timeout]);
  clearTimeout(timer);
  if (outcome === "timeout") {
    // A connection that completes after the timeout must still be closed.
    void attempt.then((conn) => conn?.close());
    return false;
  }
  if (outcome === null) return false;
  outcome.close();
  return true;
}
