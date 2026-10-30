/** UUID v4 from Web Crypto, including ordinary HTTP where randomUUID is absent.
 * Never weaken an idempotency key with Math.random or a time-based fallback.
 */
export function createClientId(): string {
  const provider = globalThis.crypto;
  try {
    if (typeof provider?.randomUUID === "function") return provider.randomUUID();
  } catch { /* A failing convenience method may still leave secure random bytes available. */ }
  try {
    if (typeof provider?.getRandomValues === "function") {
      const bytes = provider.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0"));
      return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
    }
  } catch { /* Report the missing secure provider, never use a predictable key. */ }
  throw Error("Не удалось создать защищённый номер запроса. Обновите страницу или используйте браузер с поддержкой Web Crypto.");
}
