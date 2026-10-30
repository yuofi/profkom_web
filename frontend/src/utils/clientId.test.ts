import { afterEach, expect, it, vi } from "vitest";
import { createClientId } from "./clientId";

afterEach(() => { vi.unstubAllGlobals();vi.restoreAllMocks(); });
it("uses the native UUID API when it is available", () => {
  const native = vi.fn(() => "2806d837-7862-47db-9658-10c0ba31f12c");
  vi.stubGlobal("crypto", { randomUUID: native, getRandomValues: vi.fn() });
  expect(createClientId()).toBe("2806d837-7862-47db-9658-10c0ba31f12c");expect(native).toHaveBeenCalledOnce();
});
it("creates an RFC4122 v4 UUID from secure bytes on ordinary HTTP", () => {
  const random = vi.spyOn(Math, "random").mockImplementation(() => { throw Error("Insecure fallback"); });
  const secure = vi.fn((bytes: Uint8Array) => { bytes.fill(255);return bytes; });
  vi.stubGlobal("crypto", { getRandomValues: secure });
  expect(createClientId()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");expect(secure).toHaveBeenCalledOnce();expect(random).not.toHaveBeenCalled();
});
it("falls back to secure bytes if only randomUUID fails", () => {
  vi.stubGlobal("crypto", { randomUUID: () => { throw Error("Unavailable"); }, getRandomValues: (bytes: Uint8Array) => bytes });
  expect(createClientId()).toBe("00000000-0000-4000-8000-000000000000");
});
it.each([undefined, {}, { getRandomValues: () => { throw Error("Provider failed"); } }])("reports unavailable secure randomness clearly instead of inventing a predictable key", provider => {
  vi.stubGlobal("crypto", provider);expect(() => createClientId()).toThrow("Не удалось создать защищённый номер запроса");
});
