// Deno 2.9.7 and current Chromium both ship the TC39 base64 methods, but
// the TypeScript lib may not declare them, so they are reached through
// narrow casts.
type Base64Constructor = { fromBase64(base64: string): Uint8Array };
type Base64Bytes = Uint8Array & { toBase64(): string };

export function decodeBase64(base64: string): Uint8Array {
  return (Uint8Array as unknown as Base64Constructor).fromBase64(base64);
}

export function encodeBase64(bytes: Uint8Array): string {
  return (bytes as Base64Bytes).toBase64();
}
